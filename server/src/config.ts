/**
 * Configuration, from the environment, validated at startup.
 *
 * Nothing here has a secret as a default. A missing secret in production is a
 * refusal to start, not a fallback: a server that boots with a default signing
 * key is worse than one that does not boot, because it looks fine.
 */

export class ConfigError extends Error {}

export type Mode = 'development' | 'production' | 'test';

export interface Config {
  readonly mode: Mode;
  readonly port: number;
  readonly host: string;
  /** Origin allowed to call the API with credentials. */
  readonly allowedOrigin: string;
  /** Minted session lifetime. */
  readonly sessionTtlMinutes: number;
  /** One-time login code lifetime. */
  readonly loginCodeTtlMinutes: number;
  readonly loginCodeLength: number;
  /** Attempts allowed on one code before it is burned. */
  readonly loginCodeMaxAttempts: number;
  readonly rateLimit: {
    readonly loginPerHour: number;
    readonly otpPerHour: number;
    readonly windowMinutes: number;
  };
  /**
   * Key used to hash rate-limit subjects and session tokens.
   *
   * Required in production. The hash is what keeps the rate-limit table from
   * being a list of who tried to log in.
   */
  readonly secretKey: string;
  /** Whether cookies carry Secure. False only for local http development. */
  readonly secureCookies: boolean;
  readonly otpProvider: 'local-dev' | 'none' | 'email';
  /**
   * 'smtp' is the one that sends. It needs SMTP_HOST and SMTP_FROM, and
   * credentials where the server requires them; without SMTP_HOST the server
   * refuses to start in that mode rather than silently delivering nothing.
   */
  readonly emailProvider: 'local-dev' | 'none' | 'smtp';
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Where generated documents and uploads go. */
  readonly storageDir: string;
  /**
   * Whether `X-Forwarded-For` is believed.
   *
   * It decides what counts as the caller's address, which decides what the
   * rate limiter counts. Behind a proxy, the socket address is the proxy's,
   * so every caller in the world shares one bucket and the login limiter
   * protects nobody; direct on a socket, a forwarded header is whatever the
   * caller typed, so believing it lets them rotate out of the bucket at will.
   * Both failures are silent, which is why this is explicit.
   */
  readonly trustProxy: boolean;
  /**
   * Shared secret for the scheduled-job endpoints, or null.
   *
   * There is no process to run a timer in on a serverless platform, so the
   * scheduler is an HTTP endpoint the platform calls. Null means the
   * endpoints refuse: an unauthenticated URL that runs a billing cycle is not
   * something to leave open by default.
   */
  readonly cronSecret: string | null;
  /**
   * Opens POST /api/setup, which creates the first production society. Unset,
   * setup is CLI-only (`npm run db:bootstrap`). It stops working by itself
   * once a production society exists, but should be removed after use.
   */
  readonly setupToken: string | null;
  /** 'vercel' when running as a serverless function. Reporting only. */
  readonly platform: 'node' | 'vercel';
}

function required(env: Record<string, string | undefined>, key: string, why: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`${key} is required: ${why}`);
  }
  return value;
}

