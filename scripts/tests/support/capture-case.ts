import { expect } from 'bun:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type correctionFixture, object, events } from './correction.ts';

export async function captureCase(
  trial: ReturnType<typeof correctionFixture>['trial'],
  mode: string,
  result: string,
  captures: number,
  reviews: number,
) {
  const t = await trial(mode, { checkTimeMs: 500 });
  const resultProcess = t.execute();
  expect(resultProcess.status).toBe(result === 'ready_for_human_review' ? 0 : 1);
  const state = await t.state();
  expect(state.result).toBe(result);
  expect(state.review).toBe(reviews);
  expect(events(state.events).filter((event) => object(event).role === 'capture')).toHaveLength(
    captures,
  );
  if (result === 'ready_for_human_review') {
    expect(await readFile(join(t.config.cwd, 'trial/evidence/generated/desktop.png'), 'utf8')).toBe(
      'correct',
    );
  }
  if (mode === 'capture_success') {
    const before = JSON.stringify(state);
    expect(t.execute().status).toBe(0);
    expect(JSON.stringify(await t.state())).toBe(before);
    await writeFile(join(t.config.cwd, 'trial/evidence/generated/desktop.png'), 'stale');
    expect(object(JSON.parse(t.execute().stdout)).result).toBe('target_changed_after_stop');
  }
  if (mode === 'capture_unavailable') {
    expect(state.findings).toContain('capture-1.stderr');
    expect(state.repair).toBe(0);
  }
}
