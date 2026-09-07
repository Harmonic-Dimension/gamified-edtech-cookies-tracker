import { describe, it, expect } from 'vitest';
import { withTimeout, settleWithin, TimeoutError, isTimeoutError } from '../src/util/timeout.js';

const never = () => new Promise<string>(() => {});
const slow = (ms: number, value = 'done') => new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));

describe('timeout helpers', () => {
  it('resolves normally when the work finishes in time', async () => {
    await expect(withTimeout(slow(10), 500, 'work')).resolves.toBe('done');
  });

  it('rejects with a TimeoutError when the work hangs', async () => {
    await expect(withTimeout(never(), 30, 'hanging work')).rejects.toBeInstanceOf(TimeoutError);
    await withTimeout(never(), 30, 'hanging work').catch((err) => {
      expect(isTimeoutError(err)).toBe(true);
      expect(String(err)).toContain('hanging work');
    });
  });

  it('falls back instead of hanging, and swallows a late rejection', async () => {
    const late = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('too late')), 40));
    await expect(settleWithin(late, 10, 'fallback')).resolves.toBe('fallback');
    // Give the late rejection time to fire; it must not become an unhandled rejection.
    await slow(60);
  });

  it('does not treat ordinary errors as timeouts', async () => {
    expect(isTimeoutError(new Error('boom'))).toBe(false);
  });
});
