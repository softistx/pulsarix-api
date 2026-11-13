import type { ModuleMongo } from "../../config/db";
import { env } from "../../config/env";
import { idOrInvalid } from "../../core/shared/ids";
import { issueNotFound } from "../issues/public";
import {
  type ChronixActorClient,
  type ChronixLinkClient,
  ChronixLinkError,
  ChronixUnavailableError,
  type LinkTimer,
  type RefTotal,
} from "./chronix";
import { chronixClient } from "./chronix.client";
import {
  chronixFailure,
  emailUnverified,
  invalidKey,
  keyMismatch,
  notLinked,
} from "./time.errors";
import { openLinkKey, sealLinkKey } from "./time.seal";

export type TimeMongo = ModuleMongo<"time">;

// What the issue page shows of the time, never an error (see `TimeSpent`).
export type TimeSpentView =
  | { status: "UNLINKED" | "UNAVAILABLE" | "FORBIDDEN" }
  | {
      status: "AVAILABLE";
      totalSeconds: number;
      mySeconds: number;
      entryCount: number;
      running: boolean;
    };

const ISSUE = "issue";
const PARTNER_APP = "pulsarix";
const MAX_REFS = 100; // the contract's cap on `totals`

// The issue as chronix references it (§3 `ExternalRefInput`): its stable id, a
// label that survives a move or a delete, and a deep link back.
export function refOf(issue: { id: string; key: string; title: string }) {
  return {
    kind: ISSUE,
    id: issue.id,
    label: `${issue.key} ${issue.title}`,
    url: `${env.UI_ORIGIN}/issues/${issue.key}`,
  };
}

// The organisation's chronix link and the member's calls on it.
export class TimeService {
  constructor(
    private readonly mongo: TimeMongo,
    private readonly organisationId: string,
    // The acting account's e-mail: chronix's `X-Chronix-Actor`.
    private readonly actorEmail: string,
    private readonly emailVerified: boolean,
  ) {}

  private async linkDocument() {
    return this.mongo.db.timeLinks.findById("main");
  }

  async status() {
    const link = await this.linkDocument();
    return {
      linked: Boolean(link),
      organisationName: link?.organisationName ?? null,
    };
  }

  // The client of the stored key, or null when none is stored or it no longer
  // opens (a sealing key taken out of TOTP_KEYS).
  async client(): Promise<ChronixLinkClient | null> {
    const link = await this.linkDocument();
    if (!link) return null;
    const key = openLinkKey(link.sealedKey, this.organisationId);
    return key ? chronixClient({ baseUrl: env.CHRONIX_URL, key }) : null;
  }

