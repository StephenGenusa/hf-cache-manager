import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** The "delete" checkbox: red when checked, as in the mockup. */
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border border-[#4a5160] bg-transparent text-white',
        'data-[state=checked]:border-[#e0566a] data-[state=checked]:bg-[#e0566a] disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator><Check className="h-3 w-3" strokeWidth={3} /></CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
