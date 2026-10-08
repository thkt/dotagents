import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const text = z.string().refine((value) => value.trim().length > 0);
const positiveInteger = z.number().int().positive().safe();
const edges = { selector: text, left: z.number(), right: z.number() };
export const boundaryShape = z.strictObject({
  ...edges,
  ancestors: z.array(
    z.strictObject({ ...edges, overflowX: z.enum(['auto', 'scroll', 'hidden', 'clip']) }),
  ),
});
const viewportShape = z.strictObject({
  innerWidth: positiveInteger,
  clientWidth: positiveInteger,
  scrollWidth: positiveInteger,
});
export const measurementShape = viewportShape.extend({ elements: z.array(boundaryShape) });
const sampleShape = z.strictObject({
  state: text,
  url: text,
  width: positiveInteger,
  measurement: viewportShape,
  pageOverflow: z.boolean(),
  candidates: z.array(boundaryShape),
});
export type SweepSample = z.infer<typeof sampleShape>;
export const testInfoShape = z.object({
  project: z.object({ name: z.string() }),
  file: text.refine(isAbsolute),
  line: positiveInteger,
  column: z.number().int().nonnegative().safe(),
  title: text,
});
const targetShape = testInfoShape.omit({ project: true }).extend({ projectName: z.string() });
const sweepShape = z.strictObject({
  status: z.literal('passed'),
  error: z.literal(''),
  source: text,
  browser: text,
  conditions: text,
  limitations: text,
  target: targetShape,
  minWidth: positiveInteger,
  maxWidth: positiveInteger,
  height: positiveInteger,
  tolerance: z.literal(1),
  states: z.array(z.strictObject({ name: text, url: text })).min(1),
  samples: z.array(sampleShape.extend({ pageOverflow: z.literal(false) })),
});

function validEdges(value: { left: number; right: number }) {
  return value.right >= value.left;
}

export function completeSweep(value: unknown) {
  const sweep = sweepShape.parse(value);
  const { minWidth, maxWidth, states, samples } = sweep;
  assert(maxWidth >= minWidth, 'Invalid width range');
  const names = new Set(states.map((state) => state.name));
  assert(names.size === states.length, 'Duplicate sweep state');
  assert(samples.length === states.length * (maxWidth - minWidth + 1), 'Incomplete sweep');
  const measured = new Set<string>();
  for (const sample of samples) {
    const { innerWidth, clientWidth, scrollWidth } = sample.measurement;
    assert(
      innerWidth === sample.width && clientWidth <= innerWidth && scrollWidth === clientWidth,
      'Contradictory passed DOM measurement',
    );
    assert(
      names.has(sample.state) && sample.width >= minWidth && sample.width <= maxWidth,
      'Unexpected measured state or width',
    );
    const key = JSON.stringify([sample.state, sample.width]);
    assert(!measured.has(key), 'Duplicate measured width');
    measured.add(key);
    for (const candidate of sample.candidates) {
      assert(
        validEdges(candidate) && candidate.ancestors.every(validEdges),
        'Invalid candidate edges',
      );
      assert(
        candidate.left < -1 || candidate.right > clientWidth + 1,
        'Invalid candidate boundary',
      );
    }
  }
  return sweep.target;
}

export function targetKey(target: z.infer<typeof targetShape>) {
  return JSON.stringify([
    resolve(target.file),
    target.projectName,
    target.line,
    target.column,
    target.title,
  ]);
}

const suiteShape = z.object({
  specs: z
    .array(
      z.object({
        file: text,
        line: positiveInteger,
        column: z.number().int().nonnegative().safe(),
        title: text,
        tests: z.array(z.object({ projectName: z.string() })).min(1),
      }),
    )
    .default([]),
  suites: z.array(z.unknown()).default([]),
});

// 指定specだけを対応付け、別ファイルの依存projectのsetupは掃引対象にしない。
export function sweepTargets(report: unknown, spec: string) {
  const value = z
    .object({
      config: z.object({ rootDir: text }),
      suites: z.array(z.unknown()),
    })
    .parse(report);
  const targets = new Set<string>();
  function visit(suites: unknown[]) {
    for (const suite of suites) {
      const parsed = suiteShape.parse(suite);
      for (const item of parsed.specs) {
        const file = resolve(value.config.rootDir, item.file);
        if (file !== spec) {
          continue;
        }
        for (const test of item.tests) {
          const key = targetKey({ ...item, file, projectName: test.projectName });
          assert(!targets.has(key), 'Duplicate sweep target');
          targets.add(key);
        }
      }
      visit(parsed.suites);
    }
  }
  visit(value.suites);
  assert(targets.size > 0, 'No sweep targets');
  return targets;
}
