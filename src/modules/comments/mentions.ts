// The mention markers of a body: `@[Label](id)`, as @softistx/material's
// MentionTextareaField keeps them. The label is display text and the id comes
// from the client, so the id is only ever a claim to check.
const MARKER = /@\[[^\]\n]*\]\(([^)\s]*)\)/g;

// The distinct ids the markers of `body` name, in order of appearance.
export function mentionedIds(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MARKER)) {
    const id = match[1];
    if (id) seen.add(id);
  }
  return [...seen];
}
