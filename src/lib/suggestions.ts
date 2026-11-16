import { atTime, isoDate, parseDate, type Draft } from './draft';
import { pad2, timeText, type Row } from './rows';

/** How far back the source calendars are read for suggestions, in days. */
export const SUGGEST_DAYS = 365;
/** Known limit: the list keeps the most frequent titles only, so the state stays small. */
export const MAX_SUGGESTIONS = 200;

const DAY_MS = 86_400_000;

/** One earlier title with the values of its latest occurrence. */
export interface Suggestion {
    /** Title as written in the latest occurrence, trimmed. */
    title: string;
    /** Entry type of the source calendar. */
    type: 'appointment' | 'reminder';
    /** Whether the latest occurrence is all-day. */
    allDay: boolean;
    /** Local start time, HH:MM. */
    startTime: string;
    /** Timed length on the wall clock in minutes, at least 0; 0 for all-day. */
    minutes: number;
    /** All-day length in days, at least 1; 0 for timed. */
    days: number;
    /** Number of occurrences. */
    count: number;
    /** Start of the latest occurrence in ms. */
    latest: number;
}

/** One item of the vis2-materialdesign Select/Autocomplete JSON list. */
export interface SuggestionItem {
    /** Value written to the state: the title. */
    value: string;
    /** Text shown and matched: the title. */
    text: string;
    /** Second line: type and time. */
    subText: string;
    /** Icon name. */
    icon: string;
}

/** Fields a suggestion changes in the draft. */
export type SuggestionFill = Partial<
    Record<'type' | 'startTime' | 'endDate' | 'endTime', string> & { allDay: boolean }
>;

const key = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

// Local wall clock as if it were UTC, so differences ignore daylight saving switches.
const wall = (d: Date): number => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());

/**
 * One suggestion per title from the rows of the source calendars, most frequent first, then the latest.
 *
 * @param rows Rows of all calendars.
 * @param calendarIds Calendars whose titles are offered.
 */
export function buildSuggestions(rows: readonly Row[], calendarIds: ReadonlySet<string>): Suggestion[] {
    const groups = new Map<string, Suggestion>();
    for (const row of rows) {
        const title = row.event.replace(/\s+/g, ' ').trim();
        if (!title || row._type === 'birthday' || !calendarIds.has(row._calId)) {
            continue;
        }
        const start = new Date(row._date);
        const end = new Date(row._end);
        const latest = start.getTime();
        const found = groups.get(key(title));
        if (found && found.latest >= latest) {
            found.count++;
            continue;
        }
        groups.set(key(title), {
            title,
            type: row._type,
            allDay: row._allDay,
            startTime: timeText(start),
            minutes: row._allDay ? 0 : Math.max(0, (wall(end) - wall(start)) / 60_000),
            days: row._allDay ? Math.max(1, Math.round((wall(end) - wall(start)) / DAY_MS)) : 0,
            count: (found?.count ?? 0) + 1,
            latest,
        });
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || b.latest - a.latest);
}

// Minutes a timed pick lasts: an appointment its own length, a reminder's hidden end one hour.
const length = (s: Suggestion): number => (s.type === 'appointment' && !s.allDay && s.minutes > 0 ? s.minutes : 60);

/**
 * Row text as in the app: `Termin · 08:30–09:30`, `Termin · ganztägig, 3 Tage`, `Erinnerung · 07:00`.
 *
 * @param s Suggestion to describe.
 */
export function describe(s: Suggestion): string {
    if (s.type === 'reminder') {
        return s.allDay ? 'Erinnerung' : `Erinnerung · ${s.startTime}`;
    }
    if (s.allDay) {
        return s.days > 1 ? `Termin · ganztägig, ${s.days} Tage` : 'Termin · ganztägig';
    }
    const [hours, minutes] = s.startTime.split(':').map(Number);
    const end = (hours * 60 + minutes + length(s)) % 1440;
    return `Termin · ${s.startTime}–${pad2(Math.floor(end / 60))}:${pad2(end % 60)}`;
}

/**
 * The list for the Autocomplete's `jsonStringObject`.
 *
 * @param list Suggestions in display order.
 */
export function suggestionItems(list: readonly Suggestion[]): SuggestionItem[] {
    return list.slice(0, MAX_SUGGESTIONS).map(s => ({
        value: s.title,
        text: s.title,
        subText: describe(s),
        icon: s.type === 'reminder' ? 'reminder' : 'calendar-clock',
    }));
}

/**
 * The suggestion whose title equals the text, ignoring case and repeated whitespace.
 *
 * @param text Untrusted text of the draft.
 * @param list Current suggestions.
 */
export function findSuggestion(text: unknown, list: readonly Suggestion[]): Suggestion | undefined {
    if (typeof text !== 'string' || !text.trim()) {
        return undefined;
    }
    const wanted = key(text);
    return list.find(s => key(s.title) === wanted);
}

/**
 * Draft fields a picked suggestion sets: type, all-day, start time and the end after its length.
 * The start date stays; an all-day suggestion keeps the form's start time. An invalid start date or
 * kept time moves no end, validation reports it on save.
 *
 * @param draft Untrusted values of the draft states.
 * @param s Picked suggestion.
 */
export function fillFromSuggestion(draft: Draft, s: Suggestion): SuggestionFill {
    const allDay = s.allDay && s.type === 'appointment';
    const fill: SuggestionFill = s.allDay ? { type: s.type, allDay } : { type: s.type, allDay, startTime: s.startTime };
    const day = parseDate(draft.startDate);
    if (!day) {
        return fill;
    }
    if (allDay) {
        const last = new Date(day.getFullYear(), day.getMonth(), day.getDate() + Math.max(1, s.days) - 1);
        return { ...fill, endDate: isoDate(last) };
    }
    const from = atTime(day, s.allDay ? draft.startTime : s.startTime);
    if (!from) {
        return fill;
    }
    const end = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate(),
        from.getHours(),
        from.getMinutes() + length(s),
    );
    return { ...fill, endDate: isoDate(end), endTime: timeText(end) };
}
