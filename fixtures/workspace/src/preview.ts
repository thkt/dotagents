export async function renderPreview<T>(directory: string, action: (directory: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const result = await action(directory);
  signal?.throwIfAborted();
  return result;
}
