// The key an address is limited by: an IPv4 address as is, an IPv6 one by its
// /64 (one host owns a whole /64, so it must not rotate through it).
export function addressKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  // An IPv4 address a dual-stack socket reports as ::ffff:a.b.c.d, or an IPv6
  // one with a zone (fe80::1%en0).
  const bare = ip.split("%")[0] ?? ip;
  const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped?.[1]) return mapped[1];
  ip = bare;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [
        ...left,
        ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
        ...right,
      ]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
