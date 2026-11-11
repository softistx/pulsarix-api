// The per-request GraphQL context. Empty in A0; the viewer, the access
// catalogue and the tenant scope arrive with A1.
export type Context = Record<never, never>;
