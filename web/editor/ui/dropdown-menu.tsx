// Adapted from shadcn/ui (MIT); Radix owns focus, keyboard and dismissal behavior.
import * as React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { cn } from './utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return <Menu.Portal><Menu.Content sideOffset={sideOffset} className={cn('ui-menu', className)} {...props} /></Menu.Portal>;
}
export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn('ui-menu-item', className)} {...props} />;
}
export function DropdownMenuLabel(props: React.ComponentProps<typeof Menu.Label>) { return <Menu.Label className="ui-menu-label" {...props} />; }
export function DropdownMenuSeparator() { return <Menu.Separator className="ui-menu-separator" />; }
