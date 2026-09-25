import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isRecord } from '../shared/values.ts';

try {
  const result = spawnSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve('fallow/bin/fallow'),
      'dead-code',
      '--unused-files',
      '--unused-exports',
      '--unused-types',
      '--unused-deps',
      '--circular-deps',
      '--fail-on-issues',
      '--format',
      'json',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  process.stderr.write(result.stderr ?? '');
  if (result.error) {
    throw result.error;
  }
  // Keep findings and error envelopes visible, including when the child fails.
  process.stdout.write(result.stdout);
  assert(result.status === 0, `fallow failed (${result.signal ?? result.status})`);
  const report: unknown = JSON.parse(result.stdout);
  assert(
    isRecord(report) && report.kind === 'dead-code' && Array.isArray(report.workspace_diagnostics),
    'Invalid fallow analysis report',
  );
  assert(
    !report.workspace_diagnostics.some(
      (diagnostic: unknown) => isRecord(diagnostic) && diagnostic.degrades_analysis === true,
    ),
    'Incomplete fallow analysis: inspect workspace_diagnostics',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
