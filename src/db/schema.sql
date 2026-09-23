-- PR Review Agent — local SQLite schema
-- One file per install. No server, no network dependency for storage.

CREATE TABLE IF NOT EXISTS reviewers (
    id TEXT PRIMARY KEY,              -- slug, e.g. "alice"
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Raw corpus: every past review comment ingested from GitHub/GitLab history.
-- Immutable / append-only. This is the ground truth the profile is derived from.
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewer_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    file_path TEXT,
    diff_hunk TEXT,
    comment_body TEXT NOT NULL,
    review_state TEXT,                -- APPROVED | CHANGES_REQUESTED | COMMENTED
    category TEXT,                    -- one of src/pipeline/categories.js, set by the backfill categorization pass (src/pipeline/categorize.js)
    severity TEXT,                    -- blocking | nit | question
    source TEXT DEFAULT 'backfill',   -- backfill | live
    gh_comment_id INTEGER,            -- GitHub's global comment id — dedup key for re-runs
    created_at TEXT,
    ingested_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (reviewer_id) REFERENCES reviewers(id)
);

-- Embeddings stored as JSON arrays; similarity computed in JS (brute-force
-- cosine). Fine for corpora of a few thousand rows — no vector DB needed.
CREATE TABLE IF NOT EXISTS comment_embeddings (
    comment_id INTEGER PRIMARY KEY,
    embedding TEXT NOT NULL,          -- JSON-encoded float array
    model TEXT NOT NULL,              -- which embedding model produced this
    dims INTEGER NOT NULL,
    FOREIGN KEY (comment_id) REFERENCES comments(id)
);

-- One row per PR the agent has reviewed (or is reviewing).
CREATE TABLE IF NOT EXISTS review_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewer_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    status TEXT DEFAULT 'draft',      -- draft | submitted | dismissed
    created_at TEXT DEFAULT (datetime('now')),
    submitted_at TEXT
);

-- Individual draft comments produced by the pipeline for a session.
CREATE TABLE IF NOT EXISTS draft_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    file_path TEXT,
    line INTEGER,
    category TEXT,
    severity TEXT,
    agent_text TEXT NOT NULL,
    human_text TEXT,                  -- filled in if edited, or set for a human-added comment
    status TEXT DEFAULT 'pending',    -- pending | accepted | edited | rejected | added
    FOREIGN KEY (session_id) REFERENCES review_sessions(id)
);

-- Feedback log — fast loop. Append-only, tagged by delta_type so the
-- consolidation pass can tell "wrong content" apart from "right content,
-- wrong tone".
CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewer_id TEXT NOT NULL,
    draft_comment_id INTEGER,
    agent_draft TEXT,
    human_final TEXT,
    delta_type TEXT,                  -- tone | wrong_content | false_positive | missed_issue | approved_as_is
                                       -- missed_issue comes from review:addHumanComment (the only type that can grow the rubric)
    created_at TEXT DEFAULT (datetime('now')),
    consolidated INTEGER DEFAULT 0,
    FOREIGN KEY (draft_comment_id) REFERENCES draft_comments(id)
);

CREATE INDEX IF NOT EXISTS idx_comments_reviewer ON comments(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_corrections_reviewer_unconsolidated
    ON corrections(reviewer_id, consolidated);
CREATE INDEX IF NOT EXISTS idx_draft_comments_session ON draft_comments(session_id);
