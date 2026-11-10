import { asRecord } from './json';

export type EntryType = 'appointment' | 'reminder' | 'birthday';
export const ENTRY_TYPES: readonly EntryType[] = ['appointment', 'reminder', 'birthday'];
export const MAX_CALENDARS = 20;

/** Service account credentials taken from the downloaded Google JSON key. */
export interface ServiceAccountKey {
    /** Service account e-mail address (`client_email`). */
    clientEmail: string;
    /** PEM private key (`private_key`). */
    privateKey: string;
}

/** One configured calendar row, already validated. */
export interface CalendarConfig {
    /** Display name, also used in logs. */
    name: string;
    /** Google calendar ID; may be an e-mail address, so it is never logged. */
    calendarId: string;
    /** Entry type the calendar's events are shown as. */
    type: EntryType;
    /** Colour as `#rrggbb`. */
    color: string;
    /** Whether the adapter may write to this calendar. */
    writable: boolean;
}

/** Normalised instance settings. */
export interface Settings {
    /** Service account key, or null when missing or invalid. */
    key: ServiceAccountKey | null;
    /** Valid calendars, at most MAX_CALENDARS. */
    calendars: CalendarConfig[];
    /** Poll interval in milliseconds. */
    pollMs: number;
    /** Days of past events to keep. */
    daysPast: number;
    /** Days of upcoming events to keep. */
    daysPreview: number;
    /** First writable calendar per entry type; a type without one is not written. */
    writable: Partial<Record<EntryType, CalendarConfig>>;
}

const MINUTE_MS = 60_000;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function clampInt(value: unknown, min: number, max: number, fallback: number, label: string, errors: string[]): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${label} is not a number, using ${fallback}`);
        return fallback;
    }
    const rounded = Math.round(value);
    const clamped = Math.min(max, Math.max(min, rounded));
    if (clamped !== rounded) {
        errors.push(`${label} ${rounded} is outside ${min} to ${max}, using ${clamped}`);
    }
    return clamped;
}

function parseKey(value: unknown, errors: string[]): ServiceAccountKey | null {
    if (typeof value !== 'string' || value.trim() === '') {
        errors.push('No service account key configured');
        return null;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        errors.push('Service account key is not valid JSON');
        return null;
    }
    const record = asRecord(raw);
    const clientEmail = record.client_email;
    const privateKey = record.private_key;
    if (
        typeof clientEmail !== 'string' ||
        !/^[^@\s]+@[^@\s]+$/.test(clientEmail) ||
        typeof privateKey !== 'string' ||
        !privateKey.includes('-----BEGIN PRIVATE KEY-----')
    ) {
        errors.push('Service account key lacks client_email or private_key');
        return null;
    }
    return { clientEmail, privateKey };
}

function parseCalendars(value: unknown, errors: string[]): CalendarConfig[] {
    const calendars: CalendarConfig[] = [];
    const seen = new Set<string>();
    for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
        const record = asRecord(item);
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const calendarId = typeof record.calendarId === 'string' ? record.calendarId.trim() : '';
        if (!name || name.length > 50) {
            errors.push(`Calendar ${index + 1}: name missing or longer than 50 characters, skipped`);
            continue;
        }
        if (!calendarId || calendarId.length > 200 || /\s/.test(calendarId)) {
            errors.push(`Calendar "${name}": calendar ID missing or invalid, skipped`);
            continue;
        }
        if (seen.has(calendarId)) {
            errors.push(`Calendar "${name}": same calendar ID as an earlier row, skipped`);
            continue;
        }
        if (calendars.length >= MAX_CALENDARS) {
            errors.push(`More than ${MAX_CALENDARS} calendars, the rest is skipped`);
            break;
        }
        let type: EntryType = 'appointment';
        if (ENTRY_TYPES.includes(record.type as EntryType)) {
            type = record.type as EntryType;
        } else {
            errors.push(`Calendar "${name}": unknown type, using appointment`);
        }
        let color = '#ffffff';
        if (typeof record.color === 'string' && COLOR.test(record.color)) {
            color = record.color;
        } else {
            errors.push(`Calendar "${name}": colour is not #rrggbb, using #ffffff`);
        }
        seen.add(calendarId);
        calendars.push({ name, calendarId, type, color, writable: record.writable === true });
    }
    if (!calendars.length) {
        errors.push('No valid calendar configured');
    }
    return calendars;
}

/**
 * First writable calendar per type; a second one for the same type is reported and skipped.
 *
 * @param calendars Valid calendars, in config order
 * @param errors Collects the warnings
 */
function writableByType(calendars: CalendarConfig[], errors: string[]): Partial<Record<EntryType, CalendarConfig>> {
    const writable: Partial<Record<EntryType, CalendarConfig>> = {};
    for (const calendar of calendars.filter(c => c.writable)) {
        if (writable[calendar.type]) {
            errors.push(
                `Calendar "${calendar.name}": second writable calendar of type ${calendar.type}, it will not be written`,
            );
        } else {
            writable[calendar.type] = calendar;
        }
    }
    return writable;
}

/**
 * Validates and clamps the instance settings; the UI checks are convenience only.
 *
 * @param native Raw `native` object of the instance, untrusted.
 */
export function normalizeConfig(native: unknown): { settings: Settings; errors: string[] } {
    const record = asRecord(native);
    const errors: string[] = [];
    const calendars = parseCalendars(record.calendars, errors);
    const settings: Settings = {
        key: parseKey(record.serviceAccountKey, errors),
        calendars,
        pollMs: clampInt(record.pollMinutes, 1, 60, 5, 'pollMinutes', errors) * MINUTE_MS,
        daysPast: clampInt(record.daysPast, 0, 366, 30, 'daysPast', errors),
        daysPreview: clampInt(record.daysPreview, 0, 366, 150, 'daysPreview', errors),
        writable: writableByType(calendars, errors),
    };
    return { settings, errors };
}
