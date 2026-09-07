/**
 * Timeout helpers.
 *
 * Several Playwright calls have no timeout of their own — `evaluate`, and the
 * teardown calls that flush a trace or a HAR file. If the page or the browser
 * wedges, those can block forever, which would silently stall a whole audit.
 * Every such call in this project is wrapped in one of these helpers so that a
 * stuck step becomes a recorded failure instead of an audit that never ends.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError when the promise takes too long. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Waits for the promise, but gives up after `ms` and returns `fallback`
 * instead. The original promise is left running with its rejection swallowed,
 * so a late failure cannot crash the process.
 */
export async function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  promise.catch(() => undefined);
  try {
    return await withTimeout(promise, ms, 'operation');
  } catch {
    return fallback;
  }
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof TimeoutError || (err instanceof Error && err.name === 'TimeoutError');
}
