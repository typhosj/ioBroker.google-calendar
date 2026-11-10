import { expect } from 'chai';
import { createRequire } from 'node:module';
import type { Settings } from './lib/config';
import type { Http } from './lib/http';
import type { TokenSource } from './lib/auth';

/** Stand-in for the adapter-core base class: records state writes and runs a hook before each one. */
class FakeAdapter {
    readonly listeners = new Map<string, (arg: unknown) => unknown>();
    readonly writes: string[] = [];
    readonly errors: string[] = [];
    /** Runs before each state write; a test uses it to start unload or to fail a write. */
    beforeWrite: (id: string) => void = () => undefined;
    readonly log = {
        warn: (): void => undefined,
        info: (): void => undefined,
        debug: (): void => undefined,
        error: (message: string): void => {
            this.errors.push(message);
        },
    };

    constructor(_options: object) {
        // The real base class connects to the controller; nothing to do here.
    }

    on(event: string, handler: (arg: unknown) => unknown): this {
        this.listeners.set(event, handler);
        return this;
    }

    setStateChangedAsync(id: string): Promise<void> {
        return Promise.resolve().then(() => {
            this.beforeWrite(id);
            this.writes.push(id);
        });
    }

    setTimeout(): undefined {
        return undefined;
    }

    clearTimeout(): void {
        return undefined;
    }
}

/** The private members the cycle needs; set directly because the class is not exported. */
interface Internals {
    google: { settings: Settings; http: Http; token: TokenSource } | undefined;
    cycle(): Promise<number>;
}

// Load main.ts against the stand-in instead of the real adapter-core, then restore the module cache.
const load = createRequire(__filename);
const corePath = load.resolve('@iobroker/adapter-core');
load.cache[corePath] = {
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: { Adapter: FakeAdapter },
} as unknown as NodeJS.Module;
const mainModule: unknown = load('./main');
delete load.cache[corePath];
const createAdapter = mainModule as (options: object) => FakeAdapter;

const settings: Settings = {
    key: null,
    calendars: [
        {
            name: 'Test',
            calendarId: 'calendar@example.test',
            type: 'appointment',
            color: '#ff0000',
            writable: false,
        },
    ],
    pollMs: 60_000,
    daysPast: 1,
    daysPreview: 7,
};

function startCycle(): { adapter: FakeAdapter; internals: Internals } {
    const adapter = createAdapter({});
    const internals = adapter as unknown as Internals;
    internals.google = {
        settings,
        http: () => Promise.resolve({ status: 200, body: { items: [] } }),
        token: () => Promise.resolve('token'),
    };
    return { adapter, internals };
}

function unload(adapter: FakeAdapter): void {
    adapter.listeners.get('unload')?.(() => undefined);
}

describe('cycle and unload', () => {
    it('writes the table while running', async () => {
        const { adapter, internals } = startCycle();
        await internals.cycle();
        expect(adapter.writes).to.include('table');
        expect(adapter.errors).to.deep.equal([]);
    });

    it('does not write the table when unload starts during the connection write', async () => {
        const { adapter, internals } = startCycle();
        adapter.beforeWrite = id => {
            if (id === 'info.connection') {
                unload(adapter);
            }
        };
        await internals.cycle();
        expect(adapter.writes).to.not.include('table');
    });

    it('logs no cycle error when a table write fails during unload', async () => {
        const { adapter, internals } = startCycle();
        adapter.beforeWrite = id => {
            if (id === 'table') {
                unload(adapter);
                throw new Error('states database closed');
            }
        };
        await internals.cycle();
        expect(adapter.errors).to.deep.equal([]);
    });

    it('logs a cycle error when a table write fails while running', async () => {
        const { adapter, internals } = startCycle();
        adapter.beforeWrite = id => {
            if (id === 'table') {
                throw new Error('states database closed');
            }
        };
        await internals.cycle();
        expect(adapter.errors).to.have.length(1);
        expect(adapter.errors[0]).to.contain('Calendar cycle failed');
    });
});
