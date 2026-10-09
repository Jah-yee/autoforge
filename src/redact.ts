/** Returns a function that replaces each secret (4+ characters) with "***", longest first. */
export function makeRedactor(secrets: Iterable<string | undefined>): (text: string) => string {
  const list = [...new Set(secrets)]
    .filter((s): s is string => !!s && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text) => list.reduce((t, s) => t.replaceAll(s, "***"), text);
}
