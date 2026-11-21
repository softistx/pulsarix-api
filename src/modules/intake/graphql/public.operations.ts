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
