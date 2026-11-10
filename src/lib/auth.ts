import { createSign } from 'node:crypto';
import type { ServiceAccountKey } from './config';
import { GoogleError, type Http } from './http';
import { asRecord } from './json';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Read and write of events; access is limited further by what is shared with the account. */
export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const base64url = (text: string): string => Buffer.from(text).toString('base64url');

/**
 * The signed JWT a service account exchanges for an access token.
 *
 * @param key Service account credentials.
 * @param nowSec Current time in seconds since the epoch.
 */
export function buildAssertion(key: ServiceAccountKey, nowSec: number): string {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
        JSON.stringify({ iss: key.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
    );
    let signature: string;
    try {
        signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.privateKey).toString('base64url');
    } catch {
        throw new GoogleError('The service account private key cannot sign; paste the key file again', 0);
    }
    return `${header}.${claims}.${signature}`;
}

export type TokenSource = () => Promise<string>;

/**
 * Returns a cached access token, renewed one minute before it expires.
 *
 * @param key Service account credentials.
 * @param http Transport used for the token request.
 * @param now Clock in milliseconds, injectable for tests.
 */
export function createTokenSource(key: ServiceAccountKey, http: Http, now: () => number = Date.now): TokenSource {
    let cached: { token: string; expiresAt: number } | undefined;
    return async () => {
        if (cached && now() < cached.expiresAt) {
            return cached.token;
        }
        const assertion = buildAssertion(key, Math.floor(now() / 1000));
        const response = await http(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion,
            }).toString(),
        });
        const body = asRecord(response.body);
        if (response.status !== 200 || typeof body.access_token !== 'string' || !body.access_token) {
            const code = typeof body.error === 'string' ? `, ${body.error.slice(0, 50)}` : '';
            throw new GoogleError(`Token request failed (HTTP ${response.status}${code})`, response.status);
        }
        const lifetimeSec = typeof body.expires_in === 'number' && body.expires_in > 120 ? body.expires_in : 3600;
        cached = { token: body.access_token, expiresAt: now() + (lifetimeSec - 60) * 1000 };
        return cached.token;
    };
}
