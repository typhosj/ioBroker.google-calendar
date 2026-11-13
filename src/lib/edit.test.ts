import { expect } from 'chai';
import {
    changeErrorText,
    deleteErrorText,
    draftFromRow,
    DUPLICATE_TEXT,
    GONE_TEXT,
    MAX_EDIT_CHARS,
    parseEditRequest,
    parseTarget,
    patchBody,
    targetOf,
    writeId,
} from './edit';
import { GoogleError } from './http';
import type { Row } from './rows';

const local = (y: number, m: number, d: number, h = 0, min = 0): string => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 10, 13, 14, 20);

function row(patch: Partial<Row>): Row {
    return {
        date: '',
        event: 'Zahnarzt',
        _date: local(2026, 11, 19, 18, 0),
        _end: local(2026, 11, 19, 19, 0),
        _allDay: false,
        _calName: 'Termine',
        _calColor: '#4faba2',
        _class: 'ical_Termine',
        _IDID: 'ev1',
        _calId: 'termine@example.test',
        _recurringEventId: '',
        _type: 'appointment',
        ...patch,
    };
}

const request = (value: unknown): string => JSON.stringify(value);

describe('parseEditRequest', () => {
    const event = { _IDID: 'ev1_20261119', _calId: 'termine@example.test', event: 'Zahnarzt' };

    it('takes device, calendar and event from a tap', () => {
        expect(parseEditRequest(request({ instance: 'a.f1fa48', event }))).to.deep.equal({
            device: 'a.f1fa48',
            calendarId: 'termine@example.test',
            eventId: 'ev1_20261119',
        });
    });

    it('rejects anything that is not such a tap', () => {
        const bad: unknown[] = [
            undefined,
            null,
            '',
            42,
            'not json',
            '[]',
            request({ event }),
            request({ instance: 'ABCDEF12', event }),
            request({ instance: '../../ab', event }),
            request({ instance: 'a.f1fa48' }),
            request({ instance: 'a.f1fa48', event: 'x' }),
            request({ instance: 'a.f1fa48', event: { ...event, _IDID: '' } }),
            request({ instance: 'a.f1fa48', event: { ...event, _IDID: 7 } }),
            request({ instance: 'a.f1fa48', event: { ...event, _calId: '' } }),
            request({ instance: 'a.f1fa48', event: { _IDID: 'ev1' } }),
        ];
        for (const value of bad) {
            expect(parseEditRequest(value), String(value)).to.equal(null);
        }
    });

    it('accepts a request up to the size cap and rejects one above', () => {
        const head = request({ instance: 'a.f1fa48', event: { ...event, pad: '' } });
        const fill = (length: number): string =>
            head.replace('"pad":""', `"pad":"${'x'.repeat(length - head.length)}"`);
        expect(parseEditRequest(fill(MAX_EDIT_CHARS))).to.not.equal(null);
        expect(parseEditRequest(fill(MAX_EDIT_CHARS + 1))).to.equal(null);
    });
});

describe('parseTarget', () => {
    const target = { calendarId: 'c@example.test', eventId: 'e1', type: 'birthday', seriesId: 's1' };

    it('reads a stored target and defaults a missing series ID', () => {
        expect(parseTarget(JSON.stringify(target))).to.deep.equal(target);
        expect(parseTarget(JSON.stringify({ ...target, seriesId: undefined }))?.seriesId).to.equal('');
    });

    it('treats empty or broken values as no target', () => {
        for (const value of [
            undefined,
            null,
            '',
            '{',
            '[]',
            JSON.stringify({ ...target, type: 'party' }),
            JSON.stringify({ ...target, eventId: '' }),
            JSON.stringify({ ...target, calendarId: 3 }),
        ]) {
            expect(parseTarget(value), String(value)).to.equal(null);
        }
    });
});

describe('targetOf and writeId', () => {
    it('keeps calendar, event, type and series of the row', () => {
        expect(targetOf(row({ _IDID: 'i1', _recurringEventId: 's1' }))).to.deep.equal({
            calendarId: 'termine@example.test',
            eventId: 'i1',
            type: 'appointment',
            seriesId: 's1',
        });
    });

    it('writes a birthday series as a whole and every other entry by its own ID', () => {
        expect(writeId({ calendarId: 'c', eventId: 'i1', type: 'birthday', seriesId: 's1' })).to.equal('s1');
        expect(writeId({ calendarId: 'c', eventId: 'b1', type: 'birthday', seriesId: '' })).to.equal('b1');
        expect(writeId({ calendarId: 'c', eventId: 'i1', type: 'appointment', seriesId: 's1' })).to.equal('i1');
        expect(writeId({ calendarId: 'c', eventId: 'r1', type: 'reminder', seriesId: '' })).to.equal('r1');
    });
});

