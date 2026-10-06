import { z } from 'zod';
import { ApiClient } from '../api/client.js';
import { companySchema, userSchema, whoamiSchema } from '../api/schemas.js';
import { readBrowserCookie } from '../auth/browser-cookies.js';
import {
  type Browser,
  profileName,
  readConfig,
  writeConfig,
} from '../auth/config.js';
import { DougsError } from '../output/errors.js';
export interface GlobalOptions {
  json?: boolean;
  jsonl?: boolean;
  profile?: string;
  company?: string;
  verbose?: boolean;
  quiet?: boolean;
  cache?: boolean;
}
export interface Context {
  client: ApiClient;
  company: string;
  options: GlobalOptions;
}
const rawUser = z.looseObject({
  id: z.union([z.string(), z.number()]),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  companies: z
    .array(
      z.looseObject({
        id: z.union([z.string(), z.number()]),
        name: z.string().optional(),
        businessName: z.string().optional(),
      }),
    )
    .optional(),
});
export async function authenticated(options: GlobalOptions) {
  const config = await readConfig();
  const name = profileName(config, options.profile);
  const profile = config.profiles[name] ?? {};
  const session = process.env.DOUGS_SESSION || profile.session;
  if (!session)
    throw new DougsError(
      'AUTH_MISSING',
      'No Dougs session configured',
      3,
      'run: dougs login --from-browser chrome',
    );
  const client = new ApiClient({
    session,
    verbose: options.verbose && !options.quiet,
    refresh:
      !process.env.DOUGS_SESSION && profile.source && profile.source !== 'token'
        ? async () => {
            const session = readBrowserCookie(profile.source as Browser);
            config.profiles[name] = { ...profile, session };
            await writeConfig(config);
            return session;
          }
        : undefined,
  });
  return {
    client,
    config,
    name,
    profile,
    source: process.env.DOUGS_SESSION ? 'env' : (profile.source ?? 'token'),
  };
}
export async function identity(options: GlobalOptions) {
  const auth = await authenticated(options);
  const raw = rawUser.parse(await auth.client.request('GET', '/users/me'));
  const listed = z
    .array(
      z.looseObject({
        id: z.union([z.string(), z.number()]),
        name: z.string().optional(),
        businessName: z.string().optional(),
      }),
    )
    .parse(await auth.client.request('GET', `/users/${raw.id}/companies`));
  const companies = listed.map((c) =>
    companySchema.parse({
      id: String(c.id),
      name: c.name ?? c.businessName ?? '',
    }),
  );
  const company =
    options.company ||
    process.env.DOUGS_COMPANY ||
    auth.profile.companyId ||
    (companies.length === 1 ? companies[0]?.id : undefined);
  const user = userSchema.parse({
    id: String(raw.id),
    name:
      raw.name ??
      ([raw.firstName, raw.lastName].filter(Boolean).join(' ') || null),
    email: raw.email ?? null,
  });
  return {
    ...auth,
    data: whoamiSchema.parse({
      user,
      companies,
      activeCompany: company ?? null,
      authSource: auth.source,
    }),
  };
}
export async function context(options: GlobalOptions): Promise<Context> {
  const auth = await authenticated(options);
  let company =
    options.company || process.env.DOUGS_COMPANY || auth.profile.companyId;
  if (!company)
    company = (await identity(options)).data.activeCompany ?? undefined;
  if (!company || !/^\d+$/.test(company))
    throw new DougsError(
      'COMPANY_REQUIRED',
      'Select a company',
      2,
      'run dougs whoami; use --company <id>',
    );
  return { client: auth.client, company, options };
}
