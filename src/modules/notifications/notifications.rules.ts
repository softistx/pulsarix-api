import type { FieldChange } from "../../core/shared/changes";
import type { ActivityVerb } from "../activity/activity.model";
import type { NotificationKind } from "./notifications.model";

// What a notification is decided from: the journal row's verb, who acted, the
// issue as it now stands and, for a comment, the members it mentions.
export interface NotifyEvent {
  verb: ActivityVerb;
  actorId: string;
  assigneeId: string | null;
  watcherIds: readonly string[];
  changes: readonly FieldChange[];
  mentionIds: readonly string[];
}

const strength: Record<NotificationKind, number> = {
  mention: 3,
  assigned: 2,
  watchedChange: 1,
};

// Who is told of an event, and why: at most one kind per recipient (the
// strongest), and never the actor.
//
// - a new comment: the members it mentions, then the issue's watchers;
// - an edited comment: its mentions only (the row dedupes the ones already told);
// - an issue created or changed: the assignee when it is a new one, then the
//   watchers of a change or a move;
// - a deleted issue or comment: nobody.
export function recipientsOf(
  event: NotifyEvent,
): Map<string, NotificationKind> {
  const found = new Map<string, NotificationKind>();
  const tell = (recipientId: string | null, kind: NotificationKind) => {
    if (!recipientId || recipientId === event.actorId) return;
    const held = found.get(recipientId);
    if (!held || strength[kind] > strength[held]) found.set(recipientId, kind);
  };
  switch (event.verb) {
    case "commented":
      for (const id of event.mentionIds) tell(id, "mention");
      for (const id of event.watcherIds) tell(id, "watchedChange");
      break;
    case "commentEdited":
      for (const id of event.mentionIds) tell(id, "mention");
      break;
    case "created":
      tell(event.assigneeId, "assigned");
      break;
    case "updated":
    case "moved":
      if (event.changes.some((change) => change.field === "assigneeId")) {
        tell(event.assigneeId, "assigned");
      }
      for (const id of event.watcherIds) tell(id, "watchedChange");
      break;
    default:
      break;
  }
  return found;
}
