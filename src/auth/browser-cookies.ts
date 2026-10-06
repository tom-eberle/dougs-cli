import { execFileSync } from 'node:child_process';
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DougsError } from '../output/errors.js';
import type { Browser } from './config.js';
export function decryptCookie(
  encrypted: Uint8Array,
  password: string,
  host: string,
  platform = process.platform,
  dbVersion = 24,
): string {
  const data = Buffer.from(encrypted);
  const prefix = data.subarray(0, 3).toString();
  if (prefix !== 'v10' && !(platform === 'linux' && prefix === 'v11'))
    throw new DougsError(
      'COOKIE_VERSION',
      'Unsupported browser cookie encryption',
      3,
      'use dougs login --with-token',
    );
  const key = pbkdf2Sync(
    password,
    'saltysalt',
    platform === 'darwin' ? 1003 : 1,
    16,
    'sha1',
  );
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  let plain = Buffer.concat([
    decipher.update(data.subarray(3)),
    decipher.final(),
  ]);
  const hash = createHash('sha256').update(host).digest();
  if (plain.length >= 32 && timingSafeEqual(plain.subarray(0, 32), hash))
    plain = plain.subarray(32);
  else if (dbVersion >= 24)
    throw new DougsError('COOKIE_HOST', 'Cookie host digest mismatch', 3);
  return plain.toString('utf8');
}
const browsers: Record<
  Browser,
  { mac: string; linux: string; service: string; account: string }
> = {
  chrome: {
    mac: 'Google/Chrome',
    linux: 'google-chrome',
    service: 'Chrome Safe Storage',
    account: 'Chrome',
  },
  brave: {
    mac: 'BraveSoftware/Brave-Browser',
    linux: 'BraveSoftware/Brave-Browser',
    service: 'Brave Safe Storage',
    account: 'Brave',
  },
  edge: {
    mac: 'Microsoft Edge',
    linux: 'microsoft-edge',
    service: 'Microsoft Edge Safe Storage',
    account: 'Microsoft Edge',
  },
  arc: {
    mac: 'Arc/User Data',
    linux: 'arc',
    service: 'Arc Safe Storage',
    account: 'Arc',
  },
};
export function readBrowserCookie(browser: Browser): string {
  if (process.platform === 'win32')
    throw new DougsError(
      'BROWSER_UNSUPPORTED',
      'Windows cookie decryption is not supported',
      3,
      'use dougs login --with-token',
    );
  const info = browsers[browser];
  let password = 'peanuts';
  try {
    password =
      process.platform === 'darwin'
        ? execFileSync(
            'security',
            [
              'find-generic-password',
              '-w',
              '-s',
              info.service,
              '-a',
              info.account,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          ).trim()
        : execFileSync(
            'secret-tool',
            [
              'lookup',
              'application',
              browser === 'chrome' ? 'chrome' : browser,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          ).trim() || 'peanuts';
  } catch {
    if (process.platform === 'darwin')
      throw new DougsError(
        'KEYCHAIN_UNAVAILABLE',
        `Cannot read ${info.service}`,
        3,
        'unlock the login keychain or use --with-token',
      );
  }
  const root =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support', info.mac)
      : join(
          process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
          info.linux,
        );
  const matches: { value: string; expiry: number; access: number }[] = [];
  if (existsSync(root))
    for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    )) {
      for (const relative of ['Cookies', 'Network/Cookies']) {
        const path = join(root, dir.name, relative);
        if (!existsSync(path)) continue;
        let db: DatabaseSync | undefined;
        try {
          // Read-only SQLite includes the live WAL; no writes or profile copies needed.
          db = new DatabaseSync(path, { readOnly: true });
          const version = Number(
            db.prepare("SELECT value FROM meta WHERE key = 'version'").get()
              ?.value ?? 0,
          );
          const rows = db
            .prepare(
              "SELECT host_key,value,encrypted_value,CAST(expires_utc AS TEXT) AS expires_utc,CAST(last_access_utc AS TEXT) AS last_access_utc FROM cookies WHERE name = ? AND host_key IN ('app.dougs.fr','.app.dougs.fr','.dougs.fr','dougs.fr')",
            )
            .all('auth_session');
          for (const row of rows) {
            const expiry = Number(row.expires_utc);
            if (expiry && expiry / 1e6 - 11644473600 <= Date.now() / 1000)
              continue;
            try {
              const value = row.value
                ? String(row.value)
                : decryptCookie(
                    row.encrypted_value as Uint8Array,
                    password,
                    String(row.host_key),
                    process.platform,
                    version,
                  );
              if (value)
                matches.push({
                  value,
                  expiry,
                  access: Number(row.last_access_utc),
                });
            } catch {
              /* Try remaining profiles. */
            }
          }
        } catch {
          /* Profile may be inaccessible or not a Chromium profile. */
        } finally {
          db?.close();
        }
      }
    }
  matches.sort((a, b) => b.expiry - a.expiry || b.access - a.access);
  const match = matches[0];
  if (!match)
    throw new DougsError(
      'COOKIE_MISSING',
      `No valid Dougs session in ${browser}`,
      3,
      `log into app.dougs.fr in ${browser}, then retry`,
    );
  return match.value;
}
