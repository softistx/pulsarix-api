import { dbOf } from "@alxia/tenancy";
import { fixedClock, scryptHasher } from "@softistx/janus";
import { totpCode } from "@softistx/janus/testing";
import {
  createMemoryMailer,
  type Mailer,
  type MemoryMailer,
} from "@softistx/mail";
import { createApp } from "../src/app";
import { coreMongo } from "../src/config/db";
import { createAuth } from "../src/core/auth";
import type { KernelLimits } from "../src/core/shared/limits";
import type { Media } from "../src/modules/attachments/attachments.storage";
import type { PublicIntake } from "../src/modules/intake/intake.submit";
import type { ChronixLinkFactory } from "../src/modules/time/chronix";
import { type Http, http } from "./http";

export const uiOrigin = "https://ui.pulsarix.test";

// A development sealing key, the same as .env.example's fallback.
const totpKeys = "spec:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

let counter = 0;

const nextSlug = () => {
  counter += 1;
  return `org-${Date.now().toString(36)}-${counter}`;
};
// An e-mail address no other spec uses: janus's accounts live in the run's one
// core database and specs do not clear them.
export const uniqueEmail = (name = "ada") => {
  counter += 1;
  return `${name}.${Date.now().toString(36)}.${counter}@pulsarix.test`;
};

export const specPassword = "a long password";

// The app with the REAL janus, its stores in the test core database: a memory
// mailer whose outbox a spec reads (`kit.sent` for the links in it), a fixed
// clock it moves (sessions, links and invitations expire by it), and a cheap
// hasher. Each call builds its own, so a spec moving its clock moves no other's.
// The mails nobody waits for run in `auth.background`: a spec awaits its
// `settled()` before it reads the outbox.
export function authApp(
  options: {
    mailer?: Mailer;
    media?: Media | undefined;
    intake?: PublicIntake;
    magicLink?: boolean;
    limits?: KernelLimits;
    chronix?: ChronixLinkFactory;
  } = {},
) {
  const clock = fixedClock(Date.now());
  const outbox: MemoryMailer = createMemoryMailer();
  const auth = createAuth({
    db: dbOf(coreMongo),
    mailer: options.mailer ?? outbox,
    clock,
    hasher: scryptHasher({ cost: 10 }),
    uiOrigin,
    mailFrom: "noreply@pulsarix.test",
    totpKeys,
    magicLink: options.magicLink ?? false,
  });
  const app = createApp({
    auth,
    ...("media" in options && { media: options.media }),
    ...(options.intake && { intake: options.intake }),
    ...("limits" in options && { limits: options.limits }),
    ...(options.chronix && { chronix: options.chronix }),
  });
  return {
    auth,
    app,
    outbox,
    clock,
    // A client sending the session `token` as a bearer, and the organisation as
    // x-organization-id when given; anonymous without a token.
    client: (
      token?: string | null,
      clientOptions: {
        organisation?: string;
        language?: string;
        headers?: Record<string, string>;
      } = {},
    ) => http({ app }, token ?? null, clientOptions),
    // The code the authenticator app shows for `secret` one step after the
    // clock (janus accepts a code once, and a step either side of its clock).
    nextCode: (secret: string) =>
      totpCode(secret, new Date(clock.now().getTime() + 30_000)),
    code: (secret: string) => totpCode(secret, clock.now()),
    async settled() {
      await auth.background.settled();
    },
    // The links delivered so far, read from the outbox.
    get sent() {
      return linksIn(outbox);
    },
  };
}

export type AuthApp = ReturnType<typeof authApp>;
export type { Http };

export type LinkKind = "resetPassword" | "magicLink" | "invitation";

const paths: Record<LinkKind, string> = {
  resetPassword: "/auth/reset-password",
  magicLink: "/auth/magic-link",
  invitation: "/invitations/accept",
};

export interface SentLink {
  kind: LinkKind;
  to: string;
  subject: string;
  link: string;
  token: string;
}

