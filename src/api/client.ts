import { DougsError } from '../output/errors.js';
export type Fetch = typeof fetch;
export interface ClientOptions {
  session: string;
  base?: string;
  fetch?: Fetch;
  refresh?: () => Promise<string>;
  verbose?: boolean;
  sleep?: (ms: number) => Promise<void>;
}
export class ApiClient {
  private session: string;
  private base: string;
  private transport: Fetch;
  private active = 0;
  private queue: (() => void)[] = [];
  private refreshed = false;
  constructor(private options: ClientOptions) {
    this.session = options.session;
    this.base =
      options.base ?? process.env.DOUGS_API_BASE ?? 'https://app.dougs.fr';
    this.transport = options.fetch ?? fetch;
  }
  private async lock(): Promise<void> {
    if (this.active >= 4)
      await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
  }
  private unlock(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.response(method, path, body);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DougsError(
        'API_SHAPE',
        'API returned non-JSON content',
        6,
        'run dougs doctor',
      );
    }
  }
  async response(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    method = method.toUpperCase();
    const url = new URL(path, this.base);
    if (
      url.origin !== new URL(this.base).origin ||
      !path.startsWith('/') ||
      path.startsWith('//')
    )
      throw new DougsError(
        'UNSAFE_URL',
        'API path must be relative to the Dougs origin',
        2,
      );
    await this.lock();
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.options.verbose)
          process.stderr.write(`${method} ${url.pathname} (cookie redacted)\n`);
        let response: Response;
        try {
          response = await this.transport(url, {
            method,
            headers: {
              Accept: 'application/json',
              Cookie: `auth_session=${this.session}`,
              'User-Agent':
                'dougs-cli/0.1.0 (+https://www.npmjs.com/package/dougs-cli)',
              ...(body !== undefined && !(body instanceof FormData)
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
            body:
              body === undefined
                ? undefined
                : body instanceof FormData
                  ? body
                  : JSON.stringify(body),
            redirect: 'manual',
            signal: AbortSignal.timeout(30000),
          });
        } catch {
          if (method === 'GET' && attempt < 3) {
            await this.delay(attempt);
            continue;
          }
          throw new DougsError(
            'NETWORK',
            'Request failed or timed out',
            6,
            'check connectivity, then retry',
          );
        }
        if (
          (response.status === 401 || response.status === 403) &&
          !this.refreshed &&
          this.options.refresh
        ) {
          this.refreshed = true;
          await response.body?.cancel();
          this.session = await this.options.refresh();
          continue;
        }
        if (
          method === 'GET' &&
          (response.status === 429 || response.status >= 500) &&
          attempt < 3
        ) {
          await response.body?.cancel();
          await this.delay(attempt);
          continue;
        }
        if (response.status === 401 || response.status === 403)
          throw new DougsError(
            'AUTH_EXPIRED',
            'Dougs session missing or expired',
            3,
            'run: dougs login --from-browser chrome',
            response.status,
          );
        if (response.status === 404)
          throw new DougsError(
            'NOT_FOUND',
            'Resource not found',
            4,
            undefined,
            404,
          );
        if (response.status >= 400)
          throw new DougsError(
            response.status >= 500 || response.status === 429
              ? 'API_UNAVAILABLE'
              : 'API_REJECTED',
            'Dougs rejected the request',
            response.status >= 500 || response.status === 429 ? 6 : 5,
            undefined,
            response.status,
          );
        return response;
      }
    } finally {
      this.unlock();
    }
  }
  private delay(attempt: number): Promise<void> {
    return (
      this.options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(250 * 2 ** attempt);
  }
  async download(path: string): Promise<Uint8Array> {
    let response = await this.response('GET', path);
    for (let n = 0; response.status >= 300 && response.status < 400; n++) {
      if (n >= 5)
        throw new DougsError('REDIRECT', 'Too many download redirects', 6);
      const location = response.headers.get('location');
      if (!location)
        throw new DougsError('REDIRECT', 'Missing download redirect', 6);
      const url = new URL(location, this.base);
      await response.body?.cancel();
      if (url.protocol !== 'https:' && url.origin !== new URL(this.base).origin)
        throw new DougsError('REDIRECT', 'Insecure download redirect', 6);
      response =
        url.origin === new URL(this.base).origin
          ? await this.response('GET', url.pathname + url.search)
          : await this.transport(url, {
              redirect: 'manual',
              signal: AbortSignal.timeout(30000),
            });
      if (response.status >= 400)
        throw new DougsError(
          'DOWNLOAD_FAILED',
          'File download failed',
          6,
          undefined,
          response.status,
        );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
