import type { CalendarConfig, EntryType } from './config';
import type { GoogleEvent } from './google';

/** One entry in the format of `ical.1.data.table`, plus the fields the write path needs. */
export interface Row {
    /** Display text, e.g. `19.11.2026 18:00-19:00`. */
    date: string;
    /** Event title. */
    event: string;
    /** Start as ISO date-time, UTC. */
    _date: string;
    /** End as ISO date-time, UTC; exclusive for all-day entries. */
    _end: string;
    /** Whether the entry is all-day. */
    _allDay: boolean;
    /** Calendar display name. */
    _calName: string;
    /** Calendar colour as `#rrggbb`. */
    _calColor: string;
    /** Table class, `ical_<calendar name>`. */
    _class: string;
    /** Google event ID; for a series instance the instance ID. */
    _IDID: string;
    /** Google calendar ID. */
    _calId: string;
    /** Series ID for a series instance, '' otherwise. */
    _recurringEventId: string;
    /** Entry type the calendar is shown as. */
    _type: EntryType;
}

/**
 * Two-digit zero-padded number.
 *
 * @param n Number to pad.
 */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Local date as `DD.MM.YYYY`.
 *
 * @param d Date in the host time zone.
 */
export const dayText = (d: Date): string => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;

/**
 * Local time as `HH:MM`.
 *
 * @param d Date in the host time zone.
 */
export const timeText = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/**
 * Whether two dates fall on the same local calendar day.
 *
 * @param a First date.
 * @param b Second date.
 */
export const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Last day an all-day entry covers; Google's end date is exclusive.
 *
 * @param endExclusive Exclusive end date from Google.
 */
export const lastDay = (endExclusive: Date): Date =>
    new Date(endExclusive.getFullYear(), endExclusive.getMonth(), endExclusive.getDate() - 1);

/**
 * Local midnight of a `YYYY-MM-DD` date, in the host time zone.
 *
 * @param date Calendar date, already validated as YYYY-MM-DD.
 */
function localMidnight(date: string): Date {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, month - 1, day);
}

/**
 * Display text of the date part; all-day ranges show an inclusive last day.
 *
 * @param start Start of the entry.
 * @param end Exclusive end of the entry.
 * @param allDay Whether the entry is all-day.
 */
function displayDate(start: Date, end: Date, allDay: boolean): string {
    if (allDay) {
        const last = lastDay(end);
        return last > start && !sameDay(start, last) ? `${dayText(start)}-${dayText(last)}` : dayText(start);
    }
    if (start.getTime() === end.getTime()) {
        return `${dayText(start)} ${timeText(start)}`;
    }
    return sameDay(start, end)
        ? `${dayText(start)} ${timeText(start)}-${timeText(end)}`
        : `${dayText(start)} ${timeText(start)}-${dayText(end)} ${timeText(end)}`;
}

/**
 * Maps one validated event to the ical table format.
 *
 * @param event Validated event from the Google read.
 * @param calendar Calendar the event was read from.
 */
export function toRow(event: GoogleEvent, calendar: CalendarConfig): Row {
    const allDay = event.start.date !== undefined;
    const start = event.start.date ? localMidnight(event.start.date) : new Date(event.start.dateTime ?? '');
    const end = event.end.date ? localMidnight(event.end.date) : new Date(event.end.dateTime ?? '');
    return {
        date: displayDate(start, end, allDay),
        event: event.summary,
        _date: start.toISOString(),
        _end: end.toISOString(),
        _allDay: allDay,
        _calName: calendar.name,
        _calColor: calendar.color,
        _class: `ical_${calendar.name}`,
        _IDID: event.id,
        _calId: calendar.calendarId,
        _recurringEventId: event.recurringEventId,
        _type: calendar.type,
    };
}

/**
 * ISO strings of the same format sort chronologically as text.
 *
 * @param rows Rows to sort; not modified.
 */
export function sortRows(rows: Row[]): Row[] {
    return [...rows].sort((a, b) => a._date.localeCompare(b._date) || a.event.localeCompare(b.event, 'de'));
}
