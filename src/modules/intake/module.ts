import { defineModule } from "@alxia/modules";
import { defineCodes } from "../../i18n/define-codes";
import { registerIssueChange } from "../issues/public";
import { followIssue } from "./intake.closing";
import intakeTypeDefs from "./intake.graphqls" with { type: "text" };
import { clientReportFiles, clientReports, widgetKeys } from "./intake.model";
import { intakeResolvers } from "./intake.resolver";

// A report follows its issue to its end (intake.closing.ts).
registerIssueChange(followIssue);

// The intake: widget keys with their allowed origins (core database), the
// client reports they bring in (organisation database), the team's inbox with
// accept and decline, and the public side (src/modules/intake/intake.routes.ts,
// mounted by src/app.ts at /public/graphql, which is not part of /graphql).
export const intakeModule = defineModule({
  name: "intake",
  dependsOn: [
    "access",
    "organisations",
    "projects",
    "issues",
    "comments",
    "attachments",
  ],
  coreCollections: { widgetKeys },
  collections: { clientReportFiles, clientReports },
  typeDefs: [intakeTypeDefs],
  resolvers: intakeResolvers as never,
  // Keys are managed by admins; the inbox is worked with `issue:write`.
  permissions: ["intake:manage"],
  defaultGrants: { admin: ["intake:manage"] },
  codes: defineCodes("intake", [
    "unknown-key",
    "origin-not-allowed",
    "key-disabled",
    "too-many-requests",
    "unavailable",
    "persisted-only",
    "unsupported-media",
    "too-fast",
    "key-not-found",
    "not-found",
    "report-decided",
    "invalid-origin",
    "file-unsupported-type",
    "file-undecodable",
    "file-too-large",
    "file-too-many-pixels",
    "attachments-disabled",
    "too-many-files",
    "files-too-large",
    "ticket-invalid",
    "ticket-expired",
    "ticket-used",
    "upload-mismatch",
    "quarantine-full",
    "file-not-found",
  ]),
});
