/**
 * The single, fixed category vocabulary for this app.
 *
 * Calibration needs to compare "categories the analysis pass flags on a new
 * diff" against "categories this reviewer historically comments on" — that
 * only works if both sides use the *same* names. Free-form categories (what
 * the analysis pass used to invent, and what a hand-written rubric tends to
 * contain) never line up, so the historical rate lookup always missed and
 * calibration silently passed everything through.
 *
 * So: backfill categorizes past comments from this list, the analysis pass
 * picks from this list, and calibration joins the two on it.
 */
const CATEGORIES = [
  'security', // injection, authz, secrets, unsafe/unvalidated input
  'correctness', // logic bugs, edge cases, off-by-one, wrong result
  'error-handling', // swallowed exceptions, missing timeouts/retries/cleanup
  'concurrency', // races, deadlocks, shared mutable state, async ordering
  'performance', // N+1 queries, needless allocation, hot-path cost
  'testing', // missing, weak, or brittle tests
  'types', // type safety, null/undefined handling, unsafe casts
  'naming', // unclear or misleading identifiers
  'readability', // complexity, duplication, dead code, control flow
  'architecture', // layering, coupling, module boundaries, dependencies
  'api-design', // signatures, defaults, backward compatibility
  'logging', // observability, debuggability, log noise
  'docs', // missing/wrong comments, README, changelog
  'dependencies', // version pins, supply chain, licenses
  'style', // formatting and idiom — usually the lowest-priority flags
  'uncategorized', // no clear fit; kept so unknowns stay visible
];

const UNCATEGORIZED = 'uncategorized';

/** True when `cat` is a value the analysis pass and calibration both understand. */
function isKnownCategory(cat) {
  return typeof cat === 'string' && CATEGORIES.includes(cat);
}

/** Coerce any model output to a canonical category, else `uncategorized`. */
function normalizeCategory(cat) {
  if (typeof cat !== 'string') return UNCATEGORIZED;
  const match = CATEGORIES.find((c) => c.toLowerCase() === cat.trim().toLowerCase());
  return match || UNCATEGORIZED;
}

module.exports = { CATEGORIES, UNCATEGORIZED, isKnownCategory, normalizeCategory };
