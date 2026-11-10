import { expect } from 'chai';
import type { CalendarConfig } from './config';
import type { GoogleEvent } from './google';
import { sortRows, toRow } from './rows';

const TERMINE: CalendarConfig = {
    name: 'Termine',
    calendarId: 'cal-t',
    type: 'appointment',
    color: '#4faba2',
    writable: true,
};
const GEBURTSTAGE: CalendarConfig = {
    name: 'Geburtstage',
    calendarId: 'cal-g',
    type: 'birthday',
    color: '#7986cb',
    writable: true,
};
const ERINNERUNGEN: CalendarConfig = {
    name: 'Erinnerungen',
    calendarId: 'cal-e',
    type: 'reminder',
    color: '#f6bf26',
    writable: true,
};

const ev = (start: GoogleEvent['start'], end: GoogleEvent['end'], extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
    id: 'id1',
    recurringEventId: '',
    summary: 'Eintrag',
    start,
    end,
    ...extra,
});

describe('toRow', () => {
    it('runs with the Berlin time zone', () => {
        expect(new Date(2026, 0, 1).getTimezoneOffset()).to.equal(-60);
    });

    it('maps a timed appointment like ical', () => {
        const row = toRow(
            ev({ dateTime: '2026-11-19T18:00:00+01:00' }, { dateTime: '2026-11-19T19:00:00+01:00' }),
            TERMINE,
        );
        expect(row).to.deep.equal({
            date: '19.11.2026 18:00-19:00',
            event: 'Eintrag',
            _date: '2026-11-19T17:00:00.000Z',
            _end: '2026-11-19T18:00:00.000Z',
            _allDay: false,
            _calName: 'Termine',
            _calColor: '#4faba2',
            _class: 'ical_Termine',
            _IDID: 'id1',
            _calId: 'cal-t',
            _recurringEventId: '',
            _type: 'appointment',
        });
    });

    it('maps an all-day birthday to local midnights with an exclusive end, as ical does', () => {
        const row = toRow(
            ev({ date: '2026-11-15' }, { date: '2026-11-16' }, { recurringEventId: 'r1', id: 'r1_20261115' }),
            GEBURTSTAGE,
        );
        expect(row).to.deep.include({
            date: '15.11.2026',
            _date: '2026-11-14T23:00:00.000Z',
            _end: '2026-11-15T23:00:00.000Z',
            _allDay: true,
            _IDID: 'r1_20261115',
            _recurringEventId: 'r1',
            _type: 'birthday',
        });
    });

    it('keeps all-day dates across the daylight-saving switch', () => {
        const row = toRow(ev({ date: '2026-03-29' }, { date: '2026-03-30' }), TERMINE);
        expect(row._date).to.equal('2026-03-28T23:00:00.000Z');
        expect(row._end).to.equal('2026-03-29T22:00:00.000Z');
    });

    it('shows a multi-day all-day range with an inclusive last day', () => {
        expect(toRow(ev({ date: '2026-11-14' }, { date: '2026-11-17' }), TERMINE).date).to.equal(
            '14.11.2026-16.11.2026',
        );
    });

    it('shows a multi-day timed appointment with both days', () => {
        const row = toRow(
            ev({ dateTime: '2026-11-14T10:00:00+01:00' }, { dateTime: '2026-11-16T12:00:00+01:00' }),
            TERMINE,
        );
        expect(row.date).to.equal('14.11.2026 10:00-16.11.2026 12:00');
    });

    it('shows a reminder as one point in time', () => {
        const row = toRow(
            ev({ dateTime: '2026-11-10T08:00:00+01:00' }, { dateTime: '2026-11-10T08:00:00+01:00' }),
            ERINNERUNGEN,
        );
        expect(row.date).to.equal('10.11.2026 08:00');
        expect(row._date).to.equal(row._end);
        expect(row._type).to.equal('reminder');
    });
});

describe('sortRows', () => {
    it('orders by start, then title, without changing the input', () => {
        const a = toRow(
            ev({ dateTime: '2026-11-10T09:00:00+01:00' }, { dateTime: '2026-11-10T10:00:00+01:00' }, { summary: 'B' }),
            TERMINE,
        );
        const b = toRow(
            ev({ dateTime: '2026-11-10T09:00:00+01:00' }, { dateTime: '2026-11-10T10:00:00+01:00' }, { summary: 'A' }),
            TERMINE,
        );
        const c = toRow(
            ev({ dateTime: '2026-11-09T09:00:00+01:00' }, { dateTime: '2026-11-09T10:00:00+01:00' }, { summary: 'C' }),
            TERMINE,
        );
        const input = [a, b, c];
        expect(sortRows(input).map(r => r.event)).to.deep.equal(['C', 'A', 'B']);
        expect(input.map(r => r.event)).to.deep.equal(['B', 'A', 'C']);
    });
});
