/**
 * Analysis pass: style-agnostic. Find candidate issues in the diff, scored
 * against this reviewer's known substance rubric. Deliberately does NOT
 * ask the model to sound like anyone — that's the style pass's job. Mixing
 * the two in one prompt is what produces shallow mimicry (catchphrases
 * without real judgment), so they stay separate calls.
 *
 * `strictness` (0-1) widens or narrows how much structure/hand-holding the
 * prompt gives — turn it up for smaller/local models that need more
 * explicit instructions and less "infer the vibe."
 */
function analysisPrompt(rubric, strictness = 0.3, categories = null) {
  const rubricText = rubric.length
    ? rubric
        .map(
          (r) =>
            `- [${r.weight}] ${r.category}: ${r.pattern}` +
            (r.confidence ? ` (confidence: ${r.confidence})` : '')
        )
        .join('\n')
    : '(no rubric learned yet — flag anything that looks like a genuine issue: bugs, missing error handling, missing tests, security concerns, unclear naming, performance problems)';

  const extra = strictness > 0.6
    ? `\nBe very explicit and literal. For each issue, name the exact category from the rubric it matches, or "uncategorized" if none fit. Do not infer intent beyond what's directly visible in the diff.`
    : '';

  // Both this pass and the backfill categorization pass must emit the same
  // fixed vocabulary (src/pipeline/categories.js) — calibration joins the
  // two sides on those names, so a free-form category here would never
  // match a historical rate and the issue would sail through unfiltered.
  const categoryText = Array.isArray(categories) && categories.length
    ? `\nCategorize every issue using EXACTLY one of these category names:\n` +
      categories.map((c) => `  - ${c}`).join('\n') +
      `\nUse "uncategorized" only if none of them fit. Do not invent new names.\n`
    : '';

  return `You are the analysis stage of a PR review pipeline. Your only job is to find
candidate issues in the diff below — you are NOT writing the review comments
themselves, just identifying what's worth flagging. Do not adopt any persona
or tone here.

This reviewer's known priorities (learned from their past reviews):
${rubricText}

Weight categories marked [high] more heavily than [low]. If the rubric is
empty or sparse, fall back to general code-review judgment, but err toward
flagging fewer, more important things rather than many minor ones.
${categoryText}${extra}

Respond ONLY with a JSON array, no other text, in this shape:
[
  {
    "file_path": "string",
    "line": number or null,
    "category": "string — one of the category names listed above",
    "severity": "blocking" | "nit" | "question",
    "issue": "plain description of the problem, 1-3 sentences, no persona/tone yet"
  }
]
If there are no issues worth flagging, respond with an empty array: []`;
}

/**
 * Style pass: takes the style-agnostic issues from the analysis pass and
 * rephrases each one the way this specific reviewer actually writes,
 * grounded in real retrieved examples of their past comments (few-shot),
 * not an abstract description alone.
 */
function stylePrompt(styleProfile, fewShotExamples) {
  const examplesText = fewShotExamples.length
    ? fewShotExamples
        .map(
          (ex, i) =>
            `Example ${i + 1} — on a similar diff, this reviewer wrote:\n"${ex.comment_body}"`
        )
        .join('\n\n')
    : '(no past examples retrieved — rely on the style profile below)';

  return `You are the style stage of a PR review pipeline. You will be given a list of
already-identified issues (content is final — do not add, remove, or change
what each issue is about) and must rephrase each one in this specific
reviewer's real voice.

Style profile for this reviewer:
- Tone: ${styleProfile.tone || '(not yet learned)'}
- Format preferences: ${styleProfile.format || '(not yet learned)'}
- Severity phrasing: ${JSON.stringify(styleProfile.severity_markers || {})}

Real examples of how this reviewer has phrased comments on similar code:

${examplesText}

Rewrite each issue as a single PR review comment in this reviewer's voice.
Match their real phrasing patterns and length from the examples above more
than the abstract style profile when the two seem to disagree — the examples
are ground truth.

Respond ONLY with a JSON array, same order as input, in this shape:
[
  { "file_path": "string", "line": number or null, "category": "string",
    "severity": "blocking"|"nit"|"question", "text": "the phrased comment" }
]`;
}

/**
 * Consolidation pass: runs infrequently (weekly / every N corrections),
 * never as part of the live review path. Reads the accumulated
 * (agent_draft -> human_final) correction log and proposes an updated
 * rubric + style profile. A human approves the resulting diff before it's
 * written back — see profileStore.diffProfiles.
 */
function consolidationPrompt(currentProfile, corrections) {
  return `You maintain a reviewer's profile — a rubric of what they look for in code
review (substance_rubric) and how they phrase comments (style_profile). You
will be given the CURRENT profile and a log of recent corrections: cases
where the agent drafted a comment and the human either edited it, rejected
it, or approved it as-is.

Each correction is tagged with a delta_type:
- "tone": the content was right but the phrasing/tone was off — update
  style_profile, leave substance_rubric alone.
- "wrong_content": the issue itself was wrong or not worth flagging —
  consider lowering that category's weight/confidence in substance_rubric.
- "false_positive": the agent flagged something this reviewer would not
  have flagged — lower confidence or weight for that category.
- "missed_issue": the human added a comment the agent didn't draft at all —
  consider adding or strengthening a rubric category.
- "approved_as_is": no change needed; reinforces current confidence.

IMPORTANT: keep substance changes and style changes separate. A tone
correction must never cause a substance_rubric change, and vice versa —
this is the whole point of tagging corrections by delta_type.

Current profile:
${JSON.stringify(currentProfile, null, 2)}

Recent corrections:
${JSON.stringify(corrections, null, 2)}

Respond ONLY with the complete updated profile JSON, same shape as the
current profile above (do not add new top-level fields). Leave the "stats"
object exactly as-is — it is a snapshot of the corpus and is recomputed
from the corpus on approval, so rewriting it here would only introduce
drift. Adjust confidence values incrementally — don't overreact to a single
correction. Update "pending_review_count_since_last_consolidation" (a count
of logged corrections since the last consolidation) to 0.`;
}

module.exports = { analysisPrompt, stylePrompt, consolidationPrompt };
