import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/utils';

const variants = {
  default: 'bg-secondary text-secondary-foreground border-input hover:brightness-110',
  primary: 'bg-primary text-primary-foreground border-primary hover:brightness-110',
  destructive: 'bg-destructive text-destructive-foreground border-[#8a2a38] hover:brightness-110',
  ghost: 'bg-transparent border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  tonal: 'bg-[#2b3a5e] text-[#dfe8ff] border-[#3e5590] hover:brightness-110',
} as const;
const sizes = { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3.5 text-[13px]', icon: 'h-7 w-7 p-0' } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = 'default', size = 'sm', asChild = false, className, type = 'button', ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      type={type}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition disabled:pointer-events-none disabled:opacity-45',
        variants[variant], sizes[size], className,
      )}
      {...props}
    />
  );
}
