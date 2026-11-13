import type { Resolvers } from "@/generated/graphql/resolvers";
import { permissionsOfAccount, requireViewer } from "../access";
import { consumeOrRefuse, throttleIp } from "../shared/throttle";

// The account flows are anonymous by nature (sign-up, sign-in, links, the
// second factor's challenge); `viewer` reads the context's viewer and refuses
// nothing; the others need a viewer (401 `auth.errors.unauthenticated`).
export const accounts: Resolvers = {
  Query: {
    viewer: (_, __, ctx) => ctx.viewer,
    authConfig: (_, __, ctx) => ({ magicLink: ctx.services.signIn.magicLink }),
  },
  Viewer: {
    language: ({ locale }) => (locale ? (locale === "en" ? "EN" : "FR") : null),
    permissions: () => [...permissionsOfAccount()],
  },
  Mutation: {
    signUp: async (_, { input }, ctx) => {
      await throttleIp(ctx.services.limits?.signUpIp, ctx.ip);
      return ctx.services.signIn.signUp(input);
    },
    signIn: (_, { input }, ctx) => ctx.services.signIn.signIn(input),
    confirmSecondFactor: (_, { challenge, code }, ctx) =>
      ctx.services.signIn.confirmSecondFactor(challenge, code),
    recoverSecondFactor: (_, { challenge, recoveryCode }, ctx) =>
      ctx.services.signIn.recoverSecondFactor(challenge, recoveryCode),
    enrollSecondFactor: (_, __, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).enrollSecondFactor(),
    activateSecondFactor: (_, { code }, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).activateSecondFactor(code),
    disableSecondFactor: (_, __, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).disableSecondFactor(),
    requestMagicLink: (_, { email }, ctx) =>
      ctx.services.signIn.requestMagicLink(email),
    confirmMagicLink: (_, { token }, ctx) =>
      ctx.services.signIn.confirmMagicLink(token),
    requestPasswordReset: (_, { email }, ctx) =>
      ctx.services.signIn.requestPasswordReset(email),
    resetPassword: (_, { token, password }, ctx) =>
      ctx.services.signIn.resetPassword(token, password),
    requestEmailVerification: async (_, __, ctx) => {
      const viewer = requireViewer(ctx);
      const limit = ctx.services.limits?.emailVerificationAccount;
      if (limit) {
        await consumeOrRefuse(
          limit,
          { accountId: viewer.id },
          "email-verification",
        );
      }
      return ctx.services.viewer(viewer).requestEmailVerification();
    },
    confirmEmailVerification: (_, { token }, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).confirmEmailVerification(token),
    updateViewer: (_, { input }, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).update(input),
    changePassword: (_, { input }, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).changePassword(input),
    requestStepUp: (_, __, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).requestStepUp(),
    confirmStepUp: (_, { challenge, code }, ctx) =>
      ctx.services.viewer(requireViewer(ctx)).confirmStepUp(challenge, code),
    signOut: (_, __, ctx) => ctx.services.signIn.signOut(),
  },
};
