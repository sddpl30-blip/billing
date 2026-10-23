import React from 'react';
import { AlertCircle, Check, X } from 'lucide-react';

export interface ToastMessage {
  readonly id: string;
  readonly msg: string;
  /** An error is shown as one, with its own icon, and read out at once. */
  readonly tone: 'info' | 'error';
}

/**
 * The notification stack, fixed above every layout.
 *
 * Outside the scrolling content on purpose: inside it, a toast raised while
 * the member was scrolled down appeared off screen and was never seen. The
 * region is live, so a screen reader hears it too.
 */
export const Toasts: React.FC<{ toasts: readonly ToastMessage[]; onDismiss: (id: string) => void }> = ({
  toasts, onDismiss,
}) => (
  <div
    aria-live="polite"
    aria-relevant="additions"
    className="fixed z-[90] left-1/2 -translate-x-1/2 w-[min(92vw,40rem)] space-y-2 pointer-events-none"
    style={{ top: 'calc(var(--mv-banner-h) + 0.75rem)' }}
  >
    {toasts.map(t => (
      <div
        key={t.id}
        role={t.tone === 'error' ? 'alert' : 'status'}
        className={`pointer-events-auto p-3 text-xs font-bold flex items-start gap-2.5 rounded-xl shadow-md animate-scale-up ${
          t.tone === 'error' ? 'bg-[#7F1D1D] text-white' : 'bg-[var(--mv-ink)] text-white'
        }`}
      >
        {t.tone === 'error'
          ? <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-200" aria-hidden="true" />
          : <Check className="w-4 h-4 shrink-0 mt-0.5 text-[var(--mv-accent-on-dark)]" aria-hidden="true" />}
        <span className="leading-snug flex-1">
          <span className="sr-only">{t.tone === 'error' ? 'Error: ' : ''}</span>{t.msg}
        </span>
        <button
          type="button"
          onClick={() => onDismiss(t.id)}
          aria-label="Dismiss notification"
          className="shrink-0 opacity-70 hover:opacity-100"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    ))}
  </div>
);
