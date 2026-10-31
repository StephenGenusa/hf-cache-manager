import type { GroupAdviceDTO } from '../../shared/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

const TEXT = { green: 'text-[var(--tint-green-text)]', yellow: 'text-[var(--tint-yellow-text)]', red: 'text-[var(--tint-red-text)]' } as const;

/** The short reason in the tint's muted colour; the explanation and the facts used show on hover and focus. A missing-fact reason is grey. */
export function AdviceCell({ advice }: { advice: GroupAdviceDTO | undefined }) {
  if (advice === undefined || advice.reason === '' || advice.reason === '—') return <span className="text-muted-foreground">—</span>;
  const color = advice.tint === null ? 'text-muted-foreground' : TEXT[advice.tint];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-testid="advice-reason" tabIndex={0} className={`cursor-help text-xs ${color}`}>{advice.reason}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs font-sans break-normal">
          <div className="space-y-1">
            {advice.explanation !== '' && <p>{advice.explanation}</p>}
            {advice.facts.length > 0 && <ul className="list-disc pl-4 text-muted-foreground">{advice.facts.map((f) => <li key={f}>{f}</li>)}</ul>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
