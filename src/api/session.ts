/**
 * Where the backend is, and who is signed in.
 *
 * The identity question is the one this file exists to answer. The demo had
 * the resident's flat written into the source as 'B-204', so every sign-in —
 * whatever address was used — landed on the same flat's bills. Here the flat
 * comes from `/api/auth/me`, which reads it from the owner record the account
 * is linked to. There is no fallback to a constant in server mode: an account
 * with no flat on record sees no flats, which is the truthful answer.
 */

import { ApiClient, ApiError, type SessionUser } from './client';

/**
 * The API base.
 *
 * `VITE_API_BASE` at build time, or `window.SOCIETYBOOKS_API_BASE` at runtime
 * so one build can be pointed at a different server without rebuilding.
 * Empty means "this origin", which is the normal deployment: the API behind
 * the same host as the app.
 */
export function apiBase(): string {
  const runtime = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { SOCIETYBOOKS_API_BASE?: unknown }).SOCIETYBOOKS_API_BASE;
  if (typeof runtime === 'string' && runtime !== '') return runtime;

  const configured = readViteEnv('VITE_API_BASE');
  return configured ?? '';
}

/**
 * Whether this build should expect a backend at all.
 *
 * The published demo is a static site with no server behind it, and it has to
 * keep working: `VITE_DATA_SOURCE=demo` says so explicitly. Left unset, a
 * production build expects the server — so a deployment that forgot the
 * variable shows an error rather than quietly showing sample figures — and a
 * development build tries the server and falls back to the demo if it is not
 * there.
 */
export function configuredDataSource(): 'server' | 'demo' | 'auto' {
  const value = readViteEnv('VITE_DATA_SOURCE');
  if (value === 'server' || value === 'demo') return value;
  return isProductionBuild() ? 'server' : 'auto';
}

function isProductionBuild(): boolean {
  return viteEnv()?.PROD === true;
}

/**
 * `import.meta.env`, or undefined outside Vite.
 *
 * Written as one expression on purpose. Vite finds `import.meta.env` in the
 * source text and replaces it (in a build) or defines it (in dev); reading
 * `import.meta` into a variable first and `.env` off that later hid it from
 * Vite, so every VITE_ variable read as unset and VITE_DATA_SOURCE did
 * nothing. Under plain tsc or node it is simply undefined.
 */
function viteEnv(): Record<string, unknown> | undefined {
  return (import.meta as unknown as { env?: Record<string, unknown> }).env;
}

function readViteEnv(key: string): string | undefined {
  // import.meta.env exists under Vite and not under plain tsc or node, so it
  // is read defensively rather than relied upon.
  const value = viteEnv()?.[key];
  return typeof value !== 'string' || value === '' ? undefined : value;
}

export function createClient(onUnauthenticated?: () => void): ApiClient {
  return new ApiClient({
    base: apiBase(),
    ...(onUnauthenticated === undefined ? {} : { onUnauthenticated }),
  });
}

export interface Reachability {
  readonly reachable: boolean;
  readonly schemaVersion: string | null;
  readonly databaseReachable: boolean;
  readonly emailDelivers: boolean;
  readonly why?: string;
}

/**
 * Asks the server whether it is there, before the app decides which mode to
 * run in. Health is deliberately unauthenticated, so this costs no session.
 */
export async function probe(client: ApiClient, timeoutMs = 4000): Promise<Reachability> {
  try {
    const health = await withTimeout(
      client.get<{
        status: string; schemaVersion: string | null;
        database: { reachable: boolean };
        providers: { emailDelivers: boolean };
      }>('/api/health'),
      timeoutMs,
    );
    if (typeof health?.database?.reachable !== 'boolean') {
      // Something answered at that address — a static host's fallback page,
      // a proxy — but not the SocietyBooks API.
      throw new Error('the address answered, but not as a SocietyBooks API');
    }
    return {
      reachable: true,
      schemaVersion: health.schemaVersion,
      databaseReachable: health.database.reachable,
      emailDelivers: health.providers.emailDelivers,
      ...(health.database.reachable
        ? {}
        : { why: 'the API is up but cannot reach its database' }),
    };
  } catch (err) {
    // A server that refused to start sends which setting is missing in
    // `detail` (a variable name, never a value). Showing it turns "the log
    // names the variable" into the variable itself, on the screen the person
    // deploying is already looking at.
    const detail = err instanceof ApiError && typeof err.detail === 'string' ? ` ${err.detail}` : '';
    return {
      reachable: false,
      schemaVersion: null,
      databaseReachable: false,
      emailDelivers: false,
      why: (err instanceof Error ? err.message : 'the API did not answer') + detail,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function currentUser(client: ApiClient): Promise<SessionUser | null> {
  try {
    return await client.get<SessionUser>('/api/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.unauthenticated) return null;
    throw err;
  }
}

export interface SignInResult {
  readonly user: {
    readonly email: string;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
    readonly flatIds: readonly string[];
  };
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export function signInWithPassword(
  client: ApiClient,
  input: { email: string; password: string },
): Promise<SignInResult> {
  return client.post<SignInResult>('/api/auth/password', input);
}

export function requestCode(
  client: ApiClient,
  email: string,
): Promise<{ accepted: true; message: string; delivered: boolean }> {
  return client.post('/api/auth/request-code', { email });
}

export function verifyCode(
  client: ApiClient,
  input: { email: string; code: string },
): Promise<SignInResult> {
  return client.post<SignInResult>('/api/auth/verify-code', input);
}

export function signOut(client: ApiClient): Promise<{ signedOut: boolean }> {
  return client.post('/api/auth/sign-out');
}

/**
 * The role the screens switch on, from the roles the server granted.
 *
 * The app has three views; the server has five roles. A treasurer or secretary
 * sees the committee view, a manager the manager view, everyone else the
 * resident view. Derived from the server's answer rather than from which
 * button was pressed, which is what the demo did — its PIN modal set the view
 * and nothing checked it.
 */
export function viewForRoles(roles: readonly string[]): 'Resident' | 'Manager' | 'Committee' {
  if (roles.includes('treasurer') || roles.includes('secretary') || roles.includes('auditor')) {
    return 'Committee';
  }
  if (roles.includes('manager')) return 'Manager';
  return 'Resident';
}

/** The views this account may switch to. The server enforces the rest. */
export function viewsAvailable(roles: readonly string[]): ReadonlyArray<'Resident' | 'Manager' | 'Committee'> {
  const views: Array<'Resident' | 'Manager' | 'Committee'> = [];
  if (roles.includes('resident')) views.push('Resident');
  if (roles.includes('manager')) views.push('Manager');
  if (roles.includes('treasurer') || roles.includes('secretary') || roles.includes('auditor')) {
    views.push('Committee');
  }
  return views.length === 0 ? ['Resident'] : views;
}
