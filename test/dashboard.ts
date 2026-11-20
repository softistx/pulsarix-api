import { ObjectId } from "mongodb";
import { tenancy } from "../src/config/db";
import { startOfDayIn } from "../src/core/shared/days";
import { authApp, memberWith, signedUp } from "./auth";

// What the dashboard specs share: an organisation (in any time zone), its
// projects with their statuses, and issues, reports and notifications written
// straight into its database, cloned from one made through the API so that
// they carry every field a real one has.
export const Dashboard = `query($first: Int, $after: String, $latest: Int) {
  dashboard {
    timeZone today
    assigned(first: $first, after: $after) {
      nodes { issue { id key } status { id category } projectKey late }
      totalCount lateCount endCursor hasNextPage
    }
    inbox(latest: $latest) { unread latest { id issueKey } }
    projects { project { id key } open urgent late }
    triage { project { key } issues newReports }
  }
}`;

export interface Figures {
  project: { id: string; key: string };
  open: number;
  urgent: number;
  late: number;
}
export interface Assigned {
  nodes: { issue: { id: string; key: string }; late: boolean }[];
  totalCount: number;
  lateCount: number;
  endCursor: string | null;
  hasNextPage: boolean;
}
export interface DashboardData {
  dashboard: {
    timeZone: string;
    today: string;
    assigned: Assigned;
    inbox: { unread: number; latest: { id: string; issueKey: string }[] };
    projects: Figures[];
    triage:
      | { project: { key: string }; issues: number; newReports: number }[]
      | null;
  };
}

const CreateOrganisation = `mutation($input: CreateOrganisationInput!) {
  createOrganisation(input: $input) { organisation { id } }
}`;
const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id key }
}`;
const Statuses = `query($key: String!) { project(key: $key) { statuses { id category } } }`;
const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id }
}`;

let counter = 0;
export const DAY = 86_400_000;

export async function setup(timeZone = "UTC") {
  const kit = authApp();
  const owner = await signedUp(kit);
  counter += 1;
  const { createOrganisation } = await kit
    .client(owner.token)
    .call<{ createOrganisation: { organisation: { id: string } } }>(
      CreateOrganisation,
      {
        input: {
          name: "Dash",
          slug: `dash-${Date.now().toString(36)}-${counter}`,
          timeZone,
        },
      },
    );
  return workspace(kit, owner, createOrganisation.organisation, timeZone);
}

type Kit = ReturnType<typeof authApp>;

// The helpers over an organisation that exists already.
export async function workspace(
  kit: Kit,
  owner: { id: string; token: string },
  organisation: { id: string },
  timeZone = "UTC",
) {
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const mongo = await tenancy.databaseOf(organisation.id);
  const startOfToday = startOfDayIn(timeZone, new Date());

  const project = async (key: string) => {
    const { createProject: made } = await asOwner.call<{
      createProject: { id: string; key: string };
    }>(CreateProject, { input: { key, name: `Project ${key}` } });
    const { project: read } = await asOwner.call<{
      project: { statuses: { id: string; category: string }[] };
    }>(Statuses, { key });
    const status = (category: string) => {
      const found = read.statuses.find((s) => s.category === category);
      if (!found) throw new Error(category);
      return found.id;
    };
    // One issue through the API, the template of the ones written raw.
    const { createIssue } = await asOwner.call<{ createIssue: { id: string } }>(
      CreateIssue,
      { input: { projectId: made.id, title: "template" } },
    );
    const template = await mongo.db.issues.raw.findOne({
      _id: new ObjectId(createIssue.id),
    });
    if (!template) throw new Error("template");
    await mongo.db.issues.raw.deleteOne({ _id: template._id });
    let number = 1_000;
    // `count` issues of one status, each field given or computed from its index.
    const issues = async (
      category: string,
      count: number,
      fields: (n: number) => Record<string, unknown> = () => ({}),
    ) => {
      const docs = Array.from({ length: count }, (_, n) => {
        number += 1;
        return {
          ...template,
          _id: new ObjectId(),
          number,
          key: `${key}-${number}`,
          statusId: new ObjectId(status(category)),
          ...fields(n),
        };
      });
      await mongo.db.issues.raw.insertMany(docs as never);
      return docs.map((d) => d._id.toHexString());
    };
    return { ...made, status, issues };
  };

  // `count` new reports of a project, cloned from one a reporter sent.
  const reports = async (projectId: string, count: number) => {
    const template = await mongo.db.clientReports.raw.findOne({
      projectId: new ObjectId(projectId),
    });
    const docs = Array.from({ length: count }, () => ({
      ...template,
      _id: new ObjectId(),
      projectId: new ObjectId(projectId),
      state: "new",
      trackingTokenHash: null,
    }));
    await mongo.db.clientReports.raw.insertMany(docs as never);
  };

  const member = (role: "member" | "viewer") =>
    memberWith(kit, organisation.id, owner.token, role);
  return {
    kit,
    owner,
    organisation,
    as,
    asOwner,
    mongo,
    startOfToday,
    project,
    reports,
    member,
  };
}
