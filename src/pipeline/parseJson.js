/**
 * Models — especially smaller local ones — sometimes wrap JSON in
 * markdown fences or add a stray sentence before/after. This strips the
 * common wrappers and extracts the first well-formed JSON value.
 */
function parseJsonResponse(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(json)?/i, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Fall back: find the first [ or { and the matching last ] or }
    const startArr = cleaned.indexOf('[');
    const startObj = cleaned.indexOf('{');
    const start =
      startArr === -1 ? startObj : startObj === -1 ? startArr : Math.min(startArr, startObj);
    if (start === -1) throw new Error(`Could not find JSON in model response: ${text}`);

    const isArray = cleaned[start] === '[';
    const end = isArray ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}');
    if (end === -1) throw new Error(`Could not find closing bracket in model response: ${text}`);

    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

module.exports = { parseJsonResponse };
