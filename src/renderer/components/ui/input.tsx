import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-input bg-field px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
