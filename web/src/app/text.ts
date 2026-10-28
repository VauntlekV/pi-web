/** First non-empty line of a text, trimmed and capped for one-line labels. */
export function firstLine(text: string | undefined, max = 80): string {
  if (!text) return "";
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
