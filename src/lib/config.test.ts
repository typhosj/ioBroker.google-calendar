import { expect } from 'chai';
import { MAX_CALENDARS, normalizeConfig } from './config';

const KEY = JSON.stringify({
    type: 'service_account',
    client_email: 'reader@example-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n',
});
const CAL = { name: 'Termine', calendarId: 'abc@group.calendar.google.com', type: 'appointment', color: '#4faba2' };

describe('normalizeConfig', () => {
    it('accepts a complete config', () => {
        const { settings, errors } = normalizeConfig({
            serviceAccountKey: KEY,
            calendars: [CAL],
            pollMinutes: 5,
            daysPast: 30,
            daysPreview: 150,
        });
        expect(errors).to.deep.equal([]);
        expect(settings.key?.clientEmail).to.equal('reader@example-project.iam.gserviceaccount.com');
        expect(settings.calendars).to.deep.equal([{ ...CAL, writable: false }]);
        expect(settings.pollMs).to.equal(300_000);
        expect(settings.daysPast).to.equal(30);
        expect(settings.daysPreview).to.equal(150);
    });

    it('uses defaults for missing numbers and reports nothing for them', () => {
        const { settings, errors } = normalizeConfig({ serviceAccountKey: KEY, calendars: [CAL] });
        expect(errors).to.deep.equal([]);
        expect(settings.pollMs).to.equal(300_000);
        expect(settings.daysPast).to.equal(30);
        expect(settings.daysPreview).to.equal(150);
    });

    it('clamps out-of-range numbers and rejects non-numbers', () => {
        const { settings, errors } = normalizeConfig({
            serviceAccountKey: KEY,
            calendars: [CAL],
            pollMinutes: 0,
            daysPast: -5,
            daysPreview: Number.NaN,
        });
        expect(settings.pollMs).to.equal(60_000);
        expect(settings.daysPast).to.equal(0);
        expect(settings.daysPreview).to.equal(150);
        expect(errors).to.have.length(3);
    });

    it('clamps huge values and rounds fractions', () => {
        const { settings } = normalizeConfig({
            serviceAccountKey: KEY,
            calendars: [CAL],
            pollMinutes: 1e9,
            daysPast: 2.6,
            daysPreview: Infinity,
        });
        expect(settings.pollMs).to.equal(3_600_000);
        expect(settings.daysPast).to.equal(3);
        expect(settings.daysPreview).to.equal(150);
    });

    it('does not coerce numeric strings', () => {
        const { settings, errors } = normalizeConfig({ serviceAccountKey: KEY, calendars: [CAL], pollMinutes: '10' });
        expect(settings.pollMs).to.equal(300_000);
        expect(errors).to.have.length(1);
    });

    it('reports a missing, broken or incomplete key without echoing it', () => {
        expect(normalizeConfig({ calendars: [CAL] }).settings.key).to.equal(null);
        const broken = normalizeConfig({ serviceAccountKey: '{not json', calendars: [CAL] });
        expect(broken.settings.key).to.equal(null);
        const incomplete = normalizeConfig({
            serviceAccountKey: JSON.stringify({ client_email: 'x@y', private_key: 'secret-value' }),
            calendars: [CAL],
        });
        expect(incomplete.settings.key).to.equal(null);
        expect(incomplete.errors.join(' ')).not.to.contain('secret-value');
    });

    it('skips invalid calendars and keeps valid ones', () => {
        const { settings, errors } = normalizeConfig({
            serviceAccountKey: KEY,
            calendars: [
                CAL,
                { ...CAL, name: '' },
                { ...CAL, name: 'Leer', calendarId: '' },
                { ...CAL, name: 'Leerzeichen', calendarId: 'a b' },
                { ...CAL, name: 'Doppelt' },
                'not an object',
            ],
        });
        expect(settings.calendars.map(c => c.name)).to.deep.equal(['Termine']);
        expect(errors).to.have.length(5);
        expect(errors.join(' ')).not.to.contain('abc@group');
    });

    it('defaults an unknown type and a bad colour with an error each', () => {
        const { settings, errors } = normalizeConfig({
            serviceAccountKey: KEY,
            calendars: [{ ...CAL, type: 'party', color: 'red', writable: 'yes' }],
        });
        expect(settings.calendars[0]).to.deep.include({ type: 'appointment', color: '#ffffff', writable: false });
        expect(errors).to.have.length(2);
    });

    it('caps the number of calendars', () => {
        const many = Array.from({ length: MAX_CALENDARS + 3 }, (_, i) => ({
            ...CAL,
            name: `C${i}`,
            calendarId: `c${i}@x`,
        }));
        const { settings, errors } = normalizeConfig({ serviceAccountKey: KEY, calendars: many });
        expect(settings.calendars).to.have.length(MAX_CALENDARS);
        expect(errors).to.have.length(1);
    });

    it('reports an empty calendar list', () => {
        const { settings, errors } = normalizeConfig({ serviceAccountKey: KEY, calendars: [] });
        expect(settings.calendars).to.deep.equal([]);
        expect(errors).to.deep.equal(['No valid calendar configured']);
    });

    it('survives a native that is not an object', () => {
        const { settings } = normalizeConfig(null);
        expect(settings.key).to.equal(null);
        expect(settings.calendars).to.deep.equal([]);
    });
});
