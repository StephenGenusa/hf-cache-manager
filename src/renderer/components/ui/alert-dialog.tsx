import * as AlertPrimitive from '@radix-ui/react-alert-dialog';
import type { ComponentProps, HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';

export const AlertDialog = AlertPrimitive.Root;
export const AlertDialogTrigger = AlertPrimitive.Trigger;

export function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertPrimitive.Content>) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
      <AlertPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-[#2a2f3b] bg-card p-5 text-card-foreground shadow-[0_20px_60px_rgba(0,0,0,.5)]',
          className,
        )}
        {...props}
      />
    </AlertPrimitive.Portal>
  );
}
export function AlertDialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-1 flex justify-end gap-2', className)} {...props} />;
}
export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertPrimitive.Title>) {
  return <AlertPrimitive.Title className={cn('text-[15px] font-semibold text-foreground', className)} {...props} />;
}
export function AlertDialogDescription({ className, ...props }: ComponentProps<typeof AlertPrimitive.Description>) {
  return <AlertPrimitive.Description className={cn('text-[13px] text-muted-foreground', className)} {...props} />;
}
export function AlertDialogCancel(props: ComponentProps<typeof Button>) {
  return <AlertPrimitive.Cancel asChild><Button size="md" {...props} /></AlertPrimitive.Cancel>;
}
export function AlertDialogAction({ variant = 'destructive', ...props }: ComponentProps<typeof Button>) {
  return <AlertPrimitive.Action asChild><Button size="md" variant={variant} {...props} /></AlertPrimitive.Action>;
}
