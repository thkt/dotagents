/** @file Outcome: Every screenshot boundary shares one finite, portable attachment contract. */

export const SCREENSHOT_CAP = 50;

export interface ScreenshotSpec {
  name: string;
  alt: string;
}

export function safeScreenshotName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/iu.test(value) &&
    !value.includes('..')
  );
}

export function markdownScreenshotAlt(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .trim()
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}
