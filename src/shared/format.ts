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
