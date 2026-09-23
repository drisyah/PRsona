const fs = require('fs');
const path = require('path');

/**
 * The profile is the consolidated, tuned state for one reviewer: what they
 * look for (substance_rubric) and how they say it (style_profile). It's a
 * plain JSON file, not a DB row, so a user can inspect it, hand-edit it, or
 * put it under their own git repo if they want history beyond what this
 * app already tracks internally.
 */
function profilePath(profilesDir, reviewerId) {
  return path.join(profilesDir, `${reviewerId}.json`);
}

function emptyProfile(reviewerId, displayName) {
  return {
    reviewer: reviewerId,
    display_name: displayName || reviewerId,
    version: 0,
    last_updated: new Date().toISOString(),
    stats: {
      // Snapshot of db.categoryStats() from the last approved
      // consolidation: total categorized comments and each category's
      // share of them (0..1). Informational — calibration recomputes this
      // live from the corpus on every review, so it is never the input to
      // a filter and can't drift out of sync with what's been ingested.
      total: 0,
      by_category: {},
    },
    substance_rubric: [],
    style_profile: {
      tone: '',
      format: '',
      severity_markers: {},
    },
    pending_review_count_since_last_consolidation: 0,
  };
}

function loadProfile(profilesDir, reviewerId) {
  const p = profilePath(profilesDir, reviewerId);
  if (!fs.existsSync(p)) return emptyProfile(reviewerId);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveProfile(profilesDir, profile) {
  fs.mkdirSync(profilesDir, { recursive: true });
  profile.last_updated = new Date().toISOString();
  profile.version = (profile.version || 0) + 1;
  const p = profilePath(profilesDir, profile.reviewer);
  fs.writeFileSync(p, JSON.stringify(profile, null, 2), 'utf-8');
  return profile;
}

/**
 * Bump the feedback counter on an existing profile WITHOUT treating it as a
 * profile revision: `saveProfile` increments `version`, and that should stay
 * reserved for consolidation passes a human actually approved. This writes
 * the counter (and a fresh `last_updated`) directly.
 *
 * Returns the updated profile, or null when none exists yet (reviewer was
 * never created through Setup — nothing to count against).
 */
function incrementPendingCount(profilesDir, reviewerId) {
  const p = profilePath(profilesDir, reviewerId);
  if (!fs.existsSync(p)) return null;

  const profile = JSON.parse(fs.readFileSync(p, 'utf-8'));
  profile.pending_review_count_since_last_consolidation =
    (profile.pending_review_count_since_last_consolidation || 0) + 1;
  profile.last_updated = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(profile, null, 2), 'utf-8');
  return profile;
}

/** Returns a unified diff-ish { added, removed, changed } summary for the
 *  approval UI, so a human can see what a consolidation pass would change
 *  before it's committed. Intentionally simple — not a full JSON-diff lib. */
function diffProfiles(oldProfile, newProfile) {
  const changes = [];

  const oldRubricByCategory = Object.fromEntries(
    (oldProfile.substance_rubric || []).map((r) => [r.category, r])
  );
  const newRubricByCategory = Object.fromEntries(
    (newProfile.substance_rubric || []).map((r) => [r.category, r])
  );

  for (const cat of new Set([
    ...Object.keys(oldRubricByCategory),
    ...Object.keys(newRubricByCategory),
  ])) {
    const before = oldRubricByCategory[cat];
    const after = newRubricByCategory[cat];
    if (!before && after) changes.push({ type: 'added_category', category: cat, after });
    else if (before && !after) changes.push({ type: 'removed_category', category: cat, before });
    else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ type: 'changed_category', category: cat, before, after });
    }
  }

  if (JSON.stringify(oldProfile.style_profile) !== JSON.stringify(newProfile.style_profile)) {
    changes.push({
      type: 'style_changed',
      before: oldProfile.style_profile,
      after: newProfile.style_profile,
    });
  }

  return changes;
}

module.exports = {
  loadProfile,
  saveProfile,
  emptyProfile,
  incrementPendingCount,
  diffProfiles,
  profilePath,
};
