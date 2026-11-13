import { expect } from 'chai';
import {
    deleteEvent,
    describeError,
    getEvent,
    insertEvent,
    listEvents,
    MAX_PAGES,
    parseEvent,
    patchEvent,
} from './google';
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

describe('insertEvent', () => {
    const body = {
        summary: 'Test',
        start: { date: '2026-11-12' },
        end: { date: '2026-11-13' },
        reminders: { useDefault: true as const },
    };

    it('posts JSON with the token and returns the new ID', async () => {
        const seen: { url: string; request?: { method?: string; headers?: Record<string, string>; body?: string } }[] =
            [];
        const http: Http = (url, request) => {
            seen.push({ url, request });
            return Promise.resolve({ status: 200, body: { id: 'new1' } });
        };
        expect(await insertEvent(http, 'tok', 'a@b', body)).to.equal('new1');
        expect(new URL(seen[0].url).pathname).to.equal('/calendar/v3/calendars/a%40b/events');
        expect(seen[0].request?.method).to.equal('POST');
        expect(seen[0].request?.headers).to.deep.equal({
            authorization: 'Bearer tok',
            'content-type': 'application/json',
        });
        expect(JSON.parse(seen[0].request?.body ?? '')).to.deep.equal(body);
    });

    it('throws a GoogleError on a refusal or an answer without ID', async () => {
        const refuse: Http = () => Promise.resolve({ status: 403, body: {} });
        const error = await insertEvent(refuse, 'tok', 'c', body).then(
            () => null,
            (e: unknown) => e,
        );
        expect((error as GoogleError).status).to.equal(403);
        const noId: Http = () => Promise.resolve({ status: 200, body: {} });
        await expect(insertEvent(noId, 'tok', 'c', body)).to.be.rejectedWith(GoogleError);
    });
});

/**
 * Records one request and answers with the given status and body.
 *
 * @param status HTTP status to answer with.
 * @param body Body to answer with.
 * @param seen List the request is appended to.
 */
function answer(
    status: number,
    body: unknown,
    seen: { url: string; method?: string; body?: string; headers?: Record<string, string> }[],
): Http {
    return (url, request) => {
        seen.push({ url, method: request?.method, body: request?.body, headers: request?.headers });
        return Promise.resolve({ status, body });
    };
}

describe('getEvent', () => {
    it('reads one event by encoded calendar and event ID', async () => {
        const seen: { url: string; method?: string }[] = [];
        const event = await getEvent(answer(200, allDay, seen), 'tok', 'a#b@example.test', 'r2_x');
        expect(event).to.deep.equal(allDay);
        expect(new URL(seen[0].url).pathname).to.equal('/calendar/v3/calendars/a%23b%40example.test/events/r2_x');
        expect(seen[0].method).to.equal(undefined);
    });

    it('throws on a status other than 200 and on a malformed event', async () => {
        for (const [status, body] of [
            [404, null],
            [200, { id: '' }],
            [200, 'x'],
        ] as const) {
            const error = await getEvent(answer(status, body, []), 'tok', 'c', 'e').catch((e: unknown) => e);
            expect(error, `${status}`).to.be.instanceOf(GoogleError);
            expect((error as GoogleError).status).to.equal(status);
        }
    });
});

describe('patchEvent', () => {
    const body = {
        summary: 'Neu',
        start: { date: '2026-11-15', dateTime: null },
        end: { date: '2026-11-16', dateTime: null },
    } as const;

    it('sends a PATCH with JSON body and token', async () => {
        const seen: { url: string; method?: string; body?: string; headers?: Record<string, string> }[] = [];
        await patchEvent(answer(200, { id: 'e1' }, seen), 'tok', 'c@example.test', 'e1_20261115', body);
        expect(seen[0].method).to.equal('PATCH');
        expect(new URL(seen[0].url).pathname).to.equal('/calendar/v3/calendars/c%40example.test/events/e1_20261115');
        expect(JSON.parse(seen[0].body ?? '')).to.deep.equal(body);
        expect(seen[0].headers).to.deep.equal({ authorization: 'Bearer tok', 'content-type': 'application/json' });
    });

    it('throws with the status on anything but 200', async () => {
        for (const status of [204, 400, 403, 404, 410, 500]) {
            const error = await patchEvent(answer(status, null, []), 'tok', 'c', 'e', body).catch((e: unknown) => e);
            expect((error as GoogleError).status, `${status}`).to.equal(status);
        }
    });
});

describe('deleteEvent', () => {
    it('sends a DELETE with the token', async () => {
        const seen: { url: string; method?: string; headers?: Record<string, string> }[] = [];
        await deleteEvent(answer(204, null, seen), 'tok', 'c@example.test', 'e1');
        expect(seen[0].method).to.equal('DELETE');
        expect(new URL(seen[0].url).pathname).to.equal('/calendar/v3/calendars/c%40example.test/events/e1');
        expect(seen[0].headers).to.deep.equal({ authorization: 'Bearer tok' });
    });

    it('counts an event that is already gone as deleted', async () => {
        for (const status of [200, 204, 404, 410]) {
            await deleteEvent(answer(status, null, []), 'tok', 'c', 'e');
        }
    });

    it('throws with the status on other answers', async () => {
        for (const status of [400, 401, 403, 500]) {
            const error = await deleteEvent(answer(status, null, []), 'tok', 'c', 'e').catch((e: unknown) => e);
            expect((error as GoogleError).status, `${status}`).to.equal(status);
        }
    });
});
