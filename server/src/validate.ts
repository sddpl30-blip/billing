/**
 * Input validation.
 *
 * Shaped like Zod — `v.object({...}).parse(input)` — because Zod is what this
 * project specifies and could not be installed where it was written (no
 * reachable npm registry). Swapping it in means replacing this file's exports
 * with `import { z as v } from 'zod'` and deleting the rest; the call sites do
 * not change.
 *
 * What it does that matters: every request body is parsed into a known shape
 * before any route touches it, unknown keys are rejected rather than ignored,
 * and money arrives as a whole number of paise so no route does rupee
 * arithmetic.
 */

export class ValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `${issues.length} validation ${issues.length === 1 ? 'problem' : 'problems'}: ` +
      issues.map(i => `${i.path === '' ? '(root)' : i.path} ${i.message}`).join('; '),
    );
    this.name = 'ValidationError';
  }
}

interface Context {
  readonly path: string;
}

export interface Schema<T> {
  /** Parses, or throws ValidationError with every problem found. */
  parse(input: unknown): T;
  /** Parses without throwing. */
  safeParse(input: unknown): { ok: true; value: T } | { ok: false; error: ValidationError };
  /** Internal: collects issues rather than throwing, so a whole object reports at once. */
  check(input: unknown, ctx: Context, issues: Array<{ path: string; message: string }>): T;
  optional(): Schema<T | undefined>;
}

function makeSchema<T>(
  check: (input: unknown, ctx: Context, issues: Array<{ path: string; message: string }>) => T,
): Schema<T> {
  const schema: Schema<T> = {
    check,
    parse(input) {
      const issues: Array<{ path: string; message: string }> = [];
      const value = check(input, { path: '' }, issues);
      if (issues.length > 0) throw new ValidationError(issues);
      return value;
    },
    safeParse(input) {
      try {
        return { ok: true, value: schema.parse(input) };
      } catch (err) {
        if (err instanceof ValidationError) return { ok: false, error: err };
        throw err;
      }
    },
    optional() {
      return makeSchema<T | undefined>((input, ctx, issues) =>
        input === undefined || input === null ? undefined : check(input, ctx, issues));
    },
  };
  return schema;
}

const fail = (
  issues: Array<{ path: string; message: string }>,
  ctx: Context,
  message: string,
): void => { issues.push({ path: ctx.path, message }); };

