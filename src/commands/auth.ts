import { type Command, Option } from 'commander';
import { ApiClient } from '../api/client.js';
import { rawUserSchema, type Whoami } from '../api/schemas.js';
import {
  activeProfileName,
  BROWSERS,
  type Browser,
  configPath,
  readConfig,
  writeConfig,
} from '../auth/config.js';
import { DougsError, ExitCode, usageError } from '../output/errors.js';
import { style } from '../output/style.js';
import { renderKeyValues } from '../output/table.js';
import { contextOf } from './context.js';
import { withExamples } from './shared.js';

function cleanToken(input: string): string {
  const value = input
    .trim()
    .replace(/^cookie:\s*/i, '')
    .replace(/^auth_session=/, '')
    .trim();
  if (!value || /[\s;]/.test(value))
    throw usageError(
      'Expected the auth_session cookie value on stdin',
      'paste only the value, e.g.: pbpaste | dougs login --with-token',
    );
  return value;
}

export function registerAuthCommands(program: Command): void {
  withExamples(
    program
      .command('login')
      .description('Store a Dougs session, read from your browser or from stdin')
      .addOption(
        new Option(
          '--from-browser <browser>',
          'Read the session cookie from this browser (macOS; Linux best effort)',
        ).choices(BROWSERS),
      )
      .option('--with-token', 'Read the auth_session cookie value from stdin'),
    'login --from-browser chrome',
    'login --with-token < session.txt',
    'login --from-browser brave --profile work --company 999999',
  ).action(async (opts: { fromBrowser?: Browser; withToken?: boolean }, cmd: Command) => {
    const ctx = contextOf(cmd);
    if (!!opts.fromBrowser === !!opts.withToken)
      throw usageError(
        'Choose exactly one of --from-browser <browser> or --with-token',
        'e.g.: dougs login --from-browser chrome',
      );
    let session: string;
    let expiresAt: string | null = null;
    let browserProfile: string | null = null;
    if (opts.fromBrowser) {
      const found = await ctx.runtime.readBrowserSession(opts.fromBrowser);
      session = found.value;
      expiresAt = found.expiresAt;
      browserProfile = found.profile;
    } else {
      session = cleanToken(await ctx.runtime.readStdin());
    }
    ctx.out.addSecret(session);

    const client = new ApiClient({
      session,
      baseUrl: ctx.env.DOUGS_API_BASE,
      fetch: ctx.runtime.fetch,
      log: (l) => ctx.out.debug(l),
    });
    const raw = rawUserSchema.parse(await client.get('/users/me'));
    const companies = (raw.companies ?? []).map((c) => ({
      id: String(c.id),
      name: c.brandName || c.legalName || c.fullName || '',
    }));

    const config = await readConfig(ctx.env);
    const profileName = activeProfileName(config, ctx.options.profile, ctx.env);
    const previous = config.profiles[profileName] ?? {};
    const companyId =
      ctx.options.company ??
      (companies.length === 1
        ? companies[0]!.id
        : previous.companyId && companies.some((c) => c.id === previous.companyId)
          ? previous.companyId
          : undefined);
    config.profiles[profileName] = {
      ...previous,
      session,
      source: opts.fromBrowser ?? 'token',
      companyId,
      savedAt: new Date().toISOString(),
    };
    config.activeProfile = profileName;
    await writeConfig(config, ctx.env);

    const result = {
      profile: profileName,
      source: opts.fromBrowser ?? 'token',
      browserProfile,
      sessionExpiresAt: expiresAt,
      user: { id: String(raw.id), name: raw.profile?.fullName ?? null, email: raw.email ?? null },
      companies,
      activeCompany: companyId ?? null,
      configPath: configPath(ctx.env),
    };
    ctx.out.result(result, (r) => {
      const lines = [
        `${style.green('✓')} Logged in${r.user.name ? ` as ${r.user.name}` : ''} via ${r.source}${r.browserProfile ? ` (browser profile "${r.browserProfile}")` : ''}`,
      ];
      if (r.sessionExpiresAt)
        lines.push(style.dim(`  session valid until ${r.sessionExpiresAt.slice(0, 10)}`));
      lines.push(style.dim(`  saved to profile "${r.profile}" in ${r.configPath}`));
      if (r.activeCompany)
        lines.push(
          `  company ${r.activeCompany}${companies.find((c) => c.id === r.activeCompany)?.name ? ` (${companies.find((c) => c.id === r.activeCompany)?.name})` : ''}`,
        );
      else if (companies.length > 1)
        lines.push(
          style.yellow(`  ${companies.length} companies: pass --company <id> or set DOUGS_COMPANY`),
        );
      return lines.join('\n');
    });
  });

  withExamples(
    program.command('logout').description('Forget the stored session for the active profile'),
    'logout',
    'logout --profile work',
  ).action(async (_opts: unknown, cmd: Command) => {
    const ctx = contextOf(cmd);
    const config = await readConfig(ctx.env);
    const profileName = activeProfileName(config, ctx.options.profile, ctx.env);
    const profile = config.profiles[profileName];
    const hadSession = !!profile?.session;
    if (profile) config.profiles[profileName] = { companyId: profile.companyId };
    await writeConfig(config, ctx.env);
    ctx.out.result({ profile: profileName, loggedOut: hadSession }, (r) =>
      r.loggedOut
        ? `${style.green('✓')} Logged out of profile "${r.profile}"`
        : `Profile "${r.profile}" had no stored session`,
    );
  });

  withExamples(
    program
      .command('whoami')
      .description('Show the user, their companies, the active company and where auth comes from'),
    'whoami',
    'whoami --json | jq .activeCompany',
  ).action(async (_opts: unknown, cmd: Command) => {
    const ctx = contextOf(cmd);
    const auth = await ctx.auth();
    const { user, companies } = await ctx.user();
    let activeCompany: string | null = null;
    try {
      activeCompany = await ctx.companyId();
    } catch (e) {
      if (!(e instanceof DougsError) || e.exitCode !== ExitCode.usage) throw e;
    }
    const data: Whoami = {
      user,
      companies,
      activeCompany,
      profile: auth.profileName,
      authSource: auth.source,
    };
    ctx.out.result(data, (w) =>
      renderKeyValues([
        ['user', [w.user.name, w.user.email].filter(Boolean).join(' · ') || w.user.id],
        [
          'companies',
          w.companies
            .map(
              (c) =>
                `${c.id}${c.name ? ` ${c.name}` : ''}${c.id === w.activeCompany ? ' (active)' : ''}`,
            )
            .join('\n           ') || '—',
        ],
        ['active', w.activeCompany ?? style.yellow('none — pass --company <id>')],
        ['profile', w.profile],
        [
          'auth',
          w.authSource === 'env'
            ? 'DOUGS_SESSION environment variable'
            : w.authSource === 'token'
              ? 'token (stdin)'
              : `${w.authSource} cookie (auto-refreshes)`,
        ],
      ]),
    );
  });
}
