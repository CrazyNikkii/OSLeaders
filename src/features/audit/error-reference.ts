import { randomBytes } from 'node:crypto';

export function createErrorReferenceId(): string {
  return `err_${randomBytes(6).toString('hex')}`;
}
