import { ConflictError, toObjectId } from "@softistx/mongo";
import {
  exhausted,
  type FieldIssue,
  invalid,
  required,
} from "../../../core/shared/errors";
import { retryWriteConflicts } from "../../../core/shared/locked";
import { keyTaken, projectNotFound } from "../projects.errors";
import {
  defaultPublicState,
  type ProjectDocument,
  projectKey,
} from "../projects.model";
import { defaultWorkflow } from "../projects.rules";
import type { ProjectsMongo } from "../projects.usage";

export interface CreateProjectInput {
  key: string;
  name: string;
  description?: string | null;
  leadId?: string | null;
}

export interface UpdateProjectInput {
  name?: string | null;
  description?: string | null;
  leadId?: string | null;
}

// Whether an account is a member of the organisation: a project's lead must be.
export type IsMember = (accountId: string) => Promise<boolean>;

// The projects of ONE organisation, for one request of a member (the resolver
// checked the permission). Making a project makes its default workflow with
// it, in one transaction.
export class ProjectsService {
  constructor(
    private readonly mongo: ProjectsMongo,
    private readonly isMember: IsMember,
  ) {}

  async list(includeArchived: boolean): Promise<ProjectDocument[]> {
    return this.mongo.db.projects.findMany({
      filter: includeArchived ? {} : { archivedAt: null },
      sort: { key: 1 },
    });
  }

  async byKey(key: string): Promise<ProjectDocument> {
    const found = await this.mongo.db.projects.findFirst({
      key: key.toUpperCase(),
    });
    if (!found) throw projectNotFound();
    return found;
  }

  async byId(id: string): Promise<ProjectDocument> {
    const found = await this.mongo.db.projects.findById(toObjectId(id));
    if (!found) throw projectNotFound();
    return found;
  }

  async create(input: CreateProjectInput): Promise<ProjectDocument> {
    const key = input.key.trim().toUpperCase();
    const name = input.name.trim();
    const issues: FieldIssue[] = [];
    if (!projectKey.safeParse(key).success) {
      issues.push({ path: "key", code: "validation.errors.invalid" });
    }
    if (!name)
      issues.push({ path: "name", code: "validation.errors.required" });
    if (input.leadId && !(await this.isMember(input.leadId))) {
      issues.push({ path: "leadId", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    try {
      return await retryWriteConflicts(
        () =>
          this.mongo.transaction(async (tx) => {
            if (await tx.db.projects.exists({ key })) throw keyTaken(key);
            const project = await tx.db.projects.create({
              key,
              name,
              description: input.description?.trim() ?? "",
              leadId: input.leadId ?? null,
            });
            await tx.db.statuses.createMany(
              defaultWorkflow.map((status, order) => ({
                ...status,
                publicState: defaultPublicState[status.category],
                projectId: project._id,
                order,
              })),
            );
            return project;
          }),
        exhausted,
      );
    } catch (error) {
      // The unique index is the last word when two creations race.
      if (error instanceof ConflictError) throw keyTaken(key);
      throw error;
    }
  }

  // A field left out stays as it is; null is refused for `name`. The key never
  // changes.
  async update(id: string, input: UpdateProjectInput) {
    const issues: FieldIssue[] = required(input, ["name"]);
    const name = input.name?.trim();
    if (name === "")
      issues.push({ path: "name", code: "validation.errors.required" });
    if (input.leadId && !(await this.isMember(input.leadId))) {
      issues.push({ path: "leadId", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    const project = await this.byId(id);
    return this.mongo.db.projects.update(project._id, {
      ...(name !== undefined && name !== null && { name }),
      ...(input.description != null && {
        description: input.description.trim(),
      }),
      ...(input.leadId !== undefined && { leadId: input.leadId }),
    });
  }

  // Archiving keeps everything and hides the project from the default list;
  // it is repeatable and so is its reverse.
  async setArchived(id: string, archived: boolean) {
    const project = await this.byId(id);
    if (!!project.archivedAt === archived) return project;
    return this.mongo.db.projects.update(project._id, {
      archivedAt: archived ? new Date() : null,
    });
  }
}
