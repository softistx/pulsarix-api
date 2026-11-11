// What other modules may import from activity.

export type { ActivityDocument, ActivityVerb } from "./activity.model";
export {
  type ActivityRecorded,
  type ActivityRecordedHandler,
  registerActivityRecorded,
} from "./activity.usage";
