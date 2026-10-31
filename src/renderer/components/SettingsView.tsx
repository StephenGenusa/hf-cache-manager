import type { ReactNode } from 'react';
import type { SettingsDTO } from '../../shared/api';
import { useSettings } from '../lib/queries';
import { AdviceSettingsSection } from './AdviceSettingsSection';
import { AutoEmptySelect } from './AutoEmptySelect';
import { ErrorNote } from './ErrorNote';

const LABEL = { lmstudio: 'LM Studio', ollama: 'Ollama' } as const;
export const READ_ONLY_NOTE = 'config.toml is read-only in this version. Edit ~/.config/hfhub/config.toml or set HFHUB_CONFIG.';

function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 border-b border-border py-1.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="break-all text-foreground">{children}</dd>
    </div>
  );
}

function Fields({ s }: { s: SettingsDTO }) {
  return (
    <dl>
      <Row label="Cache folder" testId="set-hub">{s.hubRoot}{s.hubPresent ? '' : ' (not found)'}</Row>
      <Row label="config.toml" testId="set-config">
        {s.configPath} ({s.configExists ? 'found' : 'not found'}){s.configError !== null && <span className="block text-danger">{s.configError}</span>}
      </Row>
      {s.views.map((v) => (
        <Row key={v.view} label={LABEL[v.view]} testId={`set-view-${v.view}`}>
          <div>{v.root ?? 'no folder configured'}{v.root !== null ? ` (${v.rootExists ? 'exists' : 'missing'})` : ''}</div>
          {v.statePath !== null && <div className="text-muted-foreground">state: {v.statePath}</div>}
          {Object.entries(v.aliases).map(([from, to]) => <div key={from} className="text-muted-foreground">alias {from} → {to}</div>)}
          {v.problem !== null && <div className="text-warning">{v.problem}</div>}
        </Row>
      ))}
      <Row label="Recently Deleted folder" testId="set-hold">{s.holdRoot ?? s.holdUnavailableReason ?? 'not available'}</Row>
      <Row label="Journal" testId="set-journal">{s.journalPath}</Row>
      <Row label="Symlinks" testId="set-symlinks">{s.symlinks.ok ? 'supported' : 'not supported'}{s.symlinks.detail !== '' ? ` — ${s.symlinks.detail}` : ''}</Row>
      <Row label="Platform" testId="set-platform">{s.platform}</Row>
      <Row label="Auto-empty Recently Deleted" testId="set-auto-empty"><AutoEmptySelect days={s.autoEmptyDays} /></Row>
    </dl>
  );
}

/**
 * Settings: config.toml and its folders are shown read-only; the one setting you can change is when
 * Recently Deleted empties itself (7, 14 or 30 days, or Never), which main saves to its own settings file.
 */
export function SettingsView({ section = null }: { section?: 'advice' | null }) {
  const settings = useSettings();
  const unreadable = settings.data?.settingsError ?? null;
  return (
    <div data-testid="settings-view" className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold text-foreground">Settings</h2>
      {unreadable !== null && (
        <p data-testid="settings-unreadable" className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning">
          Settings file could not be read ({unreadable}); auto-empty is off until you save Settings.
        </p>
      )}
      {settings.isPending && <p className="text-muted-foreground">Loading settings…</p>}
      {settings.isError && <ErrorNote error={{ code: 'INTERNAL', message: settings.error.message }} />}
      {settings.data !== undefined && <Fields s={settings.data} />}
      <AdviceSettingsSection scrollTo={section === 'advice'} />
      <p data-testid="settings-note" className="text-xs text-muted-foreground">{READ_ONLY_NOTE}</p>
    </div>
  );
}
