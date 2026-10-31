/**
 * The short label first, then the exact absolute path as visible, wrapping text, never
 * only in a tooltip, so every hash and Ollama blob name can be read before confirming. Used by the deletion review and
 *  the sync preview.
 */
export function PathCell({ label, full }: { label: string; full: string }) {
  return (
    <>
      <div>{label}</div>
      {full !== label && <div className="font-mono text-[10.5px] break-all text-muted-foreground">{full}</div>}
    </>
  );
}
