import { tenancy } from "../src/config/db";
import type { IntakeKit } from "./intake";

export const trackingToken = (kit: IntakeKit) => {
  const mail = kit.mailer.sent.at(-1);
  const found = mail?.text.match(/\/track\/(\S+)/);
  if (!found?.[1]) throw new Error("no tracking link was mailed");
  return found[1];
};

export const reportsOf = async (kit: IntakeKit) => {
  const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
    db: {
      clientReports: {
        findMany: (q: object) => Promise<Record<string, unknown>[]>;
      };
    };
  };
  return mongo.db.clientReports.findMany({});
};
