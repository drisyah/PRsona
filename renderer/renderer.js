// ---- Tab switching -------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    // The Review tab now lists past sessions, so refresh it when opened.
    if (btn.dataset.tab === 'review') refreshSessions();
  });
});

let currentReviewerId = null;
let currentSessionId = null;
let currentRepo = null;
let currentPrNumber = null;
let lastSessions = [];

const RESOLVED_STATUSES = ['accepted', 'edited', 'rejected', 'added'];
const SUBMITTABLE_STATUSES = ['accepted', 'edited', 'added'];

// ---- Setup tab -------------------------------------------------------

async function loadConfigIntoForm() {
  const cfg = await window.api.config.get();
  if (cfg.reviewerId) {
    currentReviewerId = cfg.reviewerId;
    document.getElementById('reviewerId').value = cfg.reviewerId;
  }
  updateSetupNotice();
  if (cfg.llm) {
    document.getElementById('llmProvider').value = cfg.llm.provider || 'anthropic';
    document.getElementById('llmModel').value = cfg.llm.model || '';
    document.getElementById('llmApiKey').value = cfg.llm.apiKey || '';
    document.getElementById('llmBaseUrl').value = cfg.llm.baseUrl || '';
  }
  if (cfg.embeddings) {
    document.getElementById('embProvider').value = cfg.embeddings.provider || '';
    document.getElementById('embModel').value = cfg.embeddings.model || '';
    document.getElementById('embApiKey').value = cfg.embeddings.apiKey || '';
    document.getElementById('embBaseUrl').value = cfg.embeddings.baseUrl || '';
  }
  document.getElementById('githubToken').value = cfg.githubToken || '';
  document.getElementById('repos').value = (cfg.repos || []).join(', ');
  // Show/hide fields for the restored providers. Deliberately does NOT fill
  // in preset values here — those belong to a provider *change*, and
  // clobbering a saved model name on launch would be a nasty surprise.
  applyVisibility();
}
loadConfigIntoForm();

/** Populate the fixed category vocabulary so the "add a comment" field can
 *  never write a name the analysis pass and calibration wouldn't recognize. */
(async () => {
  try {
    const cats = await window.api.categories.list();
    const dl = document.getElementById('hcCategoryOptions');
    dl.innerHTML = '';
    cats.forEach((c) => {
      const o = document.createElement('option');
      o.value = c;
      dl.appendChild(o);
    });
  } catch (e) {
    // Vocabulary unavailable — the field just has no suggestions.
  }
})();

// ---- Setup: provider presets + per-step self-tests ---------------------
// Picking a provider shouldn't require already knowing a model name and a
// base URL — each provider has exactly one sensible pair, so fill them in.
// Hand-typed values are respected: a field is only overwritten when it is
// empty or still holds some provider's preset value (i.e. untouched).

const PRESETS = {
  llm: {
    anthropic: { model: 'claude-sonnet-4-6', baseUrl: '' },
    openai: { model: 'gpt-4o', baseUrl: '' },
    ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://localhost:11434' },
    openai_compat: { model: '', baseUrl: 'http://localhost:1234/v1' },
  },
  emb: {
    anthropic: { model: '', baseUrl: '' },
    openai: { model: 'text-embedding-3-small', baseUrl: '' },
    ollama: { model: 'nomic-embed-text', baseUrl: 'http://localhost:11434' },
    openai_compat: { model: '', baseUrl: 'http://localhost:1234/v1' },
  },
};

const PRESET_VALUES = new Set(
  Object.values(PRESETS)
    .flatMap((byKind) => Object.values(byKind))
    .flatMap((p) => [p.model, p.baseUrl])
    .filter(Boolean)
);

const FIELD = {
  llm: { sel: 'llmProvider', model: 'llmModel', url: 'llmBaseUrl', key: 'llmApiKey' },
  emb: { sel: 'embProvider', model: 'embModel', url: 'embBaseUrl', key: 'embApiKey' },
};

function applyPreset(kind) {
  const ids = FIELD[kind];
  const preset = PRESETS[kind][document.getElementById(ids.sel).value];
  if (!preset) return; // "(same as LLM provider)" fills nothing on its own
  for (const [prop, id] of [['model', ids.model], ['baseUrl', ids.url]]) {
    const el = document.getElementById(id);
    if (!el.value || PRESET_VALUES.has(el.value)) el.value = preset[prop];
  }
}

