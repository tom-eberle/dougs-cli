import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { DougsError, ExitCode } from '../output/errors.js';

export const BROWSERS = ['chrome', 'brave', 'edge', 'arc'] as const;
export const browserSchema = z.enum(BROWSERS);
export type Browser = z.infer<typeof browserSchema>;

export const credentialSourceSchema = z.enum(['password', 'token', ...BROWSERS]);
export type CredentialSource = z.infer<typeof credentialSourceSchema>;

const profileSchema = z.object({
  /** Only when no OS credential store is available (or sessions saved before 0.1.0). */
  session: z.string().optional(),
  /** The OS store holding this profile's session, keyed by the profile name. */
  sessionStore: z.enum(['keychain', 'libsecret']).optional(),
  sessionExpiresAt: z.string().optional(),
  source: credentialSourceSchema.optional(),
  /** Last email used with password login, offered as the default next time. */
  email: z.string().optional(),
  companyId: z.string().optional(),
  savedAt: z.string().optional(),
});
export type Profile = z.infer<typeof profileSchema>;

const configSchema = z.object({
  profiles: z.record(z.string(), profileSchema).default({}),
  activeProfile: z.string().default('default'),
});
export type Config = z.infer<typeof configSchema>;

export type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dougs-cli');
}

export function cacheDir(env: Env = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dougs-cli');
}

export function configPath(env: Env = process.env): string {
  return join(configDir(env), 'config.json');
}

export async function readConfig(env: Env = process.env): Promise<Config> {
  const path = configPath(env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { profiles: {}, activeProfile: 'default' };
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success)
    throw new DougsError('CONFIG_INVALID', `Config file is not valid: ${path}`, {
      exitCode: ExitCode.usage,
      hint: 'fix or delete the file, then run dougs login again',
    });
  return parsed.data;
}

/** Atomic write with 0600 permissions; the file may hold a session cookie. */
export async function writeConfig(config: Config, env: Env = process.env): Promise<void> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export function activeProfileName(
  config: Config,
  explicit: string | undefined,
  env: Env = process.env,
): string {
  return explicit || env.DOUGS_PROFILE || config.activeProfile || 'default';
}
