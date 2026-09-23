/**
 * Which correction types may be written for each resolve action, plus the
 * fallback when the UI sends a type that doesn't fit that action.
 *
 * Consolidation reads `delta_type` to decide *which half* of the profile to
 * move: `tone` only ever touches style_profile, while `wrong_content` and
 * `false_positive` only ever touch substance_rubric. So a type that would
 * tell the model to do the wrong thing (e.g. rejecting a comment logged as
 * "tone", which has no text left to rephrase) is coerced to that action's
 * default instead of reaching the prompt.
 *
 * `missed_issue` is deliberately absent — it is not a resolution of an
 * agent draft at all; it is written by `review:addHumanComment`.
 */
const DELTA_TYPES = {
  accept: ['approved_as_is'],
  edit: ['tone', 'wrong_content'],
  reject: ['false_positive', 'wrong_content'],
};

const DEFAULT_DELTA = {
  accept: 'approved_as_is',
  edit: 'tone',
  reject: 'false_positive',
};

function pickDeltaType(action, requested) {
  const allowed = DELTA_TYPES[action];
  if (!allowed) throw new Error(`Unknown action: ${action}`);
  return allowed.includes(requested) ? requested : DEFAULT_DELTA[action];
}

module.exports = { DELTA_TYPES, DEFAULT_DELTA, pickDeltaType };
