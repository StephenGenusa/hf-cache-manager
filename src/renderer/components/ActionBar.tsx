import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Selection } from '../../core/types';
import type { SelectionPreviewDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { deletionBlock } from '../lib/deletion-block';
import { formatBytes } from '../lib/format';
import { useLibrary } from '../lib/queries';
import type { ShortcutAction } from '../lib/shortcuts';
import { modalOpen, SHORTCUT_EVENT } from '../lib/use-shortcuts';
import { useSelection } from '../state/selection';
import { Button } from './ui/button';

export const PREVIEW_DEBOUNCE_MS = 150;

export interface ActionBarProps { onReview(sel: Selection): void; onEmptyHeld(): void }

type Preview = { kind: 'idle' } | { kind: 'pending' } | { kind: 'ok'; data: SelectionPreviewDTO } | { kind: 'error'; message: string };

export function ActionBar({ onReview, onEmptyHeld }: ActionBarProps) {
  const api = useApi();
  const client = useQueryClient();
  const library = useLibrary();
  const lib = library.data;
  const byRepo = useSelection((s) => s.byRepo);
  const sel = useMemo(() => useSelection.getState().toSelection(), [byRepo]);
  const groupCount = useMemo(() => useSelection.getState().groupCount(), [byRepo]);
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' });
  const seq = useRef(0);
  // True from a library refresh until the selected repos' fresh group keys have been applied.
  const [reconciling, setReconciling] = useState(false);

  // Debounced planner preview. Every change bumps the sequence so an older response can never overwrite a newer state.
  useEffect(() => {
    const mine = ++seq.current;
    if (sel === null) { setPreview({ kind: 'idle' }); return undefined; }
    setPreview({ kind: 'pending' });
    const timer = setTimeout(() => {
      void api.previewSelection(sel).then((r) => {
        if (mine !== seq.current) return;
        setPreview(r.ok ? { kind: 'ok', data: r.data } : { kind: 'error', message: r.error.message });
      }, (e: unknown) => {
        if (mine === seq.current) setPreview({ kind: 'error', message: e instanceof Error ? e.message : 'The preview failed.' });
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, sel]);

  // After each library refresh: re-read the selected repos' group keys and drop whatever is gone (never send unknown keys).
  const lastScan = useRef<number | null>(null);
  useEffect(() => {
    if (lib === undefined) return undefined;
    const refreshed = lastScan.current !== null && lastScan.current !== lib.scannedAt;
    lastScan.current = lib.scannedAt;
    if (refreshed) {
      void client.invalidateQueries({ queryKey: ['repo'] });
      void client.invalidateQueries({ queryKey: ['advice'] });
    }
    // Synchronously drop repos that are now blocked (ambiguous, unselectable id, unreadable cache); no await in between.
    const store = useSelection.getState();
    const keep = Object.entries(store.byRepo)
      .filter(([id]) => !deletionBlock(lib, id).blocked)
      .map(([repoId, v]) => ({ repoId, groupKeys: v.groupKeys }));
    if (keep.length !== Object.keys(store.byRepo).length) store.reconcile(keep);
    const selected = keep.map((k) => k.repoId);
    if (selected.length === 0) { setReconciling(false); return undefined; }
    const known = new Set(lib.repos.map((r) => r.repoId));
    let cancelled = false;
    setReconciling(true);
    void Promise.all(selected.filter((id) => known.has(id)).map(async (repoId) => {
      try {
        const r = await api.repoDetail(repoId);
        return r.ok ? { repoId, groupKeys: r.data.groups.map((g) => g.key) } : null;
      } catch {
        return null;
      }
    })).then((rows) => {
      if (cancelled) return;
      useSelection.getState().reconcile(rows.filter((x) => x !== null));
      setReconciling(false);
    });
    return () => { cancelled = true; };
  }, [api, client, lib]);

  const blockedReason = lib === undefined ? 'loading' : !lib.hubPresent || lib.scanError !== null ? 'cache' : null;
  const canReview = sel !== null && groupCount > 0 && preview.kind === 'ok' && blockedReason === null && !reconciling;

  const reviewRef = useRef<() => void>(() => undefined);
  reviewRef.current = () => { if (canReview && sel !== null) onReview(sel); };
  useEffect(() => {
    const onShortcut = (e: Event) => {
      // never from the keyboard while a dialog is open (a review already showing) or nothing is selected (canReview)
      if ((e as CustomEvent<ShortcutAction>).detail === 'review' && !modalOpen()) reviewRef.current();
    };
    window.addEventListener(SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcut);
  }, []);

  let text: React.ReactNode;
  if (sel === null) {
    text = lib !== undefined && lib.heldCount > 0
      ? <>Recently Deleted holds {formatBytes(lib.heldBytes)}</>
      : 'Nothing selected';
  } else if (preview.kind === 'ok') {
    const p = preview.data;
    text = (
      <>
        {`${p.groupCount} group${p.groupCount === 1 ? '' : 's'} selected · `}
        <b data-testid="action-bar-freed" data-bytes={p.freedBytes} className="text-foreground">{formatBytes(p.freedBytes)}</b>
        {` would be freed · ${p.viewLinksAffected} LM Studio / Ollama links affected`}
      </>
    );
  } else if (preview.kind === 'error') {
    text = <span role="alert" className="text-danger">{preview.message}</span>;
  } else {
    text = `${groupCount} group${groupCount === 1 ? '' : 's'} selected · calculating…`;
  }

  return (
    <footer data-testid="action-bar" className="flex items-center gap-2.5 border-t border-border bg-bar px-4 py-2.5 text-muted-foreground">
      <div className="min-w-0 flex-1">
        <div>{text}</div>
        {preview.kind === 'ok' && preview.data.warnings.map((w) => <div key={w} className="text-xs text-warning">{w}</div>)}
      </div>
      {sel === null && lib !== undefined && lib.heldCount > 0 && <Button onClick={onEmptyHeld}>Permanently Delete Recent Deletions</Button>}
      {sel !== null && (
        <>
          <Button onClick={() => useSelection.getState().clear()}>Clear</Button>
          <Button data-testid="btn-review" variant="destructive" size="md" disabled={!canReview} onClick={() => reviewRef.current()}>
            Review deletion…
          </Button>
        </>
      )}
      {sel === null && <Button data-testid="btn-review" variant="destructive" size="md" disabled>Review deletion…</Button>}
    </footer>
  );
}
