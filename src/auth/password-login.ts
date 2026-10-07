import type { Fetch } from '../api/client.js';
import { DougsError, ExitCode } from '../output/errors.js';
import { type Cookie, parseSetCookie } from '../util/cookies.js';
import { DEFAULT_API_BASE, USER_AGENT } from '../version.js';

/**
 * Email + password login, as the Dougs web app does it (read from its bundle):
 *
 *   POST /auth/api/login {email, password}
 *     → {status: "authenticated"}                         session cookie set
 *     → {status: "mfaRequired", enabledAuthFactors: [...]}  a pending cookie is set
 *     → {status: "ssoRequired"}                           Google sign-in only
 *   POST /auth/api/mfa/send-email {}                        email factor: send a code
 *   POST /auth/api/mfa/verify {token, type}                 → {status: "authenticated"}
 *
 * There is no captcha or device check. Cookies set along the way are sent back on
 * the next request; the result is the final auth_session cookie. The password is
 * only ever sent to Dougs, never stored.
 */

export type AuthFactor = 'totp' | 'email';

export interface LoginPrompts {
  /** Ask for the second-factor code; `factor` says where it comes from. */
  code(factor: AuthFactor, attempt: number): Promise<string>;
  /** Tell the user something (e.g. "a code was sent by email"). */
  info(message: string): void;
}

export interface LoginOptions {
  email: string;
  password: string;
  prompts: LoginPrompts | null;
  /** Force a second factor instead of the one the web app would pick. */
  factor?: AuthFactor;
  fetch?: Fetch;
  baseUrl?: string;
  log?: (line: string) => void;
}

export interface LoginResult {
  session: string;
  expiresAt: string | null;
  factor: AuthFactor | null;
}

interface FactorInfo {
  type: string;
  lastUsedAt?: string | null;
}

const MAX_CODE_ATTEMPTS = 3;

export async function passwordLogin(options: LoginOptions): Promise<LoginResult> {
  const jar = new CookieJar();
  const base = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${base}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          ...(jar.header ? { Cookie: jar.header } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (cause) {
      throw new DougsError('NETWORK', `Could not reach ${base}`, {
        exitCode: ExitCode.network,
        hint: 'check your connection and retry',
        cause,
      });
    }
    options.log?.(`POST ${path} → ${response.status}`);
    jar.take(response);
    const data = (await response.json().catch(() => null)) as {
      status?: unknown;
      message?: unknown;
      enabledAuthFactors?: unknown;
    } | null;
    return { response, data };
  };

  const login = await post('/auth/api/login', {
    email: options.email,
    password: options.password,
  });
  if (login.response.status === 429 || login.response.status >= 500)
    throw new DougsError(
      'API_UNAVAILABLE',
      `Dougs could not log you in (HTTP ${login.response.status})`,
      {
        exitCode: ExitCode.network,
        hint: 'retry in a minute',
        status: login.response.status,
      },
    );
  if (!login.response.ok)
    throw new DougsError(
      'LOGIN_REJECTED',
      `Dougs rejected this email and password${serverMessage(login.data)}`,
      {
        exitCode: ExitCode.auth,
        hint: 'check them in the web app (forgotten password: https://app.dougs.fr/signin/forgot-password)',
        status: login.response.status,
      },
    );

  let factor: AuthFactor | null = null;
  const status = login.data?.status;
  if (status === 'ssoRequired')
    throw new DougsError('SSO_REQUIRED', 'This Dougs account signs in with Google', {
      exitCode: ExitCode.auth,
      hint: 'log in to app.dougs.fr in your browser, then: dougs login --from-browser chrome',
    });
  if (status === 'mfaRequired') {
    factor = chooseFactor(login.data?.enabledAuthFactors, options.factor);
    if (!options.prompts)
      throw new DougsError('MFA_NEEDS_TERMINAL', 'Dougs asks for a second-factor code', {
        exitCode: ExitCode.usage,
        hint: 'run dougs login in a terminal, or use: dougs login --with-token',
      });
    if (factor === 'email') {
      const sent = await post('/auth/api/mfa/send-email', {});
      if (!sent.response.ok)
        throw new DougsError(
          'MFA_FAILED',
          `Dougs could not send the email code (HTTP ${sent.response.status})`,
          {
            exitCode: ExitCode.auth,
            status: sent.response.status,
          },
        );
      options.prompts.info('Dougs sent a verification code to your email.');
    }
    for (let attempt = 1; ; attempt++) {
      const token = (await options.prompts.code(factor, attempt)).replace(/\s+/g, '');
      const verify = await post('/auth/api/mfa/verify', { token, type: factor });
      if (verify.response.ok && verify.data?.status === 'authenticated') break;
      if (verify.response.status === 429 || verify.response.status >= 500)
        throw new DougsError(
          'API_UNAVAILABLE',
          `Dougs could not check the code (HTTP ${verify.response.status})`,
          {
            exitCode: ExitCode.network,
            status: verify.response.status,
          },
        );
      if (attempt >= MAX_CODE_ATTEMPTS)
        throw new DougsError('MFA_FAILED', 'Dougs rejected the verification code', {
          exitCode: ExitCode.auth,
          hint: 'run dougs login again',
        });
      options.prompts.info('That code was not accepted; try again.');
    }
  } else if (status !== 'authenticated') {
    throw new DougsError(
      'LOGIN_UNSUPPORTED',
      `Dougs answered the login with an unknown step (${String(status)})`,
      {
        exitCode: ExitCode.auth,
        hint: 'log in to app.dougs.fr in your browser, then: dougs login --from-browser chrome',
      },
    );
  }

  const cookie = jar.get('auth_session');
  if (!cookie)
    throw new DougsError(
      'LOGIN_UNSUPPORTED',
      'Dougs accepted the login but sent no session cookie',
      {
        exitCode: ExitCode.auth,
        hint: 'please open an issue; meanwhile: dougs login --from-browser chrome',
      },
    );
  return { session: cookie.value, expiresAt: cookie.expiresAt, factor };
}

