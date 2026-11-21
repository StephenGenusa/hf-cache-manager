import type { ReactNode } from 'react';
import type { HubRepoType } from '../../shared/hub-input';
import { useApi } from '../lib/api';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { toast } from './ui/toast';

/** The repo as the Download tab's Hub field reads it: datasets and spaces carry their prefix. */
export const hubInputFor = (type: HubRepoType, repoId: string): string => (type === 'model' ? repoId : `${type}s/${repoId}`);

/** Opens a repo's Hugging Face page in the default browser; a failure is a toast. */
export function useOpenRepoPage(): (repoId: string, type: HubRepoType) => void {
  const api = useApi();
  return (repoId, type) => {
    const failed = (message: string): void => { toast({ title: `Could not open the browser: ${message}`, tone: 'danger' }); };
    void api.openRepoPage(repoId, type).then((r) => { if (!r.ok) failed(r.error.message); }, (e: unknown) => failed(e instanceof Error ? e.message : String(e)));
  };
}

export interface RepoMenuProps {
  repoId: string;
  type: HubRepoType;
  /** Given where the repo can be sent to the Download tab (the library); called with the text to look up on the Hub. */
  onOpenInDownload?: ((hubInput: string) => void) | undefined;
  /** The element the menu opens over (one element: it becomes the trigger). */
  children: ReactNode;
}

/** The right-click menu of a repo, wherever it is listed: its Hub page, and from the library the Download tab. */
export function RepoMenu({ repoId, type, onOpenInDownload, children }: RepoMenuProps) {
  const openPage = useOpenRepoPage();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem data-testid="menu-open-on-hub" onSelect={() => openPage(repoId, type)}>Open on Hugging Face</ContextMenuItem>
        {onOpenInDownload !== undefined && (
          <ContextMenuItem data-testid="menu-open-in-download" onSelect={() => onOpenInDownload(hubInputFor(type, repoId))}>Open in Download tab</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
