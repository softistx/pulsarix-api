import { ObjectId } from "mongodb";
import { z } from "zod";
import { invalid } from "../../../core/shared/errors";
import {
  filesTooLarge,
  fileTooLarge,
  fileUnsupportedType,
  tooManyFiles,
} from "../intake.errors";
import { acceptedFileTypes, maxFileBytes } from "../intake.files.kinds";
import { stripControl } from "../utils/text.utils";
import { declaredFileRole } from "../models";

// What one report may carry (plan §17, A12): one screenshot and three files,
// 5 MB each and 12 MB together. All of it is checked from what the widget
// declares, before the report exists.
export const MAX_SCREENSHOTS = 1;
export const MAX_ATTACHED = 3;
export const MAX_FILES = MAX_SCREENSHOTS + MAX_ATTACHED;
export const MAX_FILES_BYTES = 12 * 1024 * 1024;

const declared = z.object({
  role: declaredFileRole,
  name: z
    .string()
    .transform((value) => stripControl(value).trim())
    .pipe(z.string().min(1)),
  type: z.string().max(100),
  size: z.number().int().min(1),
});
export type DeclaredFile = z.input<typeof declared>;

export interface CheckedFile {
  role: z.infer<typeof declaredFileRole>;
  // The name as a file name: no folder, at most 200 characters.
  name: string;
  type: (typeof acceptedFileTypes)[number];
  size: number;
}

// The last part of a name, whatever separator it came with.
const baseName = (name: string) =>
  name.split(/[\\/]/).pop()?.trim().slice(-200) || "file";

const isAccepted = (type: string): type is CheckedFile["type"] =>
  (acceptedFileTypes as readonly string[]).includes(type);

// The declared files as they will be stored, or the refusal: 400 for a count
// or a shape, 415 for a type, 413 for a size. A screenshot is a picture.
export function checkFiles(given: readonly DeclaredFile[]): CheckedFile[] {
  if (given.length > MAX_FILES) throw tooManyFiles(MAX_FILES);
  const files: CheckedFile[] = [];
  for (const [index, file] of given.entries()) {
    const parsed = declared.safeParse(file);
    if (!parsed.success) {
      throw invalid([
        { path: `files.${index}`, code: "validation.errors.invalid" },
      ]);
    }
    const { role, name, size } = parsed.data;
    const type = parsed.data.type.trim().toLowerCase();
    if (
      !isAccepted(type) ||
      (role === "screenshot" && type === "application/pdf")
    ) {
      throw fileUnsupportedType();
    }
    if (size > maxFileBytes) throw fileTooLarge(maxFileBytes);
    files.push({ role, name: baseName(name), type, size });
  }
  const screenshots = files.filter((file) => file.role === "screenshot");
  if (
    screenshots.length > MAX_SCREENSHOTS ||
    files.length - screenshots.length > MAX_ATTACHED
  ) {
    throw tooManyFiles(MAX_FILES);
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_FILES_BYTES) {
    throw filesTooLarge(MAX_FILES_BYTES);
  }
  return files;
}

// A slot's id, new: it names the file, in its ticket and in the PUT's path.
export const newSlot = () => new ObjectId().toHexString();
