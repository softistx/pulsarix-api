import { serverAuth } from "../../config/auth";
import { coreMongo, tenancy } from "../../config/db";
import { env } from "../../config/env";
import { mailer } from "../../config/mail";
import { realtime } from "../../config/redis";
import type { NotificationsMongo } from "./services";
import { type DigestDeps, sendDigest } from "./services";

// The digest's reach into the running server: the organisation databases
// through the process's tenancy store, the accounts and memberships through
// janus, the mail through the server's mailer.
export function serverDigestDeps(): DigestDeps {
  const auth = serverAuth();
  return {
    mongo: async (organisationId) =>
      (await tenancy.databaseOf(
        organisationId,
      )) as unknown as NotificationsMongo,
    organisationName: async (organisationId) =>
      (await coreMongo.db.organisations.findById(organisationId))?.name ?? null,
    isMember: async (organisationId, accountId) =>
      (await auth.membership.roleOf(organisationId, accountId)) !== null,
    accounts: async (ids) =>
      new Map(
        (await auth.accounts.user.findMany(ids)).map((account) => [
          account.id,
          {
            name: account.name,
            email: account.email,
            locale: account.locale,
          },
        ]),
      ),
    mailer,
    from: { name: "pulsarix", address: env.MAIL_FROM },
    uiOrigin: env.UI_ORIGIN,
  };
}

// Starts the worker that mails the digests (the server calls it once; it is
// closed with the Redis, on stop). Without Redis there is no queue and no
// digest: only in development, since production requires REDIS_URL.
export function startDigestWorker(log = console.warn) {
  const queue = realtime.queues?.notificationDigest;
  if (!queue) {
    log("no REDIS_URL: notification digests are not sent");
    return null;
  }
  const deps = serverDigestDeps();
  const worker = queue.work(
    ({ data }) => sendDigest(deps, data).then(() => {}),
    {
      concurrency: 2,
    },
  );
  worker.on("error", (error) => log("notification digest worker", error));
  return worker;
}
