export const MAX_BACKOFF_MS = 3_600_000;

/**
 * Pause before the next cycle: the poll interval, doubled per failure up to 16 times, capped at one hour.
 *
 * @param pollMs Poll interval in milliseconds
 * @param failures Number of failed cycles in a row
 */
export function nextDelay(pollMs: number, failures: number): number {
    return Math.min(pollMs * 2 ** Math.min(failures, 4), MAX_BACKOFF_MS);
}

/**
 * Runs `step` now and again after the delay it resolves with. The next run is armed only after the
 * current step settled, so runs never overlap. A rejecting step does not escape: the last known delay
 * is reused, one hour before any delay is known. Steps should still handle their own errors.
 *
 * @param step One cycle; resolves with the delay in milliseconds until the next one
 * @param timers Timer functions, generic over the handle type
 * @param timers.set Arms a timer
 * @param timers.clear Clears a timer
 */
export function startLoop<T>(
    step: () => Promise<number>,
    timers: { set: (fn: () => void, ms: number) => T; clear: (handle: T) => void },
): { stop: () => void } {
    let stopped = false;
    let handle: T | undefined;
    let lastDelay = MAX_BACKOFF_MS;
    const run = (): void => {
        handle = undefined;
        void step()
            .then(
                delay => {
                    lastDelay = delay;
                },
                () => undefined,
            )
            .then(() => {
                if (!stopped) {
                    handle = timers.set(run, lastDelay);
                }
            });
    };
    run();
    return {
        stop: () => {
            stopped = true;
            if (handle !== undefined) {
                timers.clear(handle);
                handle = undefined;
            }
        },
    };
}
