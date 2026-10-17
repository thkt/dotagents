import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
export async function exportArchive<T>(root: string, action: (directory: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(root, 'archive-'));
  try {
    signal?.throwIfAborted();
    const result = await action(directory);
    signal?.throwIfAborted();
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
