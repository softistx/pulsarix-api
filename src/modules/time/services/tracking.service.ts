import type {
  ChronixActorClient,
  LinkTimer,
} from "@softistx/chronix-react/server";
import { idOrInvalid } from "../../../core/shared/ids";
import { issueNotFound } from "../../issues/public";
import { isProjectArchived } from "../../projects/public";
import {
  chronixFailure,
  emailUnverified,
  notLinked,
  pulsarixProjectArchived,
} from "../time.errors";
import { loggedOf } from "../utils/logged.utils";
import { isOnIssue, refOf } from "../utils/ref.utils";
import type { TimeLink, TimeMongo } from "./link.service";

// The member's calls on chronix: the timer and the manual log.
export class TimeTracking {
  constructor(
    private readonly mongo: TimeMongo,
    private readonly link: TimeLink,
    // The acting account's e-mail: chronix's `X-Chronix-Actor`.
    private readonly actorEmail: string,
    private readonly emailVerified: boolean,
  ) {}

  private async actor(): Promise<ChronixActorClient> {
    const client = await this.link.client();
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

  // Starts and logs are refused on an archived project; a stop is not, so a
  // timer started before the archive can still be stopped.
  private async activeIssue(issueId: string) {
    const issue = await this.issue(issueId);
    if (await isProjectArchived(this.mongo, issue.projectId)) {
      throw pulsarixProjectArchived();
    }
    return issue;
  }

  // The project's id is its chronix `partnerProjectId` (mapped in chronix).
  async startTimer(issueId: string) {
    const issue = await this.activeIssue(issueId);
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

  // Stops the member's timer only when it runs on this issue: a stale tab on
  // issue A must not stop the timer started on issue B. The saved entry, null
  // when no timer runs or it runs elsewhere. The timer can change between the
  // two chronix calls: accepted.
  async stopTimer(issueId: string) {
    const issue = await this.issue(issueId);
    const me = await this.actor();
    try {
      if (!isOnIssue(await me.runningTimer(), issue.id)) return null;
      const entry = await me.stopTimer();
      return entry && loggedOf(entry);
    } catch (error) {
      throw chronixFailure(error);
    }
  }

  // The member's running timer, null when none runs, nothing is linked or the
  // e-mail is unverified. Throws what chronix throws: the caller degrades.
  async runningTimer(): Promise<LinkTimer | null> {
    const client = await this.link.client();
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
    const issue = await this.activeIssue(issueId);
    const me = await this.actor();
    try {
      const entry = await me.logTime({
        partnerProjectId: issue.projectId.toHexString(),
        externalRef: refOf(issue),
        date: input.date,
        durationSeconds: input.durationSeconds,
        ...(input.description && { description: input.description }),
        ...(input.billable !== undefined &&
          input.billable !== null && { billable: input.billable }),
      });
      return loggedOf(entry);
    } catch (error) {
      throw chronixFailure(error);
    }
  }
}
