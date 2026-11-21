// The order a project's statuses and labels are listed in: statuses by their
// `order`, labels by name, case-insensitively. The services' `list` and the
// per-request loaders share it, so both give the same sequence.
export const STATUSES_ORDER = { sort: { order: 1 } } as const;

export const LABELS_ORDER = {
  sort: { name: 1 },
  collation: { locale: "en", strength: 2 },
} as const;
