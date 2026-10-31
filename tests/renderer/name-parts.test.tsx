import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { NameParts } from '../../src/renderer/components/NameParts';
import { RepoDetail } from '../../src/renderer/components/RepoDetail';
import { KNOWLEDGE } from '../../src/shared/knowledge';
import type { FileEntryDTO } from '../../src/shared/api';
import { QWEN_DETAIL, adviceFor, makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => { expect.hasAssertions(); });

const q8 = KNOWLEDGE.entries.find((e) => e.id === 'quant-type:Q8_0')!;
const neo = KNOWLEDGE.entries.find((e) => e.id === 'recipe:NEO')!;

test('a known quant part is underlined and its hint shows title, text, bpw and verdict on hover', async () => {
  const user = userEvent.setup();
  renderWithProviders(<NameParts parts={[{ text: 'Q8_0', entryId: q8.id, looksLikeTag: false }]} />);
  const part = screen.getByText('Q8_0');
  expect(part.className).toContain('decoration-primary');
  await user.hover(part);
  expect((await screen.findAllByText(q8.title))[0]).toBeInTheDocument();
  expect((await screen.findAllByText(q8.text))[0]).toBeInTheDocument();
  expect((await screen.findAllByText(/8\.5 bits per weight\. The same quality as 16-bit/))[0]).toBeInTheDocument();
});

test('a part is reachable by keyboard focus', async () => {
  const user = userEvent.setup();
  renderWithProviders(<NameParts parts={[{ text: 'Q8_0', entryId: q8.id, looksLikeTag: false }]} />);
  await user.tab();
  expect(screen.getByText('Q8_0')).toHaveFocus();
  expect((await screen.findAllByText(q8.title))[0]).toBeInTheDocument();
});

test('an author label says so', async () => {
  const user = userEvent.setup();
  renderWithProviders(<NameParts parts={[{ text: 'NEO', entryId: neo.id, looksLikeTag: false }]} />);
  await user.hover(screen.getByText('NEO'));
  expect((await screen.findAllByText('author label'))[0]).toBeInTheDocument();
});

test('an unknown tag gets a grey underline and the not-in-the-guide hint with the guide date', async () => {
  const user = userEvent.setup();
  renderWithProviders(<NameParts parts={[{ text: 'ZX9', entryId: null, looksLikeTag: true }]} />);
  const part = screen.getByText('ZX9');
  expect(part.className).toContain('decoration-muted-foreground');
  await user.hover(part);
  expect((await screen.findAllByText(`Not in the guide (checked on ${KNOWLEDGE.checkedOn})`))[0]).toBeInTheDocument();
});

test('plain parts render as bare text with no underline or focus stop', () => {
  renderWithProviders(<NameParts parts={[{ text: 'Qwen', entryId: null, looksLikeTag: false }, { text: '/', entryId: null, looksLikeTag: false }]} />);
  expect(screen.queryByTestId('name-part-known')).toBeNull();
  expect(screen.queryByTestId('name-part-unknown')).toBeNull();
  expect(document.body).toHaveTextContent('Qwen/');
});

const file = (relpath: string): FileEntryDTO => ({ relpath, plainFile: true, bytes: 1, commitShort: 'a3f9c1e', current: true });
const withFile = { ...QWEN_DETAIL, groups: QWEN_DETAIL.groups.map((g) => (g.key === 'quant:Q8_0' ? { ...g, files: [file('Model-Q8_0.gguf')] } : g)) };
const apiWith = (over = {}) => makeFakeApi({ repoDetail: () => Promise.resolve({ ok: true, data: withFile }), ...over });

test('the header, group labels and expanded file names use name parts', async () => {
  const user = userEvent.setup();
  const api = apiWith({ advice: (id: string) => Promise.resolve({ ok: true as const, data: adviceFor(id, withFile) }) });
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, api);
  await screen.findAllByTestId('group-row');
  const header = screen.getByTestId('repo-detail-header');
  await waitFor(() => expect(within(header).queryAllByTestId(/^name-part-/).length).toBeGreaterThan(0));
  const row = screen.getAllByTestId('group-row').find((r) => r.getAttribute('data-group-key') === 'quant:Q8_0')!;
  await waitFor(() => expect(within(row).getByText('Q8_0').className).toContain('decoration-primary'));
  await user.click(within(row).getByTestId('group-expand'));
  const files = screen.getByTestId('group-files');
  expect(files).toHaveTextContent('Model-Q8_0.gguf');
  expect(within(files).getByText('Q8_0').className).toContain('decoration-primary');
});

test('while advice fails the plain names show and no error appears', async () => {
  const api = apiWith({ advice: () => Promise.resolve({ ok: false as const, error: { code: 'INTERNAL', message: 'boom' } }) });
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, api);
  await screen.findAllByTestId('group-row');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(QWEN_DETAIL.repoId);
  expect(screen.getByText('UD-Q4_K_XL')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByTestId('name-part-known')).toBeNull();
});
