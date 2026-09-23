const { consolidationPrompt } = require('./prompts');
const { parseJsonResponse } = require('./parseJson');
const { diffProfiles } = require('../profile/profileStore');
const db = require('../db/db');

/**
 * Slow loop. Reads unconsolidated corrections, asks the model to propose
 * an updated profile, and returns { proposedProfile, changes, correctionIds }
 * WITHOUT writing anything — the caller (IPC handler / UI) is responsible
 * for showing the diff to the human and only persisting + marking
 * corrections consolidated once approved. This separation is what keeps
 * consolidation from silently drifting the profile.
 */
async function proposeConsolidation({ providers, currentProfile, reviewerId }) {
  const corrections = db.unconsolidatedCorrections(reviewerId);

  if (corrections.length === 0) {
    return { proposedProfile: null, changes: [], correctionIds: [], message: 'No new feedback to consolidate.' };
  }

  const res = await providers.completion.complete(
    consolidationPrompt(currentProfile, corrections),
    [{ role: 'user', content: 'Propose the updated profile now.' }],
    { maxTokens: 3000 }
  );

  const proposedProfile = parseJsonResponse(res);
  const changes = diffProfiles(currentProfile, proposedProfile);
  const correctionIds = corrections.map((c) => c.id);

  return { proposedProfile, changes, correctionIds };
}

/** Called once the human approves the proposed profile in the UI.
 *  Stats are refreshed from the corpus here rather than trusted from the
 *  model's response — the prompt tells it to leave `stats` alone, but the
 *  corpus is cheap to re-read and being wrong about it would put a stale
 *  number in a file users inspect by hand. */
function applyConsolidation({ profilesDir, proposedProfile, correctionIds }) {
  const { saveProfile } = require('../profile/profileStore');
  proposedProfile.stats = db.categoryStats(proposedProfile.reviewer);
  const saved = saveProfile(profilesDir, proposedProfile);
  db.markConsolidated(correctionIds);
  return saved;
}

module.exports = { proposeConsolidation, applyConsolidation };
