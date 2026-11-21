import {
  identityInvalid,
  keyDisabled,
  originNotAllowed,
} from "../intake.errors";
import type { WidgetKeyDocument } from "../models";
import { originAllowed } from "../rules/origins.rules";
import { type Identity, verifyIdentity } from "./identity.service";
import type { Caller, IntakeMongo, PublicIntake } from "./submit.service";
import type { Reporter } from "./thread.service";

// The reporter's side of the public endpoint (plan §19, A17): "My requests",
// one request with its thread, a reply, "resolved", "reopen", the read mark,
// the e-mail switch and "delete my data". Every call starts with `openSession`:
// the key, its origin, the identity token and the reporter's read limit; every
// read after it is filtered by the reporter's key and the report's id, so a
// foreign id answers the same 404 as a missing one.

// What the services below need to know of who asks: the key the report came
// in by, the organisation's database and the reporter's handle (the limits'
// key). The tracking page's is made from its token (services/requests-session.service.ts).
export interface Scope {
  key: WidgetKeyDocument;
  mongo: IntakeMongo;
  reporter: Reporter;
  organisationId: string;
}

export interface Session extends Scope {
  identity: Identity;
}

// The caller as a reporter: the address is not over its limit, the key is live
// and allows the origin, the identity token is good (401 when there is none or
// it is not), and the reporter is not over its read limit. A stream open counts
// as a read.
export async function openSession(
  intake: PublicIntake,
  publicKey: string,
  caller: Caller,
): Promise<Session> {
  await intake.guardAddress(caller.ip);
  const key = await intake.keyOf(publicKey);
  if (!originAllowed(caller.origin, key.allowedOrigins)) {
    throw originNotAllowed();
  }
  caller.originGranted = true;
  if (!key.active) throw keyDisabled();
  if (caller.identity === undefined || caller.identity === null)
    throw identityInvalid();
  const identity = verifyIdentity(caller.identity, key, intake.now());
  const reporter: Reporter = {
    keyId: key._id,
    reporterKey: identity.reporterKey,
  };
  await intake.limit((l) => l.intakeReporterRead, {
    keyId: key.id,
    reporterKey: identity.reporterKey,
  });
  intake.touch(key);
  return {
    key,
    mongo: await intake.databaseOf(key),
    reporter,
    identity,
    organisationId: key.organisationId.toHexString(),
  };
}
