// What other modules and the server may import from notifications.

export { latestNotifications } from "./notifications.latest";

// The digest worker opens the database, the mailer and Redis, so it is loaded
// when started: a module importing this surface, or a script printing the
// schema, opens no connection.
export async function startDigestWorker() {
  const { startDigestWorker: start } = await import("./notifications.worker");
  return start();
}
