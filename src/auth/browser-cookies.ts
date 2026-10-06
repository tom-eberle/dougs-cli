import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DougsError, ExitCode } from '../output/errors.js';
import type { Browser, Env } from './config.js';

/**
 * Reads the Dougs `auth_session` cookie straight from a Chromium-family browser.
 *
 * macOS: the AES key is PBKDF2-SHA1("<Browser> Safe Storage" keychain password,
 * "saltysalt", 1003 iterations, 16 bytes); values are AES-128-CBC with an IV of
 * 16 spaces behind a "v10" prefix. Linux (best effort): "v10" uses the password
 * "peanuts", "v11" the libsecret password, both with 1 iteration. Cookie DB
 * schema ≥ 24 prepends SHA-256(host_key) to the plaintext, which we verify and strip.
 */

const COOKIE_NAME = 'auth_session';
const HOSTS = ['app.dougs.fr', '.app.dougs.fr', 'dougs.fr', '.dougs.fr'];
const CHROME_EPOCH_OFFSET_S = 11_644_473_600;
const KEYCHAIN_TIMEOUT_MS = 15_000;

interface BrowserInfo {
  macDir: string;
  linuxDir: string;
  keychainService: string;
  keychainAccount: string;
  libsecretApp: string;
}

const BROWSERS: Record<Browser, BrowserInfo> = {
  chrome: {
    macDir: 'Google/Chrome',
    linuxDir: 'google-chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    libsecretApp: 'chrome',
  },
  brave: {
    macDir: 'BraveSoftware/Brave-Browser',
    linuxDir: 'BraveSoftware/Brave-Browser',
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
    libsecretApp: 'brave',
  },
  edge: {
    macDir: 'Microsoft Edge',
    linuxDir: 'microsoft-edge',
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
    libsecretApp: 'chromium',
  },
  arc: {
    macDir: 'Arc/User Data',
    linuxDir: 'arc',
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc',
    libsecretApp: 'arc',
  },
};

export interface BrowserSession {
  value: string;
  browser: Browser;
  profile: string;
  expiresAt: string | null;
}

export interface CookieReaderDeps {
  platform: NodeJS.Platform;
  home: string;
  env: Env;
  /** Returns the browser's storage password, or null when unavailable. */
  readPassword: (info: {
    service: string;
    account: string;
    libsecretApp: string;
    platform: NodeJS.Platform;
  }) => string | null;
}

export const defaultCookieDeps = (): CookieReaderDeps => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
  readPassword: ({ service, account, libsecretApp, platform }) => {
    try {
      const out =
        platform === 'darwin'
          ? execFileSync(
              'security',
              ['find-generic-password', '-w', '-s', service, '-a', account],
              {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                // A keychain prompt nobody answers must not hang an agent.
                timeout: KEYCHAIN_TIMEOUT_MS,
              },
            )
          : execFileSync('secret-tool', ['lookup', 'application', libsecretApp], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: KEYCHAIN_TIMEOUT_MS,
            });
      return out.trim() || null;
    } catch {
      return null;
    }
  },
});

export function deriveKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

/** Decrypt one `encrypted_value`. Throws on a wrong key or a host-digest mismatch. */
export function decryptCookieValue(
  encrypted: Uint8Array,
  key: Buffer,
  host: string,
  dbVersion: number,
): string {
  const data = Buffer.from(encrypted);
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
  const digest = createHash('sha256').update(host).digest();
  if (plain.length >= 32 && plain.subarray(0, 32).equals(digest)) plain = plain.subarray(32);
  else if (dbVersion >= 24)
    throw new DougsError('COOKIE_DECRYPT', 'Cookie host digest mismatch', {
      exitCode: ExitCode.auth,
    });
  return plain.toString('utf8');
}

function profileRoot(info: BrowserInfo, deps: CookieReaderDeps): string {
  return deps.platform === 'darwin'
    ? join(deps.home, 'Library', 'Application Support', info.macDir)
    : join(deps.env.XDG_CONFIG_HOME || join(deps.home, '.config'), info.linuxDir);
}

function cookieFiles(root: string): { profile: string; path: string }[] {
  if (!existsSync(root)) return [];
  const files: { profile: string; path: string }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const relative of ['Cookies', join('Network', 'Cookies')]) {
      const path = join(root, entry.name, relative);
      if (existsSync(path)) files.push({ profile: entry.name, path });
    }
  }
  return files;
}

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: Promise<SqliteModule> | undefined;

/** node:sqlite prints an ExperimentalWarning on Node 22; keep stderr clean for agents. */
function loadSqlite(): Promise<SqliteModule> {
  sqliteModule ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (/sqlite/i.test(text)) return;
      return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import('node:sqlite');
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqliteModule;
}

