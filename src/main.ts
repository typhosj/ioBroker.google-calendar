import * as utils from '@iobroker/adapter-core';

import { createTokenSource, type TokenSource } from './lib/auth';
import { normalizeConfig, type Settings } from './lib/config';
import { describeError, listEvents } from './lib/google';
import { createHttp, type Http } from './lib/http';
import { MAX_BACKOFF_MS, nextDelay, startLoop } from './lib/loop';
import { sortRows, toRow, type Row } from './lib/rows';
import { buildUpcoming } from './lib/upcoming';

const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Key of the sign-in problem in `reported`; calendar problems use their calendar ID. */
const SIGN_IN = '';

interface Google {
    settings: Settings;
    http: Http;
    token: TokenSource;
}

class GoogleCalendar extends utils.Adapter {
    private google: Google | undefined;
    private readonly shutdown = new AbortController();
    private loop: { stop: () => void } | undefined;
    private stopping = false;
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
