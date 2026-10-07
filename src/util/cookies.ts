export interface Cookie {
  name: string;
  value: string;
  expiresAt: string | null;
}

/** Parse one Set-Cookie header; Max-Age wins over Expires, as in browsers. */
export function parseSetCookie(header: string, now = Date.now()): Cookie | null {
  const [pair, ...attributes] = header.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return null;
  let expiresAt: string | null = null;
  let maxAge: number | null = null;
  for (const attribute of attributes) {
    const [key = '', ...rest] = attribute.split('=');
    const value = rest.join('=').trim();
    if (/^\s*max-age\s*$/i.test(key) && /^-?\d+$/.test(value)) maxAge = Number(value);
    if (/^\s*expires\s*$/i.test(key)) {
      const at = Date.parse(value);
      if (!Number.isNaN(at)) expiresAt = new Date(at).toISOString();
    }
  }
  if (maxAge !== null) expiresAt = new Date(now + maxAge * 1000).toISOString();
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), expiresAt };
}
