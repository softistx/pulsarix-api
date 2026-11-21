import type { Permission } from "@softistx/alxia-access";
import type { ModuleMongo } from "../../config/db";
import { can, requirePermission } from "../../core/access";
import type { MemberView } from "../../core/members";
import { escapeRegex } from "../../core/shared/regex";
import type { Context } from "../../http/context";

export type SearchMongo = ModuleMongo<"search">;

export const MAX_QUERY = 200;
export const MAX_FIRST = 50;

export type Kind = "issue" | "project" | "member";

// What reading each kind needs: the permission of the module that owns it.
const needs: Record<Kind, Permission> = {
  issue: "issue:read",
  project: "project:read",
  member: "member:read",
};
const everyKind = Object.keys(needs) as Kind[];

// The kinds to search: the ones asked for, each of which the viewer must hold
// the permission of (403 otherwise), or every kind the viewer may read.
export async function allowed(
  ctx: Context,
  asked: readonly Kind[] | null | undefined,
) {
  if (asked && asked.length > 0) {
    for (const kind of new Set(asked))
      await requirePermission(ctx, needs[kind]);
    return new Set(asked);
  }
  const held = new Set<Kind>();
  for (const kind of everyKind) if (await can(ctx, needs[kind])) held.add(kind);
  return held;
}

// An issue key as typed: `abc-12`, any case.
const KEY = /^[a-z][a-z0-9]{1,9}-\d{1,9}$/i;

export const issueKeyOf = (query: string) =>
  KEY.test(query) ? query.toUpperCase() : null;

interface Searchable {
  _id: { equals(other: unknown): boolean };
}

// The text-index hits (best score first), then, while the page is not full,
// the documents whose `fields` contain the query as typed, newest first: a
// text index matches whole words, and a command palette types prefixes. A
// document found twice keeps its first place.
export async function ranked<D extends Searchable>(
  query: string,
  first: number,
  find: {
    text(limit: number): Promise<D[]>;
    contains(pattern: RegExp, limit: number): Promise<D[]>;
  },
  head: D[] = [],
): Promise<D[]> {
  const found: D[] = [...head];
  const add = (more: D[]) => {
    for (const doc of more) {
      if (found.length >= first) return;
      if (!found.some((seen) => seen._id.equals(doc._id))) found.push(doc);
    }
  };
  add(await find.text(first + head.length));
  if (found.length < first) {
    add(
      await find.contains(
        new RegExp(escapeRegex(query), "i"),
        first + head.length,
      ),
    );
  }
  return found;
}

// Lower case without accents, so "elise" finds "Élise".
const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// How well a member matches, 0 for not at all: the name equal to the query,
// a word of the name starting with it, the name containing it, the e-mail
// starting with it, the e-mail containing it.
export function memberScore(member: MemberView, query: string): number {
  const q = fold(query.trim());
  const name = fold(member.name);
  const email = fold(member.email);
  if (name === q) return 5;
  if (name.split(/[\s'-]+/).some((word) => word.startsWith(q))) return 4;
  if (name.includes(q)) return 3;
  if (email.startsWith(q)) return 2;
  if (email.includes(q)) return 1;
  return 0;
}

// Active members only: a deactivated account is not offered. Best match
// first, then by name.
export function searchMembers(
  members: readonly MemberView[],
  query: string,
  first: number,
): MemberView[] {
  return members
    .filter((member) => member.active)
    .map((member) => ({ member, score: memberScore(member, query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.member.name.localeCompare(b.member.name) ||
        a.member.id.localeCompare(b.member.id),
    )
    .slice(0, first)
    .map(({ member }) => member);
}
