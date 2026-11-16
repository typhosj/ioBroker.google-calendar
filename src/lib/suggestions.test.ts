import { expect } from 'chai';
import type { CalendarConfig } from './config';
import type { Draft } from './draft';
import { toRow, type Row } from './rows';
import {
    buildSuggestions,
    describe as describeSuggestion,
    fillFromSuggestion,
    findSuggestion,
    MAX_SUGGESTIONS,
    suggestionItems,
    type Suggestion,
} from './suggestions';

const cal = (calendarId: string, type: CalendarConfig['type']): CalendarConfig => ({
    name: calendarId,
    calendarId,
    type,
    color: '#ffffff',
    writable: true,
});
const APPOINTMENTS = cal('cal-a', 'appointment');
const REMINDERS = cal('cal-r', 'reminder');
const BIRTHDAYS = cal('cal-b', 'birthday');
const SOURCES = new Set(['cal-a', 'cal-r', 'cal-b']);

// Timed row; times are local Berlin wall clock (the tests run with TZ=Europe/Berlin).
const timed = (summary: string, start: string, end: string, calendar = APPOINTMENTS): Row =>
    toRow(
        {
            id: summary,
            recurringEventId: '',
            summary,
            start: { dateTime: new Date(start).toISOString() },
            end: { dateTime: new Date(end).toISOString() },
        },
        calendar,
    );
const allDay = (summary: string, start: string, endExclusive: string, calendar = APPOINTMENTS): Row =>
    toRow(
        { id: summary, recurringEventId: '', summary, start: { date: start }, end: { date: endExclusive } },
        calendar,
    );

const suggestion = (title: string, values: Partial<Suggestion> = {}): Suggestion => ({
    title,
    type: 'appointment',
    allDay: false,
    startTime: '08:30',
    minutes: 60,
    days: 0,
    count: 1,
    latest: 0,
    ...values,
});

const draft = (values: Partial<Draft> = {}): Draft => ({
    type: 'appointment',
    text: '',
    startDate: '2026-11-20',
    startTime: '14:00',
    endDate: '2026-11-20',
    endTime: '15:00',
    allDay: false,
    ...values,
});

describe('buildSuggestions', () => {
    it('groups titles ignoring case and whitespace, with the values of the latest start', () => {
        const found = buildSuggestions(
            [
                timed('zahnarzt', '2026-03-02T10:00', '2026-03-02T10:30'),
                timed('  Zahnarzt ', '2026-09-01T08:30', '2026-09-01T09:45'),
                timed('ZAHNARZT', '2026-05-01T07:00', '2026-05-01T08:00'),
            ],
            SOURCES,
        );
        expect(found).to.deep.equal([
            {
                title: 'Zahnarzt',
                type: 'appointment',
                allDay: false,
                startTime: '08:30',
                minutes: 75,
                days: 0,
                count: 3,
                latest: new Date('2026-09-01T08:30').getTime(),
            },
        ]);
    });

    it('skips other calendars, birthdays and blank titles', () => {
        expect(
            buildSuggestions(
                [
                    timed('Privat', '2026-03-02T10:00', '2026-03-02T11:00', cal('cal-x', 'appointment')),
                    allDay('Oma', '2026-03-02', '2026-03-03', BIRTHDAYS),
                    timed('   ', '2026-03-02T10:00', '2026-03-02T11:00'),
                    timed('', '2026-03-02T10:00', '2026-03-02T11:00'),
                ],
                SOURCES,
            ),
        ).to.deep.equal([]);
        expect(buildSuggestions([], SOURCES)).to.deep.equal([]);
    });

    it('gives a reminder no length, counts all-day days and measures timed lengths on the wall clock', () => {
        const found = Object.fromEntries(
            buildSuggestions(
                [
                    timed('Müll', '2026-11-01T07:00', '2026-11-01T07:00', REMINDERS),
                    allDay('Urlaub', '2026-08-03', '2026-08-06'),
                    // Across the switch to winter time (25.10.2026): 01:30 to 03:30 on the clock, 3 real hours.
                    timed('Nacht', '2026-10-25T01:30', '2026-10-25T03:30'),
                ],
                SOURCES,
            ).map(s => [s.title, s]),
        );
        expect(found['Müll']).to.include({ type: 'reminder', startTime: '07:00', minutes: 0, allDay: false });
        expect(found.Urlaub).to.include({ allDay: true, days: 3, minutes: 0, startTime: '00:00' });
        expect(found.Nacht.minutes).to.equal(120);
    });

    it('gives an end before the start zero minutes and an empty all-day entry one day', () => {
        const found = Object.fromEntries(
            buildSuggestions(
                [timed('Kaputt', '2026-03-02T10:00', '2026-03-02T09:00'), allDay('Leer', '2026-03-02', '2026-03-02')],
                SOURCES,
            ).map(s => [s.title, s]),
        );
        expect(found.Kaputt.minutes).to.equal(0);
        expect(found.Leer.days).to.equal(1);
    });

    it('puts the most frequent first, then the latest start', () => {
        const found = buildSuggestions(
            [
                timed('Alt', '2026-01-01T10:00', '2026-01-01T11:00'),
                timed('Neu', '2026-06-01T10:00', '2026-06-01T11:00'),
                timed('Oft', '2026-02-01T10:00', '2026-02-01T11:00'),
                timed('Oft', '2026-02-08T10:00', '2026-02-08T11:00'),
            ],
            SOURCES,
        );
        expect(found.map(s => s.title)).to.deep.equal(['Oft', 'Neu', 'Alt']);
    });
});

