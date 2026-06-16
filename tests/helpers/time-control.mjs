export async function withFakeNow(nowImpl, fn) {
  const originalNow = Date.now;
  Date.now = typeof nowImpl === 'function' ? nowImpl : () => nowImpl;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}