/** The embeddings select can defer to the LLM provider, so visibility is
 *  always computed from the *resolved* provider, never the raw selection —
 *  otherwise "(same as LLM provider)" + Ollama would show a key field that
 *  isn't needed. */
function applyVisibility() {
  const llmProvider = document.getElementById(FIELD.llm.sel).value;
  const embProvider = document.getElementById(FIELD.emb.sel).value || llmProvider;

  toggleField(FIELD.llm.key, llmProvider === 'ollama'); // local models need no key
  toggleField(FIELD.emb.key, embProvider === 'ollama');
  toggleField(FIELD.llm.url, ['anthropic', 'openai'].includes(llmProvider));
  toggleField(FIELD.emb.url, ['anthropic', 'openai'].includes(embProvider));

  const warn = document.getElementById('embWarning');
  const cannotEmbed = embProvider === 'anthropic';
  warn.style.display = cannotEmbed ? 'block' : 'none';
  if (cannotEmbed) {
    warn.textContent =
      'Anthropic has no embeddings endpoint. Choose OpenAI, Ollama, or a custom endpoint for ' +
      'embeddings — "(same as LLM provider)" only works when your LLM provider itself can embed.';
  }
}

function toggleField(fieldId, hide) {
  const el = document.getElementById(fieldId);
  const label = el && el.closest('label');
  if (label) label.style.display = hide ? 'none' : '';
}

document.getElementById(FIELD.llm.sel).addEventListener('change', () => {
  applyPreset('llm');
  applyVisibility();
});
document.getElementById(FIELD.emb.sel).addEventListener('change', () => {
  applyPreset('emb');
  applyVisibility();
});

/** The form exactly as the user left it — shared by Save and by the tests,
 *  so a test can never be validating different values than were saved. */
function readLlm() {
  return {
    provider: document.getElementById('llmProvider').value,
    model: document.getElementById('llmModel').value,
    apiKey: document.getElementById('llmApiKey').value,
    baseUrl: document.getElementById('llmBaseUrl').value,
  };
}

function readEmb() {
  const provider = document.getElementById('embProvider').value;
  if (!provider) return null; // "(same as LLM provider)"
  return {
    provider,
    model: document.getElementById('embModel').value,
    apiKey: document.getElementById('embApiKey').value,
    baseUrl: document.getElementById('embBaseUrl').value,
  };
}

// ---- step 2: LLM -----------------------------------------------------
document.getElementById('btnTestLlm').addEventListener('click', async () => {
  setStatus('llmStatus', 'Testing…');
  try {
    await window.api.llm.test(readLlm());
    setStatus('llmStatus', 'LLM OK ✓');
  } catch (e) {
    setStatus('llmStatus', e.message, true);
  }
});

// ---- step 3: embeddings ---------------------------------------------
document.getElementById('btnTestEmb').addEventListener('click', async () => {
  setStatus('embStatus', 'Testing…');
  try {
    const { dimensions } = await window.api.emb.test(readLlm(), readEmb());
    setStatus('embStatus', `Embeddings OK — ${dimensions} dimensions ✓`);
  } catch (e) {
    setStatus('embStatus', e.message, true);
  }
});

// ---- step 4: GitHub --------------------------------------------------
// Classic PAT, scopes pre-checked — "repo + read:org" as a live link instead
// of a hint the user has to decode while creating the token in another tab.
const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo%2Cread%3Aorg&description=PR%20Review%20Agent';

document.getElementById('btnTokenHelp').addEventListener('click', () =>
  window.api.shell.open(TOKEN_URL)
);

let lastVerifiedToken = null;

/** Verifies the token and, in passing, learns the account login — exactly
 *  what step 5 needs. Wired to the button and to blur, so the backfill
 *  username is already filled in by the time the user scrolls to it. */
async function verifyGithub() {
  const token = document.getElementById('githubToken').value.trim();
  if (!token) {
    setStatus('ghStatus', 'Paste a personal access token first.', true);
    return null;
  }
  setStatus('ghStatus', 'Verifying…');
  try {
    const { login } = await window.api.github.verify(token);
    lastVerifiedToken = token;
    setStatus('ghStatus', `Token OK — logged in as ${login}`);
    const username = document.getElementById('backfillUsername');
    if (!username.value.trim()) username.value = login;
    return login;
  } catch (e) {
    setStatus('ghStatus', e.message, true);
    return null;
  }
}

document.getElementById('btnTestGh').addEventListener('click', verifyGithub);
document.getElementById('githubToken').addEventListener('change', () => {
  const token = document.getElementById('githubToken').value.trim();
  if (token && token !== lastVerifiedToken) verifyGithub();
});

