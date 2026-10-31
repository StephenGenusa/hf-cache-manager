import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { RepoDetail } from '../../src/renderer/components/RepoDetail';
import { useSelection } from '../../src/renderer/state/selection';
import type { GroupAdviceDTO, RepoAdviceDTO } from '../../src/shared/api';
import { QWEN_DETAIL, adviceFor, makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => { expect.hasAssertions(); useSelection.getState().clear?.(); });

const ID = QWEN_DETAIL.repoId;
const tinted = (over: Record<string, Partial<GroupAdviceDTO>>, repoLine: GroupAdviceDTO | null = null, basis = ''): RepoAdviceDTO => {
  const a = adviceFor(ID);
  return { ...a, basis, repoLine, groups: a.groups.map((g) => ({ ...g, ...(over[g.key] ?? {}) })) };
};
const ADV = tinted({
  'quant:UD-Q4_K_XL': { tint: 'green', reason: 'Fits your 24 GB GPU', explanation: 'Weights plus KV cache fit in GPU memory.', facts: ['Weights 17.6 GB', 'GPU 24 GB'] },
  'quant:Q8_0': { tint: 'yellow', reason: 'Spills into RAM', explanation: 'Part runs on the CPU.', facts: [] },
  'quant:BF16': { tint: 'red', reason: 'Does not fit', explanation: 'Too big.', facts: [] },
  'quant:Q6_K': { tint: null, reason: 'Set your GPU memory in Settings for size advice' },
  'assets:README': { tint: null, reason: '—' },
}, null, 'Linux · RTX 5090 24 GB · 64 GB RAM · 32K context · llama.cpp, LM Studio');   // the engine's basis() output, unprefixed

const show = (advice: RepoAdviceDTO, onOpenSettings?: () => void) =>
  renderWithProviders(<RepoDetail repoId={ID} onDeleteWholeRepo={() => undefined} onOpenSettings={onOpenSettings} />, makeFakeApi({ advice: () => Promise.resolve({ ok: true, data: advice }) }));
const row = async (key: string) => (await screen.findAllByTestId('group-row')).find((r) => r.getAttribute('data-group-key') === key)!;

test('rows carry data-tint, untinted rows carry none', async () => {
  show(ADV);
  await screen.findByTestId('advice-basis');
  expect((await row('quant:UD-Q4_K_XL')).dataset.tint).toBe('green');
  expect((await row('quant:Q8_0')).dataset.tint).toBe('yellow');
  expect((await row('quant:BF16')).dataset.tint).toBe('red');
  expect((await row('quant:Q6_K')).dataset.tint).toBeUndefined();
});

test('the reason is shown, with explanation and facts on hover; a dash for no advice; missing-fact reasons are grey', async () => {
  const user = userEvent.setup();
  show(ADV);
  const green = within(await row('quant:UD-Q4_K_XL')).getByTestId('advice-reason');
  expect(green).toHaveTextContent('Fits your 24 GB GPU');
  expect(green.className).toContain('tint-green-text');
  await user.hover(green);
  expect((await screen.findAllByText('Weights plus KV cache fit in GPU memory.'))[0]).toBeInTheDocument();
  expect((await screen.findAllByText('GPU 24 GB'))[0]).toBeInTheDocument();
  expect(within(await row('assets:README')).queryByTestId('advice-reason')).toBeNull();
  expect(await row('assets:README')).toHaveTextContent('—');
  const grey = within(await row('quant:Q6_K')).getByTestId('advice-reason');
  expect(grey).toHaveTextContent('Set your GPU memory in Settings');
  expect(grey.className).toContain('text-muted-foreground');
});

test('the basis line equals basis and "change" opens settings', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  show(ADV, open);
  expect(await screen.findByTestId('advice-basis-text')).toHaveTextContent(/^Linux · RTX 5090 24 GB · 64 GB RAM · 32K context · llama\.cpp, LM Studio$/);
  expect(screen.getByTestId('advice-basis')).toHaveTextContent(/^Advice for this PC: Linux · RTX 5090 24 GB/);
  await user.click(screen.getByTestId('advice-basis-change'));
  expect(open).toHaveBeenCalledOnce();
});

test('a repoLine renders above the table', async () => {
  const line: GroupAdviceDTO = { key: '', tint: 'red', reason: 'MLX is Apple-only; nothing on this Linux PC can load it', explanation: 'x', facts: [], labelParts: [], files: [] };
  show(tinted({}, line));
  const el = await screen.findByTestId('repo-advice-line');
  expect(el).toHaveTextContent('MLX is Apple-only');
  expect(el.compareDocumentPosition(screen.getAllByRole('table')[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('a green whole-repo judgment renders above the table with its tint while the rows stay untinted', async () => {
  const user = userEvent.setup();
  const line: GroupAdviceDTO = { key: 'repo', tint: 'green', reason: 'Runs here with vLLM / SGLang', explanation: 'This model needs about 16.0 GB of weights.',
    facts: ['weights 16.0 GB', 'KV cache 4.3 GB (32K context, F16)'], labelParts: [], files: [] };
  const plain = tinted({}, line);
  show({ ...plain, groups: plain.groups.map((g) => ({ ...g, tint: null, reason: '—' })) });
  const el = await screen.findByTestId('repo-advice-line');
  expect(el.dataset.tint).toBe('green');
  expect(within(el).getByTestId('advice-reason')).toHaveTextContent('Runs here with vLLM / SGLang');
  expect(el.compareDocumentPosition(screen.getAllByRole('table')[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const r of await screen.findAllByTestId('group-row')) expect(r.dataset.tint).toBeUndefined();
  await user.hover(within(el).getByTestId('advice-reason'));
  expect((await screen.findAllByText('KV cache 4.3 GB (32K context, F16)'))[0]).toBeInTheDocument();
});

test('clicking a tinted row label or checkbox selects exactly what was clicked; advice never changes the selection', async () => {
  const user = userEvent.setup();
  show(ADV);
  await screen.findByTestId('advice-basis');
  expect(useSelection.getState().byRepo).toEqual({});
  const green = await row('quant:UD-Q4_K_XL');
  await user.click(within(green).getByTestId('group-expand').nextElementSibling!);
  await user.click(within(green).getByTestId('advice-reason'));
  expect(useSelection.getState().byRepo).toEqual({});
  await user.click(within(await row('quant:BF16')).getByTestId('group-checkbox'));
  expect(useSelection.getState().byRepo[ID]?.groupKeys).toEqual(['quant:BF16']);
  await waitFor(() => expect(green.dataset.checked).toBe('false'));
});
