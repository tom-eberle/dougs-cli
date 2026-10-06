import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { z } from 'zod';
import {
  accountSchema,
  attachmentSchema,
  breakdownSchema,
  categorySchema,
  companySchema,
  operationSchema,
  rawOperationSchema,
  whoamiSchema,
} from '../api/schemas.js';
import { readBrowserCookie } from '../auth/browser-cookies.js';
import {
  browserSchema,
  profileName,
  readConfig,
  writeConfig,
} from '../auth/config.js';
import { usage } from '../output/errors.js';
import { output } from '../output/format.js';
import {
  authenticated,
  context,
  type GlobalOptions,
  identity,
} from './context.js';
export function options(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}
export function example(command: Command, ...examples: string[]): Command {
  command.addHelpText(
    'after',
    `\nExamples:\n${examples.map((e) => `  dougs ${e}`).join('\n')}`,
  );
  return command;
}
export async function stdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.trim();
}
export const schemas: Record<string, z.ZodType> = {
  operation: operationSchema,
  breakdown: breakdownSchema,
  attachment: attachmentSchema,
  category: categorySchema,
  account: accountSchema,
  company: companySchema,
  whoami: whoamiSchema,
  'raw-operation': rawOperationSchema,
};
export function registerCore(program: Command): void {
  example(
    program
      .command('login')
      .description(
        'Store a browser session or stdin cookie in the selected profile',
      )
      .option('--from-browser <browser>', 'chrome, brave, edge, arc')
      .option('--with-token', 'Read cookie value from stdin'),
    'login --from-browser chrome',
    'login --with-token < session.txt',
  ).action(async (_local, cmd: Command) => {
    const o = cmd.optsWithGlobals<
      GlobalOptions & { fromBrowser?: string; withToken?: boolean }
    >();
    if (!!o.fromBrowser === !!o.withToken)
      usage('Choose --from-browser or --with-token');
    const source = o.fromBrowser ? browserSchema.parse(o.fromBrowser) : 'token';
    const session =
      source === 'token' ? await stdin() : readBrowserCookie(source);
    if (!session || /[\r\n;]/.test(session))
      usage('Expected a cookie value, not a Cookie header');
    const config = await readConfig();
    const name = profileName(config, o.profile);
    config.profiles[name] = { ...config.profiles[name], session, source };
    config.activeProfile = name;
    await writeConfig(config);
    const who = await identity(o);
    if (who.data.activeCompany) {
      config.profiles[name] = {
        ...config.profiles[name],
        companyId: who.data.activeCompany,
      };
      await writeConfig(config);
    }
    output(
      {
        authenticated: true,
        profile: name,
        source,
        companies: who.data.companies.length,
      },
      o,
    );
  });
  example(
    program
      .command('logout')
      .description('Remove credentials from the selected profile'),
    'logout --profile default',
  ).action(async (_local, cmd: Command) => {
    const o = options(cmd);
    const config = await readConfig();
    const name = profileName(config, o.profile);
    const p = config.profiles[name];
    if (p) config.profiles[name] = { companyId: p.companyId };
    await writeConfig(config);
    output({ loggedOut: true, profile: name }, o);
  });
  example(
    program
      .command('whoami')
      .description('Show authenticated user, companies and active company'),
    'whoami --json',
  ).action(async (_local, cmd: Command) =>
    output((await identity(options(cmd))).data, options(cmd)),
  );
  example(
    program
      .command('schema <type>')
      .description('Print JSON Schema for a normalized output or plan'),
    'schema operation',
  ).action((type: string, _local, cmd: Command) => {
    const schema = schemas[type];
    if (!schema)
      usage(`Unknown schema. Available: ${Object.keys(schemas).join(', ')}`);
    output(z.toJSONSchema(schema), { ...options(cmd), json: true });
  });
  example(
    program
      .command('commands')
      .description(
        'Dump the complete command tree with arguments and flag types',
      ),
    'commands --json',
  ).action((_local, cmd: Command) => {
    const tree = (c: Command): unknown => ({
      name: c.name(),
      description: c.description(),
      args: c.registeredArguments.map((a) => ({
        name: a.name(),
        required: a.required,
        variadic: a.variadic,
        type: 'string',
        description: a.description,
      })),
      flags: c.options.map((o) => ({
        name: o.flags,
        type: o.required || o.optional ? 'string' : 'boolean',
        description: o.description,
        default: o.defaultValue,
      })),
      commands: c.commands.map(tree),
    });
    output(tree(program), options(cmd));
  });
  example(
    program
      .command('api <method> <path>')
      .description('Authenticated API escape hatch; use {company} in paths')
      .option('-d, --data <data>', 'JSON, @file or - (stdin)')
      .option(
        '-F, --field <key=value>',
        'Repeatable JSON fields',
        (v: string, p: string[]) => [...p, v],
        [],
      )
      .option('--raw', 'Return untouched payload')
      .option('--yes', 'Confirm a mutation')
      .option('--dry-run', 'Describe a mutation without sending it'),
    'api GET /companies/{company}/accounts',
    'api POST /companies/{company}/example -d @body.json --dry-run',
  ).action(async (method: string, path: string, _local, cmd: Command) => {
    const o = cmd.optsWithGlobals<
      GlobalOptions & {
        data?: string;
        field: string[];
        yes?: boolean;
        dryRun?: boolean;
      }
    >();
    method = method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method))
      usage('Unsupported HTTP method');
    const auth = path.includes('{company}')
      ? await context(o)
      : await authenticated(o);
    if ('company' in auth) path = path.replaceAll('{company}', auth.company);
    let body: unknown;
    if (o.data)
      body = JSON.parse(
        o.data === '-'
          ? await stdin()
          : o.data.startsWith('@')
            ? await readFile(o.data.slice(1), 'utf8')
            : o.data,
      );
    if (o.field.length) {
      if (body) usage('Use either --data or --field');
      body = Object.fromEntries(
        o.field.map((f) => {
          const i = f.indexOf('=');
          if (i < 1) usage('Fields must be key=value');
          const v = f.slice(i + 1);
          let value: unknown = v;
          try {
            value = JSON.parse(v);
          } catch {}
          return [f.slice(0, i), value];
        }),
      );
    }
    if (!['GET', 'HEAD'].includes(method)) {
      if (o.dryRun) {
        output({ method, path, body }, o);
        return;
      }
      const { confirm } = await import('../plan/diff.js');
      await confirm(o.yes);
    }
    output(await auth.client.request(method, path, body), o);
  });
  example(
    program
      .command('doctor')
      .description(
        'Check auth, API reachability and raw operation schema drift',
      ),
    'doctor --json',
  ).action(async (_local, cmd: Command) => {
    const o = options(cmd);
    const ctx = await context(o);
    const sample = await ctx.client.request(
      'GET',
      `/companies/${ctx.company}/operations?limit=5&offset=0&needsAttention=false&validated=false`,
    );
    const rows = z.array(z.unknown()).parse(sample);
    const issues = rows.flatMap((r, i) => {
      const parsed = rawOperationSchema.safeParse(r);
      return parsed.success
        ? []
        : parsed.error.issues.map((e) => ({
            sample: i,
            path: e.path.join('.'),
            code: e.code,
          }));
    });
    const known = new Set(Object.keys(rawOperationSchema.shape));
    const knownExtra = new Set(
      'messengerId transactionId investmentId reversedOperationId reverseOperationId detachDeleted isDraft autogenerated type validatedAt exclusionReason manuallyLocked needsAttention message metadata accountingSurveyId flag creatorId reversalDate salesChannelId createdAt updatedAt creator messenger isBank isCustomerCreditNote isSupplierCreditNote isExpense isInvoice isClientInvoice isVendorInvoice isInvoiceSupplier isInvoiceCustomer isKilometricIndemnity isCashPayment isCashExpense isMiscellaneous isCustomerEditableMiscellaneous isAccountingSurveyMiscellaneous isDispatch isReconciliation isCashRegisterDispatch isCashRegisterFee dispatchType name allowAddingBreakdown lockedByDate hasVat vatRate vatAmount totalAmount sections description errors allowUnbalanced isTotalAmountValid sourceDocumentCandidate'.split(
        ' ',
      ),
    );
    const unknownFields = [
      ...new Set(
        rows.flatMap((r) =>
          typeof r === 'object' && r !== null
            ? Object.keys(r).filter((k) => !known.has(k) && !knownExtra.has(k))
            : [],
        ),
      ),
    ];
    output(
      {
        auth: true,
        reachable: true,
        samples: rows.length,
        schemaValid: issues.length === 0,
        issues,
        unknownFields,
      },
      o,
    );
    if (issues.length) process.exitCode = 6;
  });
}
