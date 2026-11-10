import { expect } from 'chai';

import { MAX_BACKOFF_MS, nextDelay, startLoop } from './loop';

/** Timers that run nothing by themselves: the test fires them. */
function fakeTimers(): {
    set: (fn: () => void, ms: number) => number;
    clear: (handle: number) => void;
    pending: Map<number, { fn: () => void; ms: number }>;
} {
    const pending = new Map<number, { fn: () => void; ms: number }>();
    let next = 1;
    return {
        pending,
        set: (fn, ms) => {
            pending.set(next, { fn, ms });
            return next++;
        },
        clear: handle => {
            pending.delete(handle);
        },
    };
}

/** A step the test settles by hand. */
function manualStep(): {
    step: () => Promise<number>;
    calls: () => number;
    resolve: (ms: number) => void;
    reject: () => void;
} {
    let calls = 0;
    let resolve: (ms: number) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    return {
        step: () => {
            calls++;
            return new Promise<number>((res, rej) => {
                resolve = res;
                reject = rej;
            });
        },
        calls: () => calls,
        resolve: ms => resolve(ms),
        reject: () => reject(new Error('boom')),
    };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('nextDelay', () => {
    it('doubles per failure up to 16 times the interval', () => {
        expect(nextDelay(60_000, 0)).to.equal(60_000);
        expect(nextDelay(60_000, 1)).to.equal(120_000);
        expect(nextDelay(60_000, 4)).to.equal(960_000);
        expect(nextDelay(60_000, 5)).to.equal(960_000);
        expect(nextDelay(60_000, 1000)).to.equal(960_000);
    });

    it('never exceeds one hour', () => {
        expect(nextDelay(3_600_000, 0)).to.equal(MAX_BACKOFF_MS);
        expect(nextDelay(3_600_000, 1000)).to.equal(MAX_BACKOFF_MS);
    });
});

describe('startLoop', () => {
    it('arms exactly one timer with the delay the step returned', async () => {
        const timers = fakeTimers();
        const s = manualStep();
        startLoop(s.step, timers);
        s.resolve(1234);
        await flush();
        expect([...timers.pending.values()].map(t => t.ms)).to.deep.equal([1234]);
    });

    it('does not arm a timer or start a second step while a step is pending', async () => {
        const timers = fakeTimers();
        const s = manualStep();
        startLoop(s.step, timers);
        await flush();
        expect(timers.pending.size).to.equal(0);
        expect(s.calls()).to.equal(1);
    });

    it('runs the next step only when the timer fires', async () => {
        const timers = fakeTimers();
        const s = manualStep();
        startLoop(s.step, timers);
        s.resolve(10);
        await flush();
        [...timers.pending.values()][0].fn();
        expect(s.calls()).to.equal(2);
    });

    it('arms no timer when stopped during a pending step', async () => {
        const timers = fakeTimers();
        const s = manualStep();
        const loop = startLoop(s.step, timers);
        loop.stop();
        s.resolve(10);
        await flush();
        expect(timers.pending.size).to.equal(0);
    });

    it('clears an armed timer on stop', async () => {
        const timers = fakeTimers();
        const s = manualStep();
        const loop = startLoop(s.step, timers);
        s.resolve(10);
        await flush();
        expect(timers.pending.size).to.equal(1);
        loop.stop();
        expect(timers.pending.size).to.equal(0);
    });

    it('survives a rejecting step and retries with the last delay (one hour before any delay is known)', async () => {
        const timers = fakeTimers();
        const s = manualStep();
        startLoop(s.step, timers);
        s.reject();
        await flush();
        expect([...timers.pending.values()].map(t => t.ms)).to.deep.equal([MAX_BACKOFF_MS]);
        [...timers.pending.values()][0].fn();
        s.resolve(500);
        await flush();
        [...timers.pending.values()].forEach(t => t.fn());
        s.reject();
        await flush();
        expect([...timers.pending.values()].map(t => t.ms)).to.include(500);
    });
});
