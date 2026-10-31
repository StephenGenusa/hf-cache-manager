import type { ApiErrorCode } from '../../shared/api';

export interface ExecErrorCopy {
  text: string;
  reviewAgain: boolean;
  /** Raw technical text for a "details" toggle (INTERNAL only); never shown as the main copy. */
  details?: string;
}

const REVIEW_AGAIN = 'The cache changed since you reviewed — please review again.';
const LOCKED = 'Another operation (sync or deletion) is running. Try again when it finishes.';

/**
 * User copy for an execute error. `extra.detailPath` is the lock file (display only). `extra.staleOwnLock` is main's
 * structured finding that the lock names this app's own process: the manual fix is then spelled out. The message
 * text is never parsed.
 */
export function execErrorText(
  code: ApiErrorCode, message: string, extra: { detailPath?: string; staleOwnLock?: boolean } = {},
): ExecErrorCopy {
  switch (code) {
    case 'STALE':
    case 'FINGERPRINT':
      return { text: REVIEW_AGAIN, reviewAgain: true };
    case 'EXPIRED':
      return { text: 'This review is more than 10 minutes old — please review again.', reviewAgain: true };
    case 'USED':
    case 'UNKNOWN_PLAN':
      return { text: 'This review was already used or is no longer valid — please review again.', reviewAgain: true };
    case 'CONFIRM':
      return { text: 'The confirmation text did not match.', reviewAgain: false };
    case 'LOCKED': {
      const tail = extra.staleOwnLock === true && extra.detailPath !== undefined ? ` If no other copy of this app is running on this or any other computer that uses this cache, quit the app and delete ${extra.detailPath}.` : '';
      return { text: LOCKED + tail, reviewAgain: false };
    }
    case 'ACTIVE_DOWNLOAD':
      return { text: 'A download is in progress in this repo. Try again when it finishes.', reviewAgain: false };
    case 'CONTAINMENT':
      return { text: 'Refused: the plan touched a path outside the cache. Nothing was changed.', reviewAgain: false };
    case 'ROLLED_BACK':
      return { text: `Nothing was moved: ${message}. All changes were rolled back.`, reviewAgain: false };
    case 'INTERNAL':
      return { text: 'Something went wrong inside the app. Nothing was changed by this step.', reviewAgain: false, details: message };
    default:
      return { text: message, reviewAgain: false };
  }
}