/** The factor the web app would pick: most recently used, else an authenticator app. */
export function chooseFactor(factors: unknown, forced?: AuthFactor): AuthFactor {
  const known = (Array.isArray(factors) ? (factors as FactorInfo[]) : []).filter(
    (f): f is FactorInfo & { type: AuthFactor } => f?.type === 'totp' || f?.type === 'email',
  );
  if (forced) {
    if (known.some((f) => f.type === forced)) return forced;
    throw new DougsError(
      'MFA_FACTOR_UNAVAILABLE',
      `This account has no "${forced}" second factor`,
      {
        exitCode: ExitCode.usage,
        hint: `available: ${known.map((f) => f.type).join(', ') || 'none'}`,
      },
    );
  }
  const preference = { totp: 2, email: 1 };
  const [best] = [...known].sort((a, b) =>
    a.lastUsedAt && b.lastUsedAt
      ? Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)
      : preference[b.type] - preference[a.type],
  );
  if (!best)
    throw new DougsError(
      'LOGIN_UNSUPPORTED',
      'Dougs asks for a second factor this CLI does not know',
      {
        exitCode: ExitCode.auth,
        hint: 'log in to app.dougs.fr in your browser, then: dougs login --from-browser chrome',
      },
    );
  return best.type;
}

/** Just enough of a cookie jar for one login conversation with one origin. */
class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  take(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookie(header);
      if (!cookie) continue;
      const expired = cookie.expiresAt !== null && Date.parse(cookie.expiresAt) <= Date.now();
      if (!cookie.value || expired) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie);
    }
  }

  get(name: string): Cookie | undefined {
    return this.cookies.get(name);
  }

  get header(): string {
    return [...this.cookies.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

function serverMessage(data: { message?: unknown } | null): string {
  return typeof data?.message === 'string' && data.message ? `: ${data.message.slice(0, 200)}` : '';
}
