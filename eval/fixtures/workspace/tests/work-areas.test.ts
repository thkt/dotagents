import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportArchive } from '../src/archive.ts';
import { renderPreview } from '../src/preview.ts';
import { exportReport, previewReport } from '../src/reports.ts';

test('既存の帳票呼出元から内部所有と外部所有の処理を利用できる', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-callers-'));
  try {
    expect(await exportReport(root, 'report contents')).toBe('report contents');
    expect(await readdir(root)).toEqual([]);
    expect(await previewReport(root, 'preview contents')).toBe('preview contents');
    expect(await readFile(join(root, 'preview.txt'), 'utf8')).toBe('preview contents');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const operation of [exportReport, previewReport]) {
  test(`${operation.name}は呼出元の開始前取消を伝えて領域を変更しない`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'report-cancellation-'));
    try {
      await writeFile(join(root, 'keep.txt'), 'caller-owned');
      const controller = new AbortController();
      controller.abort();
      await expect(operation(root, '未保存の帳票', controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(await readdir(root)).toEqual(['keep.txt']);
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('caller-owned');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const owned of [true, false]) {
  for (const mode of ['success', 'failure', 'cancel-before', 'cancel-during']) {
    test(`${owned ? '内部' : '外部'}所有の${mode}で終了責任を維持する`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'work-area-'));
      try {
        const controller = new AbortController();
        const error = new Error('actionの失敗');
        let calls = 0;
        await writeFile(join(root, 'keep.txt'), 'caller-owned');
        if (mode === 'cancel-before') controller.abort();
        const action = async (directory: string) => {
          calls++;
          expect(await readdir(directory)).toEqual(owned ? [] : ['keep.txt']);
          await writeFile(join(directory, 'output.txt'), 'output');
          if (mode === 'failure') throw error;
          if (mode === 'cancel-during') controller.abort();
          return 'result';
        };
        const result = owned
          ? exportArchive(root, action, controller.signal)
          : renderPreview(root, action, controller.signal);
        if (mode === 'success') expect(await result).toBe('result');
        else if (mode === 'failure') await expect(result).rejects.toBe(error);
        else await expect(result).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls).toBe(mode === 'cancel-before' ? 0 : 1);
        expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('caller-owned');
        expect((await readdir(root)).sort()).toEqual(
          owned || mode === 'cancel-before' ? ['keep.txt'] : ['keep.txt', 'output.txt'],
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
