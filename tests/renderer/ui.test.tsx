import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from '../../src/renderer/components/ui/alert-dialog';
import { Badge } from '../../src/renderer/components/ui/badge';
import { Button } from '../../src/renderer/components/ui/button';
import { Checkbox } from '../../src/renderer/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../src/renderer/components/ui/dialog';
import { Input } from '../../src/renderer/components/ui/input';
import { ScrollArea } from '../../src/renderer/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../src/renderer/components/ui/select';
import { Switch } from '../../src/renderer/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../src/renderer/components/ui/table';
import { resetToasts, toast, Toaster } from '../../src/renderer/components/ui/toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../src/renderer/components/ui/tooltip';
import { cn } from '../../src/renderer/lib/utils';

beforeEach(() => {
  expect.hasAssertions();
  resetToasts();
});

test('cn merges conflicting tailwind classes', () => {
  expect(cn('px-2 py-1', 'px-4', false, undefined)).toBe('py-1 px-4');
});

test('Button: variants, disabled, asChild', async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(<><Button onClick={onClick}>Go</Button><Button disabled variant="destructive" size="md">No</Button>
    <Button asChild variant="ghost"><a href="#x">Link</a></Button></>);
  await user.click(screen.getByRole('button', { name: 'Go' }));
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'No' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'button');
  expect(screen.getByRole('link', { name: 'Link' })).toBeInTheDocument();
});

test('Checkbox, Switch, Input, Badge', async () => {
  const user = userEvent.setup();
  render(<><Checkbox aria-label="pick" /><Switch aria-label="on" /><Input aria-label="text" /><Badge tone="gguf">GGUF</Badge></>);
  await user.click(screen.getByRole('checkbox', { name: 'pick' }));
  expect(screen.getByRole('checkbox', { name: 'pick' })).toBeChecked();
  await user.click(screen.getByRole('switch', { name: 'on' }));
  expect(screen.getByRole('switch', { name: 'on' })).toBeChecked();
  await user.type(screen.getByLabelText('text'), 'abc');
  expect(screen.getByLabelText('text')).toHaveValue('abc');
  expect(screen.getByText('GGUF')).toBeInTheDocument();
});

test('Dialog opens, shows its parts and closes on the close button', async () => {
  const user = userEvent.setup();
  render(<Dialog><DialogTrigger asChild><Button>Open</Button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>Review</DialogTitle><DialogDescription>desc</DialogDescription></DialogHeader>
      <DialogFooter>foot</DialogFooter></DialogContent></Dialog>);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByRole('dialog', { name: 'Review' })).toBeInTheDocument();
  expect(screen.getByText('desc')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('Dialog hideClose has no close button', async () => {
  const user = userEvent.setup();
  render(<Dialog><DialogTrigger>Open</DialogTrigger><DialogContent hideClose><DialogTitle>T</DialogTitle><DialogDescription>d</DialogDescription></DialogContent></Dialog>);
  await user.click(screen.getByText('Open'));
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
});

test('AlertDialog runs the action once', async () => {
  const user = userEvent.setup();
  const onAction = vi.fn();
  render(<AlertDialog><AlertDialogTrigger>Ask</AlertDialogTrigger>
    <AlertDialogContent><AlertDialogTitle>Sure?</AlertDialogTitle><AlertDialogDescription>really</AlertDialogDescription>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={onAction}>Yes</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>);
  await user.click(screen.getByText('Ask'));
  await user.click(screen.getByRole('button', { name: 'Yes' }));
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('Select picks an item', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Select defaultValue="size" onValueChange={onChange}><SelectTrigger aria-label="sort"><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="size">Size</SelectItem><SelectItem value="name">Name</SelectItem></SelectContent></Select>);
  await user.click(screen.getByRole('combobox', { name: 'sort' }));
  await user.click(await screen.findByRole('option', { name: 'Name' }));
  expect(onChange).toHaveBeenCalledWith('name');
});

test('Tooltip shows its text on focus', async () => {
  const user = userEvent.setup();
  render(<TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger>hover</TooltipTrigger><TooltipContent>/full/path</TooltipContent></Tooltip></TooltipProvider>);
  await user.tab();
  expect((await screen.findAllByText('/full/path')).length).toBeGreaterThan(0);
});

test('Table and ScrollArea render their content', () => {
  render(<ScrollArea className="h-10"><Table><TableHeader><TableRow><TableHead>Quant</TableHead></TableRow></TableHeader>
    <TableBody><TableRow data-checked="true"><TableCell>Q8_0</TableCell></TableRow></TableBody></Table></ScrollArea>);
  expect(screen.getByRole('columnheader', { name: 'Quant' })).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'Q8_0' })).toBeInTheDocument();
});

test('toast() shows a toast and the close button removes it', async () => {
  const user = userEvent.setup();
  render(<Toaster />);
  act(() => { toast({ title: 'Moved', description: '82.5 GB', tone: 'success' }); toast({ title: 'Failed', tone: 'danger' }); });
  expect(await screen.findByText('Moved')).toBeInTheDocument();
  expect(screen.getByText('82.5 GB')).toBeInTheDocument();
  await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
  expect(screen.queryByText('Moved')).toBeNull();
  expect(screen.getByText('Failed')).toBeInTheDocument();
});
