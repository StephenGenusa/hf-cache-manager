import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const tones = {
  neutral: 'bg-tag text-tag-foreground',
  gguf: 'bg-[#1d2d22] text-[#7fd39a]',
  safetensors: 'bg-[#1d2540] text-[#8fb0ff]',
  diffusers: 'bg-[#2a1f3d] text-[#c4a2ff]',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  success: 'bg-success-soft text-success',
} as const;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> { tone?: keyof typeof tones }

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return <span className={cn('inline-flex items-center rounded-full px-1.5 py-px text-[10.5px] leading-4 whitespace-nowrap', tones[tone], className)} {...props} />;
}
