// A text as a regular expression matches it literally: the metacharacters are
// escaped.
export const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
