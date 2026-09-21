import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { readReport, reportDestination } from './review-report-records.ts';
import { renderReport } from './review-report-html.ts';

export async function generateReviewReport(input: string, output: string) {
  const data = await readReport(input);
  const destination = await reportDestination(output, data.root);
  const html = await renderReport(data);
  await writeFile(destination, html, { flag: 'wx', mode: 0o600 });
  return { output: destination, warnings: data.warnings };
}

if (import.meta.main) {
  try {
    const [input, output, ...extra] = process.argv.slice(2);
    assert(
      input && output && !extra.length,
      'Usage: bun scripts/review-report.ts RUN/host/CASE/result.json /existing/external/directory/report.html',
    );
    console.log(JSON.stringify(await generateReviewReport(input, output), null, 2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
