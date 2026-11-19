// What the public endpoint asks of a rate limit: `consume` is the bound limit
// of @softistx/redis (src/modules/intake/intake.limits.ts).
export interface Limiter<P> {
  consume(
    params: P,
    cost?: number,
    options?: { timeoutMs?: number },
  ): Promise<{ allowed: boolean; retryAfter: number }>;
}

export interface IntakeLimits {
  intakeKey: Limiter<{ publicKey: string }>;
  intakeIpKey: Limiter<{ ip: string; publicKey: string }>;
  intakeEmail: Limiter<{ digest: string }>;
  intakeOrganisation: Limiter<{ organisationId: string }>;
  intakeReporter: Limiter<{ keyId: string; reporterKey: string }>;
  intakeReporterRead: Limiter<{ keyId: string; reporterKey: string }>;
  intakeReporterReply: Limiter<{ keyId: string; reporterKey: string }>;
  intakeKeyReply: Limiter<{ keyId: string }>;
  intakeReporterSettle: Limiter<{ keyId: string; reporterKey: string }>;
  intakeReporterErase: Limiter<{ keyId: string; reporterKey: string }>;
  intakeReadIp: Limiter<{ ip: string }>;
  intakeTrackingIp: Limiter<{ ip: string }>;
  // Bytes (the `cost` of a consume), per address and key, and per key.
  intakeUploadIpKey: Limiter<{ ip: string; keyId: string }>;
  intakeUploadKey: Limiter<{ keyId: string }>;
  // One consume per decoy slot: a replayed decoy ticket is a 409 like a real one.
  intakeDecoySlot: Limiter<{ slot: string }>;
}
