import { join } from 'node:path';
import type { Command } from 'commander';
import { Cache } from '../api/cache.js';
import { ApiClient, type Fetch } from '../api/client.js';
import { Dougs } from '../api/dougs.js';
import { type Company, rawUserSchema, type Whoami } from '../api/schemas.js';
import type { BrowserSession } from '../auth/browser-cookies.js';
import {
  activeProfileName,
  BROWSERS,
  type Browser,
  type Config,
  cacheDir,
  type Env,
  type Profile,
  readConfig,
  writeConfig,
} from '../auth/config.js';
import { DougsError, ExitCode, LOGIN_HINT } from '../output/errors.js';
import { Output, type Writer } from '../output/format.js';
import { sanitizeForTerminal } from '../output/style.js';

export interface GlobalOptions {
  json?: boolean;
  jsonl?: boolean;
  profile?: string;
  company?: string;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  cache?: boolean;
}

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface Runtime {
  env: Env;
  fetch: Fetch;
  stdout: Writer;
  stderr: Writer;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
  /** Ask a yes/no question on stderr; only called when both stdin and stdout are TTYs. */
  ask: (question: string) => Promise<string>;
  readBrowserSession: (browser: Browser) => Promise<BrowserSession>;
}

export type AuthSource = Whoami['authSource'];

export interface AuthState {
  client: ApiClient;
  config: Config;
  profileName: string;
  profile: Profile;
  source: AuthSource;
}

export class Context {
  readonly out: Output;
  /** Exit code to use when the command completes without throwing (e.g. 7 for partial failure). */
  exitCode: ExitCode = ExitCode.ok;
  private authState?: Promise<AuthState>;
  private userState?: Promise<{ user: Whoami['user']; companies: Company[] }>;
  private dougsState?: Promise<Dougs>;

  constructor(
    readonly runtime: Runtime,
    readonly options: GlobalOptions,
  ) {
    this.out = new Output(
      {
        json: options.json,
        jsonl: options.jsonl,
        quiet: options.quiet,
        verbose: options.verbose,
        stdoutIsTTY: runtime.stdoutIsTTY,
      },
      runtime.stdout,
      runtime.stderr,
    );
  }

  get env(): Env {
    return this.runtime.env;
  }

  /** A client for the stored or environment-provided session. */
  auth(): Promise<AuthState> {
    this.authState ??= this.loadAuth();
    return this.authState;
  }

  private async loadAuth(): Promise<AuthState> {
    const config = await readConfig(this.env);
    const profileName = activeProfileName(config, this.options.profile, this.env);
    const profile = config.profiles[profileName] ?? {};
    const envSession = this.env.DOUGS_SESSION?.trim();
    const session = envSession || profile.session;
    if (!session)
      throw new DougsError('AUTH_MISSING', `Not logged in (profile "${profileName}")`, {
        exitCode: ExitCode.auth,
        hint: LOGIN_HINT,
      });
    const source: AuthSource = envSession ? 'env' : (profile.source ?? 'token');
    this.out.addSecret(session);
    const browser = (BROWSERS as readonly string[]).includes(source) ? (source as Browser) : null;
    const client = new ApiClient({
      session,
      baseUrl: this.env.DOUGS_API_BASE,
      fetch: this.runtime.fetch,
      log: (line) => this.out.debug(line),
      refreshSession: browser
        ? async () => {
            const fresh = await this.runtime.readBrowserSession(browser);
            this.out.addSecret(fresh.value);
            config.profiles[profileName] = {
              ...profile,
              session: fresh.value,
              savedAt: new Date().toISOString(),
            };
            await writeConfig(config, this.env);
            return fresh.value;
          }
        : undefined,
    });
    return { client, config, profileName, profile, source };
  }

  /** Current user and the companies they can access. */
  user(): Promise<{ user: Whoami['user']; companies: Company[] }> {
    this.userState ??= (async () => {
      const { client } = await this.auth();
      const raw = rawUserSchema.parse(await client.get('/users/me'));
      const companies = (raw.companies ?? []).map((c) => ({
        id: String(c.id),
        name: c.brandName || c.legalName || c.fullName || '',
      }));
      return {
        user: { id: String(raw.id), name: raw.profile?.fullName ?? null, email: raw.email ?? null },
        companies,
      };
    })();
    return this.userState;
  }

  /** Resolve the company: --company, DOUGS_COMPANY, profile default, or the only one. */
  async companyId(): Promise<string> {
    const auth = await this.auth();
    const explicit = this.options.company || this.env.DOUGS_COMPANY || auth.profile.companyId;
    if (explicit) {
      if (!/^\d+$/.test(explicit))
        throw new DougsError('USAGE', `Company ids are numeric, got "${explicit}"`, {
          exitCode: ExitCode.usage,
        });
      return explicit;
    }
    const { companies } = await this.user();
    if (companies.length === 1) return companies[0]!.id;
    throw new DougsError(
      'COMPANY_REQUIRED',
      companies.length
        ? `You have access to ${companies.length} companies; choose one`
        : 'No company found for this user',
      {
        exitCode: ExitCode.usage,
        hint: companies.length
          ? `pass --company <id> (one of: ${companies.map((c) => c.id).join(', ')}) or set DOUGS_COMPANY`
          : undefined,
      },
    );
  }

  dougs(): Promise<Dougs> {
    this.dougsState ??= (async () => {
      const [{ client }, company] = await Promise.all([this.auth(), this.companyId()]);
      const cache = new Cache(join(cacheDir(this.env), company), this.options.cache !== false);
      return new Dougs(client, company, cache);
    })();
    return this.dougsState;
  }

  /**
   * Gate a mutation. TTY: ask once. Non-interactive: refuse with exit 2 unless
   * --yes, so an agent can never hang on a prompt.
   */
  async confirm(question: string, yes: boolean | undefined): Promise<void> {
    if (yes) return;
    if (!this.runtime.stdinIsTTY || !this.runtime.stdoutIsTTY)
      throw new DougsError(
        'CONFIRMATION_REQUIRED',
        'This command changes data in Dougs and needs confirmation',
        {
          exitCode: ExitCode.usage,
          hint: 're-run with --yes to apply, or --dry-run to preview',
        },
      );
    const answer = await this.runtime.ask(sanitizeForTerminal(`${question} [y/N] `));
    if (!/^y(es)?$/i.test(answer.trim()))
      throw new DougsError('CANCELLED', 'Cancelled; nothing was changed', {
        exitCode: ExitCode.usage,
      });
  }
}

/** Resolve the shared Context from any (sub)command. */
export function contextOf(command: Command): Context {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const holder = root as Command & { dougsContext?: Context; dougsRuntime?: Runtime };
  if (!holder.dougsContext) {
    if (!holder.dougsRuntime) throw new Error('CLI runtime not initialised');
    holder.dougsContext = new Context(
      holder.dougsRuntime,
      command.optsWithGlobals<GlobalOptions>(),
    );
  }
  return holder.dougsContext;
}
