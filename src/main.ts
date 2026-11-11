import * as utils from '@iobroker/adapter-core';

import { createTokenSource, type TokenSource } from './lib/auth';
import { ENTRY_TYPES, normalizeConfig, type EntryType, type Settings } from './lib/config';
import {
    buildEvent,
    DRAFT_STATES,
    draftDefaults,
    followStart,
    isDeviceId,
    parseViews,
    saveErrorText,
    type DeviceView,
    type Draft,
} from './lib/draft';
import { describeError, insertEvent, listEvents } from './lib/google';
import { createHttp, type Http } from './lib/http';
import { MAX_BACKOFF_MS, nextDelay, startLoop } from './lib/loop';
import { sortRows, toRow, type Row } from './lib/rows';
import { buildUpcoming } from './lib/upcoming';

const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Key of the sign-in problem in `reported`; calendar problems use their calendar ID. */
const SIGN_IN = '';
const DRAFT_FIELDS = ['type', 'text', 'startDate', 'startTime', 'endDate', 'endTime', 'allDay'] as const;
/** A user change of these moves the end of the draft when the start has passed it. */
const FOLLOWED_FIELDS: readonly string[] = ['startDate', 'startTime', 'allDay'];
/** `draft.<device>.<field>` relative to the namespace. */
const DEVICE_STATE = /^draft\.([0-9a-f]+(?:\.[0-9a-f]+)?)\.([A-Za-z]+)$/;

interface Google {
    settings: Settings;
    http: Http;
    token: TokenSource;
}

