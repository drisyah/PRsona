/**
 * GitHub only accepts a review comment whose `path` is a file in the diff
 * and whose `line` is a line the diff actually shows (on the matching
 * `side`). Anything else fails create-review with 422 "Line could not be
 * resolved" — and it fails the ENTIRE review, not just that one comment.
 *
 * The analysis stage is an LLM: its line numbers are guesses. It routinely
 * cites a plausible line that sits outside the changed region (file line 5
 * when the hunk covers 20-28), and it once cited a file the diff never
 * mentioned. So before submitting, parse the real diff and split comments
 * into two piles:
 *
 *   - resolved:  provably placeable -> inline comment with explicit side
 *   - deferred:  everything else   -> folded into the review body as
 *     `path:line` notes, so nothing is silently dropped and one bad line
 *     can no longer sink the submission.
 */

/** Strip git's `a/`/`b/` prefixes (and quoting) from a ---/+++ header. */
function stripHeaderPath(raw) {
  let p = String(raw || '').trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p.replace(/^[ab]\//, '');
}

/**
 * Parse a unified diff into per-file commentable line numbers.
 * Returns Map<file_path, { left: Set<number>, right: Set<number> }> where
 * `right` = lines that exist on the new side (+ and context) and `left` =
 * lines that exist on the base side (- and context).
 *
 * Only lines inside hunks are commentable — unchanged lines outside the
 * hunks are what an LLM most often (wrongly) cites.
 */
function commentableLines(diffText) {
  const files = new Map();
  const lines = String(diffText || '').split('\n');
  // split() leaves a trailing '' for the diff's final newline; it is not a
  // context line and must not shift the counters.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let file = null;    // current path, as GitHub wants it (the b/ side)
  let oldPath = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const entry = () => {
    if (!file) return null;
    if (!files.has(file)) files.set(file, { left: new Set(), right: new Set() });
    return files.get(file);
  };

  for (const line of lines) {
    // New file header — ends the previous file's hunks. Cannot collide with
    // hunk content: content lines are always prefixed +,-,space or \.
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldLine = +m[1];
        newLine = +m[2];
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        oldPath = stripHeaderPath(line.slice(4));
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = stripHeaderPath(line.slice(4));
        // Deleted file: +++ is /dev/null, but comments still anchor there
        // under the old path (LEFT side).
        file = p === '/dev/null' ? oldPath : p;
        continue;
      }
      continue; // index / mode / rename headers etc.
    }

    // Inside a hunk: count lines per side.
    const e = entry();
    if (!e) continue;
    if (line.startsWith('+')) e.right.add(newLine++);
    else if (line.startsWith('-')) e.left.add(oldLine++);
    else if (line.startsWith('\\')) { /* \ No newline at end of file */ }
    else {
      // Context line (leading space — or '' for an empty context line).
      e.right.add(newLine++);
      e.left.add(oldLine++);
    }
  }
  return files;
}

/**
 * Split comments ({file_path, line, text}) into GitHub-native inline
 * comments ({path, line, side, body}) and the ones that cannot be anchored.
 * Prefers RIGHT when a line number exists on both sides (LLMs cite new-side
 * numbering); falls back to LEFT for deleted lines.
 */
function resolveAnchors(comments, diffText) {
  const files = commentableLines(diffText);
  const resolved = [];
  const deferred = [];
  for (const c of comments || []) {
    const f = c.file_path ? files.get(c.file_path) : null;
    const line = Number(c.line);
    if (!f || !c.line || !Number.isInteger(line) || !c.text) {
      deferred.push(c);
      continue;
    }
    let side = null;
    if (f.right.has(line)) side = 'RIGHT';
    else if (f.left.has(line)) side = 'LEFT';
    if (!side) {
      deferred.push(c);
      continue;
    }
    resolved.push({ path: c.file_path, line, side, body: c.text });
  }
  return { resolved, deferred };
}

/**
 * Render deferred comments as the review's top-level body, so they stay
 * visible as notes instead of 422-ing the submission or vanishing.
 * Returns '' when there is nothing to defer (the body key is then omitted).
 */
function deferredToBody(deferred) {
  if (!deferred || deferred.length === 0) return '';
  const notes = deferred.map((c) => {
    const loc = c.file_path ? (c.line ? `${c.file_path}:${c.line}` : c.file_path) : 'diff';
    return `- \`${loc}\` — ${c.text}`;
  });
  return ['**Review notes that could not be anchored to a diff line:**', '', ...notes].join('\n');
}

module.exports = { commentableLines, resolveAnchors, deferredToBody };
