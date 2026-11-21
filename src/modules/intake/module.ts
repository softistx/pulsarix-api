import { defineModule } from "@softistx/alxia-modules";
import { defineCodes } from "../../i18n/define-codes";
import {
  registerCommentChange,
  registerCommentSource,
} from "../comments/public";
import { registerIssueChange } from "../issues/public";
import intakeTypeDefs from "./graphql/intake.graphqls" with { type: "text" };
import { clientMessages } from "./intake.comments";
import {
  announceIssueChange,
  announcePublicReply,
} from "./intake.live.handlers";
import {
  clientReportFiles,
  clientReportMessages,
  clientReports,
  widgetKeys,
} from "./models";
import { intakeResolvers } from "./resolvers";
import { followIssue } from "./services/closing.service";
import { mailPublicReply, mailStateChange } from "./services/notify.service";
import { clearClientWaiting } from "./services/waiting.service";

// A report follows its issue to its end (services/closing.service.ts).
registerIssueChange(followIssue);
// A public reply clears "the client is waiting" (services/waiting.service.ts), and the
// reporters' messages read as `source: CLIENT` entries of the issue's comments
// (intake.comments.ts).
registerCommentChange(clearClientWaiting);
registerCommentSource(clientMessages);
// The reporters' e-mails (services/notify.service.ts): a public reply or a move of the
// issue schedules one batched e-mail. The reporters' live streams hear the team's replies and issue moves
// (intake.live.handlers.ts).
registerCommentChange(announcePublicReply);
registerIssueChange(announceIssueChange);
registerCommentChange(mailPublicReply);
registerIssueChange(mailStateChange);

// The intake: widget keys with their allowed origins (core database), the
// client reports they bring in (organisation database), the team's inbox with
// accept and decline, and the public side (routes/public-graphql.routes.ts,
// mounted by src/app.ts at /public/graphql, which is not part of /graphql).
export const intakeModule = defineModule({
  name: "intake",
  dependsOn: [
    "access",
    "organisations",
    "projects",
    "issues",
    "comments",
    "activity",
    "attachments",
  ],
  coreCollections: { widgetKeys },
  collections: { clientReportFiles, clientReportMessages, clientReports },
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
    "identity-invalid",
    "request-declined",
    "reopen-expired",
  ]),
});
