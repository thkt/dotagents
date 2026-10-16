import assert from 'node:assert/strict';
import type { z } from 'zod';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { outside } from '../shared/values.ts';
import { measureDOM, settledDOM } from './width-sweep-browser.ts';

import { measurementShape, type SweepSample, testInfoShape } from './records.ts';

type Measurement = z.infer<typeof measurementShape>;
interface SweepPage {
  goto(url: string): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<unknown>;
  evaluate(callback: () => unknown): Promise<unknown>;
  url(): string;
}
interface SweepOptions<P extends SweepPage> {
  testInfo: z.infer<typeof testInfoShape>;
  minWidth: number;
  maxWidth: number;
  height: number;
  output: string;
  source: string;
  browser: string;
  conditions: string;
  limitations: string;
  states: {
    name: string;
    url: string;
    prepare: (page: P) => Promise<void>;
    ready: (page: P, width: number) => Promise<void>;
  }[];
}

export function classifyWidth(sample: Measurement) {
  assert(
    [sample.innerWidth, sample.clientWidth, sample.scrollWidth].every(Number.isFinite) &&
      sample.clientWidth > 0 &&
      sample.scrollWidth >= sample.clientWidth,
    'Invalid DOM measurement',
  );
  return {
    pageOverflow: sample.scrollWidth > sample.clientWidth,
    candidates: sample.elements.filter(
      (element) => element.left < -1 || element.right > sample.clientWidth + 1,
    ),
  };
}

function validateOptions<P extends SweepPage>(options: SweepOptions<P>) {
  testInfoShape.parse(options.testInfo);
  for (const value of [options.minWidth, options.maxWidth, options.height]) {
    assert(Number.isSafeInteger(value) && value > 0, 'Widths and height must be positive integers');
  }
  assert(options.maxWidth >= options.minWidth, 'Reversed width range');
  for (const value of [options.source, options.browser, options.conditions, options.limitations]) {
    assert(
      typeof value === 'string' && value.trim(),
      'Source, browser, conditions and limitations are required',
    );
  }
  assert(options.states.length > 0, 'No display states');
  const names = new Set<string>();
  for (const state of options.states) {
    assert(state.name.trim() && !names.has(state.name), 'Empty or duplicate state name');
    names.add(state.name);
    assert(
      state.url.trim() && typeof state.prepare === 'function' && typeof state.ready === 'function',
      'State URL, preparation and readiness are required',
    );
  }
}

// ブラウザー・認証・サーバーの準備は対象repoのpage fixtureと設定に従う。
export async function widthSweep<P extends SweepPage>(page: P, options: SweepOptions<P>) {
  assert(isAbsolute(options.output), 'Output must be an absolute new file');
  const root = await realpath(process.cwd());
  assert(outside(root, await realpath(dirname(options.output))), 'Output must be outside checkout');
  const file = await open(options.output, 'wx');
  const samples: SweepSample[] = [];
  let status: 'passed' | 'failed' | 'unavailable' = 'unavailable';
  let error = '';
  try {
    validateOptions(options);
    status = 'failed';
    for (const state of options.states) {
      await page.setViewportSize({ width: options.minWidth, height: options.height });
      await page.goto(state.url);
      await state.prepare(page);
      for (let width = options.minWidth; width <= options.maxWidth; width++) {
        await page.setViewportSize({ width, height: options.height });
        await state.ready(page, width);
        await page.evaluate(settledDOM);
        const measurement = measurementShape.parse(await page.evaluate(measureDOM));
        assert(measurement.innerWidth === width, 'Viewport width differs from requested width');
        const { elements: _elements, ...viewport } = measurement;
        samples.push({
          state: state.name,
          url: page.url(),
          width,
          measurement: viewport,
          ...classifyWidth(measurement),
        });
      }
    }
    status = samples.some((sample) => sample.pageOverflow) ? 'failed' : 'passed';
    if (status === 'failed') {
      error = 'Page horizontal overflow';
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    // 部分計測は未完了の証拠として残し、掃引の成功にはしない。
  } finally {
    try {
      await file.writeFile(
        JSON.stringify(
          {
            status,
            error,
            target: options.testInfo && {
              projectName: options.testInfo.project.name,
              file: options.testInfo.file,
              line: options.testInfo.line,
              column: options.testInfo.column,
              title: options.testInfo.title,
            },
            source: options.source,
            browser: options.browser,
            conditions: options.conditions,
            limitations: options.limitations,
            minWidth: options.minWidth,
            maxWidth: options.maxWidth,
            height: options.height,
            states: options.states.map(({ name, url }) => ({ name, url })),
            tolerance: 1,
            samples,
          },
          null,
          2,
        ),
      );
    } finally {
      await file.close();
    }
  }
  assert(status === 'passed', `Width sweep ${status}: ${error}; evidence: ${options.output}`);
}
