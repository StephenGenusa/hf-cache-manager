import type { NamePartDTO } from '../../shared/api';
import { KNOWLEDGE } from '../../shared/knowledge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

const KNOWN = 'underline decoration-dotted decoration-primary underline-offset-2 cursor-help';
const UNKNOWN = 'underline decoration-dotted decoration-muted-foreground underline-offset-2 cursor-help';

function Hint({ part }: { part: NamePartDTO }) {
  const entry = part.entryId === null ? undefined : KNOWLEDGE.entries.find((e) => e.id === part.entryId);
  if (entry === undefined && !part.looksLikeTag) return <>{part.text}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-testid={entry !== undefined ? 'name-part-known' : 'name-part-unknown'} tabIndex={0} className={entry !== undefined ? KNOWN : UNKNOWN}>
          {part.text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs font-sans break-normal">
        {entry === undefined ? (
          <p>{`Not in the guide (checked on ${KNOWLEDGE.checkedOn})`}</p>
        ) : (
          <div className="space-y-1">
            <p className="font-semibold">{entry.title}</p>
            <p>{entry.text}</p>
            {entry.bpw !== undefined && (
              <p>{`${entry.bpw} bits per weight${entry.verdict !== undefined ? `. ${entry.verdict}` : ''}`}</p>
            )}
            {entry.bpw === undefined && entry.verdict !== undefined && <p>{entry.verdict}</p>}
            {entry.authorLabel === true && <p className="text-muted-foreground">author label</p>}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** A name shown as its parts (the texts join back to the name); recognised parts carry a hover and focus hint. */
export function NameParts({ parts }: { parts: NamePartDTO[] }) {
  return (
    <TooltipProvider>
      {parts.map((p, i) => <Hint key={`${i}:${p.text}`} part={p} />)}
    </TooltipProvider>
  );
}
