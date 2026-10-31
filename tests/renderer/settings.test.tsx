import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { RepoDetail } from '../../src/renderer/components/RepoDetail';
import { SettingsView } from '../../src/renderer/components/SettingsView';
import type { ApiResult, MachineProfileDTO } from '../../src/shared/api';
import { adviceFor, makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => { expect.hasAssertions(); });
const GIB = 2 ** 30;
const PROFILE: MachineProfileDTO = {
  detected: { platform: 'linux', ramBytes: 64 * GIB, gpuName: 'RTX 5090', gpuBytes: 24 * GIB, gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false },
  settings: { gpuBytes: null, gpuKind: null, ramBytes: null, drivesDisplay: null, context: 32768, kvType: 'f16', tools: null },
  adviceError: null, effective: { gpuBytes: 24 * GIB, ramBytes: 64 * GIB, gpuKind: 'nvidia' }, defaultTools: ['llama.cpp', 'ollama'],
};
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });

test('shows detected values and the default tools', async () => {
  renderWithProviders(<SettingsView />, makeFakeApi({ machineProfile: () => Promise.resolve(ok(PROFILE)) }));
  expect(await screen.findByTestId('advice-detected')).toHaveTextContent('RTX 5090');
  expect(screen.getByTestId('advice-detected')).toHaveTextContent('24 GB GPU memory · 64 GB RAM');
  expect(screen.getByTestId('advice-tools-default')).toBeChecked();
});

test('edits every field, saves through setAdviceSettings in bytes, and refetches advice and the profile', async () => {
  const user = userEvent.setup();
  const setAdviceSettings = vi.fn((s: MachineProfileDTO['settings']) => Promise.resolve(ok({ ...PROFILE, settings: s })));
  const advice = vi.fn(() => Promise.resolve({ ok: false as const, error: { code: 'NOT_FOUND' as const, message: 'x' } }));
  const machineProfile = vi.fn(() => Promise.resolve(ok(PROFILE)));
  renderWithProviders(<SettingsView />, makeFakeApi({ setAdviceSettings, machineProfile, advice }));
  await user.type(await screen.findByTestId('advice-gpu'), '16');
  await user.type(screen.getByTestId('advice-ram'), '32');
  await user.selectOptions(screen.getByTestId('advice-gpu-kind'), 'nvidia');
  await user.selectOptions(screen.getByTestId('advice-display'), 'yes');
  await user.selectOptions(screen.getByTestId('advice-context'), '65536');
  await user.selectOptions(screen.getByTestId('advice-kv'), 'q8_0');
  await user.click(screen.getByTestId('advice-tools-default'));
  await user.click(screen.getByTestId('advice-tool-ollama'));
  await user.click(screen.getByTestId('advice-tool-vllm'));
  const before = machineProfile.mock.calls.length;
  await user.click(screen.getByTestId('advice-save'));
  await waitFor(() => expect(setAdviceSettings).toHaveBeenCalledOnce());
  expect(setAdviceSettings).toHaveBeenCalledWith({
    gpuBytes: 16 * GIB, gpuKind: 'nvidia', ramBytes: 32 * GIB, drivesDisplay: true, context: 65536, kvType: 'q8_0', tools: ['llama.cpp', 'vllm'],
  });
  await waitFor(() => expect(machineProfile.mock.calls.length).toBeGreaterThan(before));
});

test('a SETTINGS failure shows main\'s message and keeps the form values', async () => {
  const user = userEvent.setup();
  const message = 'Settings could not be read, so they were not changed. Fix or remove settings.json first.';
  renderWithProviders(<SettingsView />, makeFakeApi({
    machineProfile: () => Promise.resolve(ok(PROFILE)),
    setAdviceSettings: () => Promise.resolve({ ok: false, error: { code: 'SETTINGS', message } }),
  }));
  await user.type(await screen.findByTestId('advice-gpu'), '16');
  await user.click(screen.getByTestId('advice-save'));
  expect(await screen.findByTestId('advice-error')).toHaveTextContent(message);
  expect(screen.getByTestId('advice-gpu')).toHaveValue('16');
});