describe('suggestionItems', () => {
    it('renders the Autocomplete JSON with row text and icon', () => {
        expect(
            suggestionItems([
                suggestion('Zahnarzt'),
                suggestion('Müll', { type: 'reminder', startTime: '07:00', minutes: 0 }),
            ]),
        ).to.deep.equal([
            { value: 'Zahnarzt', text: 'Zahnarzt', subText: 'Termin · 08:30–09:30', icon: 'calendar-clock' },
            { value: 'Müll', text: 'Müll', subText: 'Erinnerung · 07:00', icon: 'reminder' },
        ]);
    });

    it('keeps at most 200 entries in the given order', () => {
        const items = suggestionItems(Array.from({ length: MAX_SUGGESTIONS + 1 }, (_, i) => suggestion(`T${i}`)));
        expect(items).to.have.length(200);
        expect(items[0].value).to.equal('T0');
        expect(items[199].value).to.equal('T199');
    });
});

describe('findSuggestion', () => {
    const all = [suggestion('Zahnarzt'), suggestion('Elternabend Schule')];

    it('finds a title ignoring case and collapsed whitespace', () => {
        expect(findSuggestion('  zahnARZT ', all)?.title).to.equal('Zahnarzt');
        expect(findSuggestion('elternabend   schule', all)?.title).to.equal('Elternabend Schule');
    });

    it('finds nothing for a partial title, an empty text or a non-string', () => {
        expect(findSuggestion('Zahn', all)).to.equal(undefined);
        expect(findSuggestion('', all)).to.equal(undefined);
        expect(findSuggestion('   ', all)).to.equal(undefined);
        expect(findSuggestion(null, all)).to.equal(undefined);
        expect(findSuggestion(42, all)).to.equal(undefined);
        expect(findSuggestion('Zahnarzt', [])).to.equal(undefined);
    });
});

describe('fillFromSuggestion', () => {
    it('takes a reminder time, switches all-day off and ends an hour later', () => {
        expect(
            fillFromSuggestion(
                draft({ allDay: true }),
                suggestion('Müll', { type: 'reminder', startTime: '07:00', minutes: 0 }),
            ),
        ).to.deep.equal({
            type: 'reminder',
            allDay: false,
            startTime: '07:00',
            endDate: '2026-11-20',
            endTime: '08:00',
        });
    });

    it('ends a timed appointment after its length, across midnight', () => {
        expect(
            fillFromSuggestion(draft(), suggestion('Nachtdienst', { startTime: '22:30', minutes: 150 })),
        ).to.deep.equal({
            type: 'appointment',
            allDay: false,
            startTime: '22:30',
            endDate: '2026-11-21',
            endTime: '01:00',
        });
    });

    it('gives a zero-length appointment one hour', () => {
        expect(fillFromSuggestion(draft(), suggestion('Anruf', { startTime: '09:00', minutes: 0 }))).to.include({
            endDate: '2026-11-20',
            endTime: '10:00',
        });
    });

    it('keeps date and start time of an all-day appointment and counts its days inclusive', () => {
        const one = suggestion('Ausflug', { allDay: true, startTime: '00:00', minutes: 0, days: 1 });
        expect(fillFromSuggestion(draft(), one)).to.deep.equal({
            type: 'appointment',
            allDay: true,
            endDate: '2026-11-20',
        });
        const three = suggestion('Urlaub', { allDay: true, startTime: '00:00', minutes: 0, days: 3 });
        expect(fillFromSuggestion(draft({ startDate: '2026-12-30' }), three)).to.include({ endDate: '2027-01-01' });
    });

    it('keeps the time of the form for an all-day reminder', () => {
        const holiday = suggestion('Feiertag', {
            type: 'reminder',
            allDay: true,
            startTime: '00:00',
            minutes: 0,
            days: 1,
        });
        expect(fillFromSuggestion(draft(), holiday)).to.deep.equal({
            type: 'reminder',
            allDay: false,
            endDate: '2026-11-20',
            endTime: '15:00',
        });
    });

    it('moves no end when the start date or the kept time is invalid', () => {
        const zahnarzt = suggestion('Zahnarzt');
        const only = { type: 'appointment', allDay: false, startTime: '08:30' };
        expect(fillFromSuggestion(draft({ startDate: '' }), zahnarzt)).to.deep.equal(only);
        expect(fillFromSuggestion(draft({ startDate: '2026-02-30' }), zahnarzt)).to.deep.equal(only);
        expect(fillFromSuggestion(draft({ startDate: 5 }), zahnarzt)).to.deep.equal(only);
        const allDayReminder = suggestion('Feiertag', { type: 'reminder', allDay: true, days: 1 });
        expect(fillFromSuggestion(draft({ startTime: '25:00' }), allDayReminder)).to.deep.equal({
            type: 'reminder',
            allDay: false,
        });
    });
});

describe('describe', () => {
    it('writes the row texts of the app', () => {
        expect(describeSuggestion(suggestion('A', { startTime: '08:30', minutes: 60 }))).to.equal(
            'Termin · 08:30–09:30',
        );
        expect(describeSuggestion(suggestion('A', { startTime: '23:00', minutes: 120 }))).to.equal(
            'Termin · 23:00–01:00',
        );
        expect(describeSuggestion(suggestion('A', { startTime: '09:00', minutes: 0 }))).to.equal(
            'Termin · 09:00–10:00',
        );
        expect(describeSuggestion(suggestion('A', { allDay: true, days: 1 }))).to.equal('Termin · ganztägig');
        expect(describeSuggestion(suggestion('A', { allDay: true, days: 3 }))).to.equal('Termin · ganztägig, 3 Tage');
        expect(describeSuggestion(suggestion('A', { type: 'reminder', startTime: '07:00', minutes: 0 }))).to.equal(
            'Erinnerung · 07:00',
        );
        expect(describeSuggestion(suggestion('A', { type: 'reminder', allDay: true, days: 1 }))).to.equal('Erinnerung');
    });
});
