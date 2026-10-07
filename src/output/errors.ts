/** Stable process exit codes (SPEC §5.2). */
export const ExitCode = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  rejected: 5,
  network: 6,
  partial: 7,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface ErrorOptions {
  exitCode?: ExitCode;
  hint?: string;
  status?: number;
  cause?: unknown;
}

/** An error the CLI knows how to explain: machine code, human message, optional hint. */
export class DougsError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly status?: number;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'DougsError';
    this.code = code;
    this.exitCode = options.exitCode ?? ExitCode.unexpected;
    this.hint = options.hint;
    this.status = options.status;
  }
}

export const LOGIN_HINT = 'run: dougs login (or: dougs login --from-browser chrome)';

export function usageError(message: string, hint?: string): DougsError {
  return new DougsError('USAGE', message, { exitCode: ExitCode.usage, hint });
}

export function notFound(message: string, hint?: string): DougsError {
  return new DougsError('NOT_FOUND', message, { exitCode: ExitCode.notFound, hint, status: 404 });
}

export interface ErrorPayload {
  error: { code: string; message: string; hint?: string; status?: number };
}

const SECRET_PATTERNS = [/auth_session=[^;\s"']+/gi, /s%3A[A-Za-z0-9%._-]{16,}/g];

/** Remove anything that looks like a session cookie, plus explicitly known secrets. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  out = out.replace(SECRET_PATTERNS[0]!, 'auth_session=[REDACTED]');
  return out.replace(SECRET_PATTERNS[1]!, '[REDACTED]');
}

export function toDougsError(error: unknown): DougsError {
  if (error instanceof DougsError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DougsError('UNEXPECTED', message || 'Unexpected failure', {
    hint: 're-run with --verbose; if it persists, please open an issue',
    cause: error,
  });
}

export function errorPayload(error: unknown, secrets: readonly string[] = []): ErrorPayload {
  const e = toDougsError(error);
  return {
    error: {
      code: e.code,
      message: redact(e.message, secrets),
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.status ? { status: e.status } : {}),
    },
  };
}
