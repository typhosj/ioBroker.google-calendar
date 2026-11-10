import { expect } from 'chai';
import { describeError, listEvents, MAX_PAGES, parseEvent } from './google';
import { GoogleError, type Http } from './http';

const T0 = new Date('2026-11-01T00:00:00Z');
const T1 = new Date('2026-12-01T00:00:00Z');
const timed = {
    id: 'e1',
    summary: 'Zahnarzt',
    start: { dateTime: '2026-11-03T15:00:00+01:00' },
    end: { dateTime: '2026-11-03T16:00:00+01:00' },
};
const allDay = {
    id: 'e2',
    summary: 'Ben',
    start: { date: '2026-11-15' },
    end: { date: '2026-11-16' },
    recurringEventId: 'r2',
};

function pages(bodies: unknown[], urls: string[] = [], headers: (Record<string, string> | undefined)[] = []): Http {
    return (url, request) => {
        urls.push(url);
        headers.push(request?.headers);
        return Promise.resolve({ status: 200, body: bodies.shift() });
    };
}

describe('parseEvent', () => {
    it('keeps timed and all-day events', () => {
        expect(parseEvent(timed)).to.deep.equal({ ...timed, recurringEventId: '' });
        expect(parseEvent(allDay)).to.deep.equal(allDay);
    });

    it('drops cancelled, id-less, mixed and unparsable events', () => {
        expect(parseEvent({ ...timed, status: 'cancelled' })).to.equal(null);
        expect(parseEvent({ ...timed, id: '' })).to.equal(null);
        expect(parseEvent({ ...timed, end: { date: '2026-11-04' } })).to.equal(null);
        expect(parseEvent({ ...timed, start: { dateTime: 'soon' } })).to.equal(null);
        expect(parseEvent({ ...allDay, start: { date: '15.11.2026' } })).to.equal(null);
        expect(parseEvent('x')).to.equal(null);
    });

    it('defaults a missing summary and caps a long one', () => {
        expect(parseEvent({ ...timed, summary: undefined })?.summary).to.equal('');
        expect(parseEvent({ ...timed, summary: 'x'.repeat(600) })?.summary).to.have.length(500);
    });
});

describe('listEvents', () => {
    it('requests single events in the window with the token and an encoded calendar ID', async () => {
        const urls: string[] = [];
        const headers: (Record<string, string> | undefined)[] = [];
        const events = await listEvents(
            pages([{ items: [timed] }], urls, headers),
            'tok',
            'a#b@group.calendar.google.com',
            T0,
            T1,
        );
        expect(events.map(e => e.id)).to.deep.equal(['e1']);
        const url = new URL(urls[0]);
        expect(url.pathname).to.equal('/calendar/v3/calendars/a%23b%40group.calendar.google.com/events');
        expect(url.searchParams.get('singleEvents')).to.equal('true');
        expect(url.searchParams.get('orderBy')).to.equal('startTime');
        expect(url.searchParams.get('timeMin')).to.equal(T0.toISOString());
        expect(url.searchParams.get('timeMax')).to.equal(T1.toISOString());
        expect(headers[0]).to.deep.equal({ authorization: 'Bearer tok' });
    });

    it('follows page tokens and skips malformed items', async () => {
        const urls: string[] = [];
        const http = pages([{ items: [timed, { junk: true }], nextPageToken: 'p2' }, { items: [allDay] }], urls);
        const events = await listEvents(http, 'tok', 'c', T0, T1);
        expect(events.map(e => e.id)).to.deep.equal(['e1', 'e2']);
        expect(new URL(urls[1]).searchParams.get('pageToken')).to.equal('p2');
    });

    it('gives up after the page cap', async () => {
        const endless: Http = () => Promise.resolve({ status: 200, body: { items: [], nextPageToken: 'again' } });
        await expect(listEvents(endless, 'tok', 'c', T0, T1)).to.be.rejectedWith(`More than ${MAX_PAGES * 250}`);
    });

    it('throws a GoogleError with the HTTP status', async () => {
        const denied: Http = () => Promise.resolve({ status: 404, body: { error: { code: 404 } } });
        const error = await listEvents(denied, 'tok', 'c', T0, T1).then(
            () => null,
            (e: unknown) => e,
        );
        expect(error).to.be.instanceOf(GoogleError);
        expect((error as GoogleError).status).to.equal(404);
    });

    it('rejects an answer without an item list', async () => {
        await expect(listEvents(pages([{}]), 'tok', 'c', T0, T1)).to.be.rejectedWith('no item list');
    });
});

describe('describeError', () => {
    it('explains sharing problems and passes other messages through', () => {
        expect(describeError(new GoogleError('x', 404))).to.contain('not shared with the service account');
        expect(describeError(new GoogleError('x', 403))).to.contain('not shared with the service account');
        expect(describeError(new GoogleError('Token request failed (HTTP 400, invalid_grant)', 400))).to.equal(
            'Token request failed (HTTP 400, invalid_grant)',
        );
        expect(describeError(new Error('timeout'))).to.equal('timeout');
        expect(describeError('odd')).to.equal('odd');
    });
});
