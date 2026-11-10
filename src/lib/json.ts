/**
 * Narrows untrusted JSON to a plain object; anything else becomes an empty record.
 *
 * @param value Untrusted value to narrow.
 */
export function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