export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp; patternName?: string } = {}) {
    return makeSchema<string>((input, ctx, issues) => {
      if (typeof input !== 'string') {
        fail(issues, ctx, `must be a string, got ${typeof input}`);
        return '';
      }
      const value = input;
      if (opts.min !== undefined && value.length < opts.min) {
        fail(issues, ctx, `must be at least ${opts.min} characters`);
      }
      if (opts.max !== undefined && value.length > opts.max) {
        fail(issues, ctx, `must be at most ${opts.max} characters`);
      }
      if (opts.pattern !== undefined && !opts.pattern.test(value)) {
        fail(issues, ctx, `must be ${opts.patternName ?? `of the form ${opts.pattern}`}`);
      }
      return value;
    });
  },

  /** A trimmed, non-empty string. What most text fields actually want. */
  text(opts: { max?: number } = {}) {
    return makeSchema<string>((input, ctx, issues) => {
      if (typeof input !== 'string') {
        fail(issues, ctx, `must be a string, got ${typeof input}`);
        return '';
      }
      const value = input.trim();
      if (value === '') fail(issues, ctx, 'must not be empty');
      if (opts.max !== undefined && value.length > opts.max) {
        fail(issues, ctx, `must be at most ${opts.max} characters`);
      }
      return value;
    });
  },

  email() {
    return makeSchema<string>((input, ctx, issues) => {
      if (typeof input !== 'string') {
        fail(issues, ctx, 'must be a string');
        return '';
      }
      const value = input.trim().toLowerCase();
      // Deliberately simple. Anything stricter rejects addresses that work.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 320) {
        fail(issues, ctx, 'must be an email address');
      }
      return value;
    });
  },

  uuid() {
    return makeSchema<string>((input, ctx, issues) => {
      if (typeof input !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
        fail(issues, ctx, 'must be a UUID');
        return '';
      }
      return input.toLowerCase();
    });
  },

  /** An integer. Money uses `paise` below rather than this. */
  int(opts: { min?: number; max?: number } = {}) {
    return makeSchema<number>((input, ctx, issues) => {
      const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        fail(issues, ctx, 'must be a whole number');
        return 0;
      }
      if (opts.min !== undefined && n < opts.min) fail(issues, ctx, `must be at least ${opts.min}`);
      if (opts.max !== undefined && n > opts.max) fail(issues, ctx, `must be at most ${opts.max}`);
      return n;
    });
  },

  /**
   * An amount in paise.
   *
   * Separate from `int` so that every money field in the API is visibly money,
   * and so no route is tempted to accept rupees and multiply. Rejects a
   * fractional value outright rather than rounding it: a caller sending 10.5
   * paise has a bug, and rounding hides it.
   */
  paise(opts: { min?: number; max?: number } = {}) {
    const min = opts.min ?? 1;
    const max = opts.max ?? 1_000_000_000_000; // ₹10 billion, a sanity bound
    return makeSchema<number>((input, ctx, issues) => {
      const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        fail(issues, ctx, 'must be a number of paise');
        return 0;
      }
      if (!Number.isInteger(n)) {
        fail(issues, ctx, 'must be a whole number of paise, not a fraction of one');
        return 0;
      }
      if (n < min) fail(issues, ctx, `must be at least ${min} paise`);
      if (n > max) fail(issues, ctx, `must be at most ${max} paise`);
      return n;
    });
  },

  boolean() {
    return makeSchema<boolean>((input, ctx, issues) => {
      if (typeof input === 'boolean') return input;
      if (input === 'true') return true;
      if (input === 'false') return false;
      fail(issues, ctx, 'must be true or false');
      return false;
    });
  },

  /** An ISO date, which must also name a day that exists. */
  isoDate() {
    return makeSchema<string>((input, ctx, issues) => {
      if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        fail(issues, ctx, 'must be a date as YYYY-MM-DD');
        return '';
      }
      const [y, m, d] = input.split('-').map(Number);
      const probe = new Date(Date.UTC(y, m - 1, d));
      if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
        fail(issues, ctx, `must be a real date; ${input} is not one`);
      }
      return input;
    });
  },

  /** A month-and-year period label such as "Jul 2026". */
  period() {
    return makeSchema<string>((input, ctx, issues) => {
      if (typeof input !== 'string' ||
          !/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/.test(input.trim())) {
        fail(issues, ctx, 'must be a month and year such as "Jul 2026"');
        return '';
      }
      return input.trim();
    });
  },

  /**
   * Any JSON value, bounded in size.
   *
   * For the settings endpoint, where one route stores values of several
   * shapes. The typed readers in settings.ts validate each setting's own shape
   * where it is used, which is the only place that knows what it should be.
   */
  json(opts: { maxBytes?: number } = {}) {
    const maxBytes = opts.maxBytes ?? 20_000;
    return makeSchema<unknown>((input, ctx, issues) => {
      if (input === undefined) {
        fail(issues, ctx, 'is required');
        return null;
      }
      let encoded: string;
      try {
        encoded = JSON.stringify(input);
      } catch {
        fail(issues, ctx, 'must be a JSON value');
        return null;
      }
      if (encoded === undefined) {
        fail(issues, ctx, 'must be a JSON value');
        return null;
      }
      if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
        fail(issues, ctx, `must be at most ${maxBytes} bytes of JSON`);
      }
      return input;
    });
  },

  enumOf<const T extends readonly string[]>(values: T) {
    return makeSchema<T[number]>((input, ctx, issues) => {
      if (typeof input !== 'string' || !values.includes(input)) {
        fail(issues, ctx, `must be one of ${values.join(', ')}`);
        return values[0];
      }
      return input as T[number];
    });
  },

  array<T>(item: Schema<T>, opts: { min?: number; max?: number } = {}) {
    return makeSchema<T[]>((input, ctx, issues) => {
      if (!Array.isArray(input)) {
        fail(issues, ctx, 'must be an array');
        return [];
      }
      if (opts.min !== undefined && input.length < opts.min) {
        fail(issues, ctx, `must have at least ${opts.min} ${opts.min === 1 ? 'entry' : 'entries'}`);
      }
      if (opts.max !== undefined && input.length > opts.max) {
        fail(issues, ctx, `must have at most ${opts.max} entries`);
      }
      return input.map((element, i) =>
        item.check(element, { path: `${ctx.path}[${i}]` }, issues));
    });
  },

  /**
   * An object with exactly these keys.
   *
   * Unknown keys are an error, not ignored. A client sending `amountRupees`
   * where the API wants `amountPaise` should be told, not silently charged a
   * hundredth of what it meant.
   */
  object<S extends Record<string, Schema<unknown>>>(shape: S) {
    type Out = { [K in keyof S]: S[K] extends Schema<infer U> ? U : never };
    return makeSchema<Out>((input, ctx, issues) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        fail(issues, ctx, 'must be an object');
        return {} as Out;
      }
      const source = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(shape)) {
        const childPath = ctx.path === '' ? key : `${ctx.path}.${key}`;
        out[key] = schema.check(source[key], { path: childPath }, issues);
      }
      const unknown = Object.keys(source).filter(k => !(k in shape));
      if (unknown.length > 0) {
        fail(issues, ctx, `has unexpected ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}`);
      }
      return out as Out;
    });
  },
};

export type Infer<S> = S extends Schema<infer T> ? T : never;
