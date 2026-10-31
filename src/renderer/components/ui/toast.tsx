import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** `body` replaces the title/description layout (the result toast renders its own content). */
export interface ToastItem { id: number; title?: string; description?: string; body?: ReactNode; testId?: string; tone?: 'default' | 'danger' | 'success' }

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Shows a toast from anywhere (no hook needed). Returns its id. */
export function toast(t: Omit<ToastItem, 'id'>): number {
  const id = nextId++;
  items = [...items, { ...t, id }];
  emit();
  return id;
}
export function dismissToast(id: number): void {
  items = items.filter((i) => i.id !== id);
  emit();
}
/** Test helper: forget every toast. */
export function resetToasts(): void {
  items = [];
  emit();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => items;

const tones = { default: 'border-border', danger: 'border-[#8a2a38]', success: 'border-[#2f6b45]' } as const;

/** Mount once near the root. Danger toasts stay until dismissed; the rest close after 6 s. */
export function Toaster({ children }: { children?: ReactNode }) {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {children}
      {list.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          duration={t.tone === 'danger' ? Infinity : 6000}
          onOpenChange={(open) => { if (!open) dismissToast(t.id); }}
          data-testid={t.testId}
          className={cn('relative rounded-lg border bg-popover p-3 pr-8 text-popover-foreground shadow-lg', tones[t.tone ?? 'default'])}
        >
          {t.body !== undefined && <ToastPrimitive.Description asChild><div>{t.body}</div></ToastPrimitive.Description>}
          {t.title !== undefined && <ToastPrimitive.Title className="text-[13px] font-semibold">{t.title}</ToastPrimitive.Title>}
          {t.description !== undefined && (
            <ToastPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">{t.description}</ToastPrimitive.Description>
          )}
          <ToastPrimitive.Close aria-label="Dismiss" className="absolute top-2.5 right-2.5 cursor-pointer text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-4 bottom-16 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
