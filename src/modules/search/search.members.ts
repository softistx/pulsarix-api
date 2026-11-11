import type { MemberView } from "../../core/members";

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
