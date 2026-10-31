import { useState } from 'react';
import type { ApiError } from '../../shared/api';
import { execErrorText } from '../lib/exec-copy';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/**
 * An API error as readable copy. INTERNAL shows a generic message with the raw text behind a Details toggle; every other
 * code shows the shared exec copy, or main's own message when `verbatim` (sync previews use their own wording). `tone="info"` is for an outcome that is not a failure.
 */
export function ErrorNote({ error, tone = 'danger', testId = 'error-note', verbatim = false }: { error: ApiError; tone?: 'danger' | 'info'; testId?: string; verbatim?: boolean }) {
  const [open, setOpen] = useState(false);
  const copy = execErrorText(error.code, error.message, {
    ...(error.detailPath !== undefined ? { detailPath: error.detailPath } : {}),
    ...(error.staleOwnLock !== undefined ? { staleOwnLock: error.staleOwnLock } : {}),
  });
  return (
    <div
      data-testid={testId} data-tone={tone}
      className={cn('rounded-md border px-3 py-2 text-xs', tone === 'danger' ? 'border-danger bg-danger-soft text-danger' : 'border-border bg-secondary text-foreground')}
    >
      <p>{verbatim && error.code !== 'INTERNAL' ? error.message : copy.text}</p>
      {copy.details !== undefined && (
        <div className="mt-1">
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Details</Button>
          {open && <pre data-testid={`${testId}-details`} className="mt-1 text-[11px] break-all whitespace-pre-wrap text-muted-foreground">{copy.details}</pre>}
        </div>
      )}
    </div>
  );
}
