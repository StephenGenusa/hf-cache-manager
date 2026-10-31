import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiError, MachineProfileDTO } from '../../shared/api';
import type { AdviceSettings, GpuKind } from '../../core/advice/profile';
import type { Tool } from '../../shared/knowledge/rules';
import { useApi } from '../lib/api';
import { queryKeys, useMachineProfile } from '../lib/queries';
import { ErrorNote } from './ErrorNote';
import { Button } from './ui/button';
import { Input } from './ui/input';

const GIB = 2 ** 30;
const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'llama.cpp', label: 'llama.cpp' }, { id: 'lmstudio', label: 'LM Studio' }, { id: 'ollama', label: 'Ollama' },
  { id: 'vllm', label: 'vLLM / SGLang' }, { id: 'tabbyapi', label: 'TabbyAPI (EXL3)' }, { id: 'transformers', label: 'transformers' },
];
const toolLabel = (t: Tool): string => TOOLS.find((x) => x.id === t)?.label ?? t;
const CONTEXTS: AdviceSettings['context'][] = [8192, 16384, 32768, 65536, 131072];
export const ADVICE_ERROR_NOTE = 'Your saved advice settings could not be read; detected values are used.';

const gbText = (bytes: number | null): string => (bytes === null ? '' : String(Math.round((bytes / GIB) * 100) / 100));
/** '' means "use detected" (null); anything else must be a number of GB above zero. `undefined` means invalid. */
const parseGb = (text: string): number | null | undefined => {
  if (text.trim() === '') return null;
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * GIB) : undefined;
};

const SELECT = 'h-7 rounded-md border border-input bg-secondary px-2 text-xs text-secondary-foreground disabled:opacity-50';

function Field({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-center gap-3 border-b border-border py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2 text-foreground">{children}{note !== undefined && <span className="text-muted-foreground">{note}</span>}</div>
    </div>
  );
}

