import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { normalizeOperation, rawOperationSchema } from '../src/api/schemas.js';
import { decryptCookie } from '../src/auth/browser-cookies.js';
import { DougsError, errorObject, redact } from '../src/output/errors.js';
import { isJson } from '../src/output/format.js';
import { confirm } from '../src/plan/diff.js';
import { operation } from './fixtures.js';

describe('auth and output', () => {
  it('decrypts generated modern cookie vector', () => {
    const host = '.dougs.fr';
    const key = pbkdf2Sync(
      'invented-storage-key',
      'saltysalt',
      1003,
      16,
      'sha1',
    );
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
    const plain = Buffer.concat([
      createHash('sha256').update(host).digest(),
      Buffer.from('synthetic-session'),
    ]);
    const encrypted = Buffer.concat([
      Buffer.from('v10'),
      cipher.update(plain),
      cipher.final(),
    ]);
    expect(
      decryptCookie(encrypted, 'invented-storage-key', host, 'darwin'),
    ).toBe('synthetic-session');
    expect(() =>
      decryptCookie(encrypted, 'invented-storage-key', 'wrong', 'darwin'),
    ).toThrow();
  });
  it('refuses non-TTY mutations', async () => {
    await expect(confirm(false, false)).rejects.toMatchObject({
      exitCode: 2,
      code: 'CONFIRMATION_REQUIRED',
    });
    await expect(confirm(true, false)).resolves.toBeUndefined();
  });
  it('formats structured error without secrets', () => {
    expect(
      errorObject(new DougsError('AUTH_EXPIRED', 'Expired', 3, 'login', 401)),
    ).toEqual({
      error: {
        code: 'AUTH_EXPIRED',
        message: 'Expired',
        hint: 'login',
        status: 401,
      },
    });
    expect(redact('Cookie: auth_session=fake; x=y')).toBe(
      'Cookie: auth_session=[REDACTED]; x=y',
    );
    expect(isJson({}, false)).toBe(true);
  });
  it('normalizes cents, rates, directions and split mirrors', () => {
    const op = normalizeOperation(
      rawOperationSchema.parse(operation()),
      '999999',
    );
    expect(op.amount).toBe(84);
    expect(op.vatRate).toBe(20);
    expect(op.direction).toBe('expense');
    expect(op.category?.id).toBe(77);
    const raw = operation();
    raw.breakdowns.push({ ...raw.breakdowns[0]!, id: 42 });
    expect(
      normalizeOperation(rawOperationSchema.parse(raw), '999999').vatAmount,
    ).toBeNull();
  });
});
describe('HTTP', () => {
  it.each([
    [401, 3],
    [403, 3],
    [404, 4],
    [422, 5],
    [500, 6],
    [429, 6],
  ])('maps %s to exit %s', async (status, exitCode) => {
    const client = new ApiClient({
      session: 'fake',
      fetch: async () => new Response('{}', { status }),
      sleep: async () => {},
    });
    await expect(client.request('GET', '/example')).rejects.toMatchObject({
      exitCode,
    });
  });
  it('retries GET but never mutations', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('{}', { status: 503 });
    };
    const client = new ApiClient({
      session: 'fake',
      fetch: fetcher,
      sleep: async () => {},
    });
    await expect(client.request('GET', '/x')).rejects.toThrow();
    expect(calls).toBe(4);
    calls = 0;
    await expect(client.request('POST', '/x', {})).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('refreshes a browser session only once', async () => {
    let n = 0;
    const client = new ApiClient({
      session: 'old',
      refresh: async () => 'new',
      fetch: async (_url, init) => {
        n++;
        return new Response('{}', {
          status:
            (init?.headers as Record<string, string>).Cookie ===
            'auth_session=new'
              ? 200
              : 401,
        });
      },
    });
    await client.request('GET', '/x');
    expect(n).toBe(2);
  });
  it('rejects cross-origin API calls', async () => {
    const client = new ApiClient({ session: 'fake' });
    await expect(
      client.request('GET', 'https://example.org'),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
  it('follows signed downloads without cookies', async () => {
    const client = new ApiClient({
      session: 'fake',
      fetch: async (url, init) => {
        if (String(url).includes('app.dougs.fr'))
          return new Response(null, {
            status: 302,
            headers: { location: 'https://files.example.org/a' },
          });
        expect(init?.headers).toBeUndefined();
        return new Response('PDF');
      },
    });
    expect(
      Buffer.from(
        await client.download('/files/fake/actions/download'),
      ).toString(),
    ).toBe('PDF');
  });
  it('caps concurrent requests at four', async () => {
    let active = 0,
      max = 0;
    const client = new ApiClient({
      session: 'fake',
      fetch: async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return new Response('{}');
      },
    });
    await Promise.all(
      Array.from({ length: 12 }, () => client.request('GET', '/x')),
    );
    expect(max).toBe(4);
  });
});
