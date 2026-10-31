export { formatBytes } from '../../shared/format';

/** Elapsed time as words: 'just now' under 5 s, then seconds, minutes, hours and days (singular at 1). */
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return unit(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return unit(h, 'hour');
  return unit(Math.floor(h / 24), 'day');
}
