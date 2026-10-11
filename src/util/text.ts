/**
 * Text helpers for operator-facing output.
 */

/**
 * The reason behind a failed call: the error's message, or for `fetch`, which
 * hides the connection error in `cause`, that error.
 */
export function errorReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { message?: string; code?: string } | undefined;
  if (err.message === 'fetch failed' && cause) return cause.message || cause.code || err.message;
  return err.message;
}

/**
 * `text` as shown to an operator. Control characters (U+0000–U+001F,
 * U+007F–U+009F) are removed, so text from an imported file cannot inject
 * terminal escape sequences; a tab or line break becomes a space, which keeps
 * one-line output on one line. The stored text is never altered.
 */
export function displayText(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}
