/** Options for one request; a body is sent as given. */
export interface HttpRequest {
    /** HTTP method, GET when omitted. */
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    /** Request headers. */
    headers?: Record<string, string>;
    /** Request body, sent as given. */
    body?: string;
}

/** Status and parsed body of one answered request. */
export interface HttpResponse {
    /** HTTP status code. */
    status: number;
    /** Parsed JSON, or null when the body is empty or not JSON. */
    body: unknown;
}

/** Performs one HTTP request and resolves with its status and parsed body. */
export type Http = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

/** Largest accepted response body in characters. */
export const MAX_BODY_CHARS = 5_000_000;

/** A failed Google call; `status` is the HTTP status, 0 when no response exists. */
export class GoogleError extends Error {
    /**
     * @param message Text for logs, never contains secrets.
     * @param status HTTP status, 0 when no response exists.
     */
    public constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
        this.name = 'GoogleError';
    }
}

/**
 * fetch with a per-request timeout, an adapter-wide stop signal and a body size cap.
 *
 * @param timeoutMs Timeout per request in milliseconds.
 * @param stop Adapter-wide signal that aborts all requests on unload.
 * @param fetchFn Fetch implementation, injectable for tests.
 */
export function createHttp(timeoutMs: number, stop: AbortSignal, fetchFn: typeof fetch = fetch): Http {
    return async (url, request = {}) => {
        const response = await fetchFn(url, {
            ...request,
            signal: AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]),
        });
        // Known limit: the body is read completely before the size check; fine for the
        // calendar API's paged answers, a streaming cap would be needed for untrusted hosts.
        const text = await response.text();
        if (text.length > MAX_BODY_CHARS) {
            throw new GoogleError(
                `Response from ${new URL(url).host} exceeds ${MAX_BODY_CHARS} characters`,
                response.status,
            );
        }
        let body: unknown = null;
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = null;
            }
        }
        return { status: response.status, body };
    };
}
