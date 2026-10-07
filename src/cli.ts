import { createInterface } from 'node:readline/promises';
import { readBrowserSession } from './auth/browser-cookies.js';
import { platformSecretStore } from './auth/secrets.js';
import type { Runtime } from './commands/context.js';
import { DougsError, ExitCode } from './output/errors.js';
import { run } from './program.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Read a line from the terminal without echoing it (raw mode). */
function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003')
          return finish(new DougsError('CANCELLED', 'Cancelled', { exitCode: ExitCode.usage }));
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

// A closed pipe (e.g. `dougs ops list | head`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const runtime: Runtime = {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTTY: !!process.stdout.isTTY,
  stdinIsTTY: !!process.stdin.isTTY,
  readStdin,
  ask,
  askSecret,
  readBrowserSession: (browser) => readBrowserSession(browser),
  secrets: platformSecretStore(process.platform, process.env),
};

process.exitCode = await run(process.argv.slice(2), runtime);
