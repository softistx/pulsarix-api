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

  "What a reporter sees of a request: the status's name never leaves."
  enum PublicState {
    received
    inProgress
    resolved
    declined
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
    publicState: PublicState!
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
    publicState: PublicState!
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
    publicState: PublicState!
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
