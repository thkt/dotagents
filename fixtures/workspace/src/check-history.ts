export function checkHistory(value: { id?: unknown }) {
  if (typeof value.id !== 'string') throw new Error('idが必要です');
}
