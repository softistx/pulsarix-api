import { createI18n } from "@alxia/i18n";
import type { ErrorCode } from "./codes";
import { texts } from "./texts";

type Catalogue = { [key: string]: string | Catalogue };

// "a.b.c": text -> { a: { b: { c: text } } }, the nesting the catalogues take.
function nest(flat: Record<string, string>): Catalogue {
  const root: Catalogue = {};
  for (const [key, text] of Object.entries(flat)) {
    const path = key.split(".");
    const leaf = path.pop() as string;
    let node = root;
    for (const part of path) {
      const next = node[part];
      if (typeof next === "object") {
        node = next;
      } else {
        const created: Catalogue = {};
        node[part] = created;
        node = created;
      }
    }
    node[leaf] = text;
  }
  return root;
}

// English is the language of a request that names none we speak, and the last
// step of every chain.
export const FALLBACK_LANGUAGE = "en";

// The request's language: `Accept-Language` first, then the `lang` query, then
// the `language` cookie, among English and French. `i18n.t()` translates in it
// anywhere in the request, an error's message included.
export const i18n = createI18n<ErrorCode, "en" | "fr">({
  languages: ["en", "fr"],
  fallback: FALLBACK_LANGUAGE,
  fallbacks: () => [],
  order: ["header", "query", "cookie"],
});

i18n.setResources({ en: nest(texts.en), fr: nest(texts.fr) } as never);