const addressOf = (to: unknown): string[] =>
  [to]
    .flat()
    .map((a) =>
      typeof a === "string" ? a : (a as { address: string }).address,
    );

// The links in a memory mailer's outbox, oldest first: each mail whose text
// holds a link of ours, with its kind (by path), recipient and token.
export function linksIn(mailer: MemoryMailer): SentLink[] {
  return mailer.sent.flatMap((mail) =>
    (Object.keys(paths) as LinkKind[]).flatMap((kind) => {
      const found = mail.text.match(
        new RegExp(`(${uiOrigin}${paths[kind]}\\?token=(\\S+))`),
      );
      return found?.[1] && found[2]
        ? addressOf(mail.to).map((to) => ({
            kind,
            to,
            subject: mail.subject,
            link: found[1] as string,
            token: decodeURIComponent(found[2] as string),
          }))
        : [];
    }),
  );
}

// The token of the last link of `kind` sent to `to`.
export function tokenSent(
  kit: Pick<AuthApp, "sent">,
  to: string,
  kind: LinkKind,
) {
  const link = kit.sent.findLast(
    (sent) => sent.to === to && sent.kind === kind,
  );
  if (!link) throw new Error(`no ${kind} link sent to ${to}`);
  return link.token;
}

// The query pieces every spec repeats.
export const signUpMutation = `mutation($input: SignUpInput!) {
  signUp(input: $input) { status session { token viewer { id email } } }
}`;

// A new account through the API, signed in: its session token.
export async function signedUp(kit: AuthApp, name = "Ada Lovelace") {
  const email = uniqueEmail();
  const data = await kit.client().call<{
    signUp: { session: { token: string; viewer: { id: string } } };
  }>(signUpMutation, { input: { email, password: specPassword, name } });
  return {
    email,
    name,
    id: data.signUp.session.viewer.id,
    token: data.signUp.session.token,
  };
}

export type SpecAccount = Awaited<ReturnType<typeof signedUp>>;

// A new account that creates an organisation and so owns it.
export async function ownerWithOrganisation(kit: AuthApp, name = "North Star") {
  const owner = await signedUp(kit);
  const data = await kit.client(owner.token).call<{
    createOrganisation: { organisation: { id: string; slug: string } };
  }>(
    `mutation($input: CreateOrganisationInput!) {
      createOrganisation(input: $input) { role organisation { id slug } }
    }`,
    {
      input: { name, slug: nextSlug() },
    },
  );
  return { owner, organisation: data.createOrganisation.organisation };
}

const Invite = `mutation($input: InviteMemberInput!) { inviteMember(input: $input) { id } }`;
const Accept = `mutation($token: String!, $password: String) {
  acceptInvitation(token: $token, password: $password) { signIn { session { token viewer { id } } } }
}`;

// A member of the organisation with `role`, invited by the owner and accepted
// through the API: their id and session token.
export async function memberWith(
  kit: AuthApp,
  organisation: string,
  ownerToken: string,
  role: "owner" | "admin" | "member" | "viewer",
) {
  const email = uniqueEmail(role);
  await kit.client(ownerToken, { organisation }).call(Invite, {
    input: { email, name: role, role },
  });
  const accepted = await kit.client().call<{
    acceptInvitation: {
      signIn: { session: { token: string; viewer: { id: string } } };
    };
  }>(Accept, {
    token: tokenSent(kit, email, "invitation"),
    password: specPassword,
  });
  const { token, viewer } = accepted.acceptInvitation.signIn.session;
  return { id: viewer.id, token, email };
}

// Proves an account's e-mail the way a mailed link does, server side: a second
// factor is only set up after it (`auth.errors.email-unverified`).
export async function proveEmail(kit: AuthApp, email: string) {
  const users = kit.auth.accounts.user;
  const user = await users.findByEmail(email);
  if (!user) throw new Error(`no account for ${email}`);
  if (user.emailVerified) return;
  const { token } = await users.verifyEmail.send(user);
  await users.verifyEmail.confirm(token);
}
