const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const db = require('../src/db/db');
const { initConfig, getConfig } = require('../src/config/config');
const { buildProviders } = require('../src/llm');
const { GitHubClient } = require('../src/github/client');
const { resolveAnchors, deferredToBody } = require('../src/github/anchors');
const { backfillReviewer } = require('../src/pipeline/backfill');
const { categorizeComments } = require('../src/pipeline/categorize');
const { runReview } = require('../src/pipeline/review');
const { proposeConsolidation, applyConsolidation } = require('../src/pipeline/consolidate');
const { loadProfile, saveProfile, incrementPendingCount } = require('../src/profile/profileStore');
const { pickDeltaType, DELTA_TYPES } = require('../src/pipeline/deltaTypes');
const { CATEGORIES } = require('../src/pipeline/categories');

// Pin the data directory instead of letting Electron derive it from
// package.json — the derivation varies by launch mode/version, and a
// display-name rename (productName) must never orphan the existing
// database, config, and profiles.
app.setPath('userData', path.join(app.getPath('appData'), 'pr-review-agent'));

let mainWindow = null;
let profilesDir = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  db.initDb(userDataPath);
  initConfig();
  profilesDir = path.join(userDataPath, 'profiles');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function getProviders() {
  const cfg = getConfig();
  return buildProviders({
    llm: cfg.get('llm'),
    embeddings: cfg.get('embeddings'),
  });
}

function getGitHub() {
  const cfg = getConfig();
  const token = cfg.get('githubToken');
  if (!token) throw new Error('GitHub token not configured yet.');
  return new GitHubClient(token);
}

// ---------------------------------------------------------------------
// IPC: config
// ---------------------------------------------------------------------

ipcMain.handle('config:get', () => getConfig().store);

ipcMain.handle('config:set', (event, partial) => {
  const cfg = getConfig();
  for (const [k, v] of Object.entries(partial)) cfg.set(k, v);
  return cfg.store;
});

// ---------------------------------------------------------------------
// IPC: Setup self-tests
// ---------------------------------------------------------------------
// Every test here runs against what is ON SCREEN right now, never against
// the saved config. The old `config:testConnection` read the *persisted*
// config, so the natural workflow (edit field → Test) silently tested stale
// values and you only found out after Save. Nothing in this block persists.

/** Shape the form's step 2/3 blocks into what buildProviders expects. */
function formProviders({ llm, embeddings }) {
  if (!llm || !llm.provider) throw new Error('Pick an LLM provider first.');
  return buildProviders({
    llm,
    embeddings: embeddings && embeddings.provider ? embeddings : null,
  });
}

ipcMain.handle('llm:test', async (event, llm) => {
  const { completion } = formProviders({ llm, embeddings: null });
  await completion.testConnection();
  return { ok: true };
});

/** Test step 3 in isolation: first report *why* the resolved provider can't
 *  embed (an Anthropic fallback, a missing embedding model) rather than
 *  letting the user discover it at backfill, then actually embed something. */
ipcMain.handle('emb:test', async (event, { llm, embeddings }) => {
  const { embeddings: emb, embeddingsError } = formProviders({ llm, embeddings });
  if (embeddingsError) throw new Error(embeddingsError);
  const vec = await emb.embed('ping');
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('The embeddings provider returned an empty vector.');
  }
  return { ok: true, dimensions: vec.length };
});

/** Verifies a token AND returns the login, which is what gets auto-filled
 *  into step 5. Backfill matches `c.user?.login === username`, so a
 *  plausible-looking typo in a self-typed username ingests ZERO comments
 *  and the reviewer ends up with an empty corpus and no error. */
ipcMain.handle('github:verify', async (event, token) => {
  if (!token) throw new Error('Paste a personal access token first.');
  const user = await new GitHubClient(token).getUser();
  return { login: user.login, name: user.name || '' };
});

/** The one place the renderer can ask the main process to open a browser
 *  (token creation lives outside the app). Restricted to https:// so this
 *  never becomes a general navigation primitive driven by renderer input. */
