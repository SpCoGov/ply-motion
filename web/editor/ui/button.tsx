// Adapted from shadcn/ui (MIT). See THIRD_PARTY.md.
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

const variants = cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50', {
  variants: { variant: { default: 'ui-button', accent: 'ui-button ui-accent', ghost: 'ui-button ui-ghost' } },
  defaultVariants: { variant: 'default' },
});
export function Button({ className, variant, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(variants({ variant, className }))} {...props} />;
}
