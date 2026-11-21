import { OptimisticLockError } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { CoreMongo, ModuleMongo } from "../../../config/db";
import { exhausted, invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { projectNotFound } from "../../projects/public";
import { keyNotFound } from "../intake.errors";
import type { WidgetKeyDocument } from "../models";
import { allowListOf } from "../rules/origins.rules";
import { newPublicKey } from "../utils/token.utils";
import { newIdentitySecret, sealIdentitySecret } from "./identity.service";

export type IntakeMongo = ModuleMongo<"intake">;

// The core database as the viewer: the keys are core documents.
export type KeysCore = Pick<CoreMongo, "db">;

export interface CreateWidgetKeyInput {
  projectId: string;
  label: string;
  allowedOrigins: string[];
  attachmentsEnabled?: boolean | null;
}

export interface UpdateWidgetKeyInput {
  label?: string | null;
  allowedOrigins?: string[] | null;
  active?: boolean | null;
  attachmentsEnabled?: boolean | null;
}

// The widget keys of one organisation. Every lookup names the organisation, so
// a key of another is a 404 whatever id is given.
export class WidgetKeysService {
  constructor(
    private readonly core: KeysCore,
    private readonly mongo: IntakeMongo,
    private readonly organisationId: string,
  ) {}

  private get organisation(): ObjectId {
    return idOrInvalid(this.organisationId, "organisationId");
  }

  private async own(id: string): Promise<WidgetKeyDocument> {
    const found = await this.core.db.widgetKeys.findFirst({
      _id: idOrInvalid(id, "id"),
      organisationId: this.organisation,
      revokedAt: null,
    });
    if (!found) throw keyNotFound();
    return found;
  }

  async list(projectId: string): Promise<WidgetKeyDocument[]> {
    const project = idOrInvalid(projectId, "projectId");
    if (!(await this.mongo.db.projects.exists({ _id: project }))) {
      throw projectNotFound();
    }
    return this.core.db.widgetKeys.findMany({
      filter: {
        organisationId: this.organisation,
        projectId: project,
        revokedAt: null,
      },
      sort: { _id: 1 },
    });
  }

  async create(input: CreateWidgetKeyInput): Promise<WidgetKeyDocument> {
    const project = idOrInvalid(input.projectId, "projectId");
    if (!(await this.mongo.db.projects.exists({ _id: project }))) {
      throw projectNotFound();
    }
    const label = input.label.trim();
    if (!label) {
      throw invalid([{ path: "label", code: "validation.errors.required" }]);
    }
    return this.core.db.widgetKeys.create({
      organisationId: this.organisation,
      projectId: project,
      publicKey: newPublicKey(),
      label,
      allowedOrigins: allowListOf(input.allowedOrigins),
      active: true,
      attachmentsEnabled: input.attachmentsEnabled ?? true,
      revokedAt: null,
      lastUsedAt: null,
    });
  }

  async update(
    id: string,
    input: UpdateWidgetKeyInput,
  ): Promise<WidgetKeyDocument> {
    for (const field of [
      "label",
      "allowedOrigins",
      "active",
      "attachmentsEnabled",
    ] as const) {
      if (input[field] === null) {
        throw invalid([{ path: field, code: "validation.errors.required" }]);
      }
    }
    const label = input.label?.trim();
    if (label === "") {
      throw invalid([{ path: "label", code: "validation.errors.required" }]);
    }
    const current = await this.own(id);
    try {
      return await this.core.db.widgetKeys.update(current._id, {
        ...(label && { label }),
        ...(input.allowedOrigins && {
          allowedOrigins: allowListOf(input.allowedOrigins),
        }),
        ...(input.active !== undefined &&
          input.active !== null && { active: input.active }),
        ...(input.attachmentsEnabled !== undefined &&
          input.attachmentsEnabled !== null && {
            attachmentsEnabled: input.attachmentsEnabled,
          }),
        version: current.version,
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) throw exhausted();
      throw error;
    }
  }

  // A new value for the same key: the old one is unknown from then on.
  async rotate(id: string): Promise<WidgetKeyDocument> {
    const current = await this.own(id);
    try {
      return await this.core.db.widgetKeys.update(current._id, {
        publicKey: newPublicKey(),
        version: current.version,
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) throw exhausted();
      throw error;
    }
  }

  // A new identity secret for the key: answered once, in the clear, here; only
  // its sealed form is stored. The old secret opens nothing from then on, so
  // every token signed with it is refused at once.
  async generateIdentitySecret(
    id: string,
  ): Promise<{ key: WidgetKeyDocument; secret: string }> {
    const current = await this.own(id);
    const secret = newIdentitySecret();
    try {
      const key = await this.core.db.widgetKeys.update(current._id, {
        identitySecret: sealIdentitySecret(secret, current.id),
        identitySecretSetAt: new Date(),
        version: current.version,
      });
      return { key, secret };
    } catch (error) {
      if (error instanceof OptimisticLockError) throw exhausted();
      throw error;
    }
  }

  async revoke(id: string): Promise<string> {
    const current = await this.own(id);
    await this.core.db.widgetKeys.update(current._id, {
      revokedAt: new Date(),
      active: false,
    });
    return current.id;
  }
}