ipcMain.handle('shell:open', async (event, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('Only https:// links can be opened.');
  }
  await shell.openExternal(url);
  return { ok: true };
});

// ---------------------------------------------------------------------
// IPC: reviewers / profile
// ---------------------------------------------------------------------

ipcMain.handle('reviewer:create', (event, { id, displayName }) => {
  db.upsertReviewer(id, displayName);
  const profile = loadProfile(profilesDir, id);
  saveProfile(profilesDir, profile);
  return profile;
});

ipcMain.handle('reviewer:list', () => db.listReviewers());

/**
 * One round-trip for the Pull Requests dashboard's status strip: corpus
 * size, session count, and feedback awaiting consolidation. All counts are
 * read live — the strip answers "is backfill actually done?", so caching
 * them in config would defeat the point.
 */
ipcMain.handle('stats:overview', (event, reviewerId) => {
  if (!reviewerId) return { comments: 0, sessions: 0, feedback: 0 };
  return {
    comments: db.countComments(reviewerId),
    sessions: db.listSessions(reviewerId).length,
    feedback: db.unconsolidatedCorrections(reviewerId).length,
  };
});

ipcMain.handle('profile:get', (event, reviewerId) => loadProfile(profilesDir, reviewerId));

/** The fixed category vocabulary, so the UI never free-texts a name that
 *  calibration and the analysis pass wouldn't recognize. */
ipcMain.handle('categories:list', () => CATEGORIES);

// ---------------------------------------------------------------------
// IPC: backfill
// ---------------------------------------------------------------------

ipcMain.handle('backfill:run', async (event, { reviewerId, username, repos }) => {
  const github = getGitHub();
  const providers = getProviders();

  // Fail fast, before a single comment is ingested. Previously this error
  // was computed but never checked, so an Anthropic-only config would
  // ingest the whole corpus and then throw mid-embed — leaving comments
  // with no embeddings and no useful error until the first review.
  if (providers.embeddingsError) throw new Error(providers.embeddingsError);

  const result = await backfillReviewer({
    github,
    embeddingProvider: providers.embeddings,
    reviewerId,
    repos,
    username,
    onProgress: (msg) => event.sender.send('backfill:progress', msg),
  });

  // Label the newly ingested comments from the fixed vocabulary so
  // calibration has historical per-category rates to filter against.
  const cat = await categorizeComments({
    completion: providers.completion,
    reviewerId,
    onProgress: (msg) => event.sender.send('backfill:progress', msg),
  });

  return { ...result, categorized: cat.categorized, uncategorizedRemaining: cat.remaining };
});

// ---------------------------------------------------------------------
// IPC: PRs / review pipeline
// ---------------------------------------------------------------------

ipcMain.handle('prs:listOpen', async (event, { repo }) => {
  const github = getGitHub();
  return github.listOpenPRs(repo);
});

ipcMain.handle('review:run', async (event, { reviewerId, repo, prNumber }) => {
  const github = getGitHub();
  const providers = getProviders();
  const profile = loadProfile(profilesDir, reviewerId);
  const cfg = getConfig();

  const diffText = await github.getPRDiff(repo, prNumber);
  return runReview({
    providers,
    profile,
    reviewerId,
    repo,
    prNumber,
    diffText,
    strictness: cfg.get('strictness'),
  });
});

ipcMain.handle('review:sessions', (event, reviewerId) => db.listSessions(reviewerId));

ipcMain.handle('review:drafts', (event, sessionId) => db.draftsForSession(sessionId));

/**
 * Human resolves a single draft comment: accept as-is, edit the text, or
 * reject it entirely. Every resolution is logged to `corrections` — this
 * is the fast loop's raw signal, consumed later by consolidation.
 *
 * `deltaType` comes from the UI's per-card "Type" select; the action → type
 * validity rules live in src/pipeline/deltaTypes.js (see that module for
 * why a mismatched type is coerced rather than passed through).
 */
