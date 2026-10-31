import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { useSessionLog } from '../state/session-log';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

const time = (ms: number): string => new Date(ms).toLocaleTimeString();

/** Every result shown this session, newest first (in memory only). */
export function SessionLog() {
  const entries = useSessionLog((s) => s.entries);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button data-testid="btn-session-log" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ScrollText className="h-3.5 w-3.5" /> Log ({entries.length})
      </Button>
      {open && (
        <div data-testid="session-log" className="absolute top-8 right-0 z-30 max-h-80 w-[420px] overflow-y-auto rounded-lg border border-border bg-popover p-2 text-xs shadow-lg">
          {entries.length === 0 ? <p className="text-muted-foreground">Nothing done yet this session.</p> : (
            <ul className="space-y-1">
              {[...entries].reverse().map((e) => (
                <li key={e.id} data-testid="session-log-entry" className={cn(e.tone === 'danger' ? 'text-danger' : 'text-foreground')}>
                  <span className="mr-1.5 text-muted-foreground">{time(e.at)}</span>{e.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
