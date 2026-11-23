export function agentHeader(source: string) {
  const start = source.length - source.trimStart().length;
  const opening = source.slice(start).match(/^---[ \t]*(?:\r?\n|$)/);
  if (!opening) return { start, end: -1, text: "", boundary: 0 };
  const offset = start + opening[0].length;
  const closing = /^---[ \t]*\r?$/m.exec(source.slice(offset));
  if (!closing) throw new Error("Agent frontmatter is missing its closing delimiter.");
  const end = offset + closing.index;
  return { start, end, text: source.slice(start + 3, end), boundary: end + closing[0].length };
}
