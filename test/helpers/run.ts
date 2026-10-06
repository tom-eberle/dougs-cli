import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../../src/api/cache.js';
import { ApiClient } from '../../src/api/client.js';
import { Dougs } from '../../src/api/dougs.js';
import type { BrowserSession } from '../../src/auth/browser-cookies.js';
import type { Runtime } from '../../src/commands/context.js';
import { run } from '../../src/program.js';
import type { FakeDougs } from './fake-api.js';
import { COMPANY } from './fixtures.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => unknown;
  error: () => { code: string; message: string; hint?: string };
}

export interface RunOptions {
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
  stdin?: string;
  answer?: string;
  env?: Record<string, string>;
  /** Log in first by writing a config file with the fake session. */
  loggedIn?: boolean;
  home?: string;
  browserSession?: BrowserSession;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dougs-cli-test-'));
}

export async function writeLoggedInConfig(home: string, session: string): Promise<void> {
  const dir = join(home, 'config', 'dougs-cli');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      activeProfile: 'default',
      profiles: { default: { session, source: 'token', companyId: COMPANY } },
    }),
    { mode: 0o600 },
  );
}

export async function runCli(
  api: FakeDougs,
  args: string[],
  options: RunOptions = {},
): Promise<CliResult> {
  const home = options.home ?? tempHome();
  if (options.loggedIn !== false) await writeLoggedInConfig(home, api.session);
  let stdout = '';
  let stderr = '';
  const runtime: Runtime = {
    env: {
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
      DOUGS_API_BASE: 'https://dougs.example.test',
      ...options.env,
    },
    fetch: api.fetch as typeof fetch,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    stdinIsTTY: options.stdinIsTTY ?? false,
    readStdin: async () => options.stdin ?? '',
    ask: async () => options.answer ?? 'n',
    readBrowserSession: async (browser) => {
      if (!options.browserSession) throw new Error(`no ${browser} session in test`);
      return options.browserSession;
    },
  };
  const code = await run(args, runtime);
  return {
    code,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
    error: () => JSON.parse(stderr.trim().split('\n').at(-1) ?? '{}').error,
  };
}

/** A company-scoped API wrapper over the fake, with caching disabled. */
export function dougsFor(api: FakeDougs): Dougs {
  const client = new ApiClient({
    session: api.session,
    baseUrl: 'https://dougs.example.test',
    fetch: api.fetch as typeof fetch,
    sleep: async () => {},
  });
  return new Dougs(client, COMPANY, new Cache(tempHome(), false));
}
