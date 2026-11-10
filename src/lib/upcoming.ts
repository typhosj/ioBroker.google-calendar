import type { EntryType } from './config';
import { dayText, lastDay, pad2, sameDay, timeText, type Row } from './rows';

/** One entry of the vis2-materialdesign List widget (`jsonStringObject`). */
export interface ListItem {
    /** Day label: `Heute`, `Morgen`, `läuft` or the date. */
    text: string;
    /** Entry title. */
    subText: string;
    /** Time range, `bis` end of a multi-day entry, or empty. */
    rightText: string;
    /** Icon name. */
    image: string;
    /** Icon colour as `#rrggbb`. */
    imageColor: string;
    /** Whether a divider line follows the item. */
    showDivider: boolean;
}

/** Number of entries the upcoming list shows. */
export const UPCOMING_COUNT = 5;

const ICONS: Record<EntryType, string> = {
    appointment: 'calendar-clock',
    reminder: 'reminder',
    birthday: 'cake-variant',
};
const RED = '#ff6666';
const GREEN = '#66ff66';
const WHITE = '#ffffff';

const shortDay = (d: Date): string => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;

function rightText(row: Row, start: Date, end: Date, last: Date, multiDay: boolean): string {
    if (row._type === 'birthday') {
        return '';
    }
    if (row._allDay) {
        return multiDay ? `bis ${shortDay(last)}` : '';
    }
    if (multiDay) {
        return `bis ${shortDay(end)} ${timeText(end)}`;
    }
    return start.getTime() === end.getTime() ? timeText(start) : `${timeText(start)} - ${timeText(end)}`;
}

function toItem(row: Row, today: Date, tomorrow: Date): Omit<ListItem, 'showDivider'> {
    const start = new Date(row._date);
    const end = new Date(row._end);
    const last = row._allDay ? lastDay(end) : end;
    const multiDay = last > start && !sameDay(start, last);
    let text = dayText(start);
    let imageColor = WHITE;
    if (multiDay && start < today) {
        text = 'läuft';
        imageColor = RED;
    } else if (sameDay(start, today)) {
        text = 'Heute';
        imageColor = RED;
    } else if (sameDay(start, tomorrow)) {
        text = 'Morgen';
        imageColor = GREEN;
    }
    return {
        text,
        subText: row.event.trim() || '(ohne Titel)',
        rightText: rightText(row, start, end, last, multiDay),
        image: ICONS[row._type],
        imageColor,
    };
}

/**
 * The next entries that have not ended yet, from rows already sorted by start.
 *
 * @param sortedRows Rows sorted by start.
 * @param now Current time.
 */
export function buildUpcoming(sortedRows: Row[], now: Date): ListItem[] {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const items = sortedRows
        .filter(row => new Date(row._end) > now)
        .slice(0, UPCOMING_COUNT)
        .map(row => toItem(row, today, tomorrow));
    return items.map((item, index) => ({ ...item, showDivider: index < items.length - 1 }));
}
