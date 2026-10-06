import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DougsError } from '../output/errors.js';
export const browserSchema = z.enum(['chrome', 'brave', 'edge', 'arc']);
export type Browser = z.infer<typeof browserSchema>;
const profileSchema = z.object({
  session: z.string().optional(),
  source: z.enum(['token', 'chrome', 'brave', 'edge', 'arc']).optional(),
  companyId: z.string().optional(),
});
const configSchema = z.object({
  profiles: z.record(z.string(), profileSchema),
  activeProfile: z.string(),
});
export type Config = z.infer<typeof configSchema>;
export type Profile = z.infer<typeof profileSchema>;
export const configPath = () =>
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'dougs-cli',
    'config.json',
  );
let ephemeralConfig: Config = { profiles: {}, activeProfile: 'default' };
export async function readConfig(): Promise<Config> {
  if (process.env.DOUGS_EPHEMERAL === '1') return ephemeralConfig;
  try {
    return configSchema.parse(JSON.parse(await readFile(configPath(), 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { profiles: {}, activeProfile: 'default' };
    throw new DougsError(
      'CONFIG_INVALID',
      'Cannot read config',
      2,
      `check ${configPath()}`,
    );
  }
}
export async function writeConfig(config: Config): Promise<void> {
  if (process.env.DOUGS_EPHEMERAL === '1') {
    ephemeralConfig = config;
    return;
  }
  const path = configPath();
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
export function profileName(config: Config, explicit?: string): string {
  return explicit || process.env.DOUGS_PROFILE || config.activeProfile;
}
