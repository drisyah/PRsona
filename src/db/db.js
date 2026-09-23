const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

/**
 * Opens (or creates) the local SQLite database in the app's userData
 * directory and applies the schema. Idempotent — safe to call once at
 * startup.
 */
function initDb(userDataPath) {
  const dbPath = path.join(userDataPath, 'pr_review_agent.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  migrate(db);

  return db;
}

/**
 * Forward-only migrations for databases created before a column existed.
 * `CREATE TABLE IF NOT EXISTS` won't add columns to a table that's already
 * there, and the dedup index below depends on `gh_comment_id` existing —
 * so check first rather than letting CREATE UNIQUE INDEX fail.
 */
function migrate(db) {
  const commentColumns = db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name);
  if (commentColumns.includes('gh_comment_id')) {
    // The dedup key insertComment relies on. Without this index SQLite
    // rejects `ON CONFLICT (reviewer_id, gh_comment_id)` outright
    // ("ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
    // constraint"), so backfill threw on the first comment and no comment
    // was ever ingested. It lives here rather than in schema.sql because
    // an older database may not have the column yet — schema.sql is exec'd
    // before this runs, and a bare index reference would kill startup.
    //
    // Clear exact duplicates first so a database that somehow already has
    // them can still build the index. NULL gh_comment_id rows are left
    // alone (SQLite treats NULLs as distinct in a unique index anyway).
    db.exec(`
      DELETE FROM comments
        WHERE gh_comment_id IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM comments
             WHERE gh_comment_id IS NOT NULL
             GROUP BY reviewer_id, gh_comment_id
          );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_dedup
        ON comments(reviewer_id, gh_comment_id);
    `);
  }
}

function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first.');
  return db;
}

// ---- Reviewers -------------------------------------------------------

function upsertReviewer(id, displayName) {
  getDb()
    .prepare(
      `INSERT INTO reviewers (id, display_name) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name`
    )
    .run(id, displayName);
}

function listReviewers() {
  return getDb().prepare('SELECT * FROM reviewers ORDER BY created_at').all();
}

// ---- Comments (raw corpus) -------------------------------------------

/**
 * Insert one backfilled comment, skipping it if we've already ingested it.
 * Returns true when a row was actually written.
 *
 * GitHub's comment id is the dedup key — `migrate()` creates the
 * `idx_comments_dedup` unique index that makes the ON CONFLICT clause below
 * valid, and re-running backfill is a no-op for anything already ingested
 * (previously every re-run duplicated the whole corpus, quietly diluting
 * calibration's rate lookup each time).
 */
function insertComment(c) {
  const stmt = getDb().prepare(`
    INSERT INTO comments
      (reviewer_id, repo, pr_number, file_path, diff_hunk, comment_body,
       review_state, category, severity, source, gh_comment_id, created_at)
    VALUES (@reviewer_id, @repo, @pr_number, @file_path, @diff_hunk, @comment_body,
            @review_state, @category, @severity, @source, @gh_comment_id, @created_at)
    ON CONFLICT (reviewer_id, gh_comment_id) DO NOTHING
  `);
  return stmt.run(c).changes > 0;
}

/** Comments the categorization pass hasn't labeled yet. */
function commentsWithoutCategory(reviewerId) {
  return getDb()
    .prepare(
      `SELECT id, file_path, diff_hunk, comment_body FROM comments
       WHERE reviewer_id = ? AND category IS NULL
       ORDER BY id`
    )
    .all(reviewerId);
}

function updateCommentCategory(commentId, category) {
  return getDb()
    .prepare('UPDATE comments SET category = ? WHERE id = ?')
    .run(category, commentId).changes > 0;
}

/**
 * Share of this reviewer's historical comments in each category, computed
 * live from the corpus (0..1 per category, plus `total` for display).
 *
 * This is calibration's input — it is deliberately NOT persisted into the
 * profile, because the corpus is the source of truth, so the numbers can
 * never drift out of sync with what's actually ingested. Only rows with a
 * category are counted, which is why the backfill categorization pass
 * (src/pipeline/categorize.js) has to run for this to be non-empty.
 *
 * (Previously nothing populated this — the function existed but had no
 * callers, which left calibration filtering on an always-empty object and
 * therefore filtering nothing.)
 */
function categoryStats(reviewerId) {
  const rows = getDb()
    .prepare(
      `SELECT category, COUNT(*) AS n FROM comments
       WHERE reviewer_id = ? AND category IS NOT NULL
       GROUP BY category`
    )
    .all(reviewerId);

  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const by_category = {};
  for (const r of rows) by_category[r.category] = total ? r.n / total : 0;

  return { total, by_category };
}

