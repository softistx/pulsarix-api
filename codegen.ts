import type { CodegenConfig } from "@graphql-codegen/cli";
import { codegenScalars } from "@nxgt/graphql-scalars";

// `bun run generate` writes, from every src/**/*.graphqls and the SDL of
// @nxgt/graphql-scalars and @constraint (generated/graphql/):
// - src/generated/graphql/resolvers.ts: the schema's types and `Resolvers`,
//   whose context is the app's own (`Context`, src/http/context.ts). A module maps
//   a type to the document its collection stores with `mappers`.
// - src/generated/graphql/zod.ts: the Zod schemas of the inputs.
const schema = ["src/**/*.graphqls", "generated/graphql/**/*.graphqls"];

const config: CodegenConfig = {
  schema,
  ignoreNoDocuments: true,
  generates: {
    "src/generated/graphql/resolvers.ts": {
      plugins: ["typescript", "typescript-resolvers"],
      config: {
        contextType: "@/http/context#Context",
        scalars: codegenScalars,
        useTypeImports: true,
        useIndexSignature: true,
        enumsAsTypes: true,
        mappers: {
          Viewer: "@/core/auth/viewer#ViewerModel",
          Organisation:
            "@/core/organisations/organisations.model#OrganisationDocument",
          Member: "@/core/members/members.service#MemberView",
          Invitation: "@/core/invitations/invitations.issue#InvitationDocument",
          MyOrganisation:
            "@/core/organisations/organisations.model#MyOrganisationView",
          SignInPayload: "@/core/accounts/accounts.utils#SignInResult",
          Session: "@/core/accounts/accounts.utils#SessionPayload",
          Project: "@/modules/projects/projects.model#ProjectDocument",
          Status: "@/modules/projects/projects.model#StatusDocument",
          Label: "@/modules/projects/projects.model#LabelDocument",
          Issue: "@/modules/issues/issues.model#IssueDocument",
          IssueConnection: "@/modules/issues/issues.query#IssuePage",
          Comment: "@/modules/comments/comments.sources#CommentEntry",
          CommentConnection: "@/modules/comments/comments.service#CommentPage",
          Attachment:
            "@/modules/attachments/attachments.model#AttachmentDocument",
          Activity: "@/modules/activity/activity.model#ActivityDocument",
          ActivityConnection:
            "@/modules/activity/activity.service#ActivityPage",
          Notification:
            "@/modules/notifications/notifications.model#NotificationDocument",
          NotificationConnection:
            "@/modules/notifications/notifications.service#NotificationPage",
          WidgetKey: "@/modules/intake/intake.model#WidgetKeyDocument",
          ClientReport: "@/modules/intake/intake.model#ClientReportDocument",
          ClientReportFile:
            "@/modules/intake/intake.model#ClientReportFileDocument",
          ClientReportConnection: "@/modules/intake/intake.reports#ReportPage",
          TimeSpent: "@/modules/time/time.model#TimeSpentParent",
          AcceptInvitationPayload:
            "@/core/invitations/invitations.acceptance#AcceptedInvitation",
        },
      },
    },
    "src/generated/graphql/zod.ts": {
      plugins: ["@nxgt/graphql-codegen-zod"],
      config: { scalarSchemas: "@nxgt/graphql-scalars" },
    },
  },
};

export default config;