class GoogleCalendar extends utils.Adapter {
    private google: Google | undefined;
    private readonly shutdown = new AbortController();
    private loop: { stop: () => void; trigger: () => void } | undefined;
    private stopping = false;
    /** Devices with a save in progress. */
    private readonly saving = new Set<string>();
    /** Devices that opened the dialog, with what their vis bindings need. */
    private views: Record<string, DeviceView> = {};
    private failures = 0;
    /** Last good rows per calendar ID; a calendar that fails keeps its previous rows. */
    private readonly rowsByCalendar = new Map<string, Row[]>();
    /** Problems already logged, so each one logs once until it recovers. */
    private readonly reported = new Set<string>();

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'google-calendar' });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setStateChangedAsync('info.connection', false, true);
        const { settings, errors } = normalizeConfig(this.config);
        for (const error of errors) {
            this.log.warn(error);
        }
        if (!settings.key || !settings.calendars.length) {
            this.log.error(
                'Not reading any calendar: enter the service account key and at least one valid calendar in the instance settings',
            );
            return;
        }
        const http = createHttp(REQUEST_TIMEOUT_MS, this.shutdown.signal);
        this.google = { settings, http, token: createTokenSource(settings.key, http) };
        this.loop = startLoop(() => this.cycle(), {
            set: (fn, ms) => this.setTimeout(fn, ms),
            clear: handle => this.clearTimeout(handle),
        });
        this.on('stateChange', (id, state) => {
            this.onStateChange(id, state).catch((error: unknown) => {
                this.log.error(`Handling ${id} failed: ${describeError(error)}`);
            });
        });
        this.views = parseViews((await this.getStateAsync('draft.view'))?.val);
        await this.subscribeStatesAsync('draft.*');
    }

    /**
     * Reacts to a user command on the draft states: an open request on `draft.request`, or a change in
     * the draft of one device.
     *
     * @param id Full state ID
     * @param state New state
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || this.stopping) {
            return;
        }
        const relative = id.slice(this.namespace.length + 1);
        if (relative === 'draft.request') {
            if (isDeviceId(state.val)) {
                await this.openDraft(state.val);
            }
            // A vis button shows itself active while the state equals its value; clear it once handled.
            if (!this.stopping) {
                await this.setStateAsync('draft.request', '', true);
            }
            return;
        }
        const match = DEVICE_STATE.exec(relative);
        if (!match || !this.views[match[1]]) {
            return;
        }
        const [, device, field] = match;
        if (field === 'type' || field === 'allDay') {
            await this.publishView(
                device,
                field === 'type' ? { type: String(state.val) } : { allDay: state.val === true },
            );
        }
        if (FOLLOWED_FIELDS.includes(field)) {
            await this.moveEnd(device);
        } else if (field === 'save' && state.val === true) {
            await this.save(device);
        }
    }

    /**
     * Creates the draft states of a device on its first request, fills in defaults and opens its dialog.
     *
     * @param device vis-2 browser instance ID
     */
    private async openDraft(device: string): Promise<void> {
        const dot = device.indexOf('.');
        if (dot > 0) {
            // The dot of the instance ID adds a level, and nested IDs need their parents.
            await this.setObjectNotExistsAsync(`draft.${device.slice(0, dot)}`, {
                type: 'folder',
                common: { name: 'vis browsers' },
                native: {},
            });
        }
        await this.setObjectNotExistsAsync(`draft.${device}`, {
            type: 'channel',
            common: { name: `New entry of vis browser ${device}` },
            native: {},
        });
        for (const [field, common] of Object.entries(DRAFT_STATES)) {
            await this.setObjectNotExistsAsync(`draft.${device}.${field}`, { type: 'state', common, native: {} });
        }
        const current = (await this.getStateAsync(`draft.${device}.type`))?.val;
        const type: EntryType = ENTRY_TYPES.includes(current as EntryType) ? (current as EntryType) : 'reminder';
        await this.setField(device, 'type', type);
        for (const [key, value] of Object.entries(draftDefaults(new Date()))) {
            await this.setField(device, key, value);
        }
        await this.setField(device, 'result', '');
        await this.setField(device, 'open', true);
    }

    /**
     * Writes one draft state, acknowledged, and keeps `draft.view` in step.
     *
     * @param device Device ID
     * @param field Field name
     * @param value New value
     */
    private async setField(device: string, field: string, value: ioBroker.StateValue): Promise<void> {
        if (this.stopping) {
            return;
        }
        await this.setStateAsync(`draft.${device}.${field}`, value, true);
        if (field === 'type' || field === 'allDay' || field === 'result') {
            await this.publishView(device, { [field]: value });
        }
    }

    /**
     * Updates the view of one device and writes all views to `draft.view`.
     *
     * @param device Device ID
     * @param patch Changed fields
     */
    private async publishView(device: string, patch: Partial<DeviceView>): Promise<void> {
        this.views[device] = { ...{ type: '', allDay: false, result: '' }, ...this.views[device], ...patch };
        if (!this.stopping) {
            await this.setStateChangedAsync('draft.view', JSON.stringify(this.views), true);
        }
    }

    private async readDraft(device: string): Promise<Draft> {
        return Object.fromEntries(
            await Promise.all(
                DRAFT_FIELDS.map(async key => [key, (await this.getStateAsync(`draft.${device}.${key}`))?.val]),
            ),
        );
    }

    /**
     * Keeps the end of the draft after its start when the user changes the start.
     *
     * @param device Device ID
     */
    private async moveEnd(device: string): Promise<void> {
        const patch = followStart(await this.readDraft(device));
        for (const [key, value] of Object.entries(patch)) {
            await this.setField(device, key, value);
        }
    }

    /**
     * Validates the draft of a device, creates the event and reports the outcome in its `result`.
     *
     * @param device Device ID
     */
    private async save(device: string): Promise<void> {
        const google = this.google;
        if (!google) {
            return;
        }
        if (this.saving.has(device)) {
            await this.setField(device, 'result', 'Speichern läuft noch …');
            return;
        }
        this.saving.add(device);
        try {
            const result = buildEvent(await this.readDraft(device));
            if (!result.ok) {
                await this.setField(device, 'result', result.error);
                return;
            }
            const calendar = google.settings.writable[result.type];
            if (!calendar) {
                await this.setField(device, 'result', 'Für diesen Typ ist kein beschreibbarer Kalender eingerichtet.');
                return;
            }
            await insertEvent(google.http, await google.token(), calendar.calendarId, result.body);
            if (this.stopping) {
                return;
            }
            this.log.info(`Created an entry of type ${result.type} in calendar "${calendar.name}"`);
            await this.setField(device, 'result', 'ok');
            await this.setField(device, 'text', '');
            await this.setField(device, 'open', false);
            this.loop?.trigger();
        } catch (error) {
            if (!this.stopping) {
                this.log.warn(`Creating an entry failed: ${describeError(error)}`);
                await this.setField(device, 'result', saveErrorText(error));
            }
        } finally {
            this.saving.delete(device);
        }
    }

    /**
     * One loop step: read, publish, and say how long to wait.
     *
     * @returns Delay in milliseconds until the next cycle
     */
    private async cycle(): Promise<number> {
        const google = this.google;
        if (this.stopping || !google) {
            return MAX_BACKOFF_MS;
        }
        try {
            const ok = await this.read(google);
            this.failures = ok ? 0 : this.failures + 1;
            await this.publishUpcoming();
        } catch (error) {
            this.failures++;
            if (!this.stopping) {
                this.log.error(`Calendar cycle failed: ${describeError(error)}. Trying again later`);
            }
        }
        return nextDelay(google.settings.pollMs, this.failures);
    }

    /**
     * Reads every calendar.
     *
     * @param google Settings, transport and token source of this run
     * @returns true when at least one calendar could be read
     */
    private async read(google: Google): Promise<boolean> {
        const now = Date.now();
        const timeMin = new Date(now - google.settings.daysPast * DAY_MS);
        const timeMax = new Date(now + google.settings.daysPreview * DAY_MS);
        let token: string;
        try {
            token = await google.token();
        } catch (error) {
            this.report(SIGN_IN, `Google sign-in failed: ${describeError(error)}. Retrying with growing pauses`);
            await this.setConnection(false);
            return false;
        }
        this.recover(SIGN_IN, 'Google sign-in works again');
        let anyOk = false;
        for (const calendar of google.settings.calendars) {
            try {
                const events = await listEvents(google.http, token, calendar.calendarId, timeMin, timeMax);
                this.rowsByCalendar.set(
                    calendar.calendarId,
                    events.map(event => toRow(event, calendar)),
                );
                this.recover(calendar.calendarId, `Calendar "${calendar.name}" can be read again`);
                anyOk = true;
            } catch (error) {
                this.report(
                    calendar.calendarId,
                    `Calendar "${calendar.name}" could not be read: ${describeError(error)}. Keeping its last entries`,
                );
            }
            if (this.stopping) {
                return false;
            }
        }
        await this.setConnection(anyOk);
        if (anyOk && !this.stopping) {
            await this.setStateChangedAsync('table', JSON.stringify(this.rows()), true);
        }
        return anyOk;
    }

    /** Runs after every cycle, also a failed one, so "Heute"/"Morgen" follow the clock. */
    private async publishUpcoming(): Promise<void> {
        if (this.stopping || !this.rowsByCalendar.size) {
            return;
        }
        await this.setStateChangedAsync('upcoming', JSON.stringify(buildUpcoming(this.rows(), new Date())), true);
    }

    private rows(): Row[] {
        return sortRows([...this.rowsByCalendar.values()].flat());
    }

    private async setConnection(connected: boolean): Promise<void> {
        if (!this.stopping) {
            await this.setStateChangedAsync('info.connection', connected, true);
        }
    }

    private report(key: string, message: string): void {
        if (!this.stopping && !this.reported.has(key)) {
            this.reported.add(key);
            this.log.warn(message);
        }
    }

    private recover(key: string, message: string): void {
        if (this.reported.delete(key)) {
            this.log.info(message);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            this.stopping = true;
            this.loop?.stop();
            this.shutdown.abort();
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new GoogleCalendar(options);
} else {
    // otherwise start the instance directly
    (() => new GoogleCalendar())();
}
