export type ShortcutContext = 'input' | 'groups' | 'other';
export type ShortcutAction = 'focus-search' | 'next-repo' | 'prev-repo' | 'next-row' | 'prev-row' | 'review';

/**
 * Maps a key press to an app action. Space is deliberately absent: it toggles a focused checkbox natively.
 * Inside a text input nothing is taken over, so typing and caret movement keep working.
 */
export function shortcutFor(e: { key: string; ctrlKey: boolean; metaKey: boolean; context: ShortcutContext }): ShortcutAction | null {
  if (e.context === 'input') return null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Backspace') return mod ? 'review' : null;
  if (mod) return null;
  switch (e.key) {
    case '/': return 'focus-search';
    case 'ArrowDown': return e.context === 'groups' ? 'next-row' : 'next-repo';
    case 'ArrowUp': return e.context === 'groups' ? 'prev-row' : 'prev-repo';
    default: return null;
  }
}

/** Where a key event came from: a text field, the groups table (marked `data-shortcut-context="groups"`) or elsewhere. */
export function contextOf(target: EventTarget | null): ShortcutContext {
  if (!(target instanceof HTMLElement)) return 'other';
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    // A checkbox is an <input> but takes no typing: treat it as part of the table it sits in.
    if (!(target instanceof HTMLInputElement && target.type === 'checkbox')) return 'input';
  }
  return target.closest('[data-shortcut-context="groups"]') ? 'groups' : 'other';
}
