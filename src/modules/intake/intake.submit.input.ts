import { z } from "zod";
import { type FieldIssue, invalid } from "../../core/shared/errors";
import { stripControl } from "./intake.text";
import { reportImpact, reportLocale, reportType } from "./models";

// The fill time under which a form was not filled by a person (Q10).
export const MIN_FILL_MS = 3_000;
export const METADATA_BYTES = 2_048;

const text = (max: number) =>
  z
    .string()
    .transform((value) => stripControl(value).trim())
    .pipe(z.string().min(1).max(max));

export const submitInput = z.object({
  title: text(200),
  description: text(10_000),
  email: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.union([z.literal(""), z.email().max(254)]))
    .nullish(),
  pageUrl: z.string().max(2_048).nullish(),
  locale: reportLocale.nullish(),
  impact: reportImpact.nullish(),
  type: reportType.nullish(),
  metadata: z
    .array(
      z.object({
        key: text(64),
        value: z.string().transform(stripControl).pipe(z.string().max(512)),
      }),
    )
    .max(20)
    .nullish(),
  website: z.string().max(1_000).nullish(),
  filledInMs: z.number().int().min(0),
  files: z
    .array(
      z.object({
        role: z.enum(["screenshot", "file"]),
        name: z.string(),
        type: z.string(),
        size: z.number().int(),
      }),
    )
    .nullish(),
});

export type SubmitInput = z.input<typeof submitInput>;

// The zod issues as the API's field refusals.
export function refused(error: z.ZodError): never {
  const issues: FieldIssue[] = error.issues.map((issue) => ({
    path: issue.path.join("."),
    code:
      issue.code === "too_big"
        ? "validation.errors.too-long"
        : issue.code === "too_small"
          ? "validation.errors.required"
          : "validation.errors.invalid",
    ...(issue.code === "too_big" && { params: { max: Number(issue.maximum) } }),
  }));
  throw invalid(issues);
}

// A page URL as http(s) without credentials, query or fragment; null for anything else.
export function pageUrlOf(given: string | null | undefined): string | null {
  if (!given) return null;
  try {
    const url = new URL(given);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 2_048);
  } catch {
    return null;
  }
}

// The metadata's size in bytes (keys and values), refused past its limit.
export function checkMetadata(metadata: { key: string; value: string }[]) {
  const bytes = metadata.reduce(
    (sum, { key, value }) =>
      sum + Buffer.byteLength(key) + Buffer.byteLength(value),
    0,
  );
  if (bytes > METADATA_BYTES) {
    throw invalid([
      {
        path: "metadata",
        code: "validation.errors.too-long",
        params: { max: METADATA_BYTES },
      },
    ]);
  }
}