interface CookieRow {
  host_key: string;
  value: string;
  encrypted_value: Uint8Array;
  expires_utc: string;
}

/** Open read-only; if the browser holds a lock, fall back to a private temporary copy. */
function queryCookieDb(sqlite: SqliteModule, path: string): { version: number; rows: CookieRow[] } {
  const run = (file: string) => {
    let db: DatabaseSync | undefined;
    try {
      db = new sqlite.DatabaseSync(file, { readOnly: true });
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      const placeholders = HOSTS.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT host_key, value, encrypted_value, CAST(expires_utc AS TEXT) AS expires_utc
           FROM cookies WHERE name = ? AND host_key IN (${placeholders})`,
        )
        .all(COOKIE_NAME, ...HOSTS) as unknown as CookieRow[];
      return { version: Number(meta?.value ?? 0), rows };
    } finally {
      db?.close();
    }
  };
  try {
    return run(path);
  } catch {
    const dir = mkdtempSync(join(tmpdir(), 'dougs-cookies-'));
    try {
      const copy = join(dir, 'Cookies');
      copyFileSync(path, copy);
      if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
      return run(copy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function chromeTimeToIso(value: string): string | null {
  // Chrome timestamps are microseconds since 1601 and exceed 2^53; read as text.
  if (!value || value === '0') return null;
  const seconds = Number(BigInt(value) / 1_000_000n) - CHROME_EPOCH_OFFSET_S;
  return new Date(seconds * 1000).toISOString();
}

export async function readBrowserSession(
  browser: Browser,
  deps: CookieReaderDeps = defaultCookieDeps(),
  now = new Date(),
): Promise<BrowserSession> {
  if (deps.platform === 'win32')
    throw new DougsError(
      'BROWSER_UNSUPPORTED',
      'Reading browser cookies is not supported on Windows in v0.1',
      {
        exitCode: ExitCode.auth,
        hint: 'copy the auth_session cookie and run: dougs login --with-token',
      },
    );
  const info = BROWSERS[browser];
  const files = cookieFiles(profileRoot(info, deps));
  if (files.length === 0)
    throw new DougsError(
      'BROWSER_NOT_FOUND',
      `No ${browser} profile with a cookie store was found`,
      {
        exitCode: ExitCode.auth,
        hint: `log into https://app.dougs.fr in ${browser}, or use: dougs login --with-token`,
      },
    );

  const password = deps.readPassword({
    service: info.keychainService,
    account: info.keychainAccount,
    libsecretApp: info.libsecretApp,
    platform: deps.platform,
  });
  if (deps.platform === 'darwin' && !password)
    throw new DougsError(
      'KEYCHAIN_UNAVAILABLE',
      `Could not read "${info.keychainService}" from the keychain`,
      {
        exitCode: ExitCode.auth,
        hint: 'allow the keychain prompt (or unlock the login keychain), or use: dougs login --with-token',
      },
    );
  const keys: Record<string, Buffer | undefined> =
    deps.platform === 'darwin'
      ? { v10: deriveKey(password ?? '', 1003) }
      : { v10: deriveKey('peanuts', 1), v11: password ? deriveKey(password, 1) : undefined };

  const sqlite = await loadSqlite();
  const found: BrowserSession[] = [];
  for (const file of files) {
    let result: ReturnType<typeof queryCookieDb>;
    try {
      result = queryCookieDb(sqlite, file.path);
    } catch {
      continue; // unreadable or non-Chromium profile
    }
    for (const row of result.rows) {
      const expiresAt = chromeTimeToIso(row.expires_utc);
      if (expiresAt && expiresAt <= now.toISOString()) continue;
      let value = row.value;
      if (!value) {
        const encrypted = Buffer.from(row.encrypted_value);
        const key = keys[encrypted.subarray(0, 3).toString('latin1')];
        if (!key) continue;
        try {
          value = decryptCookieValue(encrypted, key, row.host_key, result.version);
        } catch {
          continue;
        }
      }
      if (value) found.push({ value, browser, profile: file.profile, expiresAt });
    }
  }
  // Freshest expiry wins, so a recent re-login beats a stale profile.
  found.sort((a, b) => (b.expiresAt ?? '9999').localeCompare(a.expiresAt ?? '9999'));
  const best = found[0];
  if (!best)
    throw new DougsError('COOKIE_MISSING', `No valid Dougs session found in ${browser}`, {
      exitCode: ExitCode.auth,
      hint: `log into https://app.dougs.fr in ${browser}, then retry`,
    });
  return best;
}