function Form({ profile }: { profile: MachineProfileDTO }) {
  const api = useApi();
  const client = useQueryClient();
  const s = profile.settings;
  const d = profile.detected;
  const [gpu, setGpu] = useState(gbText(s.gpuBytes));
  const [ram, setRam] = useState(gbText(s.ramBytes));
  const [gpuKind, setGpuKind] = useState<GpuKind | ''>(s.gpuKind ?? '');
  const [display, setDisplay] = useState<'' | 'yes' | 'no'>(s.drivesDisplay === null ? '' : s.drivesDisplay ? 'yes' : 'no');
  const [context, setContext] = useState<AdviceSettings['context']>(s.context);
  const [kv, setKv] = useState<AdviceSettings['kvType']>(s.kvType);
  const [useDefaultTools, setUseDefaultTools] = useState(s.tools === null);
  const [tools, setTools] = useState<Tool[]>(s.tools ?? profile.defaultTools);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.machineProfile });
    void client.invalidateQueries({ queryKey: ['advice'] });
  };

  async function save(): Promise<void> {
    const gpuBytes = parseGb(gpu);
    const ramBytes = parseGb(ram);
    if (gpuBytes === undefined || ramBytes === undefined) {
      setError({ code: 'INVALID_INPUT', message: 'Enter memory as a number of GB above zero, or leave it empty to use the detected value.' });
      return;
    }
    if (!useDefaultTools && tools.length === 0) {
      setError({ code: 'INVALID_INPUT', message: 'Pick at least one tool.' });
      return;
    }
    const next: AdviceSettings = {
      gpuBytes, ramBytes, gpuKind: gpuKind === '' ? null : gpuKind, drivesDisplay: display === '' ? null : display === 'yes',
      context, kvType: kv, tools: useDefaultTools ? null : tools,
    };
    setBusy(true);
    setError(null);
    try {
      const r = await api.setAdviceSettings(next);
      if (!r.ok) setError(r.error);
      else refresh();
    } catch (e) {
      setError({ code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function redetect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api.redetectMachine();
      if (!r.ok) setError(r.error);
      else refresh();
    } catch (e) {
      setError({ code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Field label="Detected">
        <span data-testid="advice-detected">
          {d.gpuName ?? 'no GPU found'}{d.gpuBytes !== null ? ` · ${gbText(d.gpuBytes)} GB GPU memory` : ''} · {gbText(d.ramBytes)} GB RAM · {d.platform}
        </span>
        <Button data-testid="advice-redetect" disabled={busy} onClick={() => void redetect()}>Detect again</Button>
      </Field>
      <Field label="GPU memory (GB)" note={d.gpuBytes !== null ? `detected ${gbText(d.gpuBytes)}` : 'not detected'}>
        <Input data-testid="advice-gpu" aria-label="GPU memory in GB" className="w-24" inputMode="decimal" placeholder="detected" value={gpu} onChange={(e) => setGpu(e.target.value)} />
      </Field>
      <Field label="GPU type">
        <select data-testid="advice-gpu-kind" aria-label="GPU type" className={SELECT} value={gpuKind} onChange={(e) => setGpuKind(e.target.value as GpuKind | '')}>
          <option value="">Detected ({d.gpuKind})</option>
          <option value="nvidia">NVIDIA</option><option value="apple">Apple</option><option value="other">Other</option>
        </select>
      </Field>
      <Field label="RAM (GB)" note={`detected ${gbText(d.ramBytes)}`}>
        <Input data-testid="advice-ram" aria-label="RAM in GB" className="w-24" inputMode="decimal" placeholder="detected" value={ram} onChange={(e) => setRam(e.target.value)} />
      </Field>
      <Field label="GPU drives the display">
        <select data-testid="advice-display" aria-label="GPU drives the display" className={SELECT} value={display} onChange={(e) => setDisplay(e.target.value as '' | 'yes' | 'no')}>
          <option value="">Detected ({d.drivesDisplay ? 'yes' : 'no'})</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
      </Field>
      <Field label="Context length">
        <select data-testid="advice-context" aria-label="Context length" className={SELECT} value={context} onChange={(e) => setContext(Number(e.target.value) as AdviceSettings['context'])}>
          {CONTEXTS.map((c) => <option key={c} value={c}>{c.toLocaleString('en-US')} tokens</option>)}
        </select>
      </Field>
      <Field label="KV cache type">
        <select data-testid="advice-kv" aria-label="KV cache type" className={SELECT} value={kv} onChange={(e) => setKv(e.target.value as AdviceSettings['kvType'])}>
          <option value="f16">f16</option><option value="q8_0">q8_0</option>
        </select>
      </Field>
      <Field label="Tools you run">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" data-testid="advice-tools-default" checked={useDefaultTools} onChange={(e) => setUseDefaultTools(e.target.checked)} />
          Use the default ({profile.defaultTools.map(toolLabel).join(', ')})
        </label>
        {!useDefaultTools && TOOLS.map((t) => (
          <label key={t.id} className="flex items-center gap-1.5">
            <input
              type="checkbox" data-testid={`advice-tool-${t.id}`} checked={tools.includes(t.id)}
              onChange={(e) => setTools((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))}
            />
            {t.label}
          </label>
        ))}
      </Field>
      <div className="mt-2 flex items-center gap-2">
        <Button data-testid="advice-save" variant="tonal" disabled={busy} onClick={() => void save()}>Save advice settings</Button>
      </div>
      {error !== null && <div className="mt-2"><ErrorNote error={error} testId="advice-error" verbatim /></div>}
    </div>
  );
}

/** Settings → Advice: what the keep advice assumes about this PC. Empty memory fields mean "use detected". */
export function AdviceSettingsSection({ scrollTo }: { scrollTo: boolean }) {
  const profile = useMachineProfile();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scrollTo) ref.current?.scrollIntoView?.();
  }, [scrollTo, profile.data !== undefined]);
  const p = profile.data;
  return (
    <section id="advice" ref={ref} data-testid="advice-settings" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-foreground">Advice</h3>
      {p?.adviceError != null && <p data-testid="advice-settings-unreadable" className="text-xs text-muted-foreground">{ADVICE_ERROR_NOTE}</p>}
      {profile.isPending && <p className="text-xs text-muted-foreground">Loading…</p>}
      {profile.isError && <ErrorNote error={{ code: 'INTERNAL', message: profile.error.message }} />}
      {p !== undefined && <Form key={JSON.stringify(p.settings)} profile={p} />}
    </section>
  );
}
