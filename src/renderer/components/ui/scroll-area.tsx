import * as ScrollPrimitive from '@radix-ui/react-scroll-area';
import type { ComponentProps, Ref } from 'react';
import { cn } from '../../lib/utils';

export function ScrollArea({ className, children, viewportRef, ...props }: ComponentProps<typeof ScrollPrimitive.Root> & { viewportRef?: Ref<HTMLDivElement> }) {
  return (
    <ScrollPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
      <ScrollPrimitive.Viewport ref={viewportRef} className="h-full w-full rounded-[inherit]">{children}</ScrollPrimitive.Viewport>
      <ScrollPrimitive.Scrollbar orientation="vertical" className="flex w-2 touch-none p-px select-none">
        <ScrollPrimitive.Thumb className="relative flex-1 rounded-full bg-input" />
      </ScrollPrimitive.Scrollbar>
      <ScrollPrimitive.Corner />
    </ScrollPrimitive.Root>
  );
}
