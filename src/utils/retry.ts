/**
 * Retry a function with exponential backoff.
 *
 * Attempts: 1st immediate, 2nd after 2s, 3rd after 4s.
 * After all retries exhausted, throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000,
): Promise<T> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt); // 2s, 4s, 8s
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}
