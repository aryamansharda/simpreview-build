export const workflowHeartbeatIntervalMs = 15 * 60 * 1000;

type TimerHandle = { unref?: () => unknown };
type HeartbeatScheduler = {
  every(callback: () => void, intervalMs: number): TimerHandle;
  cancel(handle: TimerHandle): void;
};

const defaultScheduler: HeartbeatScheduler = {
  every: (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Keep the durable workflow record fresh while xcodebuild or an upload is in
 * progress. Failures are deliberately best-effort: the build's real result is
 * more useful than replacing it with a transient heartbeat error.
 */
export function startWorkflowHeartbeat(
  heartbeat: () => Promise<unknown>,
  scheduler: HeartbeatScheduler = defaultScheduler,
) {
  let active = true;
  let running = false;
  const timer = scheduler.every(() => {
    if (!active || running) return;
    running = true;
    void heartbeat()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, workflowHeartbeatIntervalMs);
  timer.unref?.();

  return () => {
    active = false;
    scheduler.cancel(timer);
  };
}
