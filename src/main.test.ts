import { expect } from 'chai';
import { createRequire } from 'node:module';
import type { CalendarConfig, Settings } from './lib/config';
import type { Http } from './lib/http';
import type { Row } from './lib/rows';
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
    rowsByCalendar: Map<string, Row[]>;
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

interface Call {
    method: string;
    url: string;
    body?: string;
}

/**
 * Builds an adapter with a fake Google transport.
 *
 * @param options Answers of the fake transport and the settings to use
 * @param options.insertStatus Status of the POST answer
 * @param options.holdInsert Keep the POST pending until releaseInsert()
 * @param options.patchStatus Status of a PATCH answer
 * @param options.holdDelete Keep the DELETE pending until releaseDelete()
 * @param options.deleteStatus Status of a DELETE answer
 * @param options.master Body of a GET of one event; none answers 404
 * @param options.settings Settings instead of the default ones
 */
function startCycle(
    options: {
        insertStatus?: number;
        holdInsert?: boolean;
        patchStatus?: number;
        deleteStatus?: number;
        holdDelete?: boolean;
        master?: unknown;
        settings?: Settings;
    } = {},
): {
    adapter: FakeAdapter;
    internals: Internals;
    posts: { url: string }[];
    calls: Call[];
    triggered: () => number;
    releaseInsert: () => void;
    releaseDelete: () => void;
} {
    const adapter = createAdapter({});
    const internals = adapter as unknown as Internals;
    const posts: { url: string }[] = [];
    const calls: Call[] = [];
    let count = 0;
    let release: () => void = () => undefined;
    let releaseDeleteFn: () => void = () => undefined;
    const heldDelete = new Promise<void>(resolve => {
        releaseDeleteFn = resolve;
    });
    const held = new Promise<void>(resolve => {
        release = resolve;
    });
    const http: Http = (url, request) => {
        const method = request?.method ?? 'GET';
        calls.push({ method, url, body: request?.body });
        if (method === 'GET') {
            return Promise.resolve(
                new URL(url).pathname.includes('/events/')
                    ? { status: options.master ? 200 : 404, body: options.master ?? null }
                    : { status: 200, body: { items: [] } },
            );
        }
        if (method === 'PATCH') {
            return Promise.resolve({ status: options.patchStatus ?? 200, body: { id: 'patched' } });
        }
        if (method === 'DELETE') {
            const answer = { status: options.deleteStatus ?? 204, body: null };
            return options.holdDelete ? heldDelete.then(() => answer) : Promise.resolve(answer);
        }
        posts.push({ url });
        const answer = { status: options.insertStatus ?? 200, body: { id: 'new1' } };
        return options.holdInsert ? held.then(() => answer) : Promise.resolve(answer);
    };
    internals.google = { settings: options.settings ?? settings, http, token: () => Promise.resolve('token') };
    internals.loop = {
        stop: () => undefined,
        trigger: () => {
            count++;
        },
    };
    return {
        adapter,
        internals,
        posts,
        calls,
        triggered: () => count,
        releaseInsert: release,
        releaseDelete: releaseDeleteFn,
    };
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
            expect(views(adapter)).to.deep.equal({
                [A]: { type: 'reminder', allDay: false, result: '', editing: false, confirmDelete: false },
            });
            expect(adapter.states.get(`draft.${A}.target`)).to.equal('');
            expect(adapter.objects.get(`draft.${A}.delete`)?.common.role).to.equal('button');
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

        it('handles a vis-2 instance ID with a dot, creating the level above it', async () => {
            const DOT = 'a.f1fa48';
            const { adapter, internals, posts } = await opened([DOT]);
            expect(adapter.objects.get('draft.a')?.type).to.equal('folder');
            expect(adapter.objects.get(`draft.${DOT}`)?.type).to.equal('channel');
            expect(adapter.states.get(`draft.${DOT}.open`)).to.equal(true);
            expect(views(adapter)[DOT].type).to.equal('reminder');
            fill(adapter, DOT, reminder);
            await internals.onStateChange(id(DOT, 'save'), user(true));
            expect(posts).to.have.length(1);
            expect(adapter.states.get(`draft.${DOT}.result`)).to.equal('ok');
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
            expect(adapter.writes.every(written => written === 'draft.request')).to.equal(true);
            expect(adapter.states.get('draft.request')).to.equal('');
        });

        it('clears the request once handled, so the vis button does not stay active', async () => {
            const { adapter } = await opened([A]);
            expect(adapter.states.get('draft.request')).to.equal('');
            expect(adapter.writes.at(-1)).to.equal('draft.request');
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
            expect(views(adapter)[A]).to.deep.equal({
                type: 'appointment',
                allDay: true,
                result: '',
                editing: false,
                confirmDelete: false,
            });
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

    describe('edit and delete', () => {
        const EDIT = 'google-calendar.0.draft.edit';
        const local = (y: number, m: number, d: number, h = 0, min = 0): string =>
            new Date(y, m - 1, d, h, min).toISOString();
        const calendar = (name: string, type: CalendarConfig['type'], writable = true): CalendarConfig => ({
            name,
            calendarId: `${name.toLowerCase()}@example.test`,
            type,
            color: '#123456',
            writable,
        });
        const termine = calendar('Termine', 'appointment');
        const erinnerungen = calendar('Erinnerungen', 'reminder');
        const geburtstage = calendar('Geburtstage', 'birthday');
        const privat = calendar('Privat', 'appointment', false);
        const all: Settings = {
            ...settings,
            calendars: [termine, erinnerungen, geburtstage, privat],
            writable: { appointment: termine, reminder: erinnerungen, birthday: geburtstage },
        };
        function row(cal: CalendarConfig, patch: Partial<Row>): Row {
            return {
                date: '',
                event: 'Zahnarzt',
                _date: local(2026, 11, 19, 18, 0),
                _end: local(2026, 11, 19, 19, 0),
                _allDay: false,
                _calName: cal.name,
                _calColor: cal.color,
                _class: `ical_${cal.name}`,
                _IDID: 'ev1',
                _calId: cal.calendarId,
                _recurringEventId: '',
                _type: cal.type,
                ...patch,
            };
        }
        const appointment = row(termine, {});
        const birthday = row(geburtstage, {
            event: 'Oma',
            _IDID: 's1_20261115',
            _recurringEventId: 's1',
            _allDay: true,
            _date: local(2026, 11, 15),
            _end: local(2026, 11, 16),
        });
        const foreign = row(privat, { _IDID: 'p1' });
        const tap = (device: string, r: Row): { val: unknown; ack: boolean } =>
            user(JSON.stringify({ instance: device, event: r }));
        /**
         * Adapter with all three writable calendars and the given rows read.
         *
         * @param rows Rows of the last read
         * @param options Options of the fake Google transport
         */
        function withRows(rows: Row[], options: Parameters<typeof startCycle>[0] = {}): ReturnType<typeof startCycle> {
            const setup = startCycle({ settings: all, ...options });
            for (const r of rows) {
                setup.internals.rowsByCalendar.set(r._calId, [
                    ...(setup.internals.rowsByCalendar.get(r._calId) ?? []),
                    r,
                ]);
            }
            return setup;
        }
        /**
         * Starts an adapter and lets device A tap the row.
         *
         * @param r Tapped row
         * @param options Options of the fake Google transport
         */
        async function editing(
            r: Row,
            options: Parameters<typeof startCycle>[0] = {},
        ): Promise<ReturnType<typeof startCycle>> {
            const setup = withRows([appointment, birthday, foreign], options);
            await setup.internals.onStateChange(EDIT, tap(A, r));
            return setup;
        }
        const target = (adapter: FakeAdapter): unknown =>
            JSON.parse((adapter.states.get(`draft.${A}.target`) as string) || 'null');

        describe('open', () => {
            it('creates the states, fills the draft from the own row and opens the dialog', async () => {
                const { adapter } = await editing({ ...appointment, event: 'from the payload, ignored' });
                expect(adapter.objects.get(`draft.${A}.target`)?.common.write).to.equal(false);
                expect(adapter.states.get(`draft.${A}.text`)).to.equal('Zahnarzt');
                expect(adapter.states.get(`draft.${A}.type`)).to.equal('appointment');
                expect(adapter.states.get(`draft.${A}.startDate`)).to.equal('2026-11-19');
                expect(adapter.states.get(`draft.${A}.startTime`)).to.equal('18:00');
                expect(adapter.states.get(`draft.${A}.endTime`)).to.equal('19:00');
                expect(adapter.states.get(`draft.${A}.allDay`)).to.equal(false);
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('');
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
                expect(target(adapter)).to.deep.equal({
                    calendarId: termine.calendarId,
                    eventId: 'ev1',
                    type: 'appointment',
                    seriesId: '',
                });
                expect(views(adapter)[A]).to.deep.equal({
                    type: 'appointment',
                    allDay: false,
                    result: '',
                    editing: true,
                    confirmDelete: false,
                });
                expect(adapter.states.get('draft.edit')).to.equal('');
            });

            it('takes the birth date from the series master', async () => {
                const { adapter, calls } = await editing(birthday, {
                    master: { id: 's1', summary: 'Oma', start: { date: '1950-11-15' }, end: { date: '1950-11-16' } },
                });
                expect(calls.some(c => c.method === 'GET' && c.url.endsWith('/events/s1'))).to.equal(true);
                expect(adapter.states.get(`draft.${A}.startDate`)).to.equal('1950-11-15');
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
            });

            it('opens nothing when the series master cannot be read, so a save cannot move the birthday', async () => {
                const { adapter } = await editing(birthday);
                expect(adapter.states.get(`draft.${A}.open`)).to.not.equal(true);
                expect(adapter.states.get('draft.edit')).to.equal('');
            });

            it('opens nothing for a read-only calendar, an unknown row or a broken request', async () => {
                const setup = withRows([appointment, foreign]);
                const requests = [
                    tap(A, foreign),
                    tap(A, { ...appointment, _IDID: 'unknown' }),
                    tap(A, { ...appointment, _calId: 'other@example.test' }),
                    tap('ABCDEF12', appointment),
                    user('not json'),
                    user(''),
                    user(null),
                ];
                for (const request of requests) {
                    await setup.internals.onStateChange(EDIT, request);
                }
                expect(setup.adapter.objects.size).to.equal(0);
                expect(setup.adapter.states.get('draft.edit')).to.equal('');
                expect(setup.calls.filter(c => c.method !== 'GET')).to.deep.equal([]);
            });

            it('ignores an acknowledged tap', async () => {
                const setup = withRows([appointment]);
                await setup.internals.onStateChange(EDIT, {
                    val: JSON.stringify({ instance: A, event: appointment }),
                    ack: true,
                });
                expect(setup.adapter.objects.size).to.equal(0);
            });

            it('forgets the target when the same browser asks for a new entry', async () => {
                const { adapter, internals } = await editing(appointment);
                await internals.onStateChange(REQUEST, user(A));
                expect(adapter.states.get(`draft.${A}.target`)).to.equal('');
                expect(views(adapter)[A]).to.include({ editing: false, confirmDelete: false });
            });
        });

        describe('save', () => {
            it('patches title and times of the entry and closes the dialog', async () => {
                const { adapter, internals, calls, posts, triggered } = await editing(appointment);
                fill(adapter, A, { text: 'Zahnarzt neu', startTime: '17:00' });
                await internals.onStateChange(id(A, 'save'), user(true));
                const patch = calls.find(c => c.method === 'PATCH');
                expect(patch?.url).to.contain('/calendars/termine%40example.test/events/ev1');
                expect(JSON.parse(patch?.body ?? '')).to.deep.equal({
                    summary: 'Zahnarzt neu',
                    start: { dateTime: new Date(2026, 10, 19, 17, 0).toISOString(), date: null },
                    end: { dateTime: new Date(2026, 10, 19, 19, 0).toISOString(), date: null },
                });
                expect(posts).to.deep.equal([]);
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('ok');
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(false);
                expect(adapter.states.get(`draft.${A}.target`)).to.equal('');
                expect(views(adapter)[A].editing).to.equal(false);
                expect(triggered()).to.equal(1);
                expect(adapter.infos.join(' ')).to.not.contain('Zahnarzt');
            });

            it('patches a birthday as a series', async () => {
                const { adapter, internals, calls } = await editing(birthday, {
                    master: { id: 's1', summary: 'Oma', start: { date: '1950-11-15' }, end: { date: '1950-11-16' } },
                });
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(calls.find(c => c.method === 'PATCH')?.url).to.match(/\/events\/s1$/);
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('ok');
            });

            it('validates like a new entry and calls nothing on invalid input', async () => {
                const { adapter, internals, calls } = await editing(appointment);
                fill(adapter, A, { endTime: '17:00' });
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(calls.filter(c => c.method === 'PATCH')).to.deep.equal([]);
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('Bitte ein Ende nach dem Beginn wählen.');
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
            });

            it('says an entry is gone on 404 and keeps the dialog open', async () => {
                const { adapter, internals } = await editing(appointment, { patchStatus: 404 });
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('Diesen Eintrag gibt es nicht mehr.');
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
            });

            it('moves a changed type: inserts in the new calendar, then deletes the old entry', async () => {
                const { adapter, internals, calls, posts } = await editing(appointment);
                fill(adapter, A, { type: 'reminder' });
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(posts[0].url).to.contain('/calendars/erinnerungen%40example.test/events');
                const removed = calls.find(c => c.method === 'DELETE');
                expect(removed?.url).to.contain('/calendars/termine%40example.test/events/ev1');
                expect(calls.findIndex(c => c.method === 'POST')).to.be.below(
                    calls.findIndex(c => c.method === 'DELETE'),
                );
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('ok');
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(false);
            });

            it('keeps editing the new entry when the old one cannot be deleted', async () => {
                const { adapter, internals, triggered } = await editing(appointment, { deleteStatus: 500 });
                fill(adapter, A, { type: 'reminder' });
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(adapter.states.get(`draft.${A}.result`)).to.equal(
                    'Neuer Eintrag angelegt, der alte konnte nicht gelöscht werden.',
                );
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
                expect(target(adapter)).to.deep.equal({
                    calendarId: erinnerungen.calendarId,
                    eventId: 'new1',
                    type: 'reminder',
                    seriesId: '',
                });
                expect(triggered()).to.equal(1);
            });

            it('changes nothing when the insert of a type change fails', async () => {
                const { adapter, internals, calls } = await editing(appointment, { insertStatus: 403 });
                fill(adapter, A, { type: 'reminder' });
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(calls.filter(c => c.method === 'DELETE')).to.deep.equal([]);
                expect(adapter.states.get(`draft.${A}.result`)).to.contain('Freigabe');
                expect(target(adapter)).to.include({ eventId: 'ev1' });
            });
        });

        describe('target check', () => {
            const GONE = 'Diesen Eintrag gibt es nicht mehr.';
            const writes = (calls: Call[]): Call[] => calls.filter(c => c.method !== 'GET');
            /**
             * Changes the settings of a running adapter, as after a restart with a new configuration.
             *
             * @param internals Adapter internals
             * @param changed New settings
             */
            function reconfigure(internals: Internals, changed: Settings): void {
                if (internals.google) {
                    internals.google.settings = changed;
                }
            }
            /**
             * Opens the appointment for editing, then replaces the stored target of device A.
             *
             * @param value Raw value of `draft.<A>.target`
             * @param options Options of the fake Google transport
             */
            async function forged(
                value: unknown,
                options: Parameters<typeof startCycle>[0] = {},
            ): Promise<ReturnType<typeof startCycle>> {
                const setup = await editing(appointment, options);
                setup.adapter.states.set(`draft.${A}.target`, value);
                return setup;
            }
            const forgedBirthday = JSON.stringify({
                calendarId: termine.calendarId,
                eventId: 'ev1',
                type: 'birthday',
                seriesId: 'series9',
            });
            const elsewhere = JSON.stringify({
                calendarId: 'old@example.test',
                eventId: 'ev1',
                type: 'appointment',
                seriesId: '',
            });

            it('refuses to save an entry whose calendar is no longer configured for its type', async () => {
                const { adapter, internals, calls } = await editing(appointment);
                const moved = calendar('Neu', 'appointment');
                reconfigure(internals, { ...all, calendars: [moved, erinnerungen], writable: { appointment: moved } });
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(writes(calls)).to.deep.equal([]);
                expect(adapter.states.get(`draft.${A}.result`)).to.equal(GONE);
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
            });

            it('refuses to delete an entry whose calendar is no longer configured for its type', async () => {
                const { adapter, internals, calls } = await editing(appointment);
                reconfigure(internals, { ...all, writable: { reminder: erinnerungen, birthday: geburtstage } });
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(id(A, 'delete'), user(true));
                expect(writes(calls)).to.deep.equal([]);
                expect(views(adapter)[A].confirmDelete).to.equal(false);
            });

            it('neither saves nor deletes a forged or stale target', async () => {
                for (const value of [forgedBirthday, elsewhere]) {
                    const save = await forged(value);
                    fill(save.adapter, A, { type: 'birthday' });
                    await save.internals.onStateChange(id(A, 'save'), user(true));
                    expect(writes(save.calls), value).to.deep.equal([]);
                    expect(save.adapter.states.get(`draft.${A}.result`), value).to.equal(GONE);

                    const remove = await forged(value);
                    await remove.internals.onStateChange(id(A, 'delete'), user(true));
                    await remove.internals.onStateChange(id(A, 'delete'), user(true));
                    expect(writes(remove.calls), value).to.deep.equal([]);
                    expect(views(remove.adapter)[A].confirmDelete, value).to.equal(false);
                }
            });

            it('reports a broken target as gone instead of creating a duplicate', async () => {
                for (const value of ['{', '[]', '{}', 'null', JSON.stringify({ type: 'appointment' }), 42, true]) {
                    const { adapter, internals, calls, posts } = await forged(value);
                    await internals.onStateChange(id(A, 'save'), user(true));
                    expect(posts, String(value)).to.deep.equal([]);
                    expect(writes(calls), String(value)).to.deep.equal([]);
                    expect(adapter.states.get(`draft.${A}.result`), String(value)).to.equal(GONE);
                }
            });

            it('creates a new entry when the target is empty', async () => {
                for (const value of ['', null, undefined]) {
                    const { adapter, internals, posts } = await forged(value);
                    await internals.onStateChange(id(A, 'save'), user(true));
                    expect(posts, String(value)).to.have.length(1);
                    expect(adapter.states.get(`draft.${A}.result`), String(value)).to.equal('ok');
                }
            });
        });

        describe('delete', () => {
            it('asks on the first press and deletes on the second', async () => {
                const { adapter, internals, calls, triggered } = await editing(appointment);
                await internals.onStateChange(id(A, 'delete'), user(true));
                expect(views(adapter)[A].confirmDelete).to.equal(true);
                expect(calls.filter(c => c.method === 'DELETE')).to.deep.equal([]);
                await internals.onStateChange(id(A, 'delete'), user(true));
                expect(calls.filter(c => c.method === 'DELETE').map(c => new URL(c.url).pathname)).to.deep.equal([
                    '/calendar/v3/calendars/termine%40example.test/events/ev1',
                ]);
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(false);
                expect(adapter.states.get(`draft.${A}.target`)).to.equal('');
                expect(views(adapter)[A]).to.include({ editing: false, confirmDelete: false });
                expect(triggered()).to.equal(1);
                expect(adapter.infos.join(' ')).to.not.contain('Zahnarzt');
            });

            it('deletes a birthday series as a whole', async () => {
                const { internals, calls } = await editing(birthday, {
                    master: { id: 's1', summary: 'Oma', start: { date: '1950-11-15' }, end: { date: '1950-11-16' } },
                });
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(id(A, 'delete'), user(true));
                expect(calls.find(c => c.method === 'DELETE')?.url).to.match(/\/events\/s1$/);
            });

            it('asks again after any other field change', async () => {
                const { adapter, internals, calls } = await editing(appointment);
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(id(A, 'text'), user('anders'));
                expect(views(adapter)[A].confirmDelete).to.equal(false);
                await internals.onStateChange(id(A, 'delete'), user(true));
                expect(calls.filter(c => c.method === 'DELETE')).to.deep.equal([]);
            });

            it('asks again after the dialog was opened anew', async () => {
                const { adapter, internals } = await editing(appointment);
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(EDIT, tap(A, appointment));
                expect(views(adapter)[A].confirmDelete).to.equal(false);
            });

            it('reports a failed delete and asks again next time', async () => {
                const { adapter, internals } = await editing(appointment, { deleteStatus: 403 });
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(id(A, 'delete'), user(true));
                expect(adapter.states.get(`draft.${A}.result`)).to.contain('Freigabe');
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(true);
                expect(views(adapter)[A].confirmDelete).to.equal(false);
            });

            it('ignores delete without a target, false values and acknowledged presses', async () => {
                const { adapter, internals, calls } = await opened([A, B]);
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(id(A, 'delete'), user(false));
                await internals.onStateChange(id(A, 'delete'), { val: true, ack: true });
                expect(calls.filter(c => c.method === 'DELETE')).to.deep.equal([]);
                expect(views(adapter)[A].confirmDelete).to.equal(false);
            });

            it('does not delete while a save of the same browser is running', async () => {
                const { adapter, internals, calls, releaseInsert } = await editing(appointment, { holdInsert: true });
                fill(adapter, A, { type: 'reminder' });
                const pending = internals.onStateChange(id(A, 'save'), user(true));
                await new Promise(resolve => setImmediate(resolve));
                await internals.onStateChange(id(A, 'delete'), user(true));
                await internals.onStateChange(id(A, 'delete'), user(true));
                expect(calls.filter(c => c.method === 'DELETE')).to.deep.equal([]);
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('Speichern läuft noch …');
                releaseInsert();
                await pending;
            });

            it('does not save while a delete of the same browser is running', async () => {
                const { adapter, internals, calls, posts, releaseDelete } = await editing(appointment, {
                    holdDelete: true,
                });
                await internals.onStateChange(id(A, 'delete'), user(true));
                const pending = internals.onStateChange(id(A, 'delete'), user(true));
                await new Promise(resolve => setImmediate(resolve));
                await internals.onStateChange(id(A, 'save'), user(true));
                expect(calls.filter(c => c.method === 'PATCH')).to.deep.equal([]);
                expect(posts).to.deep.equal([]);
                expect(adapter.states.get(`draft.${A}.result`)).to.equal('Speichern läuft noch …');
                releaseDelete();
                await pending;
            });

            it('opens nothing in a browser while its save runs, so the moved entry keeps its fields', async () => {
                const other = row(termine, { _IDID: 'ev2', event: 'Friseur', _date: local(2026, 12, 3, 9, 0) });
                const setup = withRows([appointment, other], { holdInsert: true, deleteStatus: 500 });
                const { adapter, internals, releaseInsert } = setup;
                await internals.onStateChange(EDIT, tap(A, appointment));
                fill(adapter, A, { type: 'reminder' });
                const pending = internals.onStateChange(id(A, 'save'), user(true));
                await new Promise(resolve => setImmediate(resolve));
                await internals.onStateChange(EDIT, tap(A, other));
                await internals.onStateChange(REQUEST, user(A));
                expect(adapter.states.get('draft.edit')).to.equal('');
                expect(adapter.states.get('draft.request')).to.equal('');
                releaseInsert();
                await pending;
                expect(target(adapter)).to.deep.equal({
                    calendarId: erinnerungen.calendarId,
                    eventId: 'new1',
                    type: 'reminder',
                    seriesId: '',
                });
                expect(adapter.states.get(`draft.${A}.text`)).to.equal('Zahnarzt');
                expect(adapter.states.get(`draft.${A}.startDate`)).to.equal('2026-11-19');
                expect(adapter.states.get(`draft.${A}.startTime`)).to.equal('18:00');
                expect(adapter.states.get(`draft.${A}.type`)).to.equal('reminder');
                expect(adapter.states.get(`draft.${A}.result`)).to.equal(
                    'Neuer Eintrag angelegt, der alte konnte nicht gelöscht werden.',
                );
            });

            it('opens the dialog of another browser while one browser saves', async () => {
                const { adapter, internals, releaseInsert } = await editing(appointment, { holdInsert: true });
                fill(adapter, A, { type: 'reminder' });
                const pending = internals.onStateChange(id(A, 'save'), user(true));
                await new Promise(resolve => setImmediate(resolve));
                await internals.onStateChange(EDIT, tap(B, appointment));
                expect(adapter.states.get(`draft.${B}.open`)).to.equal(true);
                releaseInsert();
                await pending;
            });

            it('opens nothing in a browser while its delete runs', async () => {
                const { adapter, internals, releaseDelete } = await editing(appointment, { holdDelete: true });
                await internals.onStateChange(id(A, 'delete'), user(true));
                const pending = internals.onStateChange(id(A, 'delete'), user(true));
                await new Promise(resolve => setImmediate(resolve));
                await internals.onStateChange(REQUEST, user(A));
                expect(target(adapter)).to.include({ eventId: 'ev1' });
                expect(adapter.states.get(`draft.${A}.text`)).to.equal('Zahnarzt');
                releaseDelete();
                await pending;
                expect(adapter.states.get(`draft.${A}.open`)).to.equal(false);
            });

            it('deletes only the entry of the pressing browser', async () => {
                const setup = withRows([appointment, row(termine, { _IDID: 'ev2' })]);
                await setup.internals.onStateChange(EDIT, tap(A, appointment));
                await setup.internals.onStateChange(EDIT, tap(B, row(termine, { _IDID: 'ev2' })));
                await setup.internals.onStateChange(id(B, 'delete'), user(true));
                await setup.internals.onStateChange(id(B, 'delete'), user(true));
                expect(setup.calls.filter(c => c.method === 'DELETE').map(c => c.url)).to.have.length(1);
                expect(setup.calls.find(c => c.method === 'DELETE')?.url).to.match(/\/events\/ev2$/);
                expect(setup.adapter.states.get(`draft.${A}.open`)).to.equal(true);
            });
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
