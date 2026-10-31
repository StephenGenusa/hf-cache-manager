import type { ExecErrorCode } from '../types';

export const STALE_MESSAGE = 'The cache changed since you reviewed — please review again.';

export class ExecError extends Error {
  constructor(readonly code: ExecErrorCode, message: string, readonly path?: string) {
    super(message);
    this.name = 'ExecError';
  }
}
