import { expect } from 'chai';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { buildAssertion, createTokenSource, SCOPE, TOKEN_URL } from './auth';
import { GoogleError, type Http, type HttpRequest } from './http';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const KEY = { clientEmail: 'reader@example-project.iam.gserviceaccount.com', privateKey };
const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('buildAssertion', () => {
    it('signs RS256 claims for the token endpoint', () => {
        const [header, claims, signature] = buildAssertion(KEY, 1_000).split('.');
        expect(decode(header)).to.deep.equal({ alg: 'RS256', typ: 'JWT' });
        expect(decode(claims)).to.deep.equal({
            iss: KEY.clientEmail,
            scope: SCOPE,
            aud: TOKEN_URL,
            iat: 1_000,
            exp: 4_600,
        });
        const ok = createVerify('RSA-SHA256')
            .update(`${header}.${claims}`)
            .verify(publicKey, Buffer.from(signature, 'base64url'));
        expect(ok).to.equal(true);
    });

    it('fails with a clear message on an unusable private key', () => {
        expect(() =>
            buildAssertion({ ...KEY, privateKey: '-----BEGIN PRIVATE KEY-----\nbad\n-----END PRIVATE KEY-----' }, 1),
        ).to.throw('private key cannot sign');
    });
});

describe('createTokenSource', () => {
    function fakeHttp(responses: { status: number; body: unknown }[], seen: HttpRequest[]): Http {
        return (_url, request) => {
            seen.push(request ?? {});
            const next = responses.shift();
            if (!next) {
                throw new Error('unexpected request');
            }
            return Promise.resolve(next);
        };
    }

    it('fetches once and caches until shortly before expiry', async () => {
        let now = 0;
        const seen: HttpRequest[] = [];
        const http = fakeHttp(
            [
                { status: 200, body: { access_token: 'one', expires_in: 3600 } },
                { status: 200, body: { access_token: 'two', expires_in: 3600 } },
            ],
            seen,
        );
        const token = createTokenSource(KEY, http, () => now);
        expect(await token()).to.equal('one');
        now = 3_539_000;
        expect(await token()).to.equal('one');
        now = 3_541_000;
        expect(await token()).to.equal('two');
        expect(seen).to.have.length(2);
        expect(seen[0].method).to.equal('POST');
        expect(seen[0].body).to.contain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    });

    it('throws a GoogleError with status and error code, never the key', async () => {
        const token = createTokenSource(
            KEY,
            fakeHttp([{ status: 400, body: { error: 'invalid_grant' } }], []),
            () => 0,
        );
        const error = await token().then(
            () => null,
            (e: unknown) => e,
        );
        expect(error).to.be.instanceOf(GoogleError);
        expect((error as GoogleError).status).to.equal(400);
        expect((error as GoogleError).message).to.contain('invalid_grant');
        expect((error as GoogleError).message).not.to.contain('PRIVATE KEY');
    });

    it('rejects a 200 answer without a token', async () => {
        const token = createTokenSource(KEY, fakeHttp([{ status: 200, body: { nope: true } }], []), () => 0);
        await expect(token()).to.be.rejectedWith(GoogleError);
    });
});
