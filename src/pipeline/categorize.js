const { CATEGORIES, normalizeCategory } = require('./categories');
const { parseJsonResponse } = require('./parseJson');
const db = require('../db/db');

/**
 * Categorization prompt for the backfill pass. The vocabulary is the single
 * fixed list from categories.js — both this pass and the analysis pass must
 * emit the same names, otherwise calibration's rate lookup misses and
 * silently passes everything through.
 */
function categorizationPrompt() {
  return `Categorize each code-review comment below into exactly one of these categories:

${CATEGORIES.map((c) => `  - ${c}`).join('\n')}

Choose the single best fit from that list — do not invent category names.
Use "uncategorized" only when nothing fits at all. Judge from the comment
text and the diff hunk it was left on.

Each input has an "id". Respond ONLY with a JSON array, same ids as input:
[ { "id": number, "category": "one of the categories listed above" } ]`;
}

/**
 * Labels any comment still lacking a category, using the completion model.
 *
 * Runs after ingestion and is safe to re-run: it only selects rows where
 * `category IS NULL`, so already-labeled comments are never re-billed. On a
 * response we can't parse, the batch is left NULL (rather than stamped
 * "uncategorized") so the next backfill run retries it; ids the model
 * omitted from an otherwise-valid response get "uncategorized" so a single
 * flaky id can't stall progress forever.
 */
async function categorizeComments({ completion, reviewerId, onProgress, batchSize = 25 }) {
  const pending = db.commentsWithoutCategory(reviewerId);

  if (pending.length === 0) {
    onProgress?.('All comments already categorized.');
    return { categorized: 0, total: 0 };
  }

  onProgress?.(`Categorizing ${pending.length} comments...`);

  let categorized = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);

    const payload = batch.map((c) => ({
      id: c.id,
      diff_hunk: c.diff_hunk,
      comment: c.comment_body,
    }));

    let parsed;
    try {
      const res = await completion.complete(categorizationPrompt(), [
        { role: 'user', content: JSON.stringify(payload) },
      ], { maxTokens: 600 + batch.length * 40 });
      parsed = parseJsonResponse(res);
    } catch (e) {
      onProgress?.(`  Batch ${i / batchSize + 1} failed (${e.message}) — will retry next backfill.`);
      continue;
    }

    if (!Array.isArray(parsed)) {
      onProgress?.(`  Batch ${i / batchSize + 1} returned non-array — will retry next backfill.`);
      continue;
    }

    // String-keyed so a model returning "42" still matches row id 42.
    const byId = new Map(
      parsed
        .filter((r) => r && r.id !== undefined && r.id !== null)
        .map((r) => [String(r.id), normalizeCategory(r.category)])
    );

    for (const c of batch) {
      const category = byId.has(String(c.id)) ? byId.get(String(c.id)) : 'uncategorized';
      if (db.updateCommentCategory(c.id, category)) categorized += 1;
    }

    onProgress?.(`  Categorized ${categorized}/${pending.length}...`);
  }

  const stillNull = db.commentsWithoutCategory(reviewerId).length;
  onProgress?.(
    `Categorization done: ${categorized} labeled, ${stillNull} left for the next run ` +
      `(of ${pending.length} total).`
  );
  return { categorized, total: pending.length, remaining: stillNull };
}

module.exports = { categorizeComments, categorizationPrompt };
