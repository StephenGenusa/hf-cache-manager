import { type FormEvent, useState } from 'react';
import { parseHubInput } from '../../shared/hub-input';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** The Hub field: Enter or Look up sends the text on; text that does not parse shows its error inline and sends nothing. */
export function HubInput({ value, onChange, onLookup }: { value: string; onChange(v: string): void; onLookup(input: string): void }) {
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const text = value.trim();
    if (text === '') return;
    const parsed = parseHubInput(text);
    if ('error' in parsed) { setError(parsed.error); return; }
    setError(null);
    onLookup(text);
  };
  return (
    <form onSubmit={submit} className="m-2.5 mb-1.5 space-y-1.5">
      <Input
        data-testid="hub-input" aria-label="Hub repo or URL" placeholder="org/name, org/name@revision or a Hub URL" value={value}
        onChange={(e) => { onChange(e.target.value); setError(null); }}
      />
      <Button type="submit" variant="primary" disabled={value.trim() === ''}>Look up</Button>
      {error !== null && <p role="alert" data-testid="hub-input-error" className="text-xs text-danger">{error}</p>}
    </form>
  );
}
