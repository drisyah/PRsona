/**
 * Calibration is plain code, not an LLM call — deterministic and auditable.
 * The analysis pass tends to over-flag (that's fine, it's supposed to be
 * thorough); calibration trims the list down to roughly match how often
 * this reviewer actually comments on each category in real life.
 *
 * This is also where "what they don't comment on" gets encoded — a
 * reviewer's style includes their silence, not just their words.
 *
 * `stats` is `db.categoryStats(reviewerId)`: `{ total, by_category }`, where
 * each value is that category's *share* of the reviewer's historical
 * comments (0..1). It is recomputed from the corpus on every review instead
 * of being read off the profile, so calibration can never drift out of sync
 * with what has actually been ingested.
 */
function calibrate(issues, stats, opts = {}) {
  const minSharePerCategory = opts.minSharePerCategory ?? 0.05;
  const byCategory = stats?.by_category || {};

  return issues.filter((issue) => {
    // Always keep blocking issues — reviewers rarely suppress real blockers
    // regardless of how rarely they've historically commented on the category.
    if (issue.severity === 'blocking') return true;

    const share = byCategory[issue.category];

    // Category this reviewer has never commented on (unknown to the corpus,
    // or not yet categorized). Keep it: this is the doorway through which
    // "missed_issue" corrections can introduce categories the rubric doesn't
    // cover yet. It also means an empty corpus disables filtering rather
    // than filtering everything away.
    if (share === undefined) return true;

    return share >= minSharePerCategory;
  });
}

module.exports = { calibrate };
