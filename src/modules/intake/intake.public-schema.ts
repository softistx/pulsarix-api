import type { GraphQLSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import { TRACKING_FILES_PATH } from "./intake.http";
import type { Caller, PublicIntake, Submitted } from "./intake.submit";

// The schema of /public/graphql: a schema of its own, apart from /graphql's, so
// that nothing of the application can be asked through it. Three fields, run as
// the persisted operations below (the endpoint accepts no other document, so no
// introspection and no query of the client's own making).
export const publicTypeDefs = /* GraphQL */ `
  type WidgetConfig {
    projectName: String
    locale: String!
    enabled: Boolean!
    "Whether to show the screenshot and file controls."
    attachments: Boolean!
  }

  enum ReportFileRole {
    screenshot
    file
  }

  "A file the report will carry: its bytes follow by PUT, one ticket each."
  input ReportFileInput {
    role: ReportFileRole!
    name: String!
    "png, jpeg or webp; a PDF for a file, never for a screenshot."
    type: String!
    "Bytes, at most 5 MB each and 12 MB together."
    size: Int!
  }

  type FileTicket {
    "The file's slot: the last segment of the PUT path."
    slot: ID!
    role: ReportFileRole!
    "The value of the x-pulsarix-ticket header of the PUT."
    ticket: String!
    expiresAt: String!
  }

  "How much the problem blocks the reporter."
  enum ReportImpact {
    blocking
    annoying
    minor
  }

  enum ReportType {
    bug
    question
    suggestion
  }

  input MetadataEntryInput {
    key: String!
    value: String!
  }

  input SubmitClientReportInput {
    title: String!
    description: String!
    email: String
    pageUrl: String
    locale: String
    impact: ReportImpact
    type: ReportType
    metadata: [MetadataEntryInput!]
    "Honeypot: a real form leaves it empty."
    website: String
    "How long the form was open before it was sent, in milliseconds."
    filledInMs: Int!
    "At most 1 screenshot and 3 files."
    files: [ReportFileInput!]
  }

  type SubmittedReport {
    reportId: ID!
    tracking: Boolean!
    files: [FileTicket!]!
  }

  type TrackedReply {
    at: String!
    body: String!
  }

  type TrackedFile {
    id: ID!
    role: String!
    name: String!
    "The path of its 256 px thumbnail (see CONTEXT.md), a picture's only; null for a PDF."
    thumbnailUrl: String
  }

  type TrackedReport {
    state: String!
    "received, inProgress, resolved or declined: the status's name never leaves."
    publicState: String!
    "Why the report was declined, when the team wrote it knowing it is shown."
    declineReason: String
    title: String!
    createdAt: String!
    replies: [TrackedReply!]!
    files: [TrackedFile!]!
  }

  type Query {
    widgetConfig(publicKey: String!): WidgetConfig!
    clientReportStatus(token: String!): TrackedReport!
  }

  type Mutation {
    submitClientReport(
      publicKey: String!
      input: SubmitClientReportInput!
    ): SubmittedReport!
  }
`;

// The operations the endpoint runs, by id. A client sends `{ "id": ...,
// "variables": ... }`, never a document.
export const persistedOperations = {
  widgetConfig: /* GraphQL */ `
    query widgetConfig($publicKey: String!) {
      widgetConfig(publicKey: $publicKey) {
        projectName
        locale
        enabled
        attachments
      }
    }
  `,
  submitClientReport: /* GraphQL */ `
    mutation submitClientReport(
      $publicKey: String!
      $input: SubmitClientReportInput!
    ) {
      submitClientReport(publicKey: $publicKey, input: $input) {
        reportId
        tracking
        files {
          slot
          role
          ticket
          expiresAt
        }
      }
    }
  `,
  clientReportStatus: /* GraphQL */ `
    query clientReportStatus($token: String!) {
      clientReportStatus(token: $token) {
        state
        publicState
        declineReason
        title
        createdAt
        replies {
          at
          body
        }
        files {
          id
          role
          name
          thumbnailUrl
        }
      }
    }
  `,
} as const;
export type PersistedId = keyof typeof persistedOperations;

export interface PublicContext {
  intake: PublicIntake;
  caller: Caller;
}

const submitted = async (pending: Promise<Submitted>) => {
  const done = await pending;
  return {
    ...done,
    files: done.files.map((file) => ({
      ...file,
      expiresAt: file.expiresAt.toISOString(),
    })),
  };
};

export function publicSchema(): GraphQLSchema {
  return createSchema<PublicContext>({
    typeDefs: publicTypeDefs,
    resolvers: {
      Query: {
        widgetConfig: (
          _: unknown,
          args: { publicKey: string },
          ctx: PublicContext,
        ) => ctx.intake.config(args.publicKey, ctx.caller),
        clientReportStatus: async (
          _: unknown,
          args: { token: string },
          ctx: PublicContext,
        ) => {
          const tracked = await ctx.intake.status(args.token, ctx.caller.ip);
          return {
            state: tracked.state,
            publicState: tracked.publicState,
            declineReason: tracked.declineReason,
            title: tracked.title,
            createdAt: tracked.createdAt.toISOString(),
            replies: tracked.replies.map((reply) => ({
              at: reply.at.toISOString(),
              body: reply.body,
            })),
            files: tracked.files.map((file) => ({
              id: file.id,
              role: file.role,
              name: file.name,
              thumbnailUrl: file.thumbnail
                ? `${TRACKING_FILES_PATH}/${file.id}`
                : null,
            })),
          };
        },
      },
      Mutation: {
        submitClientReport: (
          _: unknown,
          args: {
            publicKey: string;
            input: Parameters<PublicIntake["submit"]>[1];
          },
          ctx: PublicContext,
        ) =>
          submitted(ctx.intake.submit(args.publicKey, args.input, ctx.caller)),
      },
    },
  });
}
