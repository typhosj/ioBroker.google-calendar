import { expect } from 'chai';
import { createHttp, MAX_BODY_CHARS } from './http';

function fakeFetch(status: number, text: string, seen: RequestInit[] = []): typeof fetch {
    return (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(init ?? {});
        return Promise.resolve(new Response(text, { status }));
    };
}

describe('createHttp', () => {
    it('parses a JSON body and passes method, headers and a signal', async () => {
        const seen: RequestInit[] = [];
        const http = createHttp(1000, new AbortController().signal, fakeFetch(200, '{"a":1}', seen));
        const response = await http('https://example.test/x', { method: 'POST', headers: { a: 'b' }, body: 'q' });
        expect(response).to.deep.equal({ status: 200, body: { a: 1 } });
        expect(seen[0].method).to.equal('POST');
        expect(seen[0].body).to.equal('q');
        expect(seen[0].signal).to.be.instanceOf(AbortSignal);
    });

    it('returns null for an empty or non-JSON body', async () => {
        const signal = new AbortController().signal;
        // A 204 Response cannot carry even an empty body in the fetch API, so test empty with 200.
        expect((await createHttp(1000, signal, fakeFetch(200, ''))('https://example.test')).body).to.equal(null);
        expect((await createHttp(1000, signal, fakeFetch(502, '<html>'))('https://example.test')).body).to.equal(null);
    });

    it('rejects an oversized body', async () => {
        const http = createHttp(1000, new AbortController().signal, fakeFetch(200, 'x'.repeat(MAX_BODY_CHARS + 1)));
        await expect(http('https://example.test')).to.be.rejectedWith('exceeds');
    });

    it('aborts when the stop signal fires', async () => {
        const stop = new AbortController();
        const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })) as typeof fetch;
        const pending = createHttp(60_000, stop.signal, hanging)('https://example.test');
        stop.abort();
        await expect(pending).to.be.rejectedWith('aborted');
    });
});