test('invalid memory text is not sent', async () => {
  const user = userEvent.setup();
  const setAdviceSettings = vi.fn(() => Promise.resolve(ok(PROFILE)));
  renderWithProviders(<SettingsView />, makeFakeApi({ machineProfile: () => Promise.resolve(ok(PROFILE)), setAdviceSettings }));
  await user.type(await screen.findByTestId('advice-gpu'), 'lots');
  await user.click(screen.getByTestId('advice-save'));
  expect(await screen.findByTestId('advice-error')).toBeInTheDocument();
  expect(setAdviceSettings).not.toHaveBeenCalled();
});

test('"Detect again" calls redetectMachine; an unreadable advice block shows a muted note', async () => {
  const user = userEvent.setup();
  const redetectMachine = vi.fn(() => Promise.resolve(ok(PROFILE)));
  renderWithProviders(<SettingsView section="advice" />, makeFakeApi({ machineProfile: () => Promise.resolve(ok({ ...PROFILE, adviceError: 'bad' })), redetectMachine }));
  expect(await screen.findByTestId('advice-settings-unreadable')).toHaveTextContent('Your saved advice settings could not be read; detected values are used.');
  await user.click(screen.getByTestId('advice-redetect'));
  await waitFor(() => expect(redetectMachine).toHaveBeenCalledOnce());
});

test('save and redetect refetch advice queries that are already loaded', async () => {
  const user = userEvent.setup();
  const advice = vi.fn((id: string) => Promise.resolve(ok(adviceFor(id))));
  renderWithProviders(
    <><RepoDetail repoId="unsloth/Qwen3.6-27B-GGUF" onDeleteWholeRepo={() => undefined} /><SettingsView /></>,
    makeFakeApi({ machineProfile: () => Promise.resolve(ok(PROFILE)), advice }),
  );
  await screen.findByTestId('advice-save');
  await waitFor(() => expect(advice).toHaveBeenCalledTimes(1));
  await user.click(screen.getByTestId('advice-save'));
  await waitFor(() => expect(advice).toHaveBeenCalledTimes(2));
  await user.click(screen.getByTestId('advice-redetect'));
  await waitFor(() => expect(advice).toHaveBeenCalledTimes(3));
});

test.each(['0x10', '1e3', '-4', 'Infinity', '0'])('memory text %s is rejected', async (text) => {
  const user = userEvent.setup();
  const setAdviceSettings = vi.fn(() => Promise.resolve(ok(PROFILE)));
  renderWithProviders(<SettingsView />, makeFakeApi({ machineProfile: () => Promise.resolve(ok(PROFILE)), setAdviceSettings }));
  await user.type(await screen.findByTestId('advice-ram'), text);
  await user.click(screen.getByTestId('advice-save'));
  expect(await screen.findByTestId('advice-error')).toBeInTheDocument();
  expect(setAdviceSettings).not.toHaveBeenCalled();
});

test('an empty tools list cannot be saved', async () => {
  const user = userEvent.setup();
  const setAdviceSettings = vi.fn(() => Promise.resolve(ok(PROFILE)));
  renderWithProviders(<SettingsView />, makeFakeApi({ machineProfile: () => Promise.resolve(ok(PROFILE)), setAdviceSettings }));
  await user.click(await screen.findByTestId('advice-tools-default'));
  await user.click(screen.getByTestId('advice-tool-llama.cpp'));
  await user.click(screen.getByTestId('advice-tool-ollama'));
  await user.click(screen.getByTestId('advice-save'));
  expect(await screen.findByTestId('advice-error')).toHaveTextContent('Pick at least one tool');
  expect(setAdviceSettings).not.toHaveBeenCalled();
  expect(screen.getByTestId('advice-tools-default')).not.toBeChecked();
});
