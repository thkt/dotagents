import assert from 'node:assert/strict';
import { z } from 'zod';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyWidth, widthSweep } from '../../ui/width-sweep.ts';

const reportShape = z.object({
  status: z.string(),
  samples: z.array(
    z.object({
      state: z.string(),
      width: z.number(),
      pageOverflow: z.boolean(),
      candidates: z.array(z.unknown()),
    }),
  ),
});
const clipped: Parameters<typeof classifyWidth>[0]['elements'][number] = {
  selector: '.child',
  left: 0,
  right: 1600,
  ancestors: [{ selector: '.scroll', overflowX: 'auto', left: 0, right: 320 }],
};
function measurement(width: number, overflow = false) {
  return {
    innerWidth: width,
    clientWidth: width,
    scrollWidth: width + (overflow ? 1 : 0),
    elements: [clipped],
  };
}

test('page overflow has no tolerance; candidate tolerance preserves clip evidence', () => {
  const sample = measurement(850);
  expect(classifyWidth(sample)).toEqual({ pageOverflow: false, candidates: [clipped] });
  expect(classifyWidth(measurement(850, true)).pageOverflow).toBe(true);
  const elements = [
    { selector: 'edge', left: -1, right: 851, ancestors: [] },
    { selector: 'left', left: -1.01, right: 850, ancestors: [] },
    { selector: 'right', left: 0, right: 851.01, ancestors: [] },
  ];
  expect(classifyWidth({ ...sample, elements }).candidates.map((x) => x.selector)).toEqual([
    'left',
    'right',
  ]);
  expect(() => classifyWidth({ ...sample, clientWidth: 0 })).toThrow('Invalid DOM measurement');
});

test('all integer widths and states are measured, including a narrow overflow and local scrolling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'width-sweep-'));
  let width = 0;
  let current = '';
  let prepared = false;
  let evaluations = 0;
  const ready: string[] = [];
  const page = {
    setViewportSize: (size: { width: number }) => {
      width = size.width;
      return Promise.resolve();
    },
    goto: (url: string) => {
      current = url;
      prepared = false;
      return Promise.resolve();
    },
    url: () => current,
    evaluate: async (_callback: () => unknown): Promise<unknown> => {
      // DOMの動作はホストで検証し、ここでは幅の反復と記録を確認する。
      evaluations++;
      const result =
        evaluations % 2 === 1
          ? undefined
          : measurement(width, current === 'narrow' && width >= 849 && width <= 851);
      return result;
    },
  };
  try {
    const output = join(root, 'result.json');
    const options = {
      testInfo: {
        project: { name: '' },
        file: join(root, 'width.spec.ts'),
        line: 1,
        column: 0,
        title: 'states',
      },
      minWidth: 848,
      maxWidth: 852,
      height: 900,
      output,
      source: 'commit + diff',
      browser: 'mock; no real browser',
      conditions: 'control test',
      limitations: 'DOM untested',
      states: ['normal', 'narrow', 'local'].map((name) => ({
        name,
        url: name,
        prepare: async () => {
          prepared = true;
        },
        ready: async () => {
          expect(prepared).toBe(true);
          ready.push(`${current}:${width}`);
        },
      })),
    };
    await assert.rejects(widthSweep(page, options), /Width sweep failed: Page horizontal overflow/);
    const saved = await readFile(output, 'utf8');
    expect(saved).not.toContain('"elements"');
    expect(saved).toContain('"overflowX": "auto"');
    const report = reportShape.parse(JSON.parse(saved));
    const normalState = options.states[0];
    assert(normalState);
    expect(report.status).toBe('failed');
    expect(ready).toHaveLength(15);
    expect(
      report.samples
        .filter((sample: { pageOverflow: boolean }) => sample.pageOverflow)
        .map((sample: { width: number }) => sample.width),
    ).toEqual([849, 850, 851]);
    expect(
      report.samples
        .filter((sample: { state: string }) => sample.state === 'local')
        .every((sample: { candidates: unknown[] }) => sample.candidates.length === 1),
    ).toBe(true);
    const before = await readFile(output, 'utf8');
    await assert.rejects(widthSweep(page, options), /EEXIST/);
    expect(await readFile(output, 'utf8')).toBe(before);
    expect(ready).toHaveLength(15);
    await widthSweep(page, {
      ...options,
      output: join(root, 'passed.json'),
      states: [normalState],
    });
    expect(
      reportShape.parse(JSON.parse(await readFile(join(root, 'passed.json'), 'utf8'))).status,
    ).toBe('passed');
    await assert.rejects(
      widthSweep(page, { ...options, output: join(root, 'empty.json'), states: [] }),
      /No display states/,
    );
    expect(
      reportShape.parse(JSON.parse(await readFile(join(root, 'empty.json'), 'utf8'))),
    ).toMatchObject({ status: 'unavailable', samples: [] });
    await assert.rejects(
      widthSweep(page, {
        ...options,
        output: join(root, 'drawing.json'),
        states: [
          {
            ...normalState,
            name: 'broken',
            url: 'normal',
            prepare: async () => {},
            ready: async () => {
              throw Error('readiness failed');
            },
          },
        ],
      }),
      /readiness failed/,
    );
    expect(
      reportShape.parse(JSON.parse(await readFile(join(root, 'drawing.json'), 'utf8'))),
    ).toMatchObject({ status: 'failed', samples: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
