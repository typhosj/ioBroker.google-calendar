import { ENTRY_TYPES, type EntryType } from './config';
import type { EventBody } from './google';
import { GoogleError } from './http';
import { pad2, timeText } from './rows';

/** The values of the `draft.*` states, unvalidated. */
export interface Draft {
    /** Entry type, one of ENTRY_TYPES. */
    type: unknown;
    /** Title or name. */
    text: unknown;
    /** Start date, YYYY-MM-DD. */
    startDate: unknown;
    /** Start time, HH:MM. */
    startTime: unknown;
    /** End date, YYYY-MM-DD; empty means the start date. */
    endDate: unknown;
    /** End time, HH:MM. */
    endTime: unknown;
    /** Whether the entry is all-day; only boolean true counts. */
    allDay: unknown;
}

/** Validated entry, or the German sentence to show. */
export type DraftResult =
    | {
          /** Validation passed. */
          ok: true;
          /** Entry type. */
          type: EntryType;
          /** Event to insert. */
          body: EventBody;
      }
    | {
          /** Validation failed. */
          ok: false;
          /** German sentence for the dialog. */
          error: string;
      };

export const MAX_TEXT = 200;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Local calendar date as `YYYY-MM-DD`.
 *
 * @param d Date in the host time zone.
 */
const isoDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/**
 * Local midnight of the day after `d`.
 *
 * @param d Date in the host time zone.
 */
const nextDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
/**
 * Rejection with the German sentence for the dialog.
 *
 * @param error German sentence.
 */
const fail = (error: string): DraftResult => ({ ok: false, error });

/**
 * A real local calendar date between `minYear` and 2100, or null.
 *
 * @param value Untrusted date text, expected as YYYY-MM-DD.
 * @param minYear Earliest accepted year.
 */
function parseDate(value: unknown, minYear = 2000): Date | null {
    const match = typeof value === 'string' ? DATE.exec(value.trim()) : null;
    if (!match) {
        return null;
    }
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (year < minYear || year > 2100) {
        return null;
    }
    const date = new Date(year, month - 1, day);
    return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/**
 * The local time on that day, or null.
 * Known limit: a time inside the spring-forward gap (02:00–02:59 on the switch day) moves one hour on.
 *
 * @param day Local calendar day.
 * @param value Untrusted time text, expected as HH:MM.
 */
function atTime(day: Date, value: unknown): Date | null {
    const match = typeof value === 'string' ? TIME.exec(value.trim()) : null;
    return match
        ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(match[1]), Number(match[2]))
        : null;
}

/**
 * Validates the draft and builds the Google event; every rejection is a German sentence for the dialog.
 * Known limit: a birthday on 29 February (RRULE:FREQ=YEARLY) shows in Google only in leap years.
 *
 * @param draft Untrusted values of the draft states.
 */
export function buildEvent(draft: Draft): DraftResult {
    if (!ENTRY_TYPES.includes(draft.type as EntryType)) {
        return fail('Bitte einen Typ wählen.');
    }
    const type = draft.type as EntryType;
    const text = typeof draft.text === 'string' ? draft.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) {
        return fail(type === 'birthday' ? 'Bitte einen Namen eingeben.' : 'Bitte einen Text eingeben.');
    }
    if (text.length > MAX_TEXT) {
        return fail(`Der Text ist länger als ${MAX_TEXT} Zeichen.`);
    }
    const startDay = parseDate(draft.startDate, type === 'birthday' ? 1900 : 2000);
    if (!startDay) {
        return fail('Bitte ein gültiges Datum eingeben.');
    }
    const base = { summary: text, reminders: { useDefault: true as const } };
    if (type === 'birthday') {
        const body = { ...base, start: { date: isoDate(startDay) }, end: { date: isoDate(nextDay(startDay)) } };
        return { ok: true, type, body: { ...body, recurrence: ['RRULE:FREQ=YEARLY'] } };
    }
    if (type === 'reminder') {
        const at = atTime(startDay, draft.startTime);
        if (!at) {
            return fail('Bitte eine gültige Uhrzeit eingeben.');
        }
        return {
            ok: true,
            type,
            body: { ...base, start: { dateTime: at.toISOString() }, end: { dateTime: at.toISOString() } },
        };
    }
    const endDay =
        draft.endDate === '' || draft.endDate === undefined || draft.endDate === null
            ? startDay
            : parseDate(draft.endDate);
    if (!endDay) {
        return fail('Bitte ein gültiges Enddatum eingeben.');
    }
    if (draft.allDay === true) {
        if (endDay < startDay) {
            return fail('Bitte ein Enddatum ab dem Beginn wählen.');
        }
        return {
            ok: true,
            type,
            body: { ...base, start: { date: isoDate(startDay) }, end: { date: isoDate(nextDay(endDay)) } },
        };
    }
    const from = atTime(startDay, draft.startTime);
    if (!from) {
        return fail('Bitte eine gültige Beginnzeit eingeben.');
    }
    const to = atTime(endDay, draft.endTime);
    if (!to) {
        return fail('Bitte eine gültige Endzeit eingeben.');
    }
    if (to <= from) {
        return fail('Bitte ein Ende nach dem Beginn wählen.');
    }
    return {
        ok: true,
        type,
        body: { ...base, start: { dateTime: from.toISOString() }, end: { dateTime: to.toISOString() } },
    };
}

/**
 * What to change so the end is not before the start: an earlier end date takes the start date;
 * a timed end that is not after the start becomes one hour after it.
 * An invalid field changes nothing it depends on, validation reports it on save.
 *
 * @param draft Untrusted values of the draft states.
 */
export function followStart(draft: Draft): { endDate?: string; endTime?: string } {
    const startDay = parseDate(draft.startDate, 1900);
    const endDay = draft.endDate === '' ? startDay : parseDate(draft.endDate, 1900);
    if (!startDay || !endDay) {
        return {};
    }
    const moved = endDay < startDay;
    const patch = moved ? { endDate: isoDate(startDay) } : {};
    if (draft.allDay === true) {
        return patch;
    }
    const from = atTime(startDay, draft.startTime);
    const to = atTime(moved ? startDay : endDay, draft.endTime);
    if (!from || !to || to > from) {
        return patch;
    }
    const end = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours() + 1, from.getMinutes());
    return { endDate: isoDate(end), endTime: timeText(end) };
}

/**
 * Form values when the dialog opens: the next full hour, one hour long.
 *
 * @param now Current time in the host time zone.
 */
export function draftDefaults(now: Date): {
    text: string;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    allDay: boolean;
} {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours() + 1);
    return {
        text: '',
        startDate: isoDate(start),
        startTime: timeText(start),
        endDate: isoDate(end),
        endTime: timeText(end),
        allDay: false,
    };
}

/**
 * German text for a failed insert.
 *
 * @param error Anything thrown by the insert.
 */
export function saveErrorText(error: unknown): string {
    if (error instanceof GoogleError && (error.status === 403 || error.status === 404)) {
        return 'Der Kalender ist nicht beschreibbar. Bitte die Freigabe für das Dienstkonto prüfen.';
    }
    if (error instanceof GoogleError && error.status === 400) {
        return 'Google hat den Eintrag abgelehnt (HTTP 400).';
    }
    return 'Speichern fehlgeschlagen. Bitte später noch einmal versuchen.';
}
