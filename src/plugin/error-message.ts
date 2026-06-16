export function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }

  if (typeof error === 'string' && error.trim()) return error;

  if (error != null) {
    const rendered = String(error).trim();
    if (rendered) return rendered;
  }

  return fallback;
}