/** Pull Requests is the default screen, so it has to say what's missing
 *  rather than failing silently on Load — and show live counters, since
 *  this screen is what the app opens on. */
function updateSetupNotice() {
  const el = document.getElementById('prsNotice');
  if (el) el.style.display = currentReviewerId ? 'none' : 'block';
  loadStats();
}

/** Fill the status strip. Best-effort by design: a stats failure must
 *  never block the screen it is decorating, so any error just leaves the
 *  em dashes in place. */
async function loadStats() {
  try {
    const [stats, cfg] = await Promise.all([
      window.api.stats.overview(currentReviewerId),
      window.api.config.get(),
    ]);
    setStat('statReviewer', currentReviewerId || 'not set', currentReviewerId);
    // Number only — the label already says "Corpus"; "342 comments" clipped.
    setStat('statCorpus', String(stats.comments), stats.comments > 0);
    setStat('statSessions', String(stats.sessions), stats.sessions > 0);
    setStat('statFeedback', String(stats.feedback), stats.feedback > 0);
    const model = (cfg.llm && cfg.llm.model) || '—';
    setStat('statModel', model, Boolean(cfg.llm && cfg.llm.model));
  } catch (e) {
    /* decorative only */
  }
}

function setStat(id, text, highlight = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('accent', Boolean(highlight));
}

document.getElementById('btnGoSetup').addEventListener('click', () => {
  document.querySelector('[data-tab="setup"]').click();
});

async function refreshReviewerList() {
  const sel = document.getElementById('reviewerList');
  if (!sel) return;
  const keep = sel.value;
  try {
    const reviewers = await window.api.reviewer.list();
    sel.innerHTML = '';
    if (!reviewers.length) {
      sel.innerHTML = '<option value="">(none yet)</option>';
      return;
    }
    reviewers.forEach((r) => {
      const o = document.createElement('option');
      o.value = r.id;
      o.dataset.displayName = r.display_name || '';
      o.textContent = r.display_name && r.display_name !== r.id ? `${r.id} — ${r.display_name}` : r.id;
      sel.appendChild(o);
    });
    if (keep) sel.value = keep;
  } catch (e) {
    sel.innerHTML = '<option value="">(error loading)</option>';
  }
}
refreshReviewerList();

// Choosing an existing reviewer loads it as the active one.
document.getElementById('reviewerList').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id) return;
  const displayName = e.target.selectedOptions[0]?.dataset.displayName || '';
  document.getElementById('reviewerId').value = id;
  document.getElementById('displayName').value = displayName;
  await window.api.config.set({ reviewerId: id });
  currentReviewerId = id;
  setStatus('reviewerStatus', `Loaded reviewer "${id}".`);
  updateSetupNotice();
  refreshSessions();
});

document.getElementById('btnCreateReviewer').addEventListener('click', async () => {
  const id = document.getElementById('reviewerId').value.trim();
  const displayName = document.getElementById('displayName').value.trim();
  if (!id) return setStatus('reviewerStatus', 'Enter a reviewer ID first.', true);
  await window.api.reviewer.create(id, displayName);
  await window.api.config.set({ reviewerId: id });
  currentReviewerId = id;
  setStatus('reviewerStatus', `Saved reviewer "${id}".`);
  updateSetupNotice();
  refreshReviewerList();
  refreshSessions();
});

document.getElementById('btnSaveConfig').addEventListener('click', async () => {
  await window.api.config.set({
    llm: readLlm(),
    embeddings: readEmb(),
    githubToken: document.getElementById('githubToken').value,
    repos: document.getElementById('repos').value.split(',').map((s) => s.trim()).filter(Boolean),
  });
  setStatus('configStatus', 'Settings saved.');
});

document.getElementById('btnBackfill').addEventListener('click', async () => {
  const username = document.getElementById('backfillUsername').value.trim();
  const repos = document.getElementById('repos').value.split(',').map((s) => s.trim()).filter(Boolean);
  const log = document.getElementById('backfillLog');
  log.textContent = '';
  if (!currentReviewerId) { log.textContent = 'Save a reviewer first.'; return; }
  if (!username || repos.length === 0) { log.textContent = 'Need a username and at least one repo.'; return; }

  window.api.backfill.onProgress((msg) => { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; });

  try {
    const result = await window.api.backfill.run(currentReviewerId, username, repos);
    log.textContent += `\nFinished: ${JSON.stringify(result)}\n`;
    loadStats(); // corpus count just changed — refresh the dashboard strip
  } catch (e) {
    log.textContent += `\nError: ${e.message}\n`;
  }
});

