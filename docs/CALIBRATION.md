# Calibration: encoding what you don't say

> "A reviewer's style includes their silence, not just their words."
> — `src/pipeline/calibrate.js`

Every LLM asked to "find issues" finds them at uniform intensity: a security
nit gets the same enthusiasm as a missing null check, and log noise gets the
same enthusiasm as a race condition. Real reviewers don't work that way. You
have base rates — you comment on `security` constantly, on `logging` almost
never — and, more importantly, you have silences: categories you never bring
up because you don't think they're worth a reviewer's pixels.

Hosted review bots ignore this and post twenty comments on a two-comment PR.
PRsona's fix sits between its two model calls: the analysis pass proposes
candidate issues, **calibration** — a deterministic filter — trims that list
to match your observed distribution, and only then does the style pass
phrase what's left.

The whole thing is 38 lines of JavaScript including comments, makes no API
calls, and you can audit the decision in one screen. This is how it works,
why it's code rather than a prompt, and what it deliberately doesn't do.

## Where it sits

```
backfill → categorize → [ analysis (LLM) → calibrate (code) → style (LLM) ] → human approves → post
```

Three stages on purpose. The analysis pass "tends to over-flag (that's fine,
it's supposed to be thorough)" — per the comment atop `calibrate.js` — so
plain code decides what survives. Keeping the two model calls apart is the
point: mixing style into analysis "is what produces shallow mimicry
(catchphrases without real judgment)" (`src/pipeline/prompts.js`).
Calibration is the seam between *what's true about this diff* and *what you
would actually say about it*.

## The input: live shares from your corpus

Calibration's only input is `db.categoryStats(reviewerId)` — the
distribution of your backfilled, categorized PR comments:

```sql
-- src/db/db.js
SELECT category, COUNT(*) AS n FROM comments
WHERE reviewer_id = ? AND category IS NOT NULL
GROUP BY category
```

Each count becomes a share (`n / total`, 0..1). Three properties worth
knowing:

- **Recomputed every review, never persisted.** The stats comment says why:
  they are recomputed from the corpus "instead of being read off the
  profile, so calibration can never drift out of sync with what has
  actually been ingested."
- **Only your real GitHub comments count.** Approving or rejecting drafts in
  the app doesn't touch the corpus. The numbers are your history, not your
  usage of the app.
- **The denominator is categorized rows.** Rows still `NULL` — backfill
  hasn't run, or a batch came back unparseable and waits for the next run —
  don't dilute the shares.

## The rules: three lines of judgment

The entire decision, verbatim from `src/pipeline/calibrate.js`:

```js
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
```

In prose:

1. **Blocking always survives.** You rarely discuss `concurrency`, but you
   never let a race ship. Severity, not frequency, decides blockers.
2. **Unknown categories always survive.** A category absent from your corpus
   gets a free pass — it might be a blind spot worth surfacing, or the
   doorway a `missed_issue` correction just opened. It also means a
   cold-start (empty) corpus disables filtering entirely instead of
   filtering everything away.
3. **Everything else must clear the floor:** share ≥
   `minSharePerCategory`, default **0.05 (5%)**. Below it the finding is
   dropped — your silence was the instruction.

No learned thresholds, no LLM in the loop, no severity arithmetic. Severity
values themselves come from the analysis pass as a closed enum
(`"blocking" | "nit" | "question"`, `prompts.js`).

## The join key: a closed vocabulary

Rules 1–3 only work if the analysis pass and your history name categories
the *same way*. PRsona enforces one fixed vocabulary of 16 categories
(`src/pipeline/categories.js`):

`security` · `correctness` · `error-handling` · `concurrency` ·
`performance` · `testing` · `types` · `naming` · `readability` ·
`architecture` · `api-design` · `logging` · `docs` · `dependencies` ·
`style` · `uncategorized`

It's enforced wherever categories are written: backfill categorization
normalizes into it, and the analysis prompt is handed the list and told to
use exactly one of these names.

The constraint exists because two silent failures taught it:

- **Free-form categories never join.** The analysis pass used to invent its
  own labels while history used whatever a hand-written rubric said. As
  `categories.js` puts it, the names "never line up, so the historical rate
  lookup always missed and calibration silently passed everything through."
- **Once, nothing populated the stats at all.** `categoryStats` "existed but
  had no callers, which left calibration filtering on an always-empty object
  and therefore filtering nothing."

Both failures were invisible from the outside — the filter *ran*, it just
never filtered. The test suite now pins both: section 1 is named
"calibration stats actually get populated", section 2 "calibration filters
(was a no-op before)".

Model output outside the vocabulary — a typo, an invented label — is
normalized to `uncategorized`, a visible bucket judged by that bucket's
share like any other. Never silently invented, never silently lost.

## A worked example

Your corpus: **436 categorized comments**.

