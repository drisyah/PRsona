/**
 * 1) migrate() must work on the user's existing database (old schema,
 *    possibly missing gh_comment_id) and must be idempotent.
 * 2) Static wiring audit: IPC handler names, preload API surface, and every
 *    DOM id the renderer references.
 * 3) The "glass + aurora" theme contract: hero/status-strip classes styled,
 *    dashboard IPC wired end to end, fonts self-hosted.
 *
 *   npm test   (or: node test/wiring.test.js)
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
const read = (p) => fs.readFileSync(R(p), 'utf-8');

// ---------------------------------------------------------------- 1. migrate
section('1. migrate() on a real, pre-existing database');

const REAL_DB = path.join(
  process.env.HOME, 'Library/Application Support/pr-review-agent/pr_review_agent.db'
);
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'prra-migrate-'));

if (fs.existsSync(REAL_DB)) {
  // Work on a COPY — the live database is never touched by these tests.
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(REAL_DB + suffix)) {
      fs.copyFileSync(REAL_DB + suffix, path.join(tmp, 'pr_review_agent.db' + suffix));
    }
  }
  const dbm = require(R('src/db/db'));
  try {
    dbm.initDb(tmp);
    check('initDb on a copied real DB does not throw', true);
  } catch (e) {
    check('initDb on a copied real DB does not throw', false, e.message);
  }
  // comments.reviewer_id is a real FK — the target reviewer must exist.
  dbm.upsertReviewer('x', 'X');

  try {
    const d = dbm.getDb();
    const dedup = d.prepare(`PRAGMA index_list('comments')`).all()
      .find((i) => i.name === 'idx_comments_dedup');
    check('idx_comments_dedup exists on the real schema', Boolean(dedup));
    check('the dedup index is UNIQUE', dedup && dedup.unique === 1);

    // The exact statement that used to blow up.
    try {
      d.prepare(`INSERT INTO comments (reviewer_id, repo, pr_number, comment_body, gh_comment_id)
                 VALUES ('x','o/r',1,'body',999999)
                 ON CONFLICT (reviewer_id, gh_comment_id) DO NOTHING`).run();
      check('insertComment ON CONFLICT now prepares cleanly', true);
    } catch (e) {
      check('insertComment ON CONFLICT now prepares cleanly', false, e.message);
    }

    // Re-running must be a no-op, not a duplicate-insert.
    const before = d.prepare('SELECT COUNT(*) n FROM comments').get().n;
    d.prepare(`INSERT INTO comments (reviewer_id, repo, pr_number, comment_body, gh_comment_id)
               VALUES ('x','o/r',1,'body',999999)
               ON CONFLICT (reviewer_id, gh_comment_id) DO NOTHING`).run();
    const after = d.prepare('SELECT COUNT(*) n FROM comments').get().n;
    check('duplicate gh_comment_id is ignored (no corpus dilution)',
      after === before, `${before} -> ${after}`);

    // NULL gh_comment_id rows must NOT collide with each other.
    dbm.upsertReviewer('y', 'Y');
    for (let i = 0; i < 3; i++) {
      d.prepare(`INSERT INTO comments (reviewer_id, repo, pr_number, comment_body, gh_comment_id)
                 VALUES ('y','o/r',1,'?',NULL)
                 ON CONFLICT (reviewer_id, gh_comment_id) DO NOTHING`).run();
    }
    const nulls = d.prepare(`SELECT COUNT(*) n FROM comments WHERE gh_comment_id IS NULL`).get().n;
    check('NULL gh_comment_id rows still insert (SQLite distinct-nulls)', nulls === 3, 'got ' + nulls);

    // migrate() runs on every startup — it must be idempotent.
    dbm.initDb(tmp);
    dbm.initDb(tmp);
    check('migrate() is idempotent across restarts', true);
  } catch (e) {
    check('post-migration assertions', false, e.message);
  }
} else {
  console.log('  (no existing DB found — skipping)');
}

// ------------------------------------------------------- 2. IPC wiring audit
section('2. IPC wiring: renderer -> preload -> main');

const mainSrc = read('electron/main.js');
const preloadSrc = read('electron/preload.js');
const rendererSrc = read('renderer/renderer.js');
const htmlSrc = read('renderer/index.html');

const handlers = [...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
const invokes = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);

const missingHandler = invokes.filter((i) => !handlers.includes(i));
const unusedHandler = handlers.filter((h) => !invokes.includes(h));
check('every preload invoke has a main-process handler',
  missingHandler.length === 0, missingHandler.join(', '));
check('every handler is reachable from preload',
  unusedHandler.length === 0, unusedHandler.join(', '));

// renderer call paths vs preload's exposed object
const exposed = {};
const apiBlock = preloadSrc.slice(preloadSrc.indexOf('exposeInMainWorld'));
let group = null;
for (const line of apiBlock.split('\n')) {
  const g = line.match(/^ {2}(\w+):\s*\{$/);
  if (g) { group = g[1]; exposed[group] = []; continue; }
  const m = line.match(/^ {4}(\w+):\s*(\(|async)/);
  if (m && group) exposed[group].push(m[1]);
}

const rendererCalls = [...rendererSrc.matchAll(/window\.api\.(\w+)\.(\w+)\s*\(/g)]
  .map((m) => `${m[1]}.${m[2]}`);
const badCalls = rendererCalls.filter((c) => {
  const [g, m] = c.split('.');
  return !exposed[g] || !exposed[g].includes(m);
});
check('every window.api.* call exists on the exposed object', badCalls.length === 0, badCalls.join(', '));

const unreachable = Object.entries(exposed)
  .flatMap(([g, ms]) => ms.map((m) => `${g}.${m}`))
  .filter((c) => !rendererCalls.includes(c));
if (unreachable.length) console.log('  note — exposed but never called: ' + unreachable.join(', '));

// ---------------------------------------------------- 3. DOM id wiring audit
section('3. every DOM id the renderer touches exists in index.html');

const htmlIds = new Set([...htmlSrc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = [...new Set([...rendererSrc.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
const statusIds = [...new Set([...rendererSrc.matchAll(/setStatus\('([^']+)'/g)].map((m) => m[1]))];
const allUsed = [...new Set([...usedIds, ...statusIds])];
const missingIds = allUsed.filter((id) => !htmlIds.has(id));
check('all renderer-referenced ids exist in the HTML', missingIds.length === 0, missingIds.join(', '));

const declaredButtons = [...htmlSrc.matchAll(/<button id="([^"]+)"/g)].map((m) => m[1]);
const unboundButtons = declaredButtons.filter((id) => !rendererSrc.includes(`'${id}'`));
check('every <button id> has a renderer reference', unboundButtons.length === 0, unboundButtons.join(', '));

// tab panels: every data-tab needs a matching section id
const tabs = [...htmlSrc.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const panelsMissing = tabs.filter((t) => !htmlIds.has(`tab-${t}`));
check('every data-tab has a tab-<name> section', panelsMissing.length === 0, panelsMissing.join(', '));

// ------------------------------------------------- 4. CSS classes used by new UI
section('4. classes introduced by the fixes have styles');
const cssSrc = read('renderer/styles.css');
for (const cls of [
  'warning', 'delta-label', 'delta-select', 'token-row', 'step-num', 'setup-step',
  // "glass + aurora" theme — the dashboard/hero surface the app opens on
  'hero', 'status-strip', 'stat', 'empty-state', 'skeleton',
]) {
  check(`.${cls} styled`, cssSrc.includes(`.${cls}`));
}

// ------------------------------------------- 5. Dashboard status strip wiring
section('5. Pull Requests dashboard status strip');
for (const [handler, method] of [['stats:overview', 'stats.overview']]) {
  check(`${handler} declared in main`, mainSrc.includes(`ipcMain.handle('${handler}'`));
  check(`${method} called from renderer`, rendererSrc.includes(`window.api.${method}`));
}
// The strip has to refresh whenever the numbers can change: reviewer load,
// backfill finishing, and a new review session.
check('loadStats refreshes on reviewer change',
  (rendererSrc.match(/loadStats\(\)/g) || []).length >= 3);
for (const id of ['statReviewer', 'statCorpus', 'statSessions', 'statFeedback', 'statModel', 'prsEmpty']) {
  check(`#${id} exists in the HTML`, htmlIds.has(id));
}
// Fonts are self-hosted (file:// app — a CDN link would break offline).
check('fonts linked locally, not from a CDN',
  htmlSrc.includes('href="fonts/fonts.css"') && !/https?:\/\/fonts\./.test(htmlSrc));
check('font files shipped', fs.existsSync(R('renderer/fonts/SpaceGrotesk-var.woff2'))
  && fs.existsSync(R('renderer/fonts/JetBrainsMono-var.woff2')));

// The userData path must stay pinned: Electron's package.json derivation is
// launch-mode-sensitive, and productName is now display-only ("PRsona").
check('userData path pinned to pr-review-agent (rename-safe)',
  mainSrc.includes("setPath('userData'") && mainSrc.includes("'pr-review-agent'"));
check('productName is PRsona, name kept for data continuity',
  read('package.json').includes('"productName": "PRsona"')
  && read('package.json').includes('"name": "pr-review-agent"'));

// ------------------------------------------- 6. Setup self-test wiring
section('6. per-step self-tests are wired end to end');
// The old single test button read the SAVED config; make sure it stayed dead
// rather than being left half-referenced alongside the new per-step tests.
// (main.js still *mentions* the old name in a comment explaining why the
// new tests read the form instead — so match the declaration, not the text.)
check('config:testConnection handler removed (main)',
  !mainSrc.includes("ipcMain.handle('config:testConnection'"));
check('config:testConnection invoke removed (preload)',
  !preloadSrc.includes("invoke('config:testConnection'"));
check('config.testConnection not called (renderer)', !rendererSrc.includes('config.testConnection'));
for (const [handler, method] of [
  ['llm:test', 'llm.test'],
  ['emb:test', 'emb.test'],
  ['github:verify', 'github.verify'],
  ['shell:open', 'shell.open'],
]) {
  check(`${handler} declared in main`, mainSrc.includes(`ipcMain.handle('${handler}'`));
  check(`${method} called from renderer`, rendererSrc.includes(`window.api.${method}`));
}
// Tests must not silently depend on persisted state.
check('llm:test builds providers from the passed form values',
  mainSrc.includes('function formProviders'));
// The githubToken deep-link has to stay https-only.
const shellHandler = (mainSrc.match(/ipcMain\.handle\('shell:open'[\s\S]*?\n\}\);/) || [''])[0];
check('shell:open refuses non-https URLs', shellHandler.includes("startsWith('https://')"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
