const db = require('../db/db');

/**
 * Pulls a reviewer's historical PR review comments from GitHub into the
 * local corpus, then embeds any rows that don't have an embedding yet.
 * Safe to re-run — insertComment is append-only but embedding step skips
 * already-embedded rows (see db.commentsWithoutEmbeddings).
 */
async function backfillReviewer({ github, embeddingProvider, reviewerId, repos, username, onProgress }) {
  let totalIngested = 0;

  for (const repo of repos) {
    onProgress?.(`Fetching ${username}'s past review comments on ${repo}...`);
    const comments = await github.listUserReviewComments(repo, username);

    for (const c of comments) {
      db.insertComment({
        reviewer_id: reviewerId,
        repo,
        pr_number: c.pull_request_url?.split('/').pop() ?? 0,
        file_path: c.path,
        diff_hunk: c.diff_hunk,
        comment_body: c.body,
        review_state: null,
        category: null, // labeled afterwards by categorizeComments() — the
                        // backfill handler runs that pass once ingest+embed
                        // finish (see electron/main.js backfill:run)
        severity: null,
        source: 'backfill',
        created_at: c.created_at,
      });
      totalIngested += 1;
    }
  }

  onProgress?.(`Ingested ${totalIngested} comments. Generating embeddings...`);

  const toEmbed = db.commentsWithoutEmbeddings(reviewerId);
  let embedded = 0;
  for (const row of toEmbed) {
    const text = `${row.file_path ?? ''}\n${row.diff_hunk ?? ''}\n${row.comment_body}`;
    const vector = await embeddingProvider.embed(text);
    db.insertEmbedding(row.id, vector, embeddingProvider.constructor.name);
    embedded += 1;
    if (embedded % 20 === 0) onProgress?.(`Embedded ${embedded}/${toEmbed.length}...`);
  }

  onProgress?.(`Done. ${totalIngested} comments ingested, ${embedded} newly embedded.`);
  return { totalIngested, embedded };
}

module.exports = { backfillReviewer };
