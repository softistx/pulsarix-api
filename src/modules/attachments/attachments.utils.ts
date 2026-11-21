import { kindName } from "./attachments.kinds";

// A file name as stored: the last path segment, control characters out.
export function cleanFileName(raw: string | null): string | null {
  // Control characters and the invisible direction marks that disguise an
  // extension (U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF) are dropped.
  const name = (raw ?? "").replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    "",
  );
  const last = name.split(/[\\/]/).pop()?.trim() ?? "";
  return last && last !== "." && last !== ".."
    ? Array.from(last).slice(0, 200).join("")
    : null;
}

// The URL a stored file is read at, on the app's own origin.
export const urlOf = (key: string) => `/media/${kindName}/${key}`;
