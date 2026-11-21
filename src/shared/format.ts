// Byte display shared by the main process (notice copy) and the renderer. Decimal units (GB = 1e9).
const UNITS = ['kB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(1)} ${UNITS[i]!}`;
}

/** The size reason of a quant whose GGUF header has not been read. A Hub look-up answers with it before any header is read, so download mode shows a progress note in its place while the shapes are pending. */
export const SHAPE_UNREAD_REASON = 'Model shape unknown: header unreadable';
