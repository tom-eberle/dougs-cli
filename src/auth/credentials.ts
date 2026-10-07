import {
  type Config,
  type CredentialSource,
  configPath,
  type Env,
  type Profile,
  writeConfig,
} from './config.js';
import type { SecretStore } from './secrets.js';

const STORE_LABELS: Record<NonNullable<Profile['sessionStore']>, string> = {
  keychain: 'macOS Keychain',
  libsecret: 'Secret Service (libsecret)',
};

/** Where this profile's session is kept, for humans. */
export function sessionLocation(profile: Profile, env: Env): string {
  return profile.sessionStore ? STORE_LABELS[profile.sessionStore] : configPath(env);
}

/**
 * The stored session of a profile. A session still in the config file is moved to
 * the OS store when one is available (transparently, once).
 */
export async function readSession(
  config: Config,
  profileName: string,
  store: SecretStore | null,
  env: Env,
  log: (line: string) => void = () => {},
): Promise<string | null> {
  const profile = config.profiles[profileName];
  if (!profile) return null;
  if (profile.session) {
    const session = profile.session;
    if (store && (await store.set(profileName, session))) {
      config.profiles[profileName] = { ...profile, session: undefined, sessionStore: store.id };
      await writeConfig(config, env);
      log(`moved the session of profile "${profileName}" to the ${store.label}`);
    }
    return session;
  }
  if (profile.sessionStore && store?.id === profile.sessionStore) return store.get(profileName);
  return null;
}

export interface NewSession {
  session: string;
  source: CredentialSource;
  expiresAt: string | null;
  email?: string;
  companyId?: string;
}

/**
 * Save a session in the OS store, or in the 0600 config file when there is none.
 * Returns where it went and whether that was the file fallback.
 */
export async function saveSession(
  config: Config,
  profileName: string,
  next: NewSession,
  store: SecretStore | null,
  env: Env,
): Promise<{ location: string; fileFallback: boolean }> {
  const previous = config.profiles[profileName] ?? {};
  const inStore = store ? await store.set(profileName, next.session) : false;
  config.profiles[profileName] = {
    ...previous,
    session: inStore ? undefined : next.session,
    sessionStore: inStore ? store?.id : undefined,
    sessionExpiresAt: next.expiresAt ?? undefined,
    source: next.source,
    email: next.email ?? previous.email,
    companyId: next.companyId ?? previous.companyId,
    savedAt: new Date().toISOString(),
  };
  await writeConfig(config, env);
  return {
    location: sessionLocation(config.profiles[profileName]!, env),
    fileFallback: !inStore,
  };
}

/** Forget a profile's session everywhere; keeps its non-secret settings. */
export async function forgetSession(
  config: Config,
  profileName: string,
  store: SecretStore | null,
  env: Env,
): Promise<boolean> {
  const profile = config.profiles[profileName];
  if (!profile) return false;
  const had = !!(profile.session || profile.sessionStore);
  if (profile.sessionStore && store?.id === profile.sessionStore) await store.delete(profileName);
  config.profiles[profileName] = { companyId: profile.companyId, email: profile.email };
  await writeConfig(config, env);
  return had;
}

/** Days until a known expiry (negative once expired); null when unknown. */
export function daysLeft(expiresAt: string | undefined | null, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? null : (at - now) / 86_400_000;
}
