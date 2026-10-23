import React, { useEffect, useRef } from 'react';

interface DialogProps {
  /** The id of the element that names the dialog, for screen readers. */
  labelledBy: string;
  onClose: () => void;
  /** Classes for the panel itself; the backdrop is the same for every dialog. */
  className?: string;
  children: React.ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one modal shell every dialog uses.
 *
 * What it adds over a styled div: it says it is a modal dialog and what it is
 * called, it takes focus when it opens and gives it back when it closes,
 * Escape and a click on the backdrop close it, and Tab stays inside it.
 */
export const Dialog: React.FC<DialogProps> = ({ labelledBy, onClose, className, children }) => {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    const preferred = node?.querySelector<HTMLElement>('[data-autofocus]');
    const first = preferred ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node;
    first?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || node === null) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
      onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={className}
      >
        {children}
      </div>
    </div>
  );
};
