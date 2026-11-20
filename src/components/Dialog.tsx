import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared modal dialog.
 *
 * Every dialog is rendered through a portal into its own host element that is a direct child of
 * <body>. A module-level stack tracks the open dialogs so that:
 *  - only the topmost dialog is interactive (every other <body> child, including lower dialogs
 *    and the application root, receives the `inert` attribute),
 *  - Escape and Tab handling apply only to the topmost dialog,
 *  - focus is restored to the opener when a dialog closes, including under React StrictMode's
 *    mount/cleanup/mount cycle and when dialogs hand over to each other.
 */

interface DialogEntry {
  host: HTMLElement;
  dialog: HTMLElement | null;
  opener: HTMLElement | null;
  requestClose: () => void;
}

const stack: DialogEntry[] = [];
const inertedByDialogs = new Set<Element>();

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[tabindex]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(',');

function isRendered(el: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node && node !== root.parentElement; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert')) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none') return false;
    if (node === el && style.visibility === 'hidden') return false;
  }
  return true;
}

export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled') && isRendered(el, root)
  );
}

function syncInert(): void {
  const top = stack[stack.length - 1];
  const children = new Set<Element>(Array.from(document.body.children));

  for (const el of Array.from(inertedByDialogs)) {
    if (!top || !children.has(el) || el === top.host) {
      el.removeAttribute('inert');
      inertedByDialogs.delete(el);
    }
  }
  if (!top) return;

  for (const child of children) {
    if (child === top.host || child.tagName === 'SCRIPT') continue;
    if (!child.hasAttribute('inert')) {
      child.setAttribute('inert', '');
      inertedByDialogs.add(child);
    }
  }
}

function handleDocumentKeyDown(e: KeyboardEvent): void {
  const top = stack[stack.length - 1];
  if (!top || e.isComposing) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    top.requestClose();
    return;
  }

  if (e.key !== 'Tab' || !top.dialog) return;

  const dialog = top.dialog;
  const items = getFocusableElements(dialog);
  const active = document.activeElement;

  if (items.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }

  const first = items[0];
  const last = items[items.length - 1];

  if (!active || !dialog.contains(active) || active === dialog) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function focusElement(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  el.focus();
  return document.activeElement === el;
}

export interface DialogProps {
  /** id of the element that names the dialog */
  labelledBy: string;
  /** classes for the dialog surface, e.g. "modal-dialog modal-bid-dialog" */
  className: string;
  onClose: () => void;
  /** When false (e.g. a submission is in flight) Escape and backdrop clicks do not close. */
  canClose?: boolean;
  /** Element to focus on open; defaults to the dialog surface itself. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** A stable control to focus if the opener disappeared and no lower dialog remains. */
  focusFallback?: () => HTMLElement | null;
  children: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({
  labelledBy,
  className,
  onClose,
  canClose = true,
  initialFocusRef,
  focusFallback,
  children,
}) => {
  const [host] = useState(() => document.createElement('div'));
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    canCloseRef.current = canClose;
  });

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    const entry: DialogEntry = {
      host,
      dialog,
      opener: active instanceof HTMLElement && active !== document.body ? active : null,
      requestClose: () => {
        if (canCloseRef.current) onCloseRef.current();
      },
    };

    document.body.appendChild(host);
    if (stack.length === 0) document.addEventListener('keydown', handleDocumentKeyDown, true);
    stack.push(entry);
    syncInert();

    if (!focusElement(initialFocusRef?.current ?? null)) dialog?.focus();

    return () => {
      const wasTop = stack[stack.length - 1] === entry;
      stack.splice(stack.indexOf(entry), 1);
      // Dialogs opened from this one inherit its opener so focus never lands on removed DOM.
      for (const other of stack) {
        if (other.opener && host.contains(other.opener)) other.opener = entry.opener;
      }
      if (stack.length === 0) document.removeEventListener('keydown', handleDocumentKeyDown, true);
      syncInert();

      if (wasTop) {
        const next = stack[stack.length - 1];
        const restored =
          focusElement(entry.opener) ||
          (next ? focusElement(next.dialog) : focusElement(focusFallback?.() ?? null));
        if (!restored && host.contains(document.activeElement)) {
          (document.activeElement as HTMLElement).blur();
        }
      }
      host.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dialog mounts only while open; focus targets belong to this opening
  }, [host]);

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && canCloseRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    host
  );
};
