import { expect } from 'chai';
import type { CalendarConfig } from './config';
import { toRow, type Row } from './rows';
import { buildUpcoming } from './upcoming';

const cal = (type: CalendarConfig['type']): CalendarConfig => ({
    name: type,
    calendarId: type,
    type,
    color: '#ffffff',
    writable: true,
});
const timed = (summary: string, start: string, end: string, type: CalendarConfig['type'] = 'appointment'): Row =>
    toRow(
        { id: summary, recurringEventId: '', summary, start: { dateTime: start }, end: { dateTime: end } },
        cal(type),
    );
const allDay = (summary: string, start: string, end: string, type: CalendarConfig['type'] = 'appointment'): Row =>
    toRow({ id: summary, recurringEventId: '', summary, start: { date: start }, end: { date: end } }, cal(type));

// Tuesday 10.11.2026, 10:00 in Berlin.
const NOW = new Date('2026-11-10T09:00:00Z');

describe('buildUpcoming', () => {
    it('drops ended entries and keeps a future reminder', () => {
        const items = buildUpcoming(
            [
                timed('Vorbei', '2026-11-10T08:00:00+01:00', '2026-11-10T09:00:00+01:00'),
                timed('Gleich', '2026-11-10T12:00:00+01:00', '2026-11-10T12:00:00+01:00', 'reminder'),
            ],
            NOW,
        );
        expect(items.map(i => i.subText)).to.deep.equal(['Gleich']);
        expect(items[0]).to.deep.equal({
            text: 'Heute',
            subText: 'Gleich',
            rightText: '12:00',
            image: 'reminder',
            imageColor: '#ff6666',
            showDivider: false,
        });
    });

    it('labels today, tomorrow and later dates with their colours', () => {
        const items = buildUpcoming(
            [
                timed('Heute', '2026-11-10T18:30:00+01:00', '2026-11-10T19:30:00+01:00'),
                timed('Morgen', '2026-11-11T05:45:00+01:00', '2026-11-11T06:00:00+01:00'),
                allDay('Ben', '2026-11-15', '2026-11-16', 'birthday'),
            ],
            NOW,
        );
        expect(items.map(i => [i.text, i.imageColor, i.rightText, i.image])).to.deep.equal([
            ['Heute', '#ff6666', '18:30 - 19:30', 'calendar-clock'],
            ['Morgen', '#66ff66', '05:45 - 06:00', 'calendar-clock'],
            ['15.11.2026', '#ffffff', '', 'cake-variant'],
        ]);
    });

    it('marks a running multi-day entry and shows its inclusive end', () => {
        const items = buildUpcoming(
            [
                allDay('Urlaub', '2026-11-09', '2026-11-13'),
                timed('Messe', '2026-11-12T10:00:00+01:00', '2026-11-16T12:00:00+01:00'),
                allDay('Kurz', '2026-11-12', '2026-11-13'),
            ],
            NOW,
        );
        expect(items.map(i => [i.text, i.rightText])).to.deep.equal([
            ['läuft', 'bis 12.11.'],
            ['12.11.2026', 'bis 16.11. 12:00'],
            ['12.11.2026', ''],
        ]);
        expect(items[0].imageColor).to.equal('#ff6666');
    });

    it('treats a timed entry that started today as today, not as running', () => {
        const items = buildUpcoming(
            [timed('Läuft heute', '2026-11-10T09:30:00+01:00', '2026-11-10T11:00:00+01:00')],
            NOW,
        );
        expect(items[0].text).to.equal('Heute');
    });

    it('keeps at most five entries and no divider after the last', () => {
        const rows = Array.from({ length: 7 }, (_, i) => allDay(`E${i}`, `2026-11-2${i}`, `2026-11-2${i + 1}`));
        const items = buildUpcoming(rows, NOW);
        expect(items).to.have.length(5);
        expect(items.map(i => i.showDivider)).to.deep.equal([true, true, true, true, false]);
    });

    it('switches tomorrow to today at local midnight', () => {
        const rows = [timed('Früh', '2026-11-11T05:45:00+01:00', '2026-11-11T06:00:00+01:00')];
        expect(buildUpcoming(rows, new Date('2026-11-10T22:59:59Z'))[0].text).to.equal('Morgen');
        expect(buildUpcoming(rows, new Date('2026-11-10T23:00:00Z'))[0].text).to.equal('Heute');
    });

    it('names an untitled entry and returns nothing for no rows', () => {
        expect(
            buildUpcoming([timed('  ', '2026-11-12T10:00:00+01:00', '2026-11-12T11:00:00+01:00')], NOW)[0].subText,
        ).to.equal('(ohne Titel)');
        expect(buildUpcoming([], NOW)).to.deep.equal([]);
    });
});
