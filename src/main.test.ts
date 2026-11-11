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
    readonly objects = new Map<string, { type: string; common: Record<string, unknown> }>();
    readonly subscribed: string[] = [];
    readonly namespace = 'google-calendar.0';
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

    setObjectNotExistsAsync(id: string, object: { type: string; common: Record<string, unknown> }): Promise<void> {
        if (!this.objects.has(id)) {
            this.objects.set(id, object);
        }
        return Promise.resolve();
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

/** Instance settings that pass normalizeConfig, for tests that run onReady. */
const configured = {
    serviceAccountKey: JSON.stringify({
        client_email: 'robot@example.test',
        private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
    }),
    calendars: [{ name: 'Test', calendarId: 'c@example.test', type: 'appointment', color: '#ff0000', writable: true }],
    pollMinutes: 5,
    daysPast: 1,
    daysPreview: 7,
};

describe('draft per device', () => {
    const A = '0a1b2c3d';
    const B = 'ffff0000';
    const REQUEST = 'google-calendar.0.draft.request';
    const id = (device: string, field: string): string => `google-calendar.0.draft.${device}.${field}`;
    const user = (val: unknown): { val: unknown; ack: boolean } => ({ val, ack: false });
    const reminder = { type: 'reminder', text: 'Test', startDate: '2026-11-12', startTime: '08:00' };
    /**
     * Sets draft states of one device directly.
     *
     * @param adapter Stand-in adapter
     * @param device Device ID
     * @param draft Field values by name
     */
    function fill(adapter: FakeAdapter, device: string, draft: Record<string, unknown>): void {
        for (const [key, value] of Object.entries(draft)) {
            adapter.states.set(`draft.${device}.${key}`, value);
        }
    }
    const views = (adapter: FakeAdapter): Record<string, Record<string, unknown>> =>
        JSON.parse(String(adapter.states.get('draft.view'))) as Record<string, Record<string, unknown>>;
    /**
     * Starts an adapter and lets the given devices request their dialog.
     *
     * @param devices Devices that open the dialog
     * @param options Options of the fake Google transport
     */
    async function opened(
        devices: string[],
        options: Parameters<typeof startCycle>[0] = {},
    ): Promise<ReturnType<typeof startCycle>> {
        const setup = startCycle(options);
        for (const device of devices) {
            await setup.internals.onStateChange(REQUEST, user(device));
        }
        return setup;
    }

    describe('open request', () => {
        it('creates the states of the device, fills in defaults and opens its dialog', async () => {
            const { adapter } = await opened([A]);
            expect(adapter.objects.get(`draft.${A}`)?.type).to.equal('channel');
            for (const field of ['type', 'text', 'startDate', 'startTime', 'endDate', 'endTime', 'allDay']) {
                expect(adapter.objects.get(`draft.${A}.${field}`)?.common.write, field).to.equal(true);
            }
            expect(adapter.objects.get(`draft.${A}.save`)?.common.role).to.equal('button');
            expect(adapter.objects.get(`draft.${A}.result`)?.common.write).to.equal(false);
            expect(adapter.states.get(`draft.${A}.type`)).to.equal('reminder');
            expect(adapter.states.get(`draft.${A}.text`)).to.equal('');
            expect(adapter.states.get(`draft.${A}.startTime`)).to.match(/^\d{2}:00$/);
            expect(adapter.states.get(`draft.${A}.result`)).to.equal('');
            expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
            expect(views(adapter)).to.deep.equal({ [A]: { type: 'reminder', allDay: false, result: '' } });
        });

        it('keeps the type the device chose last time', async () => {
            const setup = startCycle();
            fill(setup.adapter, A, { type: 'birthday' });
            await setup.internals.onStateChange(REQUEST, user(A));
            expect(setup.adapter.states.get(`draft.${A}.type`)).to.equal('birthday');
            expect(views(setup.adapter)[A].type).to.equal('birthday');
        });

        it('replaces an invalid type with reminder', async () => {
            const setup = startCycle();
            fill(setup.adapter, A, { type: 'party' });
            await setup.internals.onStateChange(REQUEST, user(A));
            expect(setup.adapter.states.get(`draft.${A}.type`)).to.equal('reminder');
        });

        it('opens only the dialog of the requesting device', async () => {
            const { adapter } = await opened([A]);
            expect(adapter.states.has(`draft.${B}.open`)).to.equal(false);
        });

        it('ignores an invalid device ID and creates nothing', async () => {
            const { adapter, internals } = startCycle();
            for (const value of ['', 'ABCDEF12', '0a1b2c3', 'x.y.z.w1', '../../ab', 12345678, null, true]) {
                await internals.onStateChange(REQUEST, user(value));
            }
            expect(adapter.objects.size).to.equal(0);
            expect(adapter.writes).to.deep.equal([]);
        });

        it('ignores an acknowledged request', async () => {
            const { adapter, internals } = startCycle();
            await internals.onStateChange(REQUEST, { val: A, ack: true });
            expect(adapter.objects.size).to.equal(0);
        });
    });

    describe('save', () => {
        it('creates the entry of one device without touching the other', async () => {
            const { adapter, internals, posts, triggered } = await opened([A, B]);
            fill(adapter, A, { ...reminder, endDate: '', endTime: '', allDay: false });
            fill(adapter, B, { text: 'halb fertig' });
            await internals.onStateChange(id(A, 'save'), user(true));
            expect(posts).to.have.length(1);
            expect(posts[0].url).to.contain('/calendars/rem%40example.test/events');
            expect(adapter.states.get(`draft.${A}.result`)).to.equal('ok');
            expect(adapter.states.get(`draft.${A}.text`)).to.equal('');
            expect(adapter.states.get(`draft.${A}.open`)).to.equal(false);
            expect(adapter.states.get(`draft.${B}.text`)).to.equal('halb fertig');
            expect(adapter.states.get(`draft.${B}.open`)).to.equal(true);
            expect(views(adapter)[A].result).to.equal('ok');
            expect(views(adapter)[B].result).to.equal('');
            expect(triggered()).to.equal(1);
            expect(adapter.infos.join(' ')).to.not.contain('Test');
        });

        it('reports an invalid draft to that device only, without calling Google', async () => {
            const { adapter, internals, posts } = await opened([A, B]);
            fill(adapter, A, { ...reminder, text: '' });
            await internals.onStateChange(id(A, 'save'), user(true));
            expect(posts).to.have.length(0);
            expect(adapter.states.get(`draft.${A}.result`)).to.equal('Bitte einen Text eingeben.');
            expect(views(adapter)[A].result).to.equal('Bitte einen Text eingeben.');
            expect(views(adapter)[B].result).to.equal('');
        });

        it('reports a type without writable calendar', async () => {
            const { adapter, internals, posts } = await opened([A]);
            fill(adapter, A, { type: 'birthday', text: 'Ben', startDate: '2026-11-15' });
            await internals.onStateChange(id(A, 'save'), user(true));
            expect(posts).to.have.length(0);
            expect(adapter.states.get(`draft.${A}.result`)).to.contain('kein beschreibbarer Kalender');
        });

        it('reports a refused insert in German and keeps the dialog open', async () => {
            const { adapter, internals } = await opened([A], { insertStatus: 403 });
            fill(adapter, A, reminder);
            await internals.onStateChange(id(A, 'save'), user(true));
            expect(adapter.states.get(`draft.${A}.result`)).to.contain('Freigabe');
            expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
        });

        it('ignores acknowledged changes and false values', async () => {
            const { adapter, internals, posts } = await opened([A]);
            fill(adapter, A, reminder);
            await internals.onStateChange(id(A, 'save'), { val: true, ack: true });
            await internals.onStateChange(id(A, 'save'), user(false));
            expect(posts).to.have.length(0);
        });

        it('ignores a device that never opened the dialog', async () => {
            const { adapter, internals, posts } = startCycle();
            fill(adapter, A, reminder);
            await internals.onStateChange(id(A, 'save'), user(true));
            expect(posts).to.have.length(0);
            expect(adapter.writes).to.deep.equal([]);
        });

        it('ignores a second save of the same device while one is running', async () => {
            const { adapter, internals, posts, releaseInsert } = await opened([A], { holdInsert: true });
            fill(adapter, A, reminder);
            const first = internals.onStateChange(id(A, 'save'), user(true));
            await new Promise(resolve => setImmediate(resolve));
            await internals.onStateChange(id(A, 'save'), user(true));
            expect(adapter.states.get(`draft.${A}.result`)).to.contain('läuft');
            releaseInsert();
            await first;
            expect(posts).to.have.length(1);
        });

        it('saves two devices at the same time', async () => {
            const { adapter, internals, posts, releaseInsert } = await opened([A, B], { holdInsert: true });
            fill(adapter, A, reminder);
            fill(adapter, B, { ...reminder, text: 'Zweiter' });
            const first = internals.onStateChange(id(A, 'save'), user(true));
            const second = internals.onStateChange(id(B, 'save'), user(true));
            await new Promise(resolve => setImmediate(resolve));
            releaseInsert();
            await Promise.all([first, second]);
            expect(posts).to.have.length(2);
            expect(adapter.states.get(`draft.${A}.result`)).to.equal('ok');
            expect(adapter.states.get(`draft.${B}.result`)).to.equal('ok');
        });

        it('writes nothing after unload starts during the insert', async () => {
            const { adapter, internals, releaseInsert } = await opened([A], { holdInsert: true });
            fill(adapter, A, reminder);
            const pending = internals.onStateChange(id(A, 'save'), user(true));
            await new Promise(resolve => setImmediate(resolve));
            adapter.writes.length = 0;
            unload(adapter);
            releaseInsert();
            await pending;
            expect(adapter.writes).to.deep.equal([]);
        });
    });

    describe('view for the vis bindings', () => {
        it('follows a user change of type and all-day', async () => {
            const { adapter, internals } = await opened([A]);
            await internals.onStateChange(id(A, 'type'), user('appointment'));
            await internals.onStateChange(id(A, 'allDay'), user(true));
            expect(views(adapter)[A]).to.deep.equal({ type: 'appointment', allDay: true, result: '' });
        });

        it('ignores a field change of a device that never opened the dialog', async () => {
            const { adapter, internals } = startCycle();
            await internals.onStateChange(id(A, 'type'), user('appointment'));
            expect(adapter.writes).to.deep.equal([]);
        });

        it('keeps the devices known across a restart', async () => {
            const adapter = createAdapter({});
            adapter.states.set('draft.view', JSON.stringify({ [A]: { type: 'reminder', allDay: false, result: '' } }));
            (adapter as unknown as { config: object }).config = configured;
            await adapter.listeners.get('ready')?.(undefined);
            const internals = adapter as unknown as Internals;
            internals.loop?.stop();
            await internals.onStateChange(id(A, 'type'), user('appointment'));
            expect(views(adapter)[A].type).to.equal('appointment');
        });
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

        it('moves the end of that device when the start date passes it', async () => {
            const { adapter, internals } = await opened([A, B]);
            fill(adapter, A, before);
            fill(adapter, B, before);
            await internals.onStateChange(id(A, 'startDate'), user('2026-11-14'));
            expect(adapter.states.get(`draft.${A}.endDate`)).to.equal('2026-11-14');
            expect(adapter.states.get(`draft.${A}.endTime`)).to.equal('11:00');
            expect(adapter.states.get(`draft.${B}.endDate`)).to.equal('2026-11-11');
        });

        it('moves the end when the start time passes it', async () => {
            const { adapter, internals } = await opened([A]);
            fill(adapter, A, { ...before, endDate: '2026-11-14' });
            await internals.onStateChange(id(A, 'startTime'), user('10:00'));
            expect(adapter.states.get(`draft.${A}.endTime`)).to.equal('11:00');
        });

        it('applies the time rule when all-day is switched off', async () => {
            const { adapter, internals } = await opened([A]);
            fill(adapter, A, { ...before, endDate: '2026-11-14' });
            await internals.onStateChange(id(A, 'allDay'), user(false));
            expect(adapter.states.get(`draft.${A}.endTime`)).to.equal('11:00');
        });

        it('writes no field when the end is still after the start', async () => {
            const { adapter, internals } = await opened([A]);
            fill(adapter, A, { ...before, endDate: '2026-11-15' });
            adapter.writes.length = 0;
            await internals.onStateChange(id(A, 'startDate'), user('2026-11-14'));
            expect(adapter.writes).to.deep.equal([]);
        });

        it('ignores an acknowledged start, so its own defaults do not trigger it', async () => {
            const { adapter, internals } = await opened([A]);
            fill(adapter, A, before);
            adapter.writes.length = 0;
            await internals.onStateChange(id(A, 'startDate'), { val: '2026-11-14', ack: true });
            expect(adapter.writes).to.deep.equal([]);
        });

        it('acknowledges what it writes', async () => {
            const { adapter, internals } = await opened([A]);
            const acks: unknown[] = [];
            const write = adapter.setStateAsync.bind(adapter);
            adapter.setStateAsync = (stateId: string, value: unknown, ack?: unknown): Promise<void> => {
                acks.push(ack);
                return write(stateId, value);
            };
            fill(adapter, A, before);
            await internals.onStateChange(id(A, 'startDate'), user('2026-11-14'));
            expect(acks).to.deep.equal([true, true]);
        });

        it('writes nothing after unload starts', async () => {
            const { adapter, internals } = await opened([A]);
            fill(adapter, A, before);
            adapter.writes.length = 0;
            unload(adapter);
            await internals.onStateChange(id(A, 'startDate'), user('2026-11-14'));
            expect(adapter.writes).to.deep.equal([]);
        });
    });

    it('subscribes to the request and all draft states', async () => {
        const adapter = createAdapter({});
        (adapter as unknown as { config: object }).config = configured;
        await adapter.listeners.get('ready')?.(undefined);
        (adapter as unknown as Internals).loop?.stop();
        expect(adapter.subscribed).to.include('draft.*');
    });
});
