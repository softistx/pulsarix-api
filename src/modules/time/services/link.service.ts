import {
  type ChronixLinkClient,
  isChronixLinkError,
} from "@softistx/chronix-react/server";
import type { ModuleMongo } from "../../../config/db";
import { env } from "../../../config/env";
import { chronixClient } from "../chronix.client";
import { chronixFailure, invalidKey, keyMismatch } from "../time.errors";
import { openLinkKey, sealLinkKey } from "../utils/seal.utils";

export type TimeMongo = ModuleMongo<"time">;

const PARTNER_APP = "pulsarix";

// The organisation's chronix link: its sealed key and the client it opens.
export class TimeLink {
  constructor(
    private readonly mongo: TimeMongo,
    private readonly organisationId: string,
  ) {}

  async document() {
    return this.mongo.db.timeLinks.findById("main");
  }

  async status() {
    const link = await this.document();
    return {
      linked: Boolean(link),
      organisationName: link?.organisationName ?? null,
    };
  }

  // The client of the stored key, or null when none is stored or it no longer
  // opens (a sealing key taken out of TOTP_KEYS).
  async client(): Promise<ChronixLinkClient | null> {
    const link = await this.document();
    if (!link) return null;
    const key = openLinkKey(link.sealedKey, this.organisationId);
    return key ? chronixClient({ baseUrl: env.CHRONIX_URL, key }) : null;
  }

  // Checks the key with chronix, then stores it sealed with the chronix
  // organisation's name.
  async link(key: string) {
    // An empty key is refused before anything is sent or sealed.
    if (!key.trim()) throw invalidKey();
    const client = chronixClient({ baseUrl: env.CHRONIX_URL, key: key.trim() });
    let info: Awaited<ReturnType<ChronixLinkClient["link"]>>;
    try {
      info = await client.link();
    } catch (error) {
      if (isChronixLinkError(error, "link.unauthenticated")) {
        throw invalidKey();
      }
      throw chronixFailure(error);
    }
    // The key must be made for this application and this organisation.
    if (
      info.partnerApp !== PARTNER_APP ||
      info.partnerOrganisationId !== this.organisationId
    ) {
      throw keyMismatch();
    }
    await this.mongo.db.timeLinks.upsert(
      { _id: "main" },
      {
        sealedKey: sealLinkKey(key.trim(), this.organisationId),
        organisationName: info.organisationName,
      },
    );
    return this.status();
  }

  async unlink() {
    await this.mongo.db.timeLinks.hardDeleteMany({ _id: "main" });
    return this.status();
  }
}