function integer(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be a whole number between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawMode = env.NODE_ENV ?? 'development';
  if (rawMode !== 'development' && rawMode !== 'production' && rawMode !== 'test') {
    throw new ConfigError(`NODE_ENV must be development, production or test, got "${rawMode}"`);
  }
  const mode: Mode = rawMode;
  const isProduction = mode === 'production';

  // In production the key must be supplied and long enough to be a key. In
  // development a per-process random value is used, so nothing has a shared
  // default that could survive into a deployment.
  const secretKey = isProduction
    ? required(env, 'SESSION_SECRET',
        'it signs session tokens and hashes rate-limit subjects. Generate one with ' +
        '`openssl rand -hex 32` and keep it out of the repository.')
    : (env.SESSION_SECRET ?? `dev-only-${Math.random().toString(36).slice(2)}-${Date.now()}`);

  if (isProduction && secretKey.length < 32) {
    throw new ConfigError(
      `SESSION_SECRET is ${secretKey.length} characters; at least 32 are required in production.`,
    );
  }

  const otpProvider = (env.OTP_PROVIDER ?? (isProduction ? 'none' : 'local-dev'));
  if (otpProvider !== 'local-dev' && otpProvider !== 'none' && otpProvider !== 'email') {
    throw new ConfigError(`OTP_PROVIDER must be email, local-dev or none, got "${otpProvider}"`);
  }
  if (isProduction && otpProvider === 'email' && (env.EMAIL_PROVIDER ?? 'none') !== 'smtp') {
    // Codes by email through an email provider that sends nothing would leave
    // every member unable to sign in, quietly.
    throw new ConfigError(
      'OTP_PROVIDER=email sends codes through the email provider, and EMAIL_PROVIDER is not ' +
      'smtp. Configure SMTP (EMAIL_PROVIDER=smtp, SMTP_HOST, SMTP_FROM) or choose another ' +
      'OTP provider.',
    );
  }
  if (isProduction && otpProvider === 'local-dev') {
    throw new ConfigError(
      'OTP_PROVIDER=local-dev writes one-time codes to the log instead of sending them, ' +
      'and must never run in production. Configure a real provider adapter, or leave it ' +
      '"none" so the server refuses to issue codes at all.',
    );
  }

  const emailProvider = (env.EMAIL_PROVIDER ?? (isProduction ? 'none' : 'local-dev'));
  if (emailProvider !== 'local-dev' && emailProvider !== 'none' && emailProvider !== 'smtp') {
    throw new ConfigError(
      `EMAIL_PROVIDER must be smtp, local-dev or none, got "${emailProvider}"`,
    );
  }
  if (emailProvider === 'smtp' && (env.SMTP_HOST ?? '').trim() === '') {
    throw new ConfigError(
      'EMAIL_PROVIDER=smtp needs SMTP_HOST (and SMTP_FROM, and credentials where the ' +
      'server requires them). A mail provider configured with nowhere to connect would ' +
      'fail on the first invoice rather than at startup.',
    );
  }
  if (isProduction && emailProvider === 'local-dev') {
    throw new ConfigError(
      'EMAIL_PROVIDER=local-dev writes messages to the log instead of sending them, and ' +
      'must not run in production. Configure smtp, or leave it "none" so nothing claims ' +
      'a delivery that did not happen.',
    );
  }

  const logLevel = (env.LOG_LEVEL ?? 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be debug, info, warn or error, got "${logLevel}"`);
  }

  const secureCookies = env.SECURE_COOKIES === undefined
    ? isProduction
    : env.SECURE_COOKIES === 'true';
  if (isProduction && !secureCookies) {
    throw new ConfigError(
      'SECURE_COOKIES=false in production would send the session cookie over plain http.',
    );
  }

  // Vercel sets VERCEL=1 in every function's environment, and always
  // terminates TLS and forwards the caller's address. So the right default is
  // derived rather than asked for: getting this wrong disables the login rate
  // limiter without any error to notice.
  const onVercel = (env.VERCEL ?? '') !== '';
  const trustProxy = env.TRUST_PROXY === undefined ? onVercel : env.TRUST_PROXY === 'true';

  const cronSecret = (env.CRON_SECRET ?? '').trim();
  if (cronSecret !== '' && cronSecret.length < 16) {
    throw new ConfigError(
      `CRON_SECRET is ${cronSecret.length} characters; at least 16 are required. It is the ` +
      'only thing standing between the open internet and a billing run.',
    );
  }

  const setupToken = (env.SETUP_TOKEN ?? '').trim();
  if (setupToken !== '' && setupToken.length < 16) {
    throw new ConfigError(
      `SETUP_TOKEN is ${setupToken.length} characters; at least 16 are required. Whoever ` +
      'holds it can create the society and its first secretary.',
    );
  }

  return {
    mode,
    trustProxy,
    cronSecret: cronSecret === '' ? null : cronSecret,
    setupToken: setupToken === '' ? null : setupToken,
    platform: onVercel ? 'vercel' : 'node',
    // 0 is allowed: it asks the operating system for a free port, which is
    // how the integration tests start a real server without picking one.
    port: integer(env, 'PORT', 4000, 0, 65535),
    host: env.HOST ?? '127.0.0.1',
    allowedOrigin: env.ALLOWED_ORIGIN ?? 'http://localhost:3600',
    sessionTtlMinutes: integer(env, 'SESSION_TTL_MINUTES', 12 * 60, 5, 60 * 24 * 30),
    loginCodeTtlMinutes: integer(env, 'LOGIN_CODE_TTL_MINUTES', 10, 1, 60),
    loginCodeLength: integer(env, 'LOGIN_CODE_LENGTH', 6, 6, 10),
    loginCodeMaxAttempts: integer(env, 'LOGIN_CODE_MAX_ATTEMPTS', 5, 1, 10),
    rateLimit: {
      loginPerHour: integer(env, 'RATE_LIMIT_LOGIN_PER_HOUR', 10, 1, 1000),
      otpPerHour: integer(env, 'RATE_LIMIT_OTP_PER_HOUR', 5, 1, 1000),
      windowMinutes: integer(env, 'RATE_LIMIT_WINDOW_MINUTES', 60, 1, 1440),
    },
    secretKey,
    secureCookies,
    otpProvider,
    emailProvider,
    logLevel: logLevel as Config['logLevel'],
    storageDir: env.STORAGE_DIR ?? './.storage',
  };
}

/** What the server prints at startup. Never includes a secret. */
export function describeConfig(config: Config): Record<string, string | number | boolean> {
  return {
    mode: config.mode,
    listening: `${config.host}:${config.port}`,
    allowedOrigin: config.allowedOrigin,
    secureCookies: config.secureCookies,
    sessionTtlMinutes: config.sessionTtlMinutes,
    otpProvider: config.otpProvider,
    emailProvider: config.emailProvider,
    logLevel: config.logLevel,
    // Length only, so a log line proves one is configured without leaking it.
    secretKeyLength: config.secretKey.length,
    platform: config.platform,
    trustProxy: config.trustProxy,
    // Whether, not what. A scheduler with no secret is a thing an operator
    // needs to see at startup rather than discover from a cron that 503s.
    cronConfigured: config.cronSecret !== null,
  };
}