  // Checks the key with chronix, then stores it sealed with the chronix
  // organisation's name.
  async link(key: string) {
    const client = chronixClient({ baseUrl: env.CHRONIX_URL, key: key.trim() });
    let info: Awaited<ReturnType<ChronixLinkClient["link"]>>;
    try {
      info = await client.link();
    } catch (error) {
      if (
        error instanceof ChronixLinkError &&
        error.code === "link.unauthenticated"
      ) {
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

  private async actor(): Promise<ChronixActorClient> {
    const client = await this.client();
    if (!client) throw notLinked();
    if (!this.emailVerified) throw emailUnverified();
    return client.as(this.actorEmail);
  }

  private async issue(issueId: string) {
    const issue = await this.mongo.db.issues.findById(
      idOrInvalid(issueId, "issueId"),
    );
    if (!issue) throw issueNotFound();
    return issue;
  }

  // The project's id is its chronix `partnerProjectId` (mapped in chronix).
  async startTimer(issueId: string) {
    const issue = await this.issue(issueId);
    const me = await this.actor();
    try {
      const { timer, stopped } = await me.startTimer({
        partnerProjectId: issue.projectId.toHexString(),
        externalRef: refOf(issue),
      });
      return {
        startedAt: timer.startedAt,
        stoppedSeconds: stopped?.durationSeconds ?? null,
      };
    } catch (error) {
      throw chronixFailure(error);
    }
  }

  // Stops the member's timer (chronix has one per member, whatever its issue)
  // and returns the saved entry, null when none ran.
  async stopTimer(issueId: string) {
    await this.issue(issueId);
    const me = await this.actor();
    try {
      const entry = await me.stopTimer();
      return (
        entry && {
          id: entry.id,
          date: entry.date,
          durationSeconds: entry.durationSeconds,
          description: entry.description,
          billable: entry.billable,
        }
      );
    } catch (error) {
      throw chronixFailure(error);
    }
  }

  // The member's running timer, null when none runs, nothing is linked or the
  // e-mail is unverified. Throws what chronix throws: the caller degrades.
  async runningTimer(): Promise<LinkTimer | null> {
    const client = await this.client();
    if (!client || !this.emailVerified) return null;
    return client.as(this.actorEmail).runningTimer();
  }

  async logTime(
    issueId: string,
    input: {
      date: string;
      durationSeconds: number;
      description?: string | null | undefined;
      billable?: boolean | null | undefined;
    },
  ) {
    const issue = await this.issue(issueId);
    const me = await this.actor();
    try {
      const entry = await me.logTime({
        partnerProjectId: issue.projectId.toHexString(),
        externalRef: refOf(issue),
        date: input.date,
        durationSeconds: input.durationSeconds,
        ...(input.description && { description: input.description }),
        ...(input.billable != null && { billable: input.billable }),
      });
      return {
        id: entry.id,
        date: entry.date,
        durationSeconds: entry.durationSeconds,
        description: entry.description,
        billable: entry.billable,
      };
    } catch (error) {
      throw chronixFailure(error);
    }
  }

  // The totals of these issues in one call per 100; an issue chronix did not
  // answer for is absent. Never throws for chronix: the page degrades.
  async totals(
    issueIds: readonly string[],
  ): Promise<Map<string, TimeSpentView>> {
    const views = new Map<string, TimeSpentView>();
    const set = (status: "UNLINKED" | "UNAVAILABLE" | "FORBIDDEN") => {
      for (const id of issueIds) views.set(id, { status });
    };
    let client: ChronixLinkClient | null;
    try {
      client = await this.client();
    } catch {
      set("UNAVAILABLE");
      return views;
    }
    if (!client) {
      const linked = await this.linkDocument();
      set(linked ? "UNAVAILABLE" : "UNLINKED");
      return views;
    }
    // chronix wants a verified actor on reads too: no call without one.
    if (!this.emailVerified) {
      set("FORBIDDEN");
      return views;
    }
    const me = client.as(this.actorEmail);
    try {
      for (let i = 0; i < issueIds.length; i += MAX_REFS) {
        const chunk = issueIds.slice(i, i + MAX_REFS);
        const rows = await me.totals(chunk.map((id) => ({ kind: ISSUE, id })));
        const byId = new Map<string, RefTotal>(rows.map((r) => [r.id, r]));
        for (const id of chunk) {
          const row = byId.get(id);
          views.set(
            id,
            row
              ? {
                  status: "AVAILABLE",
                  totalSeconds: row.totalSeconds,
                  mySeconds: row.actorSeconds,
                  entryCount: row.entryCount,
                  running: row.running,
                }
              : { status: "UNAVAILABLE" },
          );
        }
      }
    } catch (error) {
      const forbidden =
        error instanceof ChronixLinkError &&
        (error.code === "link.actor-not-member" ||
          error.code === "link.forbidden");
      if (
        !forbidden &&
        !(error instanceof ChronixUnavailableError) &&
        !(error instanceof ChronixLinkError)
      ) {
        throw error;
      }
      set(forbidden ? "FORBIDDEN" : "UNAVAILABLE");
    }
    return views;
  }
}
