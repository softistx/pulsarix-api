// Work to do once a transaction has committed (publishing a live event). It
// never runs for a rolled-back write.
export type AfterCommit = () => Promise<void>;

// Runs them in order. One that fails is logged and skipped: the change is
// committed already, and a client reconciles by refetching after a gap.
export async function runAfterCommit(
  later: readonly AfterCommit[],
  log: (message: string, error: unknown) => void = (message, error) =>
    console.warn(message, error),
) {
  for (const work of later) {
    try {
      await work();
    } catch (error) {
      log("after-commit work failed", error);
    }
  }
}
