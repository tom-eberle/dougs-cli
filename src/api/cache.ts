import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export class Cache {
  constructor(
    private company: string,
    private enabled = true,
  ) {}
  private path(key: string): string {
    return join(
      process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
      'dougs-cli',
      this.company,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
  }
  async get(
    key: string,
    ttl = Number.POSITIVE_INFINITY,
  ): Promise<unknown | undefined> {
    if (!this.enabled) return;
    try {
      const data = JSON.parse(await readFile(this.path(key), 'utf8')) as {
        at: number;
        value: unknown;
      };
      if (Date.now() - data.at <= ttl) return data.value;
    } catch {
      /* Cache misses are harmless. */
    }
  }
  async set(key: string, value: unknown): Promise<void> {
    if (!this.enabled) return;
    const path = this.path(key);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ at: Date.now(), value }), {
      mode: 0o600,
    });
  }
}
