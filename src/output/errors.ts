export class DougsError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 1,
    public hint?: string,
    public status?: number,
  ) {
    super(message);
  }
}
export function errorObject(error: unknown) {
  const e =
    error instanceof DougsError
      ? error
      : new DougsError(
          'UNEXPECTED',
          'Unexpected failure',
          1,
          'run with --verbose or consult the documentation',
        );
  return {
    error: {
      code: e.code,
      message: e.message,
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.status ? { status: e.status } : {}),
    },
  };
}
export function usage(message: string): never {
  throw new DougsError('USAGE', message, 2);
}
export function redact(text: string, secrets: string[] = []): string {
  let out = text.replace(/auth_session=[^;\s"']+/gi, 'auth_session=[REDACTED]');
  for (const secret of secrets)
    if (secret) out = out.split(secret).join('[REDACTED]');
  return out;
}
