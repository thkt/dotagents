import { afterAll, beforeAll, expect, spyOn } from 'bun:test';
import { tmpdir } from 'node:os';
import * as processModule from '../../shared/process.ts';
import { testDevelopment } from '../support/development.ts';

// 時間切れのテストはfinallyより先に次のテストへ進むため、差し替えたcommandが残る。
// 後続のfixtureがそれを元のcommandとして取り込むと、観測の委譲が自分自身を呼び続ける。
let restore: (() => void) | undefined;
beforeAll(() => {
  const original = processModule.command;
  const leaked = spyOn(processModule, 'command').mockImplementation((...args) => original(...args));
  restore = () => leaked.mockRestore();
});
afterAll(() => restore?.());

testDevelopment(
  'delegates commands outside the run after an earlier spy was left in place',
  async () => {
    const result = await processModule.command(['true'], tmpdir(), '', 10000);
    expect(result.code).toBe(0);
  },
);
