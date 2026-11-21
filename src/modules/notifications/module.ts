import { defineModule } from "@softistx/alxia-modules";
import { registerActivityRecorded } from "../activity/public";
import notificationsTypeDefs from "./notifications.graphqls" with {
  type: "text",
};
import { notifications } from "./notifications.model";
import { recordNotifications } from "./notifications.record";
import { notificationsResolvers } from "./notifications.resolver";

// Every journalled change is turned into notifications inside the transaction
// that wrote it (notifications.rules.ts decides who is told).
registerActivityRecorded((mongo, recorded) =>
  recordNotifications(mongo, recorded),
);

// The members' notifications: mentions, assignments and changes to the issues
// they watch, with their unread count and an e-mail digest through a queue.
// Reading and marking one's own needs membership only (no permission of its
// own), and the live event is the activity module's `notificationReceived`.
export const notificationsModule = defineModule({
  name: "notifications",
  dependsOn: ["access", "organisations", "issues", "comments", "activity"],
  collections: { notifications },
  typeDefs: [notificationsTypeDefs],
  resolvers: notificationsResolvers as never,
});
