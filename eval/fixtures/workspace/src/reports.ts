import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportArchive } from './archive.ts';
import { renderPreview } from './preview.ts';

export function exportReport(root: string, contents: string, signal?: AbortSignal) {
  return exportArchive(root, async (directory) => {
    const file = join(directory, 'report.txt');
    await writeFile(file, contents);
    return readFile(file, 'utf8');
  }, signal);
}

export function previewReport(directory: string, contents: string, signal?: AbortSignal) {
  return renderPreview(directory, async (area) => {
    const file = join(area, 'preview.txt');
    await writeFile(file, contents);
    return readFile(file, 'utf8');
  }, signal);
}