function countComments(reviewerId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE reviewer_id = ?')
    .get(reviewerId).n;
}

function commentsWithoutEmbeddings(reviewerId) {
  return getDb()
    .prepare(
      `SELECT c.* FROM comments c
       LEFT JOIN comment_embeddings e ON e.comment_id = c.id
       WHERE c.reviewer_id = ? AND e.comment_id IS NULL`
    )
    .all(reviewerId);
}

// ---- Embeddings --------------------------------------------------------

function insertEmbedding(commentId, embedding, model) {
  getDb()
    .prepare(
      `INSERT INTO comment_embeddings (comment_id, embedding, model, dims)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id) DO UPDATE SET embedding = excluded.embedding,
         model = excluded.model, dims = excluded.dims`
    )
    .run(commentId, JSON.stringify(embedding), model, embedding.length);
}

function allEmbeddingsForReviewer(reviewerId) {
  return getDb()
    .prepare(
      `SELECT c.id AS comment_id, c.file_path, c.diff_hunk, c.comment_body,
              c.category, c.severity, e.embedding
       FROM comments c
       JOIN comment_embeddings e ON e.comment_id = c.id
       WHERE c.reviewer_id = ?`
    )
    .all(reviewerId)
    .map((row) => ({ ...row, embedding: JSON.parse(row.embedding) }));
}

// ---- Review sessions / draft comments ----------------------------------

function createSession(reviewerId, repo, prNumber) {
  return getDb()
    .prepare(
      `INSERT INTO review_sessions (reviewer_id, repo, pr_number) VALUES (?, ?, ?)`
    )
    .run(reviewerId, repo, prNumber).lastInsertRowid;
}

function insertDraftComment(d) {
  return getDb()
    .prepare(
      `INSERT INTO draft_comments
        (session_id, file_path, line, category, severity, agent_text)
       VALUES (@session_id, @file_path, @line, @category, @severity, @agent_text)`
    )
    .run(d).lastInsertRowid;
}

function draftsForSession(sessionId) {
  return getDb()
    .prepare('SELECT * FROM draft_comments WHERE session_id = ? ORDER BY id')
    .all(sessionId);
}

function updateDraftStatus(draftId, status, humanText) {
  getDb()
    .prepare(
      `UPDATE draft_comments SET status = ?, human_text = ? WHERE id = ?`
    )
    .run(status, humanText ?? null, draftId);
}

function listSessions(reviewerId) {
  return getDb()
    .prepare(
      `SELECT * FROM review_sessions WHERE reviewer_id = ? ORDER BY created_at DESC`
    )
    .all(reviewerId);
}

/** Called after a session's accepted comments were successfully posted to
 *  GitHub as a pending review. Without this the row stayed 'draft' forever
 *  and `submitted_at` was never set. */
function markSessionSubmitted(sessionId) {
  return getDb()
    .prepare(
      `UPDATE review_sessions SET status = 'submitted', submitted_at = datetime('now')
       WHERE id = ?`
    )
    .run(sessionId).changes > 0;
}

// ---- Corrections (feedback log) ----------------------------------------

function insertCorrection(c) {
  return getDb()
    .prepare(
      `INSERT INTO corrections
        (reviewer_id, draft_comment_id, agent_draft, human_final, delta_type)
       VALUES (@reviewer_id, @draft_comment_id, @agent_draft, @human_final, @delta_type)`
    )
    .run(c).lastInsertRowid;
}

function unconsolidatedCorrections(reviewerId) {
  return getDb()
    .prepare(
      `SELECT * FROM corrections WHERE reviewer_id = ? AND consolidated = 0
       ORDER BY created_at`
    )
    .all(reviewerId);
}

function markConsolidated(ids) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb()
    .prepare(`UPDATE corrections SET consolidated = 1 WHERE id IN (${placeholders})`)
    .run(...ids);
}

module.exports = {
  initDb,
  getDb,
  upsertReviewer,
  listReviewers,
  insertComment,
  countComments,
  commentsWithoutCategory,
  updateCommentCategory,
  categoryStats,
  commentsWithoutEmbeddings,
  insertEmbedding,
  allEmbeddingsForReviewer,
  createSession,
  insertDraftComment,
  draftsForSession,
  updateDraftStatus,
  listSessions,
  markSessionSubmitted,
  insertCorrection,
  unconsolidatedCorrections,
  markConsolidated,
};
