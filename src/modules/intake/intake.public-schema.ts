import type { GraphQLSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import { TRACKING_FILES_PATH } from "./intake.http";
import {
  eraseMyData,
  markRequestRead,
  myRequests,
  openSession,
  type RequestFilter,
  reopenRequest,
  replyToRequest,
  requestOf,
  resolveRequest,
  setRequestEmails,
} from "./intake.requests";
import type { Caller, PublicIntake, Submitted } from "./intake.submit";
import {
  trackingEmails,
  trackingErase,
  trackingReopen,
  trackingReply,
  trackingResolve,
} from "./intake.tracking.actions";

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
    id: ID!
    description: String!
    impact: String
    type: String
    "The reporter's messages and the team's public replies, oldest first."
    thread: [RequestMessage!]!
    canReply: Boolean!
    canReopen: Boolean!
    resolvedAt: String
    emailsOn: Boolean!
  }

  enum RequestFilter {
    OPEN
    RESOLVED
    DECLINED
    ALL
  }

  "One request in the reporter's list."
  type RequestSummary {
    id: ID!
    title: String!
    "received, inProgress, resolved or declined."
    publicState: String!
    impact: String
    type: String
    createdAt: String!
    declineReason: String
    "The team's replies not read yet."
    unread: Int!
  }

  type RequestCounts {
    open: Int!
    resolved: Int!
    declined: Int!
    all: Int!
  }

  type MyRequests {
    nodes: [RequestSummary!]!
    counts: RequestCounts!
    "Unread replies over every request (the launcher's badge)."
    unread: Int!
    emailsOn: Boolean!
    endCursor: ID
    hasNextPage: Boolean!
  }

  type RequestFile {
    id: ID!
    name: String!
    "Its thumbnail's path (read with the identity header and the key); null for a PDF."
    thumbnailUrl: String
  }

  type RequestMessage {
    id: ID!
    "reporter or team."
    from: String!
    body: String!
    at: String!
    files: [RequestFile!]!
  }

  type RequestDetail {
    id: ID!
    title: String!
    description: String!
    publicState: String!
    impact: String
    type: String
    createdAt: String!
    declineReason: String
    unread: Int!
    thread: [RequestMessage!]!
    files: [RequestFile!]!
    canReply: Boolean!
    canReopen: Boolean!
    resolvedAt: String
    emailsOn: Boolean!
  }

  type RequestReply {
    messageId: ID!
    files: [FileTicket!]!
  }

  type UnreadCount {
    count: Int!
  }

  type ErasedData {
    requests: Int!
  }

  input RequestReplyInput {
    body: String!
    "At most 3 files, as a report's."
    files: [ReportFileInput!]
  }

  type Query {
    widgetConfig(publicKey: String!): WidgetConfig!
    "The tracking page's read. The token is the x-pulsarix-tracking header; the variable is the older way."
    clientReportStatus(token: String): TrackedReport!
    myRequests(
      publicKey: String!
      filter: RequestFilter = OPEN
      first: Int
      after: ID
    ): MyRequests!
    request(publicKey: String!, id: ID!): RequestDetail!
  }

  type Mutation {
    submitClientReport(
      publicKey: String!
      input: SubmitClientReportInput!
    ): SubmittedReport!
    replyToRequest(
      publicKey: String!
      id: ID!
      input: RequestReplyInput!
    ): RequestReply!
    resolveRequest(publicKey: String!, id: ID!): RequestSummary!
    reopenRequest(publicKey: String!, id: ID!): RequestSummary!
    markRequestRead(publicKey: String!, id: ID!): UnreadCount!
    setRequestEmails(publicKey: String!, on: Boolean!): Boolean!
    eraseMyData(publicKey: String!): ErasedData!
    "The tracking page's actions: the token is the x-pulsarix-tracking header."
    trackingReply(input: RequestReplyInput!): RequestReply!
    trackingResolve: RequestSummary!
    trackingReopen: RequestSummary!
    trackingErase: ErasedData!
    trackingEmails(on: Boolean!): Boolean!
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
    query clientReportStatus($token: String) {
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
        id
        description
        impact
        type
        thread { id from body at files { id name thumbnailUrl } }
        canReply
        canReopen
        resolvedAt
        emailsOn
      }
    }
  `,
  myRequests: /* GraphQL */ `
    query myRequests($publicKey: String!, $filter: RequestFilter, $first: Int, $after: ID) {
      myRequests(publicKey: $publicKey, filter: $filter, first: $first, after: $after) {
        nodes {
        id
        title
        publicState
        impact
        type
        createdAt
        declineReason
        unread
      }
        counts { open resolved declined all }
        unread
        emailsOn
        endCursor
        hasNextPage
      }
    }
  `,
  request: /* GraphQL */ `
    query request($publicKey: String!, $id: ID!) {
      request(publicKey: $publicKey, id: $id) {
        id title description publicState impact type createdAt declineReason unread
        thread { id from body at files { id name thumbnailUrl } }
        files { id name thumbnailUrl }
        canReply canReopen resolvedAt emailsOn
      }
    }
  `,
  replyToRequest: /* GraphQL */ `
    mutation replyToRequest($publicKey: String!, $id: ID!, $input: RequestReplyInput!) {
      replyToRequest(publicKey: $publicKey, id: $id, input: $input) {
        messageId
        files { slot role ticket expiresAt }
      }
    }
  `,
  resolveRequest: /* GraphQL */ `
    mutation resolveRequest($publicKey: String!, $id: ID!) {
      resolveRequest(publicKey: $publicKey, id: $id) {
        id
        title
        publicState
        impact
        type
        createdAt
        declineReason
        unread
      }
    }
  `,
  reopenRequest: /* GraphQL */ `
    mutation reopenRequest($publicKey: String!, $id: ID!) {
      reopenRequest(publicKey: $publicKey, id: $id) {
        id
        title
        publicState
        impact
        type
        createdAt
        declineReason
        unread
      }
    }
  `,
  markRequestRead: /* GraphQL */ `
    mutation markRequestRead($publicKey: String!, $id: ID!) {
      markRequestRead(publicKey: $publicKey, id: $id) { count }
    }
  `,
  setRequestEmails: /* GraphQL */ `
    mutation setRequestEmails($publicKey: String!, $on: Boolean!) {
      setRequestEmails(publicKey: $publicKey, on: $on)
    }
  `,
  eraseMyData: /* GraphQL */ `
    mutation eraseMyData($publicKey: String!) {
      eraseMyData(publicKey: $publicKey) { requests }
    }
  `,
  trackingReply: /* GraphQL */ `
    mutation trackingReply($input: RequestReplyInput!) {
      trackingReply(input: $input) {
        messageId
        files { slot role ticket expiresAt }
      }
    }
  `,
  trackingResolve: /* GraphQL */ `
    mutation trackingResolve {
      trackingResolve {
        id
        title
        publicState
        impact
        type
        createdAt
        declineReason
        unread
      }
    }
  `,
  trackingReopen: /* GraphQL */ `
    mutation trackingReopen {
      trackingReopen {
        id
        title
        publicState
        impact
        type
        createdAt
        declineReason
        unread
      }
    }
  `,
  trackingErase: /* GraphQL */ `
    mutation trackingErase {
      trackingErase { requests }
    }
  `,
  trackingEmails: /* GraphQL */ `
    mutation trackingEmails($on: Boolean!) {
      trackingEmails(on: $on)
    }
  `,
} as const;
export type PersistedId = keyof typeof persistedOperations;

// The operations of the tracking page: for the UI server only (no `Origin`,
// the client header), the tracking token in `x-pulsarix-tracking`.
export const trackingOperations: ReadonlySet<PersistedId> = new Set([
  "clientReportStatus",
  "trackingReply",
  "trackingResolve",
  "trackingReopen",
  "trackingErase",
  "trackingEmails",
]);

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
        myRequests: async (
          _: unknown,
          args: {
            publicKey: string;
            filter?: RequestFilter | null;
            first?: number | null;
            after?: string | null;
          },
          ctx: PublicContext,
        ) =>
          myRequests(
            await openSession(ctx.intake, args.publicKey, ctx.caller),
            args,
          ),
        request: async (
          _: unknown,
          args: { publicKey: string; id: string },
          ctx: PublicContext,
        ) =>
          requestOf(
            ctx.intake,
            await openSession(ctx.intake, args.publicKey, ctx.caller),
            args.id,
          ),
        widgetConfig: (
          _: unknown,
          args: { publicKey: string },
          ctx: PublicContext,
        ) => ctx.intake.config(args.publicKey, ctx.caller),
        clientReportStatus: async (
          _: unknown,
          args: { token?: string | null },
          ctx: PublicContext,
        ) => {
          const tracked = await ctx.intake.status(
            ctx.caller.tracking ?? args.token ?? "",
            ctx.caller.ip,
          );
          const { request } = tracked;
          return {
            id: request.id,
            description: request.description,
            impact: request.impact,
            type: request.type,
            thread: request.thread,
            canReply: request.canReply,
            canReopen: request.canReopen,
            resolvedAt: request.resolvedAt,
            emailsOn: request.emailsOn,
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
        replyToRequest: async (
          _: unknown,
          args: {
            publicKey: string;
            id: string;
            input: Parameters<typeof replyToRequest>[3];
          },
          ctx: PublicContext,
        ) => {
          const session = await openSession(
            ctx.intake,
            args.publicKey,
            ctx.caller,
          );
          const reply = await replyToRequest(
            ctx.intake,
            session,
            args.id,
            args.input,
          );
          return {
            ...reply,
            files: reply.files.map((file) => ({
              ...file,
              expiresAt: file.expiresAt.toISOString(),
            })),
          };
        },
        resolveRequest: async (
          _: unknown,
          args: { publicKey: string; id: string },
          ctx: PublicContext,
        ) =>
          resolveRequest(
            ctx.intake,
            await openSession(ctx.intake, args.publicKey, ctx.caller),
            args.id,
          ),
        reopenRequest: async (
          _: unknown,
          args: { publicKey: string; id: string },
          ctx: PublicContext,
        ) =>
          reopenRequest(
            ctx.intake,
            await openSession(ctx.intake, args.publicKey, ctx.caller),
            args.id,
          ),
        markRequestRead: async (
          _: unknown,
          args: { publicKey: string; id: string },
          ctx: PublicContext,
        ) =>
          markRequestRead(
            ctx.intake,
            await openSession(ctx.intake, args.publicKey, ctx.caller),
            args.id,
          ),
        setRequestEmails: async (
          _: unknown,
          args: { publicKey: string; on: boolean },
          ctx: PublicContext,
        ) =>
          setRequestEmails(
            await openSession(ctx.intake, args.publicKey, ctx.caller),
            args.on,
          ),
        eraseMyData: async (
          _: unknown,
          args: { publicKey: string },
          ctx: PublicContext,
        ) =>
          eraseMyData(
            ctx.intake,
            await openSession(ctx.intake, args.publicKey, ctx.caller),
          ),
        trackingReply: async (
          _: unknown,
          args: { input: Parameters<typeof trackingReply>[3] },
          ctx: PublicContext,
        ) => {
          const reply = await trackingReply(
            ctx.intake,
            ctx.caller.tracking ?? null,
            ctx.caller.ip,
            args.input,
          );
          return {
            ...reply,
            files: reply.files.map((file) => ({
              ...file,
              expiresAt: file.expiresAt.toISOString(),
            })),
          };
        },
        trackingResolve: (_: unknown, __: unknown, ctx: PublicContext) =>
          trackingResolve(
            ctx.intake,
            ctx.caller.tracking ?? null,
            ctx.caller.ip,
          ),
        trackingReopen: (_: unknown, __: unknown, ctx: PublicContext) =>
          trackingReopen(
            ctx.intake,
            ctx.caller.tracking ?? null,
            ctx.caller.ip,
          ),
        trackingErase: (_: unknown, __: unknown, ctx: PublicContext) =>
          trackingErase(ctx.intake, ctx.caller.tracking ?? null, ctx.caller.ip),
        trackingEmails: (
          _: unknown,
          args: { on: boolean },
          ctx: PublicContext,
        ) =>
          trackingEmails(
            ctx.intake,
            ctx.caller.tracking ?? null,
            ctx.caller.ip,
            args.on,
          ),
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
