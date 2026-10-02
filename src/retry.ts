interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

/** Server errors, rate limits and dropped connections are worth retrying; NOT_FOUND and auth errors are not. */
export function isTransientError(err: unknown): boolean {
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
    errors?: Array<{ type?: string }>;
  };
  if (!e || typeof e !== 'object') return false;
  if (e.status !== undefined && (e.status === 429 || e.status >= 500)) return true;
  if (e.status === 403 && /rate limit|abuse/i.test(e.message ?? '')) return true;
  if (e.errors?.some((x) => x.type === 'RATE_LIMITED')) return true;
  return e.code !== undefined && TRANSIENT_CODES.has(e.code);
}

/** Runs `fn`, retrying transient failures with a linearly growing delay. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientError(err)) throw err;
      await sleep(delayMs * attempt);
    }
  }
}
