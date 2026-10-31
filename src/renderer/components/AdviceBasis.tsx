/** "Advice for this PC: ..." with a link to Settings → Advice. Nothing is shown before the basis is known. */
export function AdviceBasis({ basis, onChange }: { basis: string; onChange?: () => void }) {
  if (basis === '') return null;
  return (
    <p data-testid="advice-basis" className="mb-2 text-xs text-muted-foreground">
      Advice for this PC: <span data-testid="advice-basis-text">{basis}</span>
      {onChange !== undefined && (
        <>
          {' · '}
          <button type="button" data-testid="advice-basis-change" onClick={onChange} className="cursor-pointer underline hover:text-foreground">change</button>
        </>
      )}
    </p>
  );
}
