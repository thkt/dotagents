export const retryLimit = 3;
export const batchWindowMs = 100;
export function canRetry(attempts: number) {
  return attempts < retryLimit;
}
