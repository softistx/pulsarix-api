# Domain glossary

pulsarix is a product-feedback and issue-tracking tool: organisations, members, projects,
issues, comments, activity, notifications, attachments, search, realtime subscriptions and
client intake (widget keys and a public intake endpoint). The code, the GraphQL schema and
the collections speak English, the default language of the product (French is offered). Terms
join this table slice by slice.

| Code       | Meaning                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Module`   | A unit of the API declared by one `defineModule` manifest and listed in `src/modules/registry.ts`: its schema, resolvers, collections, permissions, codes. |
| `Registry` | The ONE list of modules (`src/modules/registry.ts`). Adding a module is one line there.                                                                    |
| `Kernel`   | `src/core/`: what every module may use. It depends on no business module. A0 holds only `system` (the `version` query and the shared paging types).        |

## Error codes

None yet: the first `defineCodes` call arrives with A1, and `bun run context:check` then
requires each code to be listed here.
