const { analysisPrompt, stylePrompt } = require('./prompts');
const { calibrate } = require('./calibrate');
const { retrieveSimilar } = require('./retrieval');
const { parseJsonResponse } = require('./parseJson');
const { CATEGORIES, normalizeCategory } = require('./categories');
const db = require('../db/db');

/**
 * Runs the full pipeline for one PR diff and returns draft comments.
 * Also persists a review_session + draft_comments rows so the UI can show
 * them and the human can accept/edit/reject.
 *
 * providers: { completion, embeddings, embeddingsError } from src/llm/index.js
 *
 * Returns { sessionId, drafts, warning }. `warning` is non-null when the
 * configured embeddings provider can't embed — retrieval is then skipped
 * (so the style pass falls back to the profile alone) rather than throwing
 * after the analysis call has already spent tokens.
 */
async function runReview({ providers, profile, reviewerId, repo, prNumber, diffText, strictness = 0.3 }) {
  // Step 1 — analysis: style-agnostic candidate issues, drawn from the same
  // fixed category vocabulary the backfill pass uses.
  const analysisRes = await providers.completion.complete(
    analysisPrompt(profile.substance_rubric, strictness, CATEGORIES),
    [{ role: 'user', content: diffText }]
  );
  // A model that answers with a single object (or an empty/garbage value)
  // would otherwise reach `.filter`/`.length` and crash the whole review.
  const parsedAnalysis = parseJsonResponse(analysisRes);
  const rawIssues = (Array.isArray(parsedAnalysis) ? parsedAnalysis : [parsedAnalysis])
    .filter((i) => i && typeof i === 'object')
    .map((issue) => ({
      ...issue,
      // Coerce anything off-vocabulary to "uncategorized" before calibration
      // looks up a historical rate for it.
      category: normalizeCategory(issue?.category),
    }));

  if (rawIssues.length === 0) {
    const sessionId = db.createSession(reviewerId, repo, prNumber);
    return { sessionId, drafts: [], warning: providers.embeddingsError || null };
  }

  // Step 2 — calibrate: deterministic filter against this reviewer's real
  // bar, using category shares computed live from the corpus (not from the
  // profile, so it can't go stale between consolidations).
  const stats = db.categoryStats(reviewerId);
  const calibrated = calibrate(rawIssues, stats);

  // Step 3 — retrieve real past examples for the style pass (one retrieval
  // per issue would be more precise but more expensive; a single retrieval
  // over the whole diff is a reasonable default — swap in per-issue
  // retrieval if quality needs it). Degrade rather than fail when no
  // embeddings provider is configured: retrieval is skipped and the warning
  // is surfaced in the UI, instead of throwing here — after the analysis
  // call has already spent tokens.
  if (providers.embeddingsError) {
    const warning = `${providers.embeddingsError} Style pass runs on the profile only (no few-shot examples).`;
    const sessionId = db.createSession(reviewerId, repo, prNumber);
    const styled = await styleAndPersist({ providers, profile, sessionId, calibrated });
    return { sessionId, drafts: styled, warning };
  }
  const similar = await retrieveSimilar(providers.embeddings, reviewerId, diffText, 8);

  // Step 4 — style: rephrase in the reviewer's real voice, grounded in
  // retrieved examples.
  const sessionId = db.createSession(reviewerId, repo, prNumber);
  const drafts = await styleAndPersist({ providers, profile, sessionId, calibrated, similar });
  return { sessionId, drafts, warning: null };
}

/** Step 4 + 5: style pass, then persist each result as a draft row. */
async function styleAndPersist({ providers, profile, sessionId, calibrated, similar = [] }) {
  const styleRes = await providers.completion.complete(
    stylePrompt(profile.style_profile, similar),
    [{ role: 'user', content: JSON.stringify(calibrated) }]
  );
  const parsed = parseJsonResponse(styleRes);
  const styledComments = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (c) => c && typeof c === 'object'
  );

  return styledComments.map((c) => {
    const id = db.insertDraftComment({
      session_id: sessionId,
      file_path: c.file_path ?? null,
      line: c.line ?? null,
      category: c.category ?? null,
      severity: c.severity ?? null,
      agent_text: c.text,
    });
    return { id, ...c };
  });
}

module.exports = { runReview };
