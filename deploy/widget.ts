/**
 * The widget deploy (`deploy.ts --widget`), without a 404 window. The UI
 * container bind-mounts the widget checkout's `dist` at /widget. `bun run
 * build` deletes and recreates `dist`, so the mount goes stale (the app answers
 * 404 for /widget/v1/*, and Cloudflare caches it) until the container restarts.
 * So the build runs in a scratch copy of the checkout, and its output is copied
 * into the existing `dist` in place: the directory keeps its inode, the mount
 * keeps working, and no restart is needed.
 *
 * The pure parts (paths, the order of the copy, which files go stale) are here
 * and pinned by widget.spec.ts; the file and process work is in deploy.ts.
 */

import { dirname, isAbsolute, resolve } from "node:path";

/** What the widget's checkout and its served `dist` are, as absolute paths. */
export function widgetPaths(
  values: Record<string, string>,
  deployDir: string,
): { dist: string; root: string } {
  const raw = values["WIDGET_DIST"] ?? "../../pulsarix-widget/dist";
  const dist = isAbsolute(raw) ? raw : resolve(deployDir, raw);
  return { dist, root: dirname(dist) };
}

/** Files the build leaves out of the copy: the loader and manifest go last. */
const LAST = ["loader.js", "manifest.json"] as const;

/** The widget bundle a manifest names, or undefined when it names none. */
export function manifestWidget(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const widget = (JSON.parse(text) as { widget?: unknown }).widget;
    return typeof widget === "string" ? widget : undefined;
  } catch {
    return undefined;
  }
}

export type WidgetSync = {
  /** Every file to write into `dist`, in order: loader.js and manifest.json last. */
  copy: string[];
  /** Files of the old `dist` the new build no longer has, safe to delete once the loader is in place. */
  stale: string[];
};

/**
 * The copy order and the stale files. A file of the old `dist` is stale when
 * the new build lacks it, except the hashed bundle the previous manifest named
 * (`keep`): a page that loaded the old loader still imports it, so it stays
 * until the next deploy.
 */
export function planWidgetSync(input: {
  built: string[];
  existing: string[];
  keep?: string | undefined;
}): WidgetSync {
  const { built, existing, keep } = input;
  const last = LAST.filter((f) => built.includes(f));
  const copy = [
    ...built.filter((f) => !last.includes(f as never)).sort(),
    ...last,
  ];
  const have = new Set(built);
  const stale = existing.filter((f) => !have.has(f) && f !== keep).sort();
  return { copy, stale };
}
