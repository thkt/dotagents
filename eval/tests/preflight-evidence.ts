import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord } from '../../scripts/shared/values.ts';

// eval/README.mdのホスト提示版の接続契約。実Dockerの受入証拠ではない。
const scenarios = [
  'scoping',
  'initial',
  'boundaries',
  'command-failure',
  'missing-marker',
  'timeout',
  'interrupt',
];

export async function writePreflightEvidence(directory: string, plan: unknown) {
  assert(isRecord(plan) && isRecord(plan.config) && isRecord(plan.runner));
  assert(Array.isArray(plan.variants));
  const { outputDirectory: _output, preflightDirectory: _preflight, ...config } = plan.config;
  const identity = createHash('sha256')
    .update(
      JSON.stringify({
        config,
        sources: plan.runner.sourceHashes,
        launch: plan.effectiveLaunch,
        inputs: plan.variants.map((variant: unknown) => {
          assert(isRecord(variant));
          return variant.versions;
        }),
        corpus: plan.corpusHash,
      }),
    )
    .digest('hex');
  const fixture = await readFile(resolve(import.meta.dir, 'preflight.json'));
  const evidence = {
    manifest: {
      identity,
      modelFree: true,
      fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    },
    error: null,
    records: scenarios.map((scenario) => ({ scenario, status: 'passed' })),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'preflight.json'), JSON.stringify(evidence));
  return evidence;
}
