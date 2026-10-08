import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { completeSweep, sweepTargets, targetKey } from '../../ui/records.ts';

function record() {
  return {
    status: 'passed',
    error: '',
    source: 'commit + diff',
    browser: 'chromium mock',
    conditions: 'control',
    limitations: 'no browser',
    minWidth: 848,
    maxWidth: 852,
    height: 900,
    tolerance: 1,
    target: {
      file: '/repo/width.spec.ts',
      projectName: 'chromium',
      line: 5,
      column: 0,
      title: 'sweep',
    },
    states: [{ name: 'normal', url: 'https://example.test' }],
    samples: [848, 849, 850, 851, 852].map((width) => ({
      state: 'normal',
      url: 'https://example.test',
      width,
      measurement: { innerWidth: width, clientWidth: width, scrollWidth: width },
      pageOverflow: false,
      candidates: [
        {
          selector: '.child',
          left: 0,
          right: 1600,
          ancestors: [{ selector: '.scroll', overflowX: 'auto', left: 0, right: width }],
        },
      ],
    })),
  };
}

test('complete records preserve local candidates and reject incomplete or contradictory success', () => {
  expect(completeSweep(record())).toEqual(record().target);
  for (const field of ['source', 'browser', 'conditions', 'limitations', 'height', 'target']) {
    const value = record();
    Reflect.deleteProperty(value, field);
    expect(() => completeSweep(value)).toThrow(field);
  }
  for (const field of ['measurement', 'candidates', 'url']) {
    const value = record();
    Reflect.deleteProperty(value.samples[0] ?? {}, field);
    expect(() => completeSweep(value)).toThrow(field);
  }
  const overflow = record();
  const overflowSample = overflow.samples[0];
  assert(overflowSample);
  overflowSample.measurement.scrollWidth = 850;
  expect(() => completeSweep(overflow)).toThrow('Contradictory passed DOM measurement');
  const flag = record();
  const flagSample = flag.samples[0];
  assert(flagSample);
  flagSample.pageOverflow = true;
  expect(() => completeSweep(flag)).toThrow('pageOverflow');
  const duplicate = record();
  const state = duplicate.states[0];
  assert(state);
  duplicate.states.push(state);
  duplicate.samples.push(...structuredClone(duplicate.samples));
  expect(() => completeSweep(duplicate)).toThrow('Duplicate sweep state');
  const missing = record();
  const sample = missing.samples[0];
  assert(sample);
  missing.samples[1] = structuredClone(sample);
  expect(() => completeSweep(missing)).toThrow('Duplicate measured width');
  const invalid = record();
  invalid.height = 0;
  expect(() => completeSweep(invalid)).toThrow('height');
  const boundary = record();
  const candidate = boundary.samples[0]?.candidates[0];
  assert(candidate);
  candidate.right = 849;
  expect(() => completeSweep(boundary)).toThrow('Invalid candidate boundary');
});

test('selected targets include every test and project but exclude dependency setup files', () => {
  const spec = {
    file: 'width.spec.ts',
    line: 5,
    column: 0,
    title: 'sweep',
    tests: [{ projectName: 'chromium' }, { projectName: 'firefox' }],
  };
  const required = sweepTargets(
    {
      config: { rootDir: '/repo' },
      suites: [
        {
          suites: [
            {
              specs: [spec, { ...spec, file: 'setup.spec.ts', tests: [{ projectName: 'setup' }] }],
            },
          ],
        },
      ],
    },
    '/repo/width.spec.ts',
  );
  const chromium = targetKey(completeSweep(record()));
  const firefoxRecord = record();
  firefoxRecord.target.projectName = 'firefox';
  firefoxRecord.browser = 'firefox mock';
  const firefox = targetKey(completeSweep(firefoxRecord));
  expect([...required]).toEqual([chromium, firefox]);
  expect(required.size).toBe(2);
});
