import { test, afterEach } from 'bun:test';
import { correctionFixture } from '../../support/correction.ts';
import { captureCase } from '../../support/capture-case.ts';
const { trial, cleanup } = correctionFixture();
afterEach(cleanup);
for (const [mode, result] of [
  ['capture_unavailable', 'capture_unavailable'],
  ['capture_timeout', 'capture_timeout'],
] as const) {
  test(`${mode} through controller entry`, () => captureCase(trial, mode, result, 1, 0));
}
