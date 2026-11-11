// A stranger's text without its control characters (NUL, escape, bell...): a
// newline and a tab stay. Written as a filter, not a pattern, so the intent
// reads: everything below U+0020 except \n and \t, and U+007F, goes.
export function stripControl(value: string): string {
  let kept = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    kept += char;
  }
  return kept;
}
