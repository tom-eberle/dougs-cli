import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../../src/api/cache.js';
import { ApiClient } from '../../src/api/client.js';
import { Dougs } from '../../src/api/dougs.js';
import type { BrowserSession } from '../../src/auth/browser-cookies.js';
import type { SecretStore } from '../../src/auth/secrets.js';
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
  /** Answers to successive prompts (ask and askSecret), before falling back to `answer`. */
  answers?: string[];
  /** Receives every question asked on the TTY (secret ones are prefixed with "secret:"). */
  questions?: string[];
  /** OS credential store; default none (sessions go to the config file). */
  secrets?: SecretStore | null;
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
    ask: async (question) => {
      options.questions?.push(question);
      return options.answers?.shift() ?? options.answer ?? 'n';
    },
    askSecret: async (question) => {
      options.questions?.push(`secret:${question}`);
      return options.answers?.shift() ?? '';
    },
    secrets: options.secrets ?? null,
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

/** An in-memory OS credential store; `broken` makes every write fail. */
export function memoryStore(broken = false): SecretStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    id: 'keychain',
    label: 'macOS Keychain',
    items,
    get: async (account) => items.get(account) ?? null,
    set: async (account, secret) => {
      if (broken) return false;
      items.set(account, secret);
      return true;
    },
    delete: async (account) => {
      items.delete(account);
    },
  };
}
