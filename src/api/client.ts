import { DougsError, ExitCode, LOGIN_HINT, notFound, redact } from '../output/errors.js';
import { Limiter } from '../util/concurrency.js';
import { parseSetCookie } from '../util/cookies.js';
import { DEFAULT_API_BASE, USER_AGENT } from '../version.js';

export type Fetch = typeof fetch;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface ClientOptions {
  session: string;
  baseUrl?: string;
  fetch?: Fetch;
  /** Called once on 401/403 to obtain a fresh session (e.g. re-read the browser cookie). */
  refreshSession?: () => Promise<string | null>;
  /** Called when Dougs sends a new auth_session cookie (rotated value or new expiry). */
  onSessionCookie?: (session: string, expiresAt: string | null) => void;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

const MAX_CONCURRENCY = 4;

/**
 * HTTP client for the private Dougs API: cookie auth, polite concurrency,
 * GET-only retries with backoff, and errors mapped to stable exit codes.
 */
export class ApiClient {
  readonly baseUrl: string;
  private session: string;
  /** One shared refresh for all concurrent requests (sessions rotate). */
  private refresh?: Promise<string | null>;
  private readonly transport: Fetch;
  private readonly limiter = new Limiter(MAX_CONCURRENCY);
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ClientOptions) {
    this.session = options.session;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.transport = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get currentSession(): string {
    return this.session;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return (await this.json('GET', path)) as T;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.json('POST', path, body)) as T;
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return (await this.json('DELETE', path)) as T;
  }

  /** Send a request and decode the JSON body (null for empty responses). */
  async json(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(method, path, body);
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DougsError('API_SHAPE', `Expected JSON from ${method} ${pathOnly(path)}`, {
        exitCode: ExitCode.network,
        hint: 'run: dougs doctor',
      });
    }
  }

  /** Low-level request. Redirects are returned, not followed (see download). */
  async request(method: HttpMethod, path: string, body?: unknown): Promise<Response> {
    const url = this.resolve(path);
    return this.limiter.run(async () => {
      const maxRetries = method === 'GET' ? (this.options.maxRetries ?? 3) : 0;
      let authRetried = false;
      for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        const sent = this.session;
        let response: Response;
        try {
          response = await this.transport(url, {
            method,
            headers: this.headers(body),
            body: encodeBody(body),
            redirect: 'manual',
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
          });
        } catch (cause) {
          this.log(`${method} ${pathOnly(path)} → network error (${(cause as Error).message})`);
          if (attempt < maxRetries) {
            await this.sleep(backoff(attempt));
            continue;
          }
          throw new DougsError('NETWORK', `Could not reach ${this.baseUrl}`, {
            exitCode: ExitCode.network,
            hint: 'check your connection and retry',
            cause,
          });
        }
        this.log(`${method} ${pathOnly(path)} → ${response.status} (${Date.now() - started} ms)`);
        this.takeSessionCookie(response);

        if (
          // 401 means the session is gone. A 403 is only a session problem on reads: on a
          // write it is Dougs refusing that change, and a fresh cookie would not help.
          (response.status === 401 || (response.status === 403 && method === 'GET')) &&
          !authRetried &&
          (await this.freshSession(sent))
        ) {
          authRetried = true;
          await response.body?.cancel();
          continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          await this.sleep(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt),
          );
          continue;
        }
        if (response.status >= 400) throw await this.toError(method, path, response);
        return response;
      }
    });
  }

  /**
   * Download a file, following redirects. The session cookie is only ever sent
   * to the Dougs origin, never to the signed S3 URL it redirects to.
   */
  async download(path: string): Promise<Uint8Array> {
    let response = await this.request('GET', path);
    for (let hops = 0; response.status >= 300 && response.status < 400; hops++) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hops >= 5)
        throw new DougsError('DOWNLOAD_FAILED', 'File download redirect could not be followed', {
          exitCode: ExitCode.network,
        });
      const next = new URL(location, this.baseUrl);
      if (next.origin === new URL(this.baseUrl).origin) {
        response = await this.request('GET', next.pathname + next.search);
        continue;
      }
      if (next.protocol !== 'https:')
        throw new DougsError('DOWNLOAD_FAILED', 'Refusing a non-HTTPS download redirect', {
          exitCode: ExitCode.network,
        });
      response = await this.limiter.run(() =>
        this.transport(next, {
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        }),
      );
      this.log(`GET ${next.origin}/… (signed storage URL) → ${response.status}`);
    }
    if (!response.ok)
      throw new DougsError('DOWNLOAD_FAILED', `File download failed (HTTP ${response.status})`, {
        exitCode: ExitCode.network,
        status: response.status,
      });
    return new Uint8Array(await response.arrayBuffer());
  }

  private resolve(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new DougsError('USAGE', `API paths must start with "/", got "${path}"`, {
        exitCode: ExitCode.usage,
      });
    const url = new URL(this.baseUrl + path);
    if (url.origin !== new URL(this.baseUrl).origin)
      throw new DougsError('USAGE', 'API path must stay on the Dougs origin', {
        exitCode: ExitCode.usage,
      });
    return url;
  }

  private headers(body: unknown): Record<string, string> {
    return {
      Accept: 'application/json',
      Cookie: `auth_session=${this.session}`,
      'User-Agent': USER_AGENT,
      ...(body !== undefined && !(body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    };
  }

  /**
   * After a 401/403: is there a newer session than the one this request sent?
   * Every concurrent caller awaits the same refresh, then retries once with it.
   */
  private async freshSession(sent: string): Promise<boolean> {
    if (this.session !== sent) return true;
    if (!this.options.refreshSession) return false;
    this.refresh ??= this.options
      .refreshSession()
      .catch(() => null)
      .then((fresh) => {
        if (!fresh || fresh === this.session) return null;
        this.log('session rejected; retrying with a fresh browser cookie');
        this.session = fresh;
        return fresh;
      });
    // A cached refresh only helps if it produced a different session than this request sent.
    const fresh = await this.refresh;
    return fresh !== null && fresh !== sent;
  }

  /**
   * Adopt a renewed session cookie, only from a successful answer to our authenticated
   * request. Dougs answers a 401 with a fresh *anonymous* auth_session cookie (observed):
   * taking that would replace a good session and block the browser refresh.
   */
  private takeSessionCookie(response: Response): void {
    if (!response.ok) return;
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookie(header);
      if (cookie?.name !== 'auth_session' || !cookie.value) continue;
      if (cookie.expiresAt && Date.parse(cookie.expiresAt) <= Date.now()) continue;
      this.session = cookie.value;
      this.options.onSessionCookie?.(cookie.value, cookie.expiresAt);
    }
  }

  private async toError(method: HttpMethod, path: string, response: Response): Promise<DougsError> {
    const messageCode = response.headers.get('x-message-code');
    const apiMessage = await readApiMessage(response);
    const where = `${method} ${pathOnly(path)}`;
    const detail = apiMessage ? `: ${apiMessage}` : '';
    const status = response.status;
    if (messageCode?.startsWith('accountingLine.locked'))
      return new DougsError('LOCKED', `Dougs refused ${where}: the accounting lines are locked`, {
        exitCode: ExitCode.rejected,
        hint: 'the period is locked in Dougs; unlocking is an accountant action in the web app',
        status,
      });
    if (status === 401)
      return new DougsError('AUTH_EXPIRED', 'Dougs session is missing or expired', {
        exitCode: ExitCode.auth,
        hint: LOGIN_HINT,
        status,
      });
    if (status === 403)
      return method === 'GET'
        ? new DougsError('FORBIDDEN', `Dougs refused access to ${where}${detail}`, {
            exitCode: ExitCode.rejected,
            hint: 'check --company, or log in again: dougs login',
            status,
          })
        : new DougsError('FORBIDDEN', `Dougs refused the change: ${where}${detail}`, {
            exitCode: ExitCode.rejected,
            hint: 'your session is fine (reads work); Dougs does not allow this change on this record — check it in the web app',
            status,
          });
    if (status === 404) return notFound(`Not found: ${where}`);
    if (status === 429 || status >= 500)
      return new DougsError(
        'API_UNAVAILABLE',
        `Dougs is unavailable (HTTP ${status}) for ${where}${detail}`,
        {
          exitCode: ExitCode.network,
          hint: 'retry in a minute',
          status,
        },
      );
    return new DougsError('API_REJECTED', `Dougs rejected ${where} (HTTP ${status})${detail}`, {
      exitCode: ExitCode.rejected,
      status,
    });
  }

  private log(line: string): void {
    this.options.log?.(redact(line, [this.session]));
  }
}

function encodeBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (body instanceof FormData) return body;
  return JSON.stringify(body);
}

function backoff(attempt: number): number {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 100);
}

function pathOnly(path: string): string {
  return path.split('?')[0] ?? path;
}

async function readApiMessage(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).slice(0, 2000);
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message.slice(0, 300);
    if (Array.isArray(parsed.message)) return parsed.message.map(String).join('; ').slice(0, 300);
    return null;
  } catch {
    return null;
  }
}
