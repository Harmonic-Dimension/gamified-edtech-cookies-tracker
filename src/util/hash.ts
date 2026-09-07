import { createHash } from 'node:crypto';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Short, still-unique-enough hash for display in tables. */
export function shortHash(input: string): string {
  return sha256(input).slice(0, 12);
}
