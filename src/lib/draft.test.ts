import { expect } from 'chai';
import { buildEvent, draftDefaults, MAX_TEXT, saveErrorText, type Draft } from './draft';
import { GoogleError } from './http';

const base: Draft = {
    type: 'reminder',
    text: 'Müll raus',
    startDate: '2026-11-12',
    startTime: '08:00',
    endDate: '',
    endTime: '',
    allDay: false,
};
const build = (patch: Partial<Draft>): ReturnType<typeof buildEvent> => buildEvent({ ...base, ...patch });

describe('buildEvent', () => {
    it('builds a zero-duration reminder in local time', () => {
        expect(build({})).to.deep.equal({
            ok: true,
            type: 'reminder',
            body: {
                summary: 'Müll raus',
                start: { dateTime: '2026-11-12T07:00:00.000Z' },
                end: { dateTime: '2026-11-12T07:00:00.000Z' },
                reminders: { useDefault: true },
            },
        });
    });

    it('builds a timed appointment, also across days', () => {
        const same = build({ type: 'appointment', startTime: '18:30', endDate: '2026-11-12', endTime: '19:30' });
        expect(same.ok && same.body.start).to.deep.equal({ dateTime: '2026-11-12T17:30:00.000Z' });
        expect(same.ok && same.body.end).to.deep.equal({ dateTime: '2026-11-12T18:30:00.000Z' });
        const multi = build({ type: 'appointment', startTime: '10:00', endDate: '2026-11-14', endTime: '12:00' });
        expect(multi.ok && multi.body.end).to.deep.equal({ dateTime: '2026-11-14T11:00:00.000Z' });
    });

    it('uses the start date when the end date is empty', () => {
        const result = build({ type: 'appointment', startTime: '09:00', endDate: '', endTime: '10:00' });
        expect(result.ok && result.body.end).to.deep.equal({ dateTime: '2026-11-12T09:00:00.000Z' });
    });

    it('stores an all-day end date exclusive', () => {
        const one = build({ type: 'appointment', allDay: true, endDate: '2026-11-12' });
        expect(one.ok && [one.body.start, one.body.end]).to.deep.equal([
            { date: '2026-11-12' },
            { date: '2026-11-13' },
        ]);
        const range = build({ type: 'appointment', allDay: true, endDate: '2026-11-16' });
        expect(range.ok && range.body.end).to.deep.equal({ date: '2026-11-17' });
        const yearEnd = build({ type: 'appointment', allDay: true, startDate: '2026-12-31', endDate: '2026-12-31' });
        expect(yearEnd.ok && yearEnd.body.end).to.deep.equal({ date: '2027-01-01' });
    });

    it('builds a yearly all-day birthday and ignores times', () => {
        expect(build({ type: 'birthday', text: 'Ben', startTime: 'nonsense' })).to.deep.equal({
            ok: true,
            type: 'birthday',
            body: {
                summary: 'Ben',
                start: { date: '2026-11-12' },
                end: { date: '2026-11-13' },
                recurrence: ['RRULE:FREQ=YEARLY'],
                reminders: { useDefault: true },
            },
        });
    });

    it('accepts a real birth year for a birthday only', () => {
        expect(build({ type: 'birthday', text: 'Ben', startDate: '1985-03-12' })).to.deep.equal({
            ok: true,
            type: 'birthday',
            body: {
                summary: 'Ben',
                start: { date: '1985-03-12' },
                end: { date: '1985-03-13' },
                recurrence: ['RRULE:FREQ=YEARLY'],
                reminders: { useDefault: true },
            },
        });
        expect(build({ type: 'birthday', text: 'Ben', startDate: '1899-12-31' })).to.deep.include({ ok: false });
        expect(build({ startDate: '1985-03-12' })).to.deep.include({ ok: false });
    });

    it('accepts the date boundaries 2000-01-01 and 2100-12-31', () => {
        expect(build({ startDate: '2000-01-01' }).ok).to.equal(true);
        expect(build({ startDate: '2100-12-31' }).ok).to.equal(true);
    });

    it('rejects a non-string or blank end date of an appointment', () => {
        for (const endDate of [42, '   ']) {
            expect(build({ type: 'appointment', startTime: '10:00', endDate, endTime: '11:00' })).to.deep.equal({
                ok: false,
                error: 'Bitte ein gültiges Enddatum eingeben.',
            });
        }
    });

    it('collapses whitespace and caps the text', () => {
        expect((build({ text: '  Müll \n  raus ' }) as { body: { summary: string } }).body.summary).to.equal(
            'Müll raus',
        );
        expect(build({ text: 'x'.repeat(MAX_TEXT) }).ok).to.equal(true);
        expect(build({ text: 'x'.repeat(MAX_TEXT + 1) })).to.deep.include({ ok: false });
    });

    it('rejects a missing type, text, date or time with a German message', () => {
        for (const patch of [
            { type: 'party' },
            { type: undefined },
            { text: '   ' },
            { text: 42 },
            { startDate: '12.11.2026' },
            { startDate: '2026-02-30' },
            { startDate: '1999-12-31' },
            { startDate: '2101-01-01' },
            { startTime: '24:00' },
            { startTime: '8:00' },
            { startTime: '' },
        ] as Partial<Draft>[]) {
            const result = build(patch);
            expect(result.ok, JSON.stringify(patch)).to.equal(false);
            expect((result as { error: string }).error).to.match(/^Bitte |^Der Text/);
        }
    });

    it('rejects an appointment that ends before it starts', () => {
        expect(
            build({ type: 'appointment', startTime: '10:00', endDate: '2026-11-12', endTime: '10:00' }),
        ).to.deep.include({ ok: false });
        expect(
            build({ type: 'appointment', startTime: '10:00', endDate: '2026-11-11', endTime: '12:00' }),
        ).to.deep.include({ ok: false });
        expect(build({ type: 'appointment', allDay: true, endDate: '2026-11-11' })).to.deep.include({ ok: false });
        expect(build({ type: 'appointment', startTime: '10:00', endDate: '2026-11-12', endTime: 'x' })).to.deep.include(
            { ok: false },
        );
    });

    it('treats only boolean true as all-day', () => {
        const result = build({
            type: 'appointment',
            allDay: 'true',
            startTime: '10:00',
            endDate: '2026-11-12',
            endTime: '11:00',
        });
        expect(result.ok && result.body.start.dateTime).to.be.a('string');
    });
});

describe('draftDefaults', () => {
    it('starts at the next full hour and ends one hour later', () => {
        expect(draftDefaults(new Date(2026, 10, 10, 9, 41))).to.deep.equal({
            text: '',
            startDate: '2026-11-10',
            startTime: '10:00',
            endDate: '2026-11-10',
            endTime: '11:00',
            allDay: false,
        });
    });

    it('rolls over midnight', () => {
        const defaults = draftDefaults(new Date(2026, 11, 31, 23, 5));
        expect([defaults.startDate, defaults.startTime, defaults.endDate, defaults.endTime]).to.deep.equal([
            '2027-01-01',
            '00:00',
            '2027-01-01',
            '01:00',
        ]);
    });
});

describe('saveErrorText', () => {
    it('names the sharing problem, a rejection and anything else', () => {
        expect(saveErrorText(new GoogleError('x', 403))).to.contain('Freigabe');
        expect(saveErrorText(new GoogleError('x', 404))).to.contain('Freigabe');
        expect(saveErrorText(new GoogleError('x', 400))).to.contain('abgelehnt');
        expect(saveErrorText(new Error('timeout'))).to.contain('später');
    });
});