ipcMain.handle('review:resolveDraft', (event, { draftId, reviewerId, action, editedText, deltaType }) => {
  const draft = db.getDb().prepare('SELECT * FROM draft_comments WHERE id = ?').get(draftId);
  if (!draft) throw new Error('Draft not found');
  if (!DELTA_TYPES[action]) throw new Error(`Unknown action: ${action}`);

  let status, humanText;
  if (action === 'accept') {
    status = 'accepted'; humanText = draft.agent_text;
  } else if (action === 'edit') {
    if (!editedText || !editedText.trim()) throw new Error('Edited text is required.');
    status = 'edited'; humanText = editedText;
  } else {
    status = 'rejected'; humanText = null;
  }

  const finalDeltaType = pickDeltaType(action, deltaType);

  db.updateDraftStatus(draftId, status, humanText);
  db.insertCorrection({
    reviewer_id: reviewerId,
    draft_comment_id: draftId,
    agent_draft: draft.agent_text,
    human_final: humanText,
    delta_type: finalDeltaType,
  });
  // Feedback has accumulated — record it against the profile so
  // consolidation can see how much new signal there is.
  incrementPendingCount(profilesDir, reviewerId);

  return { ok: true, delta_type: finalDeltaType };
});

/**
 * The human adds a comment the agent did NOT draft at all — the
 * `missed_issue` correction type. This is the only path that can *grow* the
 * substance rubric with new categories: rejections can only ever lower a
 * category's weight, so without it the rubric has no way to learn what the
 * agent consistently fails to notice.
 *
 * Stored as a draft with an empty `agent_text` and status 'added' so it
 * flows through the same display and submit paths as agent drafts (the
 * submit button keys off accepted/edited/added and uses `human_text`).
 */
ipcMain.handle('review:addHumanComment', (event, { sessionId, reviewerId, filePath, line, text, category }) => {
  if (!text || !text.trim()) throw new Error('Comment text is required.');
  const session = db.getDb().prepare('SELECT * FROM review_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('No active review session — run a review first.');

  const draftId = db.insertDraftComment({
    session_id: sessionId,
    file_path: filePath?.trim() || null,
    line: line ? Number(line) : null,
    category: category?.trim() || null,
    severity: null,
    agent_text: '',
  });
  db.updateDraftStatus(draftId, 'added', text.trim());
  db.insertCorrection({
    reviewer_id: reviewerId,
    draft_comment_id: draftId,
    agent_draft: '',
    human_final: text.trim(),
    delta_type: 'missed_issue',
  });
  incrementPendingCount(profilesDir, reviewerId);

  return db.getDb().prepare('SELECT * FROM draft_comments WHERE id = ?').get(draftId);
});

ipcMain.handle('review:submitToGitHub', async (event, { repo, prNumber, comments, sessionId }) => {
  const github = getGitHub();
  // The analysis pass is an LLM, so its line/file guesses can fall outside
  // the diff — and GitHub 422s the ENTIRE review for one unresolvable
  // anchor. Validate every comment against the real diff first: provably
  // placeable ones go inline with an explicit side, the rest ride along in
  // the review body instead of failing the submission (src/github/anchors).
  const diffText = await github.getPRDiff(repo, prNumber);
  const { resolved, deferred } = resolveAnchors(comments, diffText);
  const result = await github.createPendingReview(
    repo, prNumber, resolved, deferredToBody(deferred),
  );
  // Only mark the session once GitHub actually accepted the review — a
  // residual 422 (bad path, stale token) leaves it 'draft' so it can be
  // corrected and retried.
  if (sessionId) db.markSessionSubmitted(sessionId);
  return { ...result, anchored: resolved.length, deferred: deferred.length };
});

// ---------------------------------------------------------------------
// IPC: consolidation (slow loop)
// ---------------------------------------------------------------------

ipcMain.handle('consolidate:propose', async (event, { reviewerId }) => {
  const providers = getProviders();
  const currentProfile = loadProfile(profilesDir, reviewerId);
  return proposeConsolidation({ providers, currentProfile, reviewerId });
});

ipcMain.handle('consolidate:apply', (event, { proposedProfile, correctionIds }) => {
  return applyConsolidation({ profilesDir, proposedProfile, correctionIds });
});
