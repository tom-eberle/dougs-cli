import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  type CookieReaderDeps,
  decryptCookieValue,
  deriveKey,
  readBrowserSession,
} from '../src/auth/browser-cookies.js';
import { tempHome } from './helpers/run.js';

const PASSWORD = 'invented-safe-storage-password';
const HOST = '.dougs.fr';

function encrypt(value: string, key: Buffer, { hostDigest = true, prefix = 'v10' } = {}): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([
    hostDigest ? createHash('sha256').update(HOST).digest() : Buffer.alloc(0),
    Buffer.from(value),
  ]);
  return Buffer.concat([Buffer.from(prefix), cipher.update(plain), cipher.final()]);
}

/** Chrome timestamps: microseconds since 1601-01-01. */
function chromeTime(iso: string): string {
  return String((BigInt(Date.parse(iso)) / 1000n + 11_644_473_600n) * 1_000_000n);
}

function makeCookieDb(
  path: string,
  rows: { value: Buffer; expires: string; host?: string }[],
  version = 24,
) {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE meta (key TEXT, value TEXT); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)',
  );
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version));
  for (const r of rows)
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)').run(
      r.host ?? HOST,
      'auth_session',
      '',
      r.value,
      BigInt(r.expires),
    );
  db.close();
}

function macDeps(home: string, password: string | null = PASSWORD): CookieReaderDeps {
  return { platform: 'darwin', home, env: {}, readPassword: () => password };
}

describe('cookie decryption', () => {
  const key = deriveKey(PASSWORD, 1003);

  it('decrypts a v10 value and strips the SHA-256 host digest (DB schema ≥ 24)', () => {
    expect(decryptCookieValue(encrypt('s%3Asynthetic.value', key), key, HOST, 24)).toBe(
      's%3Asynthetic.value',
    );
  });

  it('accepts values without a digest on older databases', () => {
    expect(
      decryptCookieValue(encrypt('legacy-value', key, { hostDigest: false }), key, HOST, 20),
    ).toBe('legacy-value');
  });

  it('rejects a digest for another host and a wrong key', () => {
    expect(() => decryptCookieValue(encrypt('x', key), key, 'evil.example', 24)).toThrow(/digest/);
    expect(() =>
      decryptCookieValue(encrypt('x', key), deriveKey('wrong', 1003), HOST, 24),
    ).toThrow();
  });
});

describe('readBrowserSession', () => {
  const key = deriveKey(PASSWORD, 1003);

  it('searches every profile and picks the freshest unexpired cookie', async () => {
    const home = tempHome();
    const root = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    makeCookieDb(join(root, 'Default', 'Cookies'), [
      { value: encrypt('older', key), expires: chromeTime('2099-01-01T00:00:00Z') },
    ]);
    makeCookieDb(join(root, 'Profile 2', 'Cookies'), [
      { value: encrypt('newest', key), expires: chromeTime('2099-06-01T00:00:00Z') },
      { value: encrypt('expired', key), expires: chromeTime('2001-01-01T00:00:00Z') },
    ]);
    const session = await readBrowserSession('chrome', macDeps(home));
    expect(session).toMatchObject({ value: 'newest', profile: 'Profile 2', browser: 'chrome' });
    expect(session.expiresAt).toBe('2099-06-01T00:00:00.000Z');
  });

  it('reads Network/Cookies (newer layout) for other Chromium browsers', async () => {
    const home = tempHome();
    const root = join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
    makeCookieDb(join(root, 'Default', 'Network', 'Cookies'), [
      { value: encrypt('brave-value', key), expires: chromeTime('2099-01-01T00:00:00Z') },
    ]);
    expect((await readBrowserSession('brave', macDeps(home))).value).toBe('brave-value');
  });

  it('uses the "peanuts" key for v10 cookies on Linux', async () => {
    const home = tempHome();
    const linuxKey = deriveKey('peanuts', 1);
    makeCookieDb(join(home, '.config', 'google-chrome', 'Default', 'Cookies'), [
      { value: encrypt('linux-value', linuxKey), expires: chromeTime('2099-01-01T00:00:00Z') },
    ]);
    const deps: CookieReaderDeps = { platform: 'linux', home, env: {}, readPassword: () => null };
    expect((await readBrowserSession('chrome', deps)).value).toBe('linux-value');
  });

  it('explains a missing keychain entry and a missing browser', async () => {
    const home = tempHome();
    makeCookieDb(
      join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'),
      [],
    );
    await expect(readBrowserSession('chrome', macDeps(home, null))).rejects.toMatchObject({
      code: 'KEYCHAIN_UNAVAILABLE',
      exitCode: 3,
    });
    await expect(readBrowserSession('edge', macDeps(home))).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
      exitCode: 3,
    });
    await expect(readBrowserSession('chrome', macDeps(home))).rejects.toMatchObject({
      code: 'COOKIE_MISSING',
    });
  });

  it('refuses Windows with a pointer to --with-token', async () => {
    await expect(
      readBrowserSession('chrome', { ...macDeps(tempHome()), platform: 'win32' }),
    ).rejects.toMatchObject({
      code: 'BROWSER_UNSUPPORTED',
      hint: expect.stringContaining('--with-token'),
    });
  });
});
