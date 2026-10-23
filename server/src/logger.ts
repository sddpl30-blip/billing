/**
 * Structured logging.
 *
 * One JSON object per line, so a log aggregator can index it and a human can
 * still read it with `jq`. Every payload passes through `redact` first — not
 * at the call sites, because the one call site that forgets is the one that
 * logs a password.
 */

import { redact } from './security';
import type { Config } from './config';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A child logger that stamps every line with the same fields. */
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(config: Pick<Config, 'logLevel' | 'mode'>): Logger {
  const threshold = ORDER[config.logLevel];

  const make = (bound: Record<string, unknown>): Logger => {
    const emit = (level: Level, message: string, fields?: Record<string, unknown>): void => {
      if (ORDER[level] < threshold) return;
      const line = {
        at: new Date().toISOString(),
        level,
        message,
        ...(redact(bound) as Record<string, unknown>),
        ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
      };
      const text = JSON.stringify(line);
      if (level === 'error') console.error(text);
      else if (level === 'warn') console.warn(text);
      else console.log(text);
    };

    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };

  return make({});
}

/** A logger that keeps lines in memory. Used by the tests. */
export function createMemoryLogger(): Logger & { lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const make = (bound: Record<string, unknown>): Logger => ({
    debug: (m, f) => { lines.push({ level: 'debug', message: m, ...bound, ...(redact(f ?? {}) as object) }); },
    info: (m, f) => { lines.push({ level: 'info', message: m, ...bound, ...(redact(f ?? {}) as object) }); },
    warn: (m, f) => { lines.push({ level: 'warn', message: m, ...bound, ...(redact(f ?? {}) as object) }); },
    error: (m, f) => { lines.push({ level: 'error', message: m, ...bound, ...(redact(f ?? {}) as object) }); },
    child: (fields) => make({ ...bound, ...fields }),
  });
  return Object.assign(make({}), { lines });
}
