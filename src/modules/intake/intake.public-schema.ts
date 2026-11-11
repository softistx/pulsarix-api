import type { GraphQLSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import type { Caller, PublicIntake } from "./intake.submit";

// The schema of /public/graphql: a schema of its own, apart from /graphql's, so
// that nothing of the application can be asked through it. Three fields, run as
// the persisted operations below (the endpoint accepts no other document, so no
// introspection and no query of the client's own making).
export const publicTypeDefs = /* GraphQL */ `
  type WidgetConfig {
    projectName: String
    locale: String!
    enabled: Boolean!
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
    metadata: [MetadataEntryInput!]
    "Honeypot: a real form leaves it empty."
    website: String
    "How long the form was open before it was sent, in milliseconds."
    filledInMs: Int!
  }

  type SubmittedReport {
    reportId: ID!
    tracking: Boolean!
  }

  type TrackedReply {
    at: String!
    body: String!
  }

  type TrackedReport {
    state: String!
    title: String!
    createdAt: String!
    replies: [TrackedReply!]!
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
      }
    }
  `,
  clientReportStatus: /* GraphQL */ `
    query clientReportStatus($token: String!) {
      clientReportStatus(token: $token) {
        state
        title
        createdAt
        replies {
          at
          body
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
            title: tracked.title,
            createdAt: tracked.createdAt.toISOString(),
            replies: tracked.replies.map((reply) => ({
              at: reply.at.toISOString(),
              body: reply.body,
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
        ) => ctx.intake.submit(args.publicKey, args.input, ctx.caller),
      },
    },
  });
}
