import { createHmac } from "node:crypto";
import { goodReport, type IntakeKit } from "~/intake";
import { tenancy } from "../src/config/db";
import { IDENTITY_HEADER } from "../src/modules/intake/services/identity.service";

export const Generate = `mutation($keyId: ID!) {
  generateWidgetIdentitySecret(keyId: $keyId) {
    secret key { id identitySecretSetAt }
  }
}`;

export const generate = async (kit: IntakeKit) =>
  (
    await kit.asOwner.call<{
      generateWidgetIdentitySecret: { secret: string };
    }>(Generate, { keyId: kit.key.id })
  ).generateWidgetIdentitySecret.secret;

export const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");
export const now = () => Math.floor(Date.now() / 1000);

// What the host's server does: the payload segment, signed.
export function token(
  secret: string,
  kit: IntakeKit,
  claims: Record<string, unknown> = {},
) {
  const iat = now();
  const body = b64(
    JSON.stringify({
      sub: "user-42",
      email: "ada@host.test",
      name: "Ada",
      aud: kit.key.publicKey,
      iat,
      exp: iat + 3600,
      ...claims,
    }),
  );
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64(signature)}`;
}

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

export const identified = (kit: IntakeKit, value: string) =>
  kit.submit(goodReport(), { [IDENTITY_HEADER]: value });