| Category | Comments | Share | Category | Comments | Share |
|---|--:|--:|---|--:|--:|
| security | 94 | 21.6% | naming | 14 | 3.2% |
| correctness | 84 | 19.3% | docs | 12 | 2.8% |
| error-handling | 48 | 11.0% | uncategorized | 10 | 2.3% |
| performance | 40 | 9.2% | style | 8 | 1.8% |
| testing | 36 | 8.3% | logging | 6 | 1.4% |
| readability | 28 | 6.4% | dependencies | 4 | 0.9% |
| architecture | 24 | 5.5% | concurrency | 4 | 0.9% |
| types | 24 | 5.5% | *api-design* | *0* | *never* |

Note `api-design`: a category you've never once commented on.

A PR comes in. The analysis pass returns 12 candidates:

| # | Category | Severity | Your share | Outcome | Why |
|--:|---|---|--:|---|---|
| 1 | security | blocking | 21.6% | ✅ kept | rules 1 + 3 |
| 2 | security | nit | 21.6% | ✅ kept | rule 3 |
| 3 | correctness | nit | 19.3% | ✅ kept | rule 3 |
| 4 | error-handling | question | 11.0% | ✅ kept | rule 3 |
| 5 | performance | nit | 9.2% | ✅ kept | rule 3 |
| 6 | testing | nit | 8.3% | ✅ kept | rule 3 |
| 7 | concurrency | blocking | 0.9% | ✅ kept | rule 1 — rarely discussed, never waived |
| 8 | api-design | question | never | ✅ kept | rule 2 — corpus silent |
| 9 | naming | nit | 3.2% | ❌ dropped | rule 3 — below 5% |
| 10 | docs | question | 2.8% | ❌ dropped | rule 3 |
| 11 | style | nit | 1.8% | ❌ dropped | rule 3 |
| 12 | logging | nit | 1.4% | ❌ dropped | rule 3 |

Twelve proposals in, eight comments out — and the four that died are exactly
the categories where your merged review history says you don't spend pixels.

## Why it's code, not another prompt

- **Deterministic and auditable.** Same corpus, same diff, same survivors,
  every time. A "review like Alice" prompt drifts with every token; a
  `.filter()` doesn't.
- **Free and instant.** No extra API call between the two LLM passes, no
  added latency, no token cost.
- **It can't hallucinate a threshold.** The floor is a named constant you
  can read, change, and test. The consolidation prompt even instructs the
  model to leave the stats alone — "rewriting it here would only introduce
  drift" — so the numbers have exactly one source.
- **Honest layering.** Taste lives upstream (your rubric weights), judgment
  lives here (deterministic filtering), voice lives downstream (the style
  pass rephrases survivors without adding or removing any).

## What surrounds it

Calibration is one layer; the others do different jobs:

- **Rubric weights** (`[high]` / `[low]` in the analysis prompt) come from
  consolidation: a `false_positive` correction lowers that category's weight
  and confidence — the analysis pass proposes fewer of them; a `missed_issue`
  adds an entry — it proposes more. That layer shapes *what gets proposed*.
- **`strictness`** (config, 0–1, default 0.3) is a prompt-shape knob, not a
  filter: above 0.6 the analysis prompt adds an explicit "be very literal"
  block for smaller local models. Despite the name, the only thresholds live
  in `calibrate.js`.
- **`minSharePerCategory`** is calibration's one knob —
  `calibrate(issues, stats, { minSharePerCategory })`, default 0.05. Not
  exposed in the UI yet; change it in code.
- **Corrections** (`accept` / `edit` / `reject` / `missed` /
  `missed_issue`) flow to consolidation, which updates the profile and
  recomputes the stats snapshot on approval. They shape future proposals;
  calibration stays a pure function of (proposals × corpus).

## Deliberate limits

What this design does *not* do — on purpose, or by acknowledged tradeoff:

- **It filters; it does not boost.** There is no re-ranking or elevation:
  severity stays exactly as the analysis pass found it, with rule 1
  covering the must-mentions. A quiet-but-nonblocking category can be
  suppressed — that's the feature, not an accident.
- **Shares count comments, not severity-weighted attention.** A chatty
  category inflates its own share. Comment frequency is a crude proxy for
  what you care about; it's also observable and unfakeable.
- **"Never commented on" is permanent in calibration's eyes.** Rule 2
  exempts such categories forever — you can't express "I never care about
  `api-design`" through silence alone. The escape hatch lives one layer up:
  a `false_positive` correction lowers the rubric weight, so the analysis
  pass stops proposing them.
- **16 categories is coarse.** Free-form precision doesn't join; a closed
  vocabulary does. Tradeoff accepted.
- **Cold start filters nothing.** Empty corpus → rule 2 keeps everything →
  calibration is a pass-through until backfill runs. Graceful, not magic.
- **5% is a heuristic, not learned.** It approximates "categories too rare
  to be worth your pixels." Tune it in code if your distribution disagrees.

## Read it yourself

| File | What's there |
|---|---|
| `src/pipeline/calibrate.js` | The whole algorithm — 38 lines with comments |
| `src/pipeline/categories.js` | The 16-name vocabulary + why free-form failed |
| `src/db/db.js` (`categoryStats`) | The stats query and its drift rationale |
| `src/pipeline/prompts.js` | Where strictness and rubric weights act |
| `test/pipeline.test.js` §§1–3 | Stats population, the three rules, end-to-end |

MIT. Bring your own keys.
