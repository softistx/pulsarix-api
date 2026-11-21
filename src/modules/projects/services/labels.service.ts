import { ConflictError, toObjectId } from "@softistx/mongo";
import {
  exhausted,
  type FieldIssue,
  invalid,
  required,
} from "../../../core/shared/errors";
import { retryWriteConflicts } from "../../../core/shared/locked";
import {
  labelNameTaken,
  labelNotFound,
  projectNotFound,
} from "../projects.errors";
import { colour, type LabelDocument } from "../projects.model";
import { LABELS_ORDER } from "../projects.search";
import { labelRemoved, type ProjectsMongo } from "../projects.usage";

export interface CreateLabelInput {
  projectId: string;
  name: string;
  colour: string;
}

export interface UpdateLabelInput {
  name?: string | null;
  colour?: string | null;
}

// The labels of the organisation's projects.
export class LabelsService {
  constructor(private readonly mongo: ProjectsMongo) {}

  list(projectId: string): Promise<LabelDocument[]> {
    return this.mongo.db.labels.findMany({
      filter: { projectId: toObjectId(projectId) },
      ...LABELS_ORDER,
    });
  }

  private async byId(id: string) {
    const found = await this.mongo.db.labels.findById(toObjectId(id));
    if (!found) throw labelNotFound();
    return found;
  }

  async create(input: CreateLabelInput): Promise<LabelDocument> {
    const name = input.name.trim();
    const issues: FieldIssue[] = [];
    if (!name)
      issues.push({ path: "name", code: "validation.errors.required" });
    if (!colour.safeParse(input.colour).success) {
      issues.push({ path: "colour", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    const projectId = toObjectId(input.projectId);
    if (!(await this.mongo.db.projects.exists({ _id: projectId }))) {
      throw projectNotFound();
    }
    try {
      return await this.mongo.db.labels.create({
        projectId,
        name,
        colour: input.colour,
      });
    } catch (error) {
      if (error instanceof ConflictError) throw labelNameTaken(name);
      throw error;
    }
  }

  async update(id: string, input: UpdateLabelInput): Promise<LabelDocument> {
    const issues: FieldIssue[] = required(input, ["name", "colour"]);
    const name = input.name?.trim();
    if (name === "")
      issues.push({ path: "name", code: "validation.errors.required" });
    if (input.colour && !colour.safeParse(input.colour).success) {
      issues.push({ path: "colour", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    const label = await this.byId(id);
    try {
      return await this.mongo.db.labels.update(label._id, {
        ...(name && { name }),
        ...(input.colour && { colour: input.colour }),
      });
    } catch (error) {
      if (error instanceof ConflictError) throw labelNameTaken(name ?? "");
      throw error;
    }
  }

  // Answers the label's id. The issues that carry it let it go in the same
  // transaction (`registerLabelRemoval`).
  async delete(id: string): Promise<string> {
    const label = await this.byId(id);
    await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          await labelRemoved(tx, label.id);
          await tx.db.labels.hardDelete(label._id);
        }),
      exhausted,
    );
    return label.id;
  }
}
