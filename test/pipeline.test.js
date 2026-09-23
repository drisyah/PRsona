/**
 * End-to-end verification of the review pipeline against a throwaway DB.
 * Only the LLM/network edges are mocked — everything else is the real code.
 *
 *   npm test   (or: node test/pipeline.test.js)
 */
const path = require('path');
const fs = require('fs');
const PROJECT = path.resolve(__dirname, '..');
const R = (p) => path.join(PROJECT, p);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const section = (t) => console.log('\n== ' + t + ' ==');

(async () => {
  // ---- fresh temp DB -------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'prra-'));
  const dbm = require(R('src/db/db'));
  dbm.initDb(tmp);
  const profilesDir = path.join(tmp, 'profiles');

  dbm.upsertReviewer('alice', 'Alice Chen');

  // ---- seed: 1 STYLE + 29 SEC, all uncategorized ---------------------
  const mkComment = (id, body) => ({
    reviewer_id: 'alice', repo: 'o/r', pr_number: 1,
    file_path: 'src/a.js', diff_hunk: '@@ -1 +1 @@',
    comment_body: body, review_state: null, category: null, severity: null,
    source: 'backfill', gh_comment_id: id, created_at: '2026-01-01T00:00:00Z',
  });
  dbm.insertComment(mkComment(1, 'STYLE marker: rename this for clarity'));
  for (let i = 2; i <= 30; i++) dbm.insertComment(mkComment(i, 'SEC marker: validates input'));

  section('1. calibration stats actually get populated');
  const before = dbm.categoryStats('alice');
  check('NULL-category rows are not counted (total 0)', before.total === 0, 'got ' + before.total);
  check('by_category empty before categorization', Object.keys(before.by_category).length === 0);

  // ---- categorization pass ------------------------------------------
  const categorize = require(R('src/pipeline/categorize'));
  let calls = 0;
  const mockLLM = {
    complete: async (system, messages) => {
      calls += 1;
      if (calls === 2) return 'sorry, I cannot answer that'; // unparseable -> batch left NULL
      const items = JSON.parse(messages[0].content);
      return JSON.stringify(items.map((it) => ({
        id: it.id,
        category: /SEC marker/.test(it.comment) ? 'security'
                : /STYLE marker/.test(it.comment) ? 'style' : 'uncategorized',
      })));
    },
  };

  const run1 = await categorize.categorizeComments({
    completion: mockLLM, reviewerId: 'alice', onProgress: () => {},
  });
  check('batch 1 labeled', run1.categorized === 25, 'got ' + run1.categorized);
  check('unparseable batch left NULL for retry', run1.remaining === 5, 'got ' + run1.remaining);

  const run2 = await categorize.categorizeComments({
    completion: mockLLM, reviewerId: 'alice', onProgress: () => {},
  });
  check('re-run only picks up the NULL rows', run2.total === 5, 'got ' + run2.total);
  check('re-run finishes the job', run2.remaining === 0, 'got ' + run2.remaining);

  const stats = dbm.categoryStats('alice');
  check('all 30 comments categorized', stats.total === 30, 'got ' + stats.total);
  check('style share is small (< 0.05)', stats.by_category.style > 0 && stats.by_category.style < 0.05,
    'got ' + stats.by_category.style);
  check('security share is large (> 0.9)', stats.by_category.security > 0.9,
    'got ' + stats.by_category.security);

  // ---- calibration ---------------------------------------------------
  section('2. calibration filters (was a no-op before)');
  const { calibrate } = require(R('src/pipeline/calibrate'));
  const cat = (severity, category) => ({ severity, category, file_path: 'a.js', line: 1, issue: 'x' });

  check('low-share category nit is DROPPED', calibrate([cat('nit', 'style')], stats).length === 0);
  check('same category as blocking is KEPT', calibrate([cat('blocking', 'style')], stats).length === 1);
  check('high-share category kept', calibrate([cat('nit', 'security')], stats).length === 1);
  check('unknown category kept (doorway for new categories)',
    calibrate([cat('nit', 'architecture')], stats).length === 1);
  check('empty stats keeps everything rather than dropping everything',
    calibrate([cat('nit', 'style'), cat('blocking', 'x')], { total: 0, by_category: {} }).length === 2);

  // ---- full review pipeline -----------------------------------------
  section('3. review pipeline: vocabulary + calibration + degrade path');
  const ps = require(R('src/profile/profileStore'));
  const profile = ps.loadProfile(profilesDir, 'alice');

  let analysisPromptText = '';
  const seenBudgets = [];
  const makeProviders = () => ({
    completion: {
      complete: async (system, messages, opts) => {
        seenBudgets.push({ analysis: system.startsWith('You are the analysis stage'), maxTokens: opts && opts.maxTokens });
        if (system.startsWith('You are the analysis stage')) {
          analysisPromptText = system;
          return JSON.stringify([
            { file_path: 'a.js', line: 10, category: 'styel', severity: 'nit', issue: 'typo in category' },
            { file_path: 'a.js', line: 20, category: 'style', severity: 'nit', issue: 'formatting nit' },
            { file_path: 'b.js', line: 30, category: 'security', severity: 'blocking', issue: 'sql injection' },
          ]);
        }
        // style pass: echo the calibrated list back as phrased comments
        const items = JSON.parse(messages[0].content);
        return JSON.stringify(items.map((i) => ({
          file_path: i.file_path, line: i.line, category: i.category,
          severity: i.severity, text: `[${i.category}] ${i.issue}`,
        })));
      },
    },
    embeddings: { embed: async () => [1, 0, 0], supportsEmbeddings: true },
    embeddingsError: null,
  });

  const { runReview } = require(R('src/pipeline/review'));
  const diff = '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n';

  const res1 = await runReview({
    providers: makeProviders(), profile, reviewerId: 'alice',
    repo: 'o/r', prNumber: 7, diffText: diff, strictness: 0.3,
  });

  check('analysis prompt carries the fixed vocabulary',
    analysisPromptText.includes('- security') && analysisPromptText.includes('- uncategorized'));
  check('no warning when embeddings configured', res1.warning === null);
  check('2 of 3 issues survive calibration', res1.drafts.length === 2, 'got ' + res1.drafts.length);
  const cats = res1.drafts.map((d) => d.category).sort();
  check('off-vocabulary "styel" normalized to uncategorized', cats.includes('uncategorized'), cats.join(','));
  check('low-share style nit filtered out', !cats.includes('style'), cats.join(','));
  check('blocking security issue kept', cats.includes('security'), cats.join(','));
  check('analysis call declares an explicit token budget (Gemini truncation fix)',
    seenBudgets.some((b) => b.analysis && b.maxTokens >= 6000), JSON.stringify(seenBudgets));
  check('style call declares an explicit token budget',
    seenBudgets.some((b) => !b.analysis && b.maxTokens >= 4000), JSON.stringify(seenBudgets));

  // degrade path: no usable embeddings provider
  const noEmb = makeProviders();
  noEmb.embeddingsError = 'Set a separate Embeddings provider in Setup — backfill needs it.';
  const res2 = await runReview({
    providers: noEmb, profile, reviewerId: 'alice',
    repo: 'o/r', prNumber: 8, diffText: diff, strictness: 0.3,
  });
  check('missing embeddings degrades with a warning instead of throwing',
    typeof res2.warning === 'string' && res2.warning.includes('Style pass runs on the profile only'),
    JSON.stringify(res2.warning));
  check('drafts still produced on the degrade path', res2.drafts.length === 2, 'got ' + res2.drafts.length);

  // ---- session submit + human-added comment --------------------------
  section('4. session status + missed_issue correction');
  check('new session starts as draft',
    dbm.getDb().prepare('SELECT status FROM review_sessions WHERE id=?').get(res1.sessionId).status === 'draft');

  dbm.markSessionSubmitted(res1.sessionId);
  const srow = dbm.getDb().prepare('SELECT status, submitted_at FROM review_sessions WHERE id=?').get(res1.sessionId);
  check('markSessionSubmitted sets status=submitted', srow.status === 'submitted');
  check('markSessionSubmitted sets submitted_at', Boolean(srow.submitted_at));

  const humanDraftId = dbm.insertDraftComment({
    session_id: res1.sessionId, file_path: 'src/a.js', line: 99,
    category: 'testing', severity: null, agent_text: '',
  });
  dbm.updateDraftStatus(humanDraftId, 'added', 'This path has no test coverage.');
  const corrId = dbm.insertCorrection({
    reviewer_id: 'alice', draft_comment_id: humanDraftId, agent_draft: '',
    human_final: 'This path has no test coverage.', delta_type: 'missed_issue',
  });
  const corr = dbm.getDb().prepare('SELECT * FROM corrections WHERE id=?').get(corrId);
  check('missed_issue correction persisted', corr.delta_type === 'missed_issue');
  const hd = dbm.getDb().prepare('SELECT status, human_text FROM draft_comments WHERE id=?').get(humanDraftId);
  check('human-added draft stored with status=added + human_text',
    hd.status === 'added' && hd.human_text.length > 0);

  // ---- delta type reachability ---------------------------------------
  section('5. all five delta types are reachable');
  const { pickDeltaType, DELTA_TYPES } = require(R('src/pipeline/deltaTypes'));
  check('accept -> approved_as_is (ignores select)', pickDeltaType('accept', 'tone') === 'approved_as_is');
  check('edit keeps tone', pickDeltaType('edit', 'tone') === 'tone');
  check('edit can be wrong_content', pickDeltaType('edit', 'wrong_content') === 'wrong_content');
  check('reject falls back off an invalid tone', pickDeltaType('reject', 'tone') === 'false_positive');
  check('reject can be wrong_content', pickDeltaType('reject', 'wrong_content') === 'wrong_content');
  const reachable = new Set([...Object.values(DELTA_TYPES).flat(), 'missed_issue']);
  check('schema set covered: tone/wrong_content/false_positive/approved_as_is/missed_issue',
    reachable.size === 5, [...reachable].join(','));

  // ---- profile counter ------------------------------------------------
  section('6. pending_review_count_since_last_consolidation');
  const prof = ps.emptyProfile('alice', 'Alice Chen');
  ps.saveProfile(profilesDir, prof);
  const versionAfterSave = prof.version;
  ps.incrementPendingCount(profilesDir, 'alice');
  ps.incrementPendingCount(profilesDir, 'alice');
  ps.incrementPendingCount(profilesDir, 'alice');
  const reloaded = ps.loadProfile(profilesDir, 'alice');
  check('counter incremented to 3',
    reloaded.pending_review_count_since_last_consolidation === 3,
    'got ' + reloaded.pending_review_count_since_last_consolidation);
  check('counter bumps do NOT consume a profile version',
    reloaded.version === versionAfterSave, `v${reloaded.version} vs v${versionAfterSave}`);
  check('counter on a reviewer with no profile returns null',
    ps.incrementPendingCount(profilesDir, 'nobody') === null);

  // ---- GitHub pending review ------------------------------------------
  section('7. GitHub POST creates a PENDING review');
  const { GitHubClient } = require(R('src/github/client'));
  let captured = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ id: 42 }) };
  };
  try {
    await new GitHubClient('tok').createPendingReview('o/r', 7, [
      { file_path: 'src/a.js', line: 10, text: 'hello there' },
    ]);
  } finally {
    global.fetch = realFetch;
  }
  check('POSTs to the reviews endpoint',
    captured && captured.url === 'https://api.github.com/repos/o/r/pulls/7/reviews',
    captured && captured.url);
  check('event field is OMITTED (the only way to get PENDING)',
    captured && !('event' in captured.body), captured && JSON.stringify(captured.body));
  check('inline comments carry path + line + body',
    captured && captured.body.comments[0].path === 'src/a.js'
    && captured.body.comments[0].line === 10
    && captured.body.comments[0].body === 'hello there');

  // ---- setup self-tests ---------------------------------------------
  section('8. setup self-tests: provider resolution + GitHub whoami');
  const { buildProviders } = require(R('src/llm'));

  // llm=anthropic with no embeddings block: emb:test must fail fast with a
  // diagnosis instead of throwing from deep inside embed().
  const anthOnly = buildProviders({
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' },
    embeddings: null,
  });
  check('anthropic-only config fails emb:test with an actionable message',
    typeof anthOnly.embeddingsError === 'string'
      && anthOnly.embeddingsError.includes("can't produce embeddings"),
    anthOnly.embeddingsError);

  const anthEmb = buildProviders({
    llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'k' },
    embeddings: { provider: 'anthropic', model: '', apiKey: 'k' },
  });
  check('explicit anthropic embeddings block names the right fix',
    typeof anthEmb.embeddingsError === 'string'
      && anthEmb.embeddingsError.includes('Anthropic has no embeddings endpoint'),
    anthEmb.embeddingsError);

  const oaiOnly = buildProviders({
    llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'k' },
    embeddings: null,
  });
  check('openai-only config has no embeddingsError (falls back to the LLM)',
    oaiOnly.embeddingsError === null, String(oaiOnly.embeddingsError));
  check('that fallback can actually embed', oaiOnly.embeddings.supportsEmbeddings === true);

  let keyError = '';
  try {
    buildProviders({ llm: { provider: 'anthropic', model: 'x', apiKey: '' }, embeddings: null });
  } catch (e) { keyError = e.message; }
  check('missing API key throws at construction (so llm:test surfaces it)',
    /apiKey/.test(keyError), keyError);

  // whoami: verifies the token and supplies the backfill username, which is
  // the field a self-typed typo silently zeroes out the corpus with.
  let whoami = null;
  global.fetch = async (url, opts) => {
    whoami = { url, auth: opts.headers.authorization };
    return { ok: true, status: 200, json: async () => ({ login: 'alice-dev', name: 'Alice Chen' }) };
  };
  try {
    const u = await new GitHubClient('tok-abc').getUser();
    check('getUser returns the login that auto-fills step 5', u.login === 'alice-dev',
      JSON.stringify(u));
  } finally {
    global.fetch = realFetch;
  }
  check('whoami hits GET /user with the token attached',
    whoami && whoami.url === 'https://api.github.com/user' && whoami.auth === 'Bearer tok-abc',
    whoami && `${whoami.url} ${whoami.auth}`);

  // 9. Gemini thinking counts against max_tokens; a dynamically-thinking
  // model truncated review JSON in production. Pin the effort per model family.
  section('9. Gemini thinking effort pinned (truncated-JSON guard)');
  const { OpenAICompatProvider } = require(R('src/llm/openaiCompatProvider'));
  const sentBodies = [];
  global.fetch = async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[]' } }] }) };
  };
  try {
    await new OpenAICompatProvider({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'gemini-3.6-flash' })
      .complete('s', [{ role: 'user', content: 'hi' }], { maxTokens: 6000 });
    await new OpenAICompatProvider({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'gemini-2.5-flash' })
      .complete('s', [{ role: 'user', content: 'hi' }]);
    await new OpenAICompatProvider({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'gpt-4o' })
      .complete('s', [{ role: 'user', content: 'hi' }]);
  } finally {
    global.fetch = realFetch;
  }
  check('gemini-3.x: effort pinned low and caller budget respected',
    sentBodies[0] && sentBodies[0].reasoning_effort === 'low' && sentBodies[0].max_tokens === 6000,
    JSON.stringify(sentBodies[0]));
  check('gemini-2.5: thinking fully disabled',
    sentBodies[1] && sentBodies[1].reasoning_effort === 'none', JSON.stringify(sentBodies[1]));
  check('non-Gemini endpoints never receive the parameter',
    sentBodies[2] && !('reasoning_effort' in sentBodies[2]), JSON.stringify(sentBodies[2]));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nTEST HARNESS ERROR:', e);
  process.exit(2);
});
