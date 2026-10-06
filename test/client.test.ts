import { describe, expect, it } from 'vitest';
import { ApiClient, type Fetch } from '../src/api/client.js';
import { errorPayload, redact } from '../src/output/errors.js';

const BASE = 'https://dougs.example.test';

function client(fetch: Fetch, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  return new ApiClient({
    session: 'secret-session-123',
    baseUrl: BASE,
    fetch,
    sleep: async () => {},
    ...extra,
  });
}

function sequence(...responses: (() => Response)[]): {
  fetch: Fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as Fetch;
  return { fetch, calls };
}

describe('ApiClient', () => {
  it('sends the cookie, JSON accept header and an honest user agent', async () => {
    const { fetch, calls } = sequence(() => Response.json({ ok: true }));
    await client(fetch).get('/users/me');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Cookie).toBe('auth_session=secret-session-123');
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toMatch(/^dougs-cli\/\d+\.\d+\.\d+ \(\+https:/);
  });

  it('retries GET on 5xx and 429, then succeeds', async () => {
    const { fetch, calls } = sequence(
      () => new Response('', { status: 503 }),
      () => new Response('', { status: 429 }),
      () => Response.json([1]),
    );
    expect(await client(fetch).get('/x')).toEqual([1]);
    expect(calls).toHaveLength(3);
  });

  it('never retries writes', async () => {
    const { fetch, calls } = sequence(() => new Response('', { status: 503 }));
    await expect(client(fetch).post('/x', {})).rejects.toMatchObject({
      code: 'API_UNAVAILABLE',
      exitCode: 6,
    });
    expect(calls).toHaveLength(1);
  });

  it('maps 401 to AUTH_EXPIRED (exit 3) and 404 to NOT_FOUND (exit 4)', async () => {
    await expect(
      client(sequence(() => new Response('', { status: 401 })).fetch).get('/x'),
    ).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      exitCode: 3,
      hint: 'run: dougs login --from-browser chrome',
    });
    await expect(
      client(sequence(() => new Response('', { status: 404 })).fetch).get('/x'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      exitCode: 4,
    });
  });

  it('passes the Dougs error message through on rejected requests (exit 5)', async () => {
    const { fetch } = sequence(() =>
      Response.json(
        { message: 'Malformed request: missing field', statusCode: 400 },
        { status: 400 },
      ),
    );
    await expect(client(fetch).post('/x', {})).rejects.toMatchObject({
      code: 'API_REJECTED',
      exitCode: 5,
      status: 400,
      message: expect.stringContaining('Malformed request: missing field'),
    });
  });

  it('re-reads the browser cookie once on 401, then retries with it', async () => {
    const { fetch, calls } = sequence(
      () => new Response('', { status: 401 }),
      () => Response.json({ id: 1 }),
    );
    let refreshes = 0;
    const c = client(fetch, {
      refreshSession: async () => {
        refreshes++;
        return 'fresh-session-456';
      },
    });
    expect(await c.get('/users/me')).toEqual({ id: 1 });
    expect(refreshes).toBe(1);
    expect((calls[1]!.init.headers as Record<string, string>).Cookie).toBe(
      'auth_session=fresh-session-456',
    );
  });

  it('does not loop when the refreshed cookie is the same', async () => {
    const { fetch, calls } = sequence(() => new Response('', { status: 401 }));
    const c = client(fetch, { refreshSession: async () => 'secret-session-123' });
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(calls).toHaveLength(1);
  });

  it('logs requests without ever printing the cookie', async () => {
    const lines: string[] = [];
    const { fetch } = sequence(() => Response.json({}));
    await client(fetch, { log: (l) => lines.push(l) }).get('/companies/1/operations?limit=40');
    expect(lines.join('\n')).toMatch(/GET \/companies\/1\/operations → 200/);
    expect(lines.join('\n')).not.toContain('secret-session-123');
  });

  it('follows a download redirect without sending the cookie to storage', async () => {
    const { fetch, calls } = sequence(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://storage.example.test/f/1?sig=abc' },
        }),
      () => new Response(new Uint8Array([37, 80, 68, 70])),
    );
    const bytes = await client(fetch).download('/files/abc/actions/download');
    expect([...bytes]).toEqual([37, 80, 68, 70]);
    expect(calls[1]!.url).toContain('storage.example.test');
    expect(JSON.stringify(calls[1]!.init.headers ?? {})).not.toContain('auth_session');
  });

  it('refuses paths that leave the Dougs origin', async () => {
    const { fetch } = sequence();
    await expect(client(fetch).get('//evil.example/x')).rejects.toMatchObject({ code: 'USAGE' });
    await expect(client(fetch).get('https://evil.example/x')).rejects.toMatchObject({
      code: 'USAGE',
    });
  });
});

describe('error payloads', () => {
  it('redacts session cookies wherever they appear', () => {
    expect(redact('Cookie: auth_session=fake-cookie-value; other=1')).toBe(
      'Cookie: auth_session=[REDACTED]; other=1',
    );
    // Signed express-session values ("s:" URL-encoded) are redacted even without the name.
    expect(redact(`token ${'s%3A'}abcdefghijklmnopqrstuvwxyz.sig`)).toBe('token [REDACTED]');
    expect(
      errorPayload(new Error('boom with known-secret-value'), ['known-secret-value']).error.message,
    ).toBe('boom with [REDACTED]');
  });
});