describe('draftFromRow', () => {
    it('fills a timed appointment, also across days', () => {
        expect(draftFromRow(row({}), NOW)).to.deep.equal({
            type: 'appointment',
            text: 'Zahnarzt',
            startDate: '2026-11-19',
            startTime: '18:00',
            endDate: '2026-11-19',
            endTime: '19:00',
            allDay: false,
        });
        const multi = draftFromRow(row({ _end: local(2026, 11, 21, 12, 0) }), NOW);
        expect([multi.endDate, multi.endTime]).to.deep.equal(['2026-11-21', '12:00']);
    });

    it('fills a reminder with end = start', () => {
        const reminder = draftFromRow(
            row({ _type: 'reminder', _date: local(2026, 11, 20, 8, 0), _end: local(2026, 11, 20, 8, 0) }),
            NOW,
        );
        expect([reminder.startDate, reminder.startTime, reminder.endDate, reminder.endTime]).to.deep.equal([
            '2026-11-20',
            '08:00',
            '2026-11-20',
            '08:00',
        ]);
    });

    it('shows an all-day end inclusive and suggests times for switching all-day off', () => {
        const one = draftFromRow(row({ _allDay: true, _date: local(2026, 11, 14), _end: local(2026, 11, 15) }), NOW);
        expect(one).to.deep.equal({
            type: 'appointment',
            text: 'Zahnarzt',
            startDate: '2026-11-14',
            startTime: '15:00',
            endDate: '2026-11-14',
            endTime: '16:00',
            allDay: true,
        });
        const range = draftFromRow(row({ _allDay: true, _date: local(2026, 11, 14), _end: local(2026, 11, 17) }), NOW);
        expect(range.endDate).to.equal('2026-11-16');
        const yearEnd = draftFromRow(row({ _allDay: true, _date: local(2026, 12, 31), _end: local(2027, 1, 1) }), NOW);
        expect([yearEnd.startDate, yearEnd.endDate]).to.deep.equal(['2026-12-31', '2026-12-31']);
    });

    it('keeps a zero-length all-day entry on its start day', () => {
        const zero = draftFromRow(row({ _allDay: true, _date: local(2026, 11, 14), _end: local(2026, 11, 14) }), NOW);
        expect([zero.startDate, zero.endDate]).to.deep.equal(['2026-11-14', '2026-11-14']);
    });

    it('takes the birth date of the series master for a birthday', () => {
        const birthday = row({
            _type: 'birthday',
            event: 'Oma',
            _allDay: true,
            _date: local(2026, 11, 15),
            _end: local(2026, 11, 16),
            _recurringEventId: 's1',
        });
        expect(draftFromRow(birthday, NOW, '1950-11-15')).to.include({
            type: 'birthday',
            text: 'Oma',
            startDate: '1950-11-15',
            endDate: '1950-11-15',
            allDay: false,
        });
        expect(draftFromRow(birthday, NOW).startDate).to.equal('2026-11-15');
    });
});

describe('patchBody', () => {
    it('clears the other kind of time, so all-day and timed can switch', () => {
        expect(
            patchBody({
                summary: 'A',
                start: { date: '2026-11-14' },
                end: { date: '2026-11-15' },
                reminders: { useDefault: true },
            }),
        ).to.deep.equal({
            summary: 'A',
            start: { date: '2026-11-14', dateTime: null },
            end: { date: '2026-11-15', dateTime: null },
        });
        expect(
            patchBody({
                summary: 'B',
                start: { dateTime: '2026-11-14T08:00:00.000Z' },
                end: { dateTime: '2026-11-14T09:00:00.000Z' },
                reminders: { useDefault: true },
            }),
        ).to.deep.equal({
            summary: 'B',
            start: { dateTime: '2026-11-14T08:00:00.000Z', date: null },
            end: { dateTime: '2026-11-14T09:00:00.000Z', date: null },
        });
    });

    it('never sends recurrence or reminders, so a series and its notifications stay', () => {
        const patch = patchBody({
            summary: 'Oma',
            start: { date: '1950-11-15' },
            end: { date: '1950-11-16' },
            recurrence: ['RRULE:FREQ=YEARLY'],
            reminders: { useDefault: true },
        });
        expect(patch).to.not.have.any.keys('recurrence', 'reminders');
    });
});

describe('error texts', () => {
    it('says an entry is gone on 404 and 410', () => {
        expect(changeErrorText(new GoogleError('x', 404))).to.equal(GONE_TEXT);
        expect(changeErrorText(new GoogleError('x', 410))).to.equal(GONE_TEXT);
    });

    it('falls back to the save texts otherwise', () => {
        expect(changeErrorText(new GoogleError('x', 403))).to.contain('Freigabe');
        expect(changeErrorText(new GoogleError('x', 400))).to.contain('HTTP 400');
        expect(changeErrorText(new Error('timeout'))).to.contain('später');
    });

    it('explains a refused delete and a failed one', () => {
        expect(deleteErrorText(new GoogleError('x', 403))).to.contain('Freigabe');
        expect(deleteErrorText(new GoogleError('x', 500))).to.equal(
            'Löschen fehlgeschlagen. Bitte später noch einmal versuchen.',
        );
        expect(deleteErrorText('weird')).to.equal('Löschen fehlgeschlagen. Bitte später noch einmal versuchen.');
    });

    it('has the agreed duplicate sentence', () => {
        expect(DUPLICATE_TEXT).to.equal('Neuer Eintrag angelegt, der alte konnte nicht gelöscht werden.');
    });
});
