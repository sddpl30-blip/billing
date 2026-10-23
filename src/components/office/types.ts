/**
 * What every Office panel is handed.
 *
 * The Office is the committee's back room: the screens for work the server's
 * API already supports and the main screens do not show — vendors, the bank,
 * approvals, periods, users, and the reports. It is server-only. Each panel
 * talks to the API through `client` and nothing else, so a panel cannot drift
 * into a second idea of the books; after a write it calls `reload` so every
 * other screen re-reads the server's answer.
 */

import type { ApiClient } from '../../api/client';

export interface OfficeContext {
  readonly client: ApiClient;
  /** Whether the signed-in account holds a permission, as the server says. */
  can(permission: string): boolean;
  /** A short message to the user; 'error' for a refusal or a failure. */
  toast(message: string, tone?: 'info' | 'error'): void;
  /** Re-read the books after a write, so the rest of the app agrees. */
  reload(): Promise<void>;
}

/** The message to show for anything a call threw. */
export function problemOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}
