// Creates only public synthetic records and HTML, without a model, browser or server.
import { mkdtemp, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture } from './tests/support/review-report.ts';
import { generateReviewReport } from './review-report.ts';

if (import.meta.main) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-report-')));
  const records = join(root, 'records');
  const output = join(root, 'html');
  await mkdir(output);
  const reports = [];
  for (const mode of ['normal', 'pending', 'empty', 'stopped'] as const) {
    const fixture = await reportFixture(records, mode);
    reports.push(await generateReviewReport(fixture.input, join(output, `${mode}.html`)));
  }
  console.log(
    JSON.stringify(
      {
        root,
        reports,
        remaining:
          'Host browser verification and screenshots; these are synthetic records, not live evaluation evidence.',
      },
      null,
      2,
    ),
  );
}
