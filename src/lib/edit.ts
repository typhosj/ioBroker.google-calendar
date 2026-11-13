import { ENTRY_TYPES, type EntryType, type Settings } from './config';
import { draftDefaults, isDeviceId, isoDate, saveErrorText } from './draft';
import type { EventBody, EventPatch, EventTime, PatchTime } from './google';
import { GoogleError } from './http';
import { asRecord } from './json';
import { lastDay, timeText, type Row } from './rows';

/** Largest accepted `draft.edit` value in characters; one table row is far below. */
export const MAX_EDIT_CHARS = 10_000;

export const GONE_TEXT = 'Diesen Eintrag gibt es nicht mehr.';
export const DUPLICATE_TEXT = 'Neuer Eintrag angelegt, der alte konnte nicht gelöscht werden.';

/** What a tap on a calendar event asks for. */
export interface EditRequest {
    /** vis-2 browser instance ID. */
    device: string;
    /** Google calendar ID of the tapped row. */
    calendarId: string;
    /** Google event ID of the tapped row (instance ID for a series). */
    eventId: string;
}

/** The entry a device edits, persisted as JSON in `draft.<device>.target`. */
export interface Target {
    /** Calendar the entry lives in. */
    calendarId: string;
    /** Event ID; for a series instance the instance ID. */
    eventId: string;
    /** Type of the entry when it was opened. */
    type: EntryType;
    /** Series ID for a series instance, '' otherwise. */
    seriesId: string;
}

/** Field values of a draft. */
export interface DraftValues {
    type: EntryType;
    text: string;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    allDay: boolean;
}

/**
 * Parses JSON text, or null.
 *
 * @param value Untrusted text.
 */
function parseJson(value: unknown): unknown {
    if (typeof value !== 'string' || !value) {
        return null;
    }
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Reads what the calendar widget wrote to `draft.edit`: `{ instance, event }`, event = the tapped row.
 *
 * @param value Untrusted state value.
 */
export function parseEditRequest(value: unknown): EditRequest | null {
    if (typeof value === 'string' && value.length > MAX_EDIT_CHARS) {
        return null;
    }
    const record = asRecord(parseJson(value));
    const event = asRecord(record.event);
    if (!isDeviceId(record.instance) || !nonEmpty(event._calId) || !nonEmpty(event._IDID)) {
        return null;
    }
    return { device: record.instance, calendarId: event._calId, eventId: event._IDID };
}

/**
 * Reads `draft.<device>.target`; empty or broken means a new entry.
 *
 * @param value State value.
 */
export function parseTarget(value: unknown): Target | null {
    const record = asRecord(parseJson(value));
    if (!nonEmpty(record.calendarId) || !nonEmpty(record.eventId) || !ENTRY_TYPES.includes(record.type as EntryType)) {
        return null;
    }
    return {
        calendarId: record.calendarId,
        eventId: record.eventId,
        type: record.type as EntryType,
        seriesId: typeof record.seriesId === 'string' ? record.seriesId : '',
    };
}

/**
 * Reads `draft.<device>.target` and checks it against the configuration: its calendar must be the
 * writable calendar of its type. The state is not write-protected in practice, and the
 * configuration may have changed since the dialog opened.
 *
 * @param value State value.
 * @param writable Writable calendar per type.
 * @returns null for an empty state (a new entry), undefined for a broken or no longer valid target.
 */
export function checkTarget(value: unknown, writable: Settings['writable']): Target | null | undefined {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const target = parseTarget(value);
    return target && writable[target.type]?.calendarId === target.calendarId ? target : undefined;
}

/**
 * The target for a row of the table.
 *
 * @param row Row of the adapter's own table.
 */
export const targetOf = (row: Row): Target => ({
    calendarId: row._calId,
    eventId: row._IDID,
    type: row._type,
    seriesId: row._recurringEventId,
});

/**
 * ID to patch or delete: a birthday changes as a series, every other entry as itself, so one
 * instance of a series created in Google changes alone.
 *
 * @param target Edited entry.
 */
export const writeId = (target: Target): string => (target.type === 'birthday' && target.seriesId) || target.eventId;

/**
 * Draft values for an entry. A birthday and an all-day entry get suggested times in case a time is
 * entered; a birthday always shows a date only, the birth date when given.
 *
 * @param row Row of the adapter's own table.
 * @param now Current time, for the suggested times.
 * @param birthDate Start date of the series master of a birthday, `YYYY-MM-DD`.
 */
export function draftFromRow(row: Row, now: Date, birthDate = ''): DraftValues {
    const start = new Date(row._date);
    const end = new Date(row._end);
    const base = { type: row._type, text: row.event };
    const suggested = draftDefaults(now);
    // A birthday is a day, also when Google holds it with a time.
    if (row._type === 'birthday') {
        const day = birthDate || isoDate(start);
        return {
            ...base,
            startDate: day,
            startTime: suggested.startTime,
            endDate: day,
            endTime: suggested.endTime,
            allDay: false,
        };
    }
    if (!row._allDay) {
        return {
            ...base,
            startDate: isoDate(start),
            startTime: timeText(start),
            endDate: isoDate(end),
            endTime: timeText(end),
            allDay: false,
        };
    }
    const last = lastDay(end);
    return {
        ...base,
        startDate: isoDate(start),
        startTime: suggested.startTime,
        endDate: isoDate(last < start ? start : last),
        endTime: suggested.endTime,
        // The dialog hides the time of an all-day entry, and only an appointment shows the all-day switch.
        allDay: row._type === 'appointment',
    };
}

/**
 * One time of a patch.
 *
 * @param time Validated start or end.
 */
const patchTime = (time: EventTime): PatchTime =>
    time.date !== undefined ? { date: time.date, dateTime: null } : { dateTime: time.dateTime ?? '', date: null };

/**
 * Patch from a validated draft: title and times only, so recurrence, reminders, description,
 * location and guests stay as they are in Google.
 *
 * @param body Event built by `buildEvent`.
 */
export const patchBody = (body: EventBody): EventPatch => ({
    summary: body.summary,
    start: patchTime(body.start),
    end: patchTime(body.end),
});

/**
 * German text for a failed change.
 *
 * @param error Anything thrown by the patch.
 */
export function changeErrorText(error: unknown): string {
    if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) {
        return GONE_TEXT;
    }
    return saveErrorText(error);
}

/**
 * German text for a failed delete.
 *
 * @param error Anything thrown by the delete.
 */
export function deleteErrorText(error: unknown): string {
    if (error instanceof GoogleError && error.status === 403) {
        return 'Der Kalender ist nicht beschreibbar. Bitte die Freigabe für das Dienstkonto prüfen.';
    }
    return 'Löschen fehlgeschlagen. Bitte später noch einmal versuchen.';
}
