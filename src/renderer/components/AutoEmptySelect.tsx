import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiError } from '../../shared/api';
import { useApi } from '../lib/api';
import { queryKeys } from '../lib/queries';
import { ErrorNote } from './ErrorNote';

const OPTIONS: Array<{ value: string; label: string }> = [
  { value: '7', label: 'After 7 days' }, { value: '14', label: 'After 14 days' }, { value: '30', label: 'After 30 days' }, { value: 'never', label: 'Never' },
];

/** The auto-empty setting: 7 / 14 / 30 days or Never (null). Saving goes through main, which writes settings.json. */
export function AutoEmptySelect({ days }: { days: number | null }) {
  const api = useApi();
  const client = useQueryClient();
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  async function change(value: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const r = await api.setAutoEmptyDays(value === 'never' ? null : Number(value));
      if (!r.ok) setError(r.error);
    } catch (e) {
      setError({ code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
      void client.invalidateQueries({ queryKey: queryKeys.held });
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    }
  }

  const current = days === null ? 'never' : String(days);
  const known = OPTIONS.some((o) => o.value === current);
  return (
    <span className="inline-flex flex-col gap-1">
      <select
        data-testid="auto-empty-select" aria-label="Auto-empty Recently Deleted" value={current} disabled={saving}
        onChange={(e) => void change(e.target.value)}
        className="h-7 rounded-md border border-input bg-secondary px-2 text-xs text-secondary-foreground disabled:opacity-50"
      >
        {!known && <option value={current}>After {current} days</option>}
        {OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error !== null && <ErrorNote error={error} testId="auto-empty-error" />}
    </span>
  );
}
