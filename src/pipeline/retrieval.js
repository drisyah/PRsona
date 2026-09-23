const { allEmbeddingsForReviewer } = require('../db/db');

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Finds the k most similar past (diff_hunk, comment) pairs for this
 * reviewer, by embedding cosine similarity. Brute-force over all rows —
 * deliberately not using a vector DB or index. For the corpus sizes this
 * tool deals with (hundreds to low thousands of comments per person) this
 * runs in single-digit milliseconds and keeps the whole app to one file.
 */
async function retrieveSimilar(embeddingProvider, reviewerId, queryText, k = 8) {
  const queryEmbedding = await embeddingProvider.embed(queryText);
  const rows = allEmbeddingsForReviewer(reviewerId);

  const scored = rows
    .map((row) => ({ ...row, score: cosineSimilarity(queryEmbedding, row.embedding) }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, k);
}

module.exports = { retrieveSimilar, cosineSimilarity };
