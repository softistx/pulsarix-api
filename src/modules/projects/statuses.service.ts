import { ConflictError, toObjectId, toObjectIds } from "@softistx/mongo";
import {
  exhausted,
  type FieldIssue,
  invalid,
  required,
} from "../../core/shared/errors";
import { retryWriteConflicts } from "../../core/shared/locked";
import {
  statusInUse,
  statusNameTaken,
  statusNotFound,
} from "./projects.errors";
import { lockProject } from "./projects.lock";
import type {
  PublicState,
  StatusCategory,
  StatusDocument,
} from "./projects.model";
import {
  colour,
  defaultPublicState,
  publicStateOfStatus,
} from "./projects.model";
import { type ProjectsMongo, statusIsUsed } from "./projects.usage";

export interface CreateStatusInput {
  projectId: string;
  name: string;
  category: StatusCategory;
  colour: string;
  // What the reporter sees; the category's default when left out.
  publicState?: PublicState | null;
}

export interface UpdateStatusInput {
  name?: string | null;
  category?: StatusCategory | null;
  colour?: string | null;
  publicState?: PublicState | null;
}

// The workflow of the organisation's projects: their statuses, in order.
export class StatusesService {
  constructor(private readonly mongo: ProjectsMongo) {}

  list(projectId: string): Promise<StatusDocument[]> {
    return this.mongo.db.statuses.findMany({
      filter: { projectId: toObjectId(projectId) },
      sort: { order: 1 },
    });
  }

  private async byId(id: string) {
    const found = await this.mongo.db.statuses.findById(toObjectId(id));
    if (!found) throw statusNotFound();
    return found;
  }

  async create(input: CreateStatusInput): Promise<StatusDocument> {
    const name = input.name.trim();
    const issues: FieldIssue[] = [];
    if (!name)
      issues.push({ path: "name", code: "validation.errors.required" });
    if (!colour.safeParse(input.colour).success) {
      issues.push({ path: "colour", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    const projectId = toObjectId(input.projectId);
    try {
      return await retryWriteConflicts(
        () =>
          this.mongo.transaction(async (tx) => {
            await lockProject(tx, projectId);
            const last = await tx.db.statuses.findMany({
              filter: { projectId },
              sort: { order: -1 },
              limit: 1,
            });
            return tx.db.statuses.create({
              projectId,
              name,
              category: input.category,
              colour: input.colour,
              publicState:
                input.publicState ?? defaultPublicState[input.category],
              order: (last[0]?.order ?? -1) + 1,
            });
          }),
        exhausted,
      );
    } catch (error) {
      if (error instanceof ConflictError) throw statusNameTaken(name);
      throw error;
    }
  }

  async update(id: string, input: UpdateStatusInput): Promise<StatusDocument> {
    const issues: FieldIssue[] = required(input, [
      "name",
      "category",
      "colour",
      "publicState",
    ]);
    const name = input.name?.trim();
    if (name === "")
      issues.push({ path: "name", code: "validation.errors.required" });
    if (input.colour && !colour.safeParse(input.colour).success) {
      issues.push({ path: "colour", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    const status = await this.byId(id);
    try {
      return await this.mongo.db.statuses.update(status._id, {
        ...(name && { name }),
        ...(input.category && { category: input.category }),
        ...(input.colour && { colour: input.colour }),
        ...this.publicStateChange(status, input),
      });
    } catch (error) {
      if (error instanceof ConflictError) throw statusNameTaken(name ?? "");
      throw error;
    }
  }

  // The state the reporter sees after an update: the one asked for; or, when
  // the category moves and the status still wears its old category's default,
  // the new category's default; otherwise what it had.
  private publicStateChange(
    status: StatusDocument,
    input: UpdateStatusInput,
  ): { publicState?: PublicState } {
    if (input.publicState) return { publicState: input.publicState };
    if (!input.category || input.category === status.category) return {};
    const current = publicStateOfStatus(status);
    return current === defaultPublicState[status.category]
      ? { publicState: defaultPublicState[input.category] }
      : {};
  }

  // `ids` is the project's statuses, every one, in their new order.
  async reorder(projectId: string, ids: string[]): Promise<StatusDocument[]> {
    const project = toObjectId(projectId);
    return retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          await lockProject(tx, project);
          const current = await tx.db.statuses.findMany({
            filter: { projectId: project },
          });
          const wanted = new Set(ids.map((id) => id.toLowerCase()));
          const same =
            wanted.size === ids.length &&
            ids.length === current.length &&
            current.every((status) => wanted.has(status.id));
          if (!same) {
            throw invalid([{ path: "ids", code: "validation.errors.invalid" }]);
          }
          const byId = new Map(current.map((status) => [status.id, status]));
          const ordered: StatusDocument[] = [];
          for (const [order, id] of toObjectIds(ids).entries()) {
            const status = byId.get(id.toHexString());
            if (!status) continue;
            ordered.push(
              status.order === order
                ? status
                : await tx.db.statuses.update(status._id, { order }),
            );
          }
          return ordered;
        }),
      exhausted,
    );
  }

  // Refused (409 `projects.errors.status-in-use`) while anything stands on the
  // status; answers its id.
  async delete(id: string): Promise<string> {
    const status = await this.byId(id);
    await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          await lockProject(tx, status.projectId);
          if (await statusIsUsed(tx, status.id)) throw statusInUse();
          await tx.db.statuses.hardDelete(status._id);
          const rest = await tx.db.statuses.findMany({
            filter: { projectId: status.projectId },
            sort: { order: 1 },
          });
          for (const [order, other] of rest.entries()) {
            if (other.order !== order) {
              await tx.db.statuses.update(other._id, { order });
            }
          }
        }),
      exhausted,
    );
    return status.id;
  }
}
