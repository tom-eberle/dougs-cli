import { createInterface } from 'node:readline/promises';
import { readBrowserSession } from './auth/browser-cookies.js';
import type { Runtime } from './commands/context.js';
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
  readBrowserSession: (browser) => readBrowserSession(browser),
};

process.exitCode = await run(process.argv.slice(2), runtime);
