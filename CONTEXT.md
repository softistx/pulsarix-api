# Domain glossary

pulsarix is a product-feedback and issue-tracking tool: organisations, members, projects,
issues, comments, activity, notifications, attachments, search, realtime subscriptions and
client intake (widget keys and a public intake endpoint). The code, the GraphQL schema and
the collections speak English, the default language of the product (French is offered). Terms
join this table slice by slice.

| Code            | Meaning                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Module`        | A unit of the API declared by one `defineModule` manifest and listed in `src/modules/registry.ts`: its schema, resolvers, collections, permissions, codes.                                                                                                                                  |
| `Registry`      | The ONE list of modules (`src/modules/registry.ts`). Adding a module is one line there.                                                                                                                                                                                                     |
| `Kernel`        | `src/core/`: what every module may use. It depends on no business module. It holds `system`, `access`, `accounts`, `organisations`, `members` and `invitations`.                                                                                                                            |
| `Organisation`  | The tenant: a team or company. Registered in the core database (`organisations`), with its own database `pulsarix_org_<id>` (plan Q2). Named in a request by `x-organization-id`, its id or its slug (the header and the `tenancy.errors.*` codes keep @alxia/tenancy's American spelling). |
| `Account`       | A janus user, global, signed in by e-mail. It belongs to any number of organisations. Not a record of an organisation's database.                                                                                                                                                           |
| `Member`        | An account holding a role in an organisation (janus relation `organization:<id>#<role>@user:<id>`). One role per organisation; two roles are a `conflict` that grants no access.                                                                                                            |
| `Role`          | `owner`, `admin`, `member`, `viewer`, in code (plan Q13). The permissions of a role come from the module manifests (`permissions`, `defaultGrants`); the owner holds every one.                                                                                                             |
| `Permission`    | `<area>:<action>` (`member:manage`). `organisation:create` is not a role's: every signed-in account holds it (`Viewer.permissions`).                                                                                                                                                        |
| `Invitation`    | An organisation's invitation of an e-mail address with a role. Its link is valid 7 days; only the token's sha256 is stored. Accepting proves the e-mail and makes or finds the account.                                                                                                     |
| `Second factor` | A TOTP code from an authenticator app, optional per account. Once active, a sign-in answers `SECOND_FACTOR_REQUIRED` with a challenge instead of a session. Ten recovery codes replace a lost app.                                                                                          |
| `Step-up`       | A fresh proof of identity (a mailed code, or the app's code) that a role change, a removal or disabling the second factor ask for when the session's last proof is older than 10 minutes.                                                                                                   |

## Mail links

The UI pages the mails link to, fixed here (the UI never renames them alone). Each posts its token
back from a button: a mail scanner follows a link, so a GET never spends it.

| Path                          | Mail           | Mutation           |
| ----------------------------- | -------------- | ------------------ |
| `/invitations/accept?token=`  | invitation     | `acceptInvitation` |
| `/auth/magic-link?token=`     | sign-in link   | `confirmMagicLink` |
| `/auth/reset-password?token=` | password reset | `resetPassword`    |

## Error codes

A code is `<module>.errors.<slug>`, declared with `defineCodes`, with its English and French texts in
`src/i18n/texts.ts` (`src/i18n/texts.spec.ts` fails when one is missing). The status is the HTTP status
of a top-level refusal; `bun run context:check` requires each declared code to be listed here.

| Codes                                                                                                                                                                   | Status and meaning                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.errors.` `client-header-required` / `unauthenticated` / `forbidden` / `unavailable` / `invalid-credentials` / `invalid-token` / `too-many-attempts` / `exhausted` | 403 no `x-pulsarix-client` header; 401 not signed in; 403 not allowed; 503 the session store cannot answer; 401 wrong e-mail or password (one answer for an unknown account); 400 a link or challenge unknown, spent or expired; 429 past a janus throttle (with `retryAfter`); 409 concurrent writes gave up, send it again. |
| `auth.errors.` `step-up-required` / `invalid-code` / `second-factor-active` / `second-factor-not-enrolled`                                                              | 403 ask `requestStepUp` then `confirmStepUp`; 400 a wrong TOTP, recovery or step-up code (`attemptsLeft` when counted); 409 a factor is active already; 409 no factor is being set up.                                                                                                                                        |
| `tenancy.errors.` `organization-required` / `unknown-organization` / `slug-taken`                                                                                       | 400 no `x-organization-id` header; 404 unknown organisation or the viewer is not a member (the same answer); 409 the slug is taken.                                                                                                                                                                                           |
| `validation.errors.` `invalid-input` / `required` / `invalid` / `too-short` / `too-long` / `out-of-range`                                                               | 400 an input refused as a whole, with `extensions.fields` giving each field's reason (`required`, `invalid`, `too-short` with `min`, `too-long` with `max`, `out-of-range`).                                                                                                                                                  |
| `members.errors.` `not-found` / `last-owner` / `owner-required`                                                                                                         | 404 no such member; 409 an organisation keeps at least one active owner; 403 only an owner grants, changes or removes the owner role.                                                                                                                                                                                         |
| `invitations.errors.` `invalid` / `already-member` / `address-already-member` / `not-found` / `not-pending`                                                             | 400 a token unknown, spent, revoked, expired, or its organisation gone (one answer); 409 the accepting account is a member already; 409 the invited address is a member already; 404 no such invitation; 409 already accepted or revoked.                                                                                     |
