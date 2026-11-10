import { GoogleError, type Http } from './http';
import { asRecord } from './json';

/** Start or end of an event: a calendar date for all-day events, else an ISO date-time. */
export interface EventTime {
    /** Calendar date, YYYY-MM-DD. */
    date?: string;
    /** ISO 8601 date-time with offset. */
    dateTime?: string;
}

/** One validated event instance, ready for storage. */
export interface GoogleEvent {
    /** Google event ID. */
    id: string;
    /** Set for an instance of a series; '' otherwise. */
    recurringEventId: string;
    /** Title, empty when the event has none; capped at 500 characters. */
    summary: string;
    /** Start of the event. */
    start: EventTime;
    /** End of the event, same kind (date or date-time) as start. */
    end: EventTime;
}

/** Body of `events.insert`. */
export interface EventBody {
    /** Title of the event. */
    summary: string;
    /** Start of the event. */
    start: EventTime;
    /** End of the event; exclusive for all-day events. */
    end: EventTime;
    /** Recurrence rules, e.g. `RRULE:FREQ=YEARLY`. */
    recurrence?: string[];
    /** Always the calendar default reminders. */
    reminders: { useDefault: true };
}

/** Base URL of the Google Calendar v3 REST API. */
export const API_BASE = 'https://www.googleapis.com/calendar/v3';
/** Items requested per page. */
export const PAGE_SIZE = 250;
/** Pages followed before the read is refused as too large. */
export const MAX_PAGES = 10;
/** Strict calendar date, YYYY-MM-DD. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses the start or end of an event.
 *
 * @param value Untrusted start or end object.
 */
function eventTime(value: unknown): EventTime | null {
    const record = asRecord(value);
    if (typeof record.dateTime === 'string' && !Number.isNaN(Date.parse(record.dateTime))) {
        return { dateTime: record.dateTime };
    }
    if (typeof record.date === 'string' && DATE.test(record.date)) {
        return { date: record.date };
    }
    return null;
}

/**
 * Validates one item of `events.list`; anything malformed is dropped.
 *
 * @param raw Untrusted item from the API.
 */
export function parseEvent(raw: unknown): GoogleEvent | null {
    const record = asRecord(raw);
    if (typeof record.id !== 'string' || !record.id || record.status === 'cancelled') {
        return null;
    }
    const start = eventTime(record.start);
    const end = eventTime(record.end);
    if (!start || !end || (start.date === undefined) !== (end.date === undefined)) {
        return null;
    }
    return {
        id: record.id,
        recurringEventId: typeof record.recurringEventId === 'string' ? record.recurringEventId : '',
        summary: typeof record.summary === 'string' ? record.summary.slice(0, 500) : '',
        start,
        end,
    };
}

/**
 * All events of one calendar in the window, series expanded by Google.
 *
 * @param http Transport for the API request.
 * @param token Bearer access token.
 * @param calendarId Calendar ID, URL-encoded here.
 * @param timeMin Window start, inclusive.
 * @param timeMax Window end, exclusive.
 */
export async function listEvents(
    http: Http,
    token: string,
    calendarId: string,
    timeMin: Date,
    timeMax: Date,
): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({
            singleEvents: 'true',
            orderBy: 'startTime',
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            maxResults: String(PAGE_SIZE),
        });
        if (pageToken) {
            query.set('pageToken', pageToken);
        }
        const response = await http(
            `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`,
            {
                headers: { authorization: `Bearer ${token}` },
            },
        );
        if (response.status !== 200) {
            throw new GoogleError(`Reading events failed (HTTP ${response.status})`, response.status);
        }
        const body = asRecord(response.body);
        if (!Array.isArray(body.items)) {
            throw new GoogleError('Reading events returned no item list', response.status);
        }
        for (const item of body.items) {
            const event = parseEvent(item);
            if (event) {
                events.push(event);
            }
        }
        if (typeof body.nextPageToken !== 'string' || !body.nextPageToken) {
            return events;
        }
        pageToken = body.nextPageToken;
    }
    throw new GoogleError(`More than ${MAX_PAGES * PAGE_SIZE} events in the time window`, 200);
}

/**
 * Log text for a failed read; never contains calendar IDs.
 *
 * @param error Anything thrown while reading.
 */
export function describeError(error: unknown): string {
    if (error instanceof GoogleError && (error.status === 403 || error.status === 404)) {
        return `not shared with the service account, or wrong calendar ID (HTTP ${error.status})`;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * Creates one event; resolves with its ID.
 *
 * @param http Transport for the API request.
 * @param token Bearer access token.
 * @param calendarId Calendar ID, URL-encoded here.
 * @param body Event to create.
 */
export async function insertEvent(http: Http, token: string, calendarId: string, body: EventBody): Promise<string> {
    const response = await http(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const record = asRecord(response.body);
    if (response.status !== 200 || typeof record.id !== 'string' || !record.id) {
        throw new GoogleError(`Creating the event failed (HTTP ${response.status})`, response.status);
    }
    return record.id;
}
