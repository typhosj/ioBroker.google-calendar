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
    readonly infos: string[] = [];
    readonly states = new Map<string, unknown>();
    readonly subscribed: string[] = [];
    /** Runs before each state write; a test uses it to start unload or to fail a write. */
    beforeWrite: (id: string) => void = () => undefined;
    readonly log = {
        warn: (): void => undefined,
        info: (message: string): void => {
            this.infos.push(message);
        },
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

    getStateAsync(id: string): Promise<{ val: unknown; ack: boolean } | null> {
        return Promise.resolve(this.states.has(id) ? { val: this.states.get(id), ack: true } : null);
    }

    setStateAsync(id: string, value: unknown): Promise<void> {
        return this.write(id, value);
    }

    setStateChangedAsync(id: string, value?: unknown): Promise<void> {
        return this.write(id, value);
    }

    subscribeStatesAsync(pattern: string): Promise<void> {
        this.subscribed.push(pattern);
        return Promise.resolve();
    }

    private write(id: string, value: unknown): Promise<void> {
        return Promise.resolve().then(() => {
            this.beforeWrite(id);
            this.writes.push(id);
            const plain = value !== null && typeof value === 'object' && 'val' in value ? value.val : value;
            this.states.set(id, plain);
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
    loop: { stop: () => void; trigger: () => void } | undefined;
    onStateChange(id: string, state: { val: unknown; ack: boolean } | null | undefined): Promise<void>;
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
    writable: {
        reminder: {
            name: 'Erinnerungen',
            calendarId: 'rem@example.test',
            type: 'reminder',
            color: '#f6bf26',
            writable: true,
        },
    },
};

/**
 * Builds an adapter with a fake Google transport.
 *
 * @param options insertStatus: status of the POST answer; holdInsert: keep the POST pending until releaseInsert()
 * @param options.insertStatus Status of the POST answer
 * @param options.holdInsert Keep the POST pending until releaseInsert()
 */
function startCycle(options: { insertStatus?: number; holdInsert?: boolean } = {}): {
    adapter: FakeAdapter;
    internals: Internals;
    posts: { url: string }[];
    triggered: () => number;
    releaseInsert: () => void;
} {
    const adapter = createAdapter({});
    const internals = adapter as unknown as Internals;
    const posts: { url: string }[] = [];
    let count = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
        release = resolve;
    });
    const http: Http = (url, request) => {
        if (request?.method !== 'POST') {
            return Promise.resolve({ status: 200, body: { items: [] } });
        }
        posts.push({ url });
        const answer = { status: options.insertStatus ?? 200, body: { id: 'new1' } };
        return options.holdInsert ? held.then(() => answer) : Promise.resolve(answer);
    };
    internals.google = { settings, http, token: () => Promise.resolve('token') };
    internals.loop = {
        stop: () => undefined,
        trigger: () => {
            count++;
        },
    };
    return { adapter, internals, posts, triggered: () => count, releaseInsert: release };
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

describe('draft', () => {
    const ID = 'google-calendar.0.draft.';
    /**
     * Sets draft states directly.
     *
     * @param adapter Stand-in adapter
     * @param draft Field values by name
     */
    function fill(adapter: FakeAdapter, draft: Record<string, unknown>): void {
        for (const [key, value] of Object.entries(draft)) {
            adapter.states.set(`draft.${key}`, value);
        }
    }

    it('fills in defaults when the dialog opens', async () => {
        const { adapter, internals } = startCycle();
        await internals.onStateChange(`${ID}open`, { val: true, ack: false });
        expect(adapter.states.get('draft.text')).to.equal('');
        expect(adapter.states.get('draft.startTime')).to.match(/^\d{2}:00$/);
        expect(adapter.states.get('draft.result')).to.equal('');
    });

    it('creates a valid reminder, resets the form, closes the dialog and reads again', async () => {
        const { adapter, internals, posts, triggered } = startCycle();
        fill(adapter, {
            type: 'reminder',
            text: 'Test',
            startDate: '2026-11-12',
            startTime: '08:00',
            endDate: '',
            endTime: '',
            allDay: false,
        });
        await internals.onStateChange(`${ID}save`, { val: true, ack: false });
        expect(posts).to.have.length(1);
        expect(posts[0].url).to.contain('/calendars/rem%40example.test/events');
        expect(adapter.states.get('draft.result')).to.equal('ok');
        expect(adapter.states.get('draft.text')).to.equal('');
        expect(adapter.states.get('draft.open')).to.equal(false);
        expect(triggered()).to.equal(1);
        expect(adapter.infos.join(' ')).to.not.contain('Test');
    });

    it('reports an invalid draft without calling Google', async () => {
        const { adapter, internals, posts } = startCycle();
        fill(adapter, { type: 'reminder', text: '', startDate: '2026-11-12', startTime: '08:00' });
        await internals.onStateChange(`${ID}save`, { val: true, ack: false });
        expect(posts).to.have.length(0);
        expect(adapter.states.get('draft.result')).to.equal('Bitte einen Text eingeben.');
    });

    it('reports a type without writable calendar', async () => {
        const { adapter, internals, posts } = startCycle();
        fill(adapter, { type: 'birthday', text: 'Ben', startDate: '2026-11-15' });
        await internals.onStateChange(`${ID}save`, { val: true, ack: false });
        expect(posts).to.have.length(0);
        expect(adapter.states.get('draft.result')).to.contain('kein beschreibbarer Kalender');
    });

    it('reports a refused insert in German', async () => {
        const { adapter, internals } = startCycle({ insertStatus: 403 });
        fill(adapter, { type: 'reminder', text: 'Test', startDate: '2026-11-12', startTime: '08:00' });
        await internals.onStateChange(`${ID}save`, { val: true, ack: false });
        expect(adapter.states.get('draft.result')).to.contain('Freigabe');
        expect(adapter.states.get('draft.open')).to.not.equal(false);
    });

    it('ignores acknowledged changes and false values', async () => {
        const { internals, posts, adapter } = startCycle();
        fill(adapter, { type: 'reminder', text: 'Test', startDate: '2026-11-12', startTime: '08:00' });
        await internals.onStateChange(`${ID}save`, { val: true, ack: true });
        await internals.onStateChange(`${ID}save`, { val: false, ack: false });
        expect(posts).to.have.length(0);
    });

    it('ignores a second save while one is running', async () => {
        const { adapter, internals, posts, releaseInsert } = startCycle({ holdInsert: true });
        fill(adapter, { type: 'reminder', text: 'Test', startDate: '2026-11-12', startTime: '08:00' });
        const first = internals.onStateChange(`${ID}save`, { val: true, ack: false });
        await new Promise(resolve => setImmediate(resolve));
        await internals.onStateChange(`${ID}save`, { val: true, ack: false });
        expect(adapter.states.get('draft.result')).to.contain('läuft');
        releaseInsert();
        await first;
        expect(posts).to.have.length(1);
    });

    describe('end follows start', () => {
        const before = {
            type: 'appointment',
            startDate: '2026-11-14',
            startTime: '10:00',
            endDate: '2026-11-11',
            endTime: '09:00',
            allDay: false,
        };

        it('moves the end when the start date passes it', async () => {
            const { adapter, internals } = startCycle();
            fill(adapter, before);
            await internals.onStateChange(`${ID}startDate`, { val: '2026-11-14', ack: false });
            expect(adapter.states.get('draft.endDate')).to.equal('2026-11-14');
            expect(adapter.states.get('draft.endTime')).to.equal('11:00');
        });

        it('moves the end when the start time passes it', async () => {
            const { adapter, internals } = startCycle();
            fill(adapter, { ...before, endDate: '2026-11-14' });
            await internals.onStateChange(`${ID}startTime`, { val: '10:00', ack: false });
            expect(adapter.states.get('draft.endTime')).to.equal('11:00');
        });

        it('applies the time rule when all-day is switched off', async () => {
            const { adapter, internals } = startCycle();
            fill(adapter, { ...before, endDate: '2026-11-14' });
            await internals.onStateChange(`${ID}allDay`, { val: false, ack: false });
            expect(adapter.states.get('draft.endTime')).to.equal('11:00');
        });

        it('writes nothing when the end is still after the start', async () => {
            const { adapter, internals } = startCycle();
            fill(adapter, { ...before, endDate: '2026-11-15' });
            await internals.onStateChange(`${ID}startDate`, { val: '2026-11-14', ack: false });
            expect(adapter.writes).to.deep.equal([]);
        });

        it('ignores an acknowledged start, so its own defaults do not trigger it', async () => {
            const { adapter, internals } = startCycle();
            fill(adapter, before);
            await internals.onStateChange(`${ID}startDate`, { val: '2026-11-14', ack: true });
            expect(adapter.writes).to.deep.equal([]);
        });

        it('acknowledges what it writes', async () => {
            const { adapter, internals } = startCycle();
            const acks: unknown[] = [];
            const write = adapter.setStateAsync.bind(adapter);
            adapter.setStateAsync = (id: string, value: unknown, ack?: unknown): Promise<void> => {
                acks.push(ack);
                return write(id, value);
            };
            fill(adapter, before);
            await internals.onStateChange(`${ID}startDate`, { val: '2026-11-14', ack: false });
            expect(acks).to.deep.equal([true, true]);
        });

        it('writes nothing after unload starts', async () => {
            const { adapter, internals } = startCycle();
            fill(adapter, before);
            unload(adapter);
            await internals.onStateChange(`${ID}startDate`, { val: '2026-11-14', ack: false });
            expect(adapter.writes).to.deep.equal([]);
        });

        it('subscribes to the fields the end follows', async () => {
            const adapter = createAdapter({});
            (adapter as unknown as { config: object }).config = {
                serviceAccountKey: JSON.stringify({
                    client_email: 'robot@example.test',
                    private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
                }),
                calendars: [
                    {
                        name: 'Test',
                        calendarId: 'c@example.test',
                        type: 'appointment',
                        color: '#ff0000',
                        writable: true,
                    },
                ],
                pollMinutes: 5,
                daysPast: 1,
                daysPreview: 7,
            };
            await adapter.listeners.get('ready')?.(undefined);
            expect(adapter.subscribed).to.include.members(['draft.startDate', 'draft.startTime', 'draft.allDay']);
        });
    });

    it('writes nothing after unload starts during the insert', async () => {
        const { adapter, internals, releaseInsert } = startCycle({ holdInsert: true });
        fill(adapter, { type: 'reminder', text: 'Test', startDate: '2026-11-12', startTime: '08:00' });
        const pending = internals.onStateChange(`${ID}save`, { val: true, ack: false });
        await new Promise(resolve => setImmediate(resolve));
        adapter.writes.length = 0;
        unload(adapter);
        releaseInsert();
        await pending;
        expect(adapter.writes).to.deep.equal([]);
    });
});
