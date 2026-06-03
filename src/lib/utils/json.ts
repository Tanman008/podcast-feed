// Extracts the first complete top-level JSON object from a string that may contain
// leading markdown fences or trailing commentary (common with gpt-4o / gpt-4o-mini).
// Returns the raw object string, or null if no opening brace is found.
export function extractFirstJsonObject(raw: string): string | null {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start); // unbalanced — let JSON.parse surface the error
}
