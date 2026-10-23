/**
 * The client for the SocietyBooks API.
 *
 * One place where the browser talks to the server. Three things it does that
 * every caller would otherwise have to remember:
 *
 *  · sends the session cookie (`credentials: 'include'`), because the session
 *    is an HttpOnly cookie the page cannot read;
 *  · reads the CSRF cookie the page *can* read and sends it back in the
 *    `X-CSRF-Token` header on every write, which is the double-submit the
 *    server checks;
 *  · turns a non-2xx response into an `ApiError` carrying the server's own
 *    message, so a screen can show why something was refused rather than
 *    "something went wrong".
 *
 * There is no retry here. A failed write on a money path must not be retried
 * automatically — the server's idempotency key makes a *deliberate* retry
 * safe, and an automatic one hides the fact that something went wrong.
 */

export const CSRF_COOKIE = 'sb_csrf';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly detail?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when signing in again is what the caller needs to do. */
  get unauthenticated(): boolean { return this.status === 401; }
  /** True when the account is signed in but not permitted. */
  get forbidden(): boolean { return this.status === 403; }
  /** True when the server refused on a rule rather than on the request. */
  get conflict(): boolean { return this.status === 409; }
}

export function readCookie(name: string, source?: string): string | undefined {
  const cookies = source ?? (typeof document === 'undefined' ? '' : document.cookie);
  for (const part of cookies.split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    if (trimmed.slice(0, index) === name) return decodeURIComponent(trimmed.slice(index + 1));
  }
  return undefined;
}

export interface ApiClientOptions {
  /** `https://books.example.org` or '' for the same origin. */
  readonly base: string;
  /** Injected in tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Called on any 401, so the app can drop its session state once. */
  readonly onUnauthenticated?: () => void;
}

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly expect?: 'json' | 'blob';
}

export class ApiClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly onUnauthenticated?: () => void;

  constructor(options: ApiClientOptions) {
    this.base = options.base.replace(/\/$/, '');
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    if (options.onUnauthenticated !== undefined) this.onUnauthenticated = options.onUnauthenticated;
  }

  private url(path: string, query?: CallOptions['query']): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.toString();
    return `${this.base}${path}${suffix === '' ? '' : `?${suffix}`}`;
  }

  async call<T>(path: string, options: CallOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      const token = readCookie(CSRF_COOKIE);
      // Sent when present. Absent means no session, and the server's 401 is a
      // clearer answer than a client-side guess.
      if (token !== undefined) headers['X-CSRF-Token'] = token;
    }

    const response = await this.doFetch(this.url(path, options.query), {
      method,
      headers,
      credentials: 'include',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    if (response.status === 401) this.onUnauthenticated?.();

    if (options.expect === 'blob') {
      if (!response.ok) throw await this.errorFrom(response);
      return (await response.blob()) as unknown as T;
    }

    const text = await response.text();
    const parsed: unknown = text === '' ? null : safeJson(text);

    if (!response.ok) {
      const body = (parsed ?? {}) as {
        error?: unknown; message?: unknown; detail?: unknown;
      };
      throw new ApiError(
        response.status,
        typeof body.message === 'string' ? body.message : `${response.status} from ${path}`,
        typeof body.error === 'string' ? body.error : 'error',
        body.detail,
        response.headers.get('X-Request-Id') ?? undefined,
      );
    }

    return parsed as T;
  }

  private async errorFrom(response: Response): Promise<ApiError> {
    let message = `${response.status} from the server`;
    let code = 'error';
    try {
      const body = JSON.parse(await response.text()) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string') message = body.message;
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // A non-JSON error body, which is what a proxy in front of the API
      // returns. The status is the information.
    }
    return new ApiError(response.status, message, code);
  }

  get<T>(path: string, query?: CallOptions['query']): Promise<T> {
    return this.call<T>(path, query === undefined ? {} : { query });
  }

  post<T>(path: string, body?: unknown, extra: Omit<CallOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.call<T>(path, { ...extra, method: 'POST', body: body ?? {} });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.call<T>(path, { method: 'PUT', body: body ?? {} });
  }

  /** A PDF, as a Blob the page can open or download. */
  pdf(path: string, query?: CallOptions['query']): Promise<Blob> {
    return this.call<Blob>(path, { expect: 'blob', ...(query === undefined ? {} : { query }) });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The server always sends JSON; a proxy error page does not. Returning the
    // text means the message a user sees is the real one rather than a parse
    // error about it.
    return { error: 'unreadable_response', message: text.slice(0, 300) };
  }
}

// --- the shapes the API returns --------------------------------------------

export interface SessionUser {
  readonly email: string;
  readonly societyId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly flats: ReadonlyArray<{ id: string; flatNo: string }>;
}

export interface SnapshotResponse {
  readonly societyId: string;
  readonly societyName: string;
  readonly registrationNo: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly mode: 'demo' | 'production';
  readonly today: string;
  readonly scope: 'society' | 'own-flats';
  readonly email: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly flats: ReadonlyArray<{
    id: string; flatNo: string; name: string;
    billingAreaSqFt?: number;
    areaBasis?: 'carpet' | 'built-up' | 'super-built-up';
    nonOccupied?: boolean;
  }>;
  readonly entries: readonly unknown[];
  readonly documents: readonly unknown[];
  readonly taxInvoiceSequence: number;
  readonly vendorBills: ReadonlyArray<{
    id: string; vendorId: string; vendorName: string; category: string;
    grossRupees: number; tdsRate: number; date: string;
    state: 'awaiting-approval' | 'approved' | 'booked' | 'rejected';
    approvedBy?: string; rejectedReason?: string; billNo?: string;
  }>;
  readonly settings: {
    readonly gst: {
      chargeGst: boolean; ratePercent: number; approved: boolean;
      /** Absent from a server older than these settings; treated as false. */
      sinkingFundTaxable?: boolean; roundToRupee?: boolean;
    };
    readonly invoicePrefix: string;
    readonly dueDays: number;
    readonly sinkingFundPercent: number;
  };
  readonly rate: {
    readonly ratePerSqFt: number; readonly basis: string;
    readonly effectiveFrom: string; readonly authority: string; readonly approved: boolean;
  } | null;
}

export interface TicketResponse {
  readonly id: string;
  readonly ticketNo: string;
  readonly flatNo: string | null;
  readonly category: string;
  readonly description: string;
  readonly priority: string;
  readonly state: string;
  readonly raisedAt: string;
  readonly dueAt: string;
  readonly resolvedAt: string | null;
  readonly breachingSla: boolean;
}

export interface PaymentResponse {
  readonly id: string;
  readonly receiptNo: string;
  readonly flatNo: string;
  readonly receivedOn: string;
  readonly amountPaise: number;
  readonly method: string;
  readonly instrumentRef: string | null;
  readonly allocations: ReadonlyArray<{
    documentId: string | null; taxInvoiceNo: string | null; amount: number; head: string | null;
  }>;
}

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly mode: string;
  readonly database: { reachable: boolean; detail?: string };
  readonly schemaVersion: string | null;
  readonly providers: {
    readonly otp: string; readonly email: string;
    readonly emailDelivers: boolean; readonly bankApi: string;
  };
}
