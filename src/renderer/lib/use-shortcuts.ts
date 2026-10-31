import { useEffect } from 'react';
import { contextOf, shortcutFor, type ShortcutAction } from './shortcuts';

/** The window event the panes listen for: `detail` is the ShortcutAction (everything except 'focus-search'). */
export const SHORTCUT_EVENT = 'hfcm:shortcut';
export const SEARCH_TEST_ID = 'repo-search';

/** True while a modal dialog is open: app shortcuts (above all Review) are then ignored. */
export function modalOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

export function dispatchShortcut(action: ShortcutAction): void {
  if (action === 'focus-search') {
    document.querySelector<HTMLInputElement>(`[data-testid="${SEARCH_TEST_ID}"]`)?.focus();
    return;
  }
  window.dispatchEvent(new CustomEvent<ShortcutAction>(SHORTCUT_EVENT, { detail: action }));
}

/** One window `keydown` listener for the whole app. A handled key has its default action cancelled. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || modalOpen()) return;
      const action = shortcutFor({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, context: contextOf(e.target) });
      if (action === null) return;
      e.preventDefault();
      dispatchShortcut(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