function setStatus(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ---- PRs tab -------------------------------------------------------

document.getElementById('btnLoadPRs').addEventListener('click', async () => {
  const repo = document.getElementById('prsRepo').value.trim();
  currentRepo = repo;
  const list = document.getElementById('prList');
  // Shimmer rows in the shape of real cards while the request is in flight.
  list.innerHTML = '<li class="pr-item skeleton"></li>'.repeat(3);
  showEmptyState(null);
  try {
    const prs = await window.api.prs.listOpen(repo);
    list.innerHTML = '';
    if (prs.length === 0) {
      showEmptyState('No open pull requests', `${repo || 'This repo'} has nothing open right now.`);
      return;
    }
    prs.forEach((pr, i) => {
      const li = document.createElement('li');
      li.className = 'pr-item';
      // Staggered rise-in (see .pr-list > * animation-delay).
      li.style.setProperty('--i', i);
      li.innerHTML = `<span>#${pr.number} — ${escapeHtml(pr.title)}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Review';
      btn.addEventListener('click', () => runReviewFor(repo, pr.number));
      li.appendChild(btn);
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = `<li>Error: ${escapeHtml(e.message)}</li>`;
    showEmptyState(null);
  }
});

/** null restores the default "enter a repo" prompt and keeps it hidden. */
function showEmptyState(title, body) {
  const el = document.getElementById('prsEmpty');
  if (!el) return;
  if (!title) { el.style.display = 'none'; return; }
  el.querySelector('strong').textContent = title;
  const bodyEl = el.querySelector('.empty-body');
  if (bodyEl) bodyEl.textContent = body || '';
  el.style.display = 'block';
}

let reviewInFlight = false;
let lastFailedReview = null;

async function runReviewFor(repo, prNumber) {
  if (!currentReviewerId) { alert('Save a reviewer in Setup first.'); return; }
  if (reviewInFlight) return;
  reviewInFlight = true;
  document.querySelector('[data-tab="review"]').click();
  document.getElementById('draftList').innerHTML = '';
  showWarning(null);
  showReviewError(null);
  showReviewProgress(true);
  currentRepo = repo;
  currentPrNumber = prNumber;

  try {
    const { sessionId, drafts, warning } = await window.api.review.run(currentReviewerId, repo, prNumber);
    currentSessionId = sessionId;
    lastFailedReview = null;
    showWarning(warning);
    renderDrafts(drafts);
    refreshSessions();
    loadStats(); // a new session exists now — refresh the dashboard strip
  } catch (e) {
    lastFailedReview = { repo, prNumber };
    showReviewError(e);
  } finally {
    showReviewProgress(false);
    reviewInFlight = false;
  }
}

function showReviewProgress(show) {
  document.getElementById('reviewProgress').style.display = show ? 'flex' : 'none';
  document.getElementById('reviewSkeletons').style.display = show ? 'grid' : 'none';
}

/** Fatal pipeline failure (LLM 503/429 load spikes, GitHub auth, bad diff...):
 *  show the real error minus Electron's IPC prefix, flag the transient
 *  provider case, and offer a retry of the exact review that failed. */
function showReviewError(e) {
  const box = document.getElementById('reviewError');
  if (!e) { box.style.display = 'none'; return; }
  const clean = (e.message || String(e))
    .replace(/^Error invoking remote method 'review:run':\s*/, '');
  document.getElementById('reviewErrorMsg').textContent = clean;
  const hint = document.getElementById('reviewErrorHint');
  const transient = /\b(429|503|529)\b|high demand|overloaded|temporar|try again later|rate.?limit/i.test(clean);
  hint.textContent = transient
    ? 'The model provider looks briefly overloaded — wait a few seconds, then retry.'
    : '';
  hint.style.display = transient ? 'block' : 'none';
  box.style.display = 'block';
}

document.getElementById('btnRetryReview').addEventListener('click', () => {
  if (lastFailedReview) runReviewFor(lastFailedReview.repo, lastFailedReview.prNumber);
});

/** Non-fatal pipeline problem (e.g. no embeddings provider configured). */
function showWarning(msg) {
  const el = document.getElementById('reviewWarning');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// ---- Past reviews ----------------------------------------------------

async function refreshSessions() {
  const select = document.getElementById('sessionSelect');
  if (!select) return;
  if (!currentReviewerId) {
    select.innerHTML = '<option value="">(save a reviewer in Setup first)</option>';
    return;
  }
  try {
    lastSessions = await window.api.review.sessions(currentReviewerId);
  } catch (e) {
    lastSessions = [];
    select.innerHTML = `<option value="">(error: ${escapeHtml(e.message)})</option>`;
    return;
  }

  select.innerHTML = '';
  if (lastSessions.length === 0) {
    select.innerHTML = '<option value="">(no reviews yet)</option>';
    return;
  }
  lastSessions.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    const when = (s.created_at || '').replace('T', ' ').slice(0, 16);
    opt.textContent = `#${s.id} — ${s.repo}#${s.pr_number} · ${s.status} · ${when}`;
    select.appendChild(opt);
  });
  if (currentSessionId) select.value = String(currentSessionId);
}

document.getElementById('btnLoadSession').addEventListener('click', async () => {
  const sid = Number(document.getElementById('sessionSelect').value);
  if (!sid) return;
  const session = lastSessions.find((s) => s.id === sid);
  if (!session) { alert('Session not found — refresh the list.'); return; }

  currentSessionId = session.id;
  currentRepo = session.repo;
  currentPrNumber = session.pr_number;
  showWarning(null);

  try {
    const drafts = await window.api.review.drafts(session.id);
    renderDrafts(drafts);
  } catch (e) {
    document.getElementById('draftList').innerHTML =
      `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
  }
});

// ---- Review tab -------------------------------------------------------

/**
 * Build one draft card. Accepts either a fresh pipeline result (has `text`,
 * no `status`) or a DB row loaded from a past session (`agent_text` /
 * `human_text` + `status`), so both render identically.
 */
function createDraftCard(d) {
  const card = document.createElement('div');
  card.className = 'draft-card';
  card.dataset.draftId = d.id;

  const body = d.human_text ?? d.agent_text ?? d.text ?? '';
  const resolved = Boolean(d.status) && d.status !== 'pending';
  // Whitelist the severity so it can't inject a class name — the model
  // chooses this string.
  const severity = ['blocking', 'nit', 'question'].includes(d.severity) ? d.severity : 'note';
  const loc = `${d.file_path || 'no file'}${d.line ? ':' + d.line : ''}`;
  const category = d.category || 'uncategorized';

  card.innerHTML = `
    <div class="meta">
      <span class="badge ${severity}">${escapeHtml(severity)}</span>
      ${escapeHtml(loc)} — ${escapeHtml(category)}${resolved ? ` · ${escapeHtml(d.status)}` : ''}
    </div>
    <textarea ${resolved ? 'readonly' : ''}>${escapeHtml(body)}</textarea>
    ${
      resolved
        ? ''
        : `<div class="actions">
      <label class="delta-label" title="Used for Save edit / Reject. Accept always logs as approved_as_is.">Type
        <select class="delta-select">
          <option value="tone">Tone/phrasing</option>
          <option value="wrong_content">Wrong issue</option>
          <option value="false_positive">Wouldn't flag</option>
        </select>
      </label>
      <button data-action="accept">Accept</button>
      <button data-action="edit">Save edit</button>
      <button data-action="reject">Reject</button>
    </div>`
    }
  `;

  if (!resolved) {
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const textarea = card.querySelector('textarea');
        const deltaType = card.querySelector('.delta-select').value;
        try {
          await window.api.review.resolveDraft(
            d.id,
            currentReviewerId,
            action,
            action === 'edit' ? textarea.value : undefined,
            deltaType
          );
        } catch (e) {
          alert(`Failed: ${e.message}`);
          return;
        }
        card.style.opacity = 0.5;
        card.querySelectorAll('button, select').forEach((el) => (el.disabled = true));
        textarea.readOnly = true;
      });
    });
  }

  return card;
}

function renderDrafts(drafts) {
  const container = document.getElementById('draftList');
  const submitBtn = document.getElementById('btnSubmitToGitHub');

  if (!drafts || drafts.length === 0) {
    container.innerHTML = '<p data-empty-msg>No issues surfaced for this PR — clean review.</p>';
    submitBtn.style.display = 'none';
    return;
  }

  container.innerHTML = '';
  drafts.forEach((d) => container.appendChild(createDraftCard(d)));
  submitBtn.style.display = 'inline-block';
}

/** Append a single card without disturbing edits in progress on the others. */
function appendDraftCard(d) {
  const container = document.getElementById('draftList');
  const placeholder = container.querySelector('[data-empty-msg]');
  if (placeholder) placeholder.remove();
  container.appendChild(createDraftCard(d));
}

// ---- Add a comment the agent missed -------------------------------

document.getElementById('btnAddHuman').addEventListener('click', async () => {
  if (!currentReviewerId) { alert('Save a reviewer in Setup first.'); return; }
  if (!currentSessionId) {
    setStatus('hcStatus', 'Run a review first — comments attach to the current session.', true);
    return;
  }
  const text = document.getElementById('hcText').value.trim();
  if (!text) { setStatus('hcStatus', 'Enter the comment text.', true); return; }

  try {
    const draft = await window.api.review.addHumanComment(
      currentSessionId,
      currentReviewerId,
      document.getElementById('hcFile').value,
      document.getElementById('hcLine').value,
      text,
      document.getElementById('hcCategory').value
    );
    document.getElementById('hcText').value = '';
    setStatus('hcStatus', 'Added — logged as a missed_issue correction.');
    appendDraftCard(draft);
    document.getElementById('btnSubmitToGitHub').style.display = 'inline-block';
  } catch (e) {
    setStatus('hcStatus', e.message, true);
  }
});

// ---- Submit to GitHub -------------------------------------------

document.getElementById('btnSubmitToGitHub').addEventListener('click', async () => {
  if (!currentSessionId) return;
  const drafts = await window.api.review.drafts(currentSessionId);
  const accepted = drafts
    .filter((d) => SUBMITTABLE_STATUSES.includes(d.status))
    .map((d) => ({ file_path: d.file_path, line: d.line, text: d.human_text || d.agent_text }));

  if (accepted.length === 0) { alert('No accepted/edited comments to submit.'); return; }

  // Inline review comments need a path and a line that exists in the diff,
  // or GitHub rejects the whole request with a 422.
  const submittable = accepted.filter((c) => c.file_path && c.line);
  const dropped = accepted.length - submittable.length;
  if (dropped > 0) {
    if (submittable.length === 0) {
      alert('Nothing to submit — every accepted comment is missing a file path or line.');
      return;
    }
    if (!confirm(`${dropped} comment(s) have no file/line and GitHub will reject them.\n\nSubmit the other ${submittable.length}?`)) return;
  }

  try {
    const res = await window.api.review.submitToGitHub(currentRepo, currentPrNumber, submittable, currentSessionId);
    if (res && res.deferred > 0) {
      alert(`Posted as a pending review — ${res.anchored} comment(s) inline, `
        + `${res.deferred} added to the review body (their lines aren't in the diff). `
        + 'Open the PR to submit it.');
    } else {
      alert('Posted as a pending review on GitHub — open the PR to submit it.');
    }
    await refreshSessions();
  } catch (e) {
    alert(`Failed to submit: ${e.message}`);
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---- Profile tab -------------------------------------------------------

document.getElementById('btnLoadProfile').addEventListener('click', async () => {
  if (!currentReviewerId) { alert('Save a reviewer in Setup first.'); return; }
  const profile = await window.api.profile.get(currentReviewerId);
  document.getElementById('profileView').textContent = JSON.stringify(profile, null, 2);
});

document.getElementById('btnPropose').addEventListener('click', async () => {
  if (!currentReviewerId) { alert('Save a reviewer in Setup first.'); return; }
  const diffContainer = document.getElementById('consolidationDiff');
  diffContainer.innerHTML = '<p>Analyzing recent feedback...</p>';

  try {
    const { proposedProfile, changes, correctionIds, message } =
      await window.api.consolidate.propose(currentReviewerId);

    if (message) { diffContainer.innerHTML = `<p>${escapeHtml(message)}</p>`; return; }

    diffContainer.innerHTML = '';
    changes.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'diff-change';
      div.textContent = JSON.stringify(c, null, 2);
      diffContainer.appendChild(div);
    });
    if (changes.length === 0) {
      diffContainer.innerHTML = '<p>The model proposed no changes to your profile.</p>';
    }

    const approveBtn = document.createElement('button');
    approveBtn.className = 'primary';
    approveBtn.textContent = 'Approve and apply these changes';
    approveBtn.addEventListener('click', async () => {
      await window.api.consolidate.apply(proposedProfile, correctionIds);
      diffContainer.innerHTML = '<p>Applied.</p>';
      document.getElementById('profileView').textContent = JSON.stringify(proposedProfile, null, 2);
    });
    diffContainer.appendChild(approveBtn);
  } catch (e) {
    diffContainer.innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
  }
});
