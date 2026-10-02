/**
 * A marker-delimited section of a markdown file that one writer owns while everyone else owns the rest.
 *
 * board.md is co-written: the god is its scribe, and in lab mode the lab loop renders its blackboard into one section of
 * it. The section is fenced by HTML comments (the same spelling the lab bridge used when it wrote the file itself), so the
 * lab can replace its section on every round without ever touching a byte outside the fences.
 */

export function sectionMarkers(name: string): { begin: string; end: string } {
  return { begin: `<!-- hive-bridge:${name}:begin -->`, end: `<!-- hive-bridge:${name}:end -->` };
}

/**
 * Return `current` with the `name` section replaced by `body` (appended when absent). `current === null` means the file
 * does not exist yet and is created from `header`. Everything outside the markers is preserved byte for byte.
 */
export function upsertManagedSection(current: string | null, name: string, body: string, header = ''): string {
  const { begin, end } = sectionMarkers(name);
  const block = `${begin}\n${body.replace(/\s+$/, '')}\n${end}`;
  if (current === null) return `${header}${header && !header.endsWith('\n\n') ? '\n' : ''}${block}\n`;
  const i = current.indexOf(begin);
  const j = i >= 0 ? current.indexOf(end, i) : -1;
  if (i >= 0 && j >= 0) return current.slice(0, i) + block + current.slice(j + end.length);
  return `${current.replace(/\s*$/, '')}\n\n${block}\n`;
}
