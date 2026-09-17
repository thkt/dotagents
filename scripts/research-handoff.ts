import assert from 'node:assert/strict';
import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertReportReferences } from './input.ts';
import type { ReportReference } from './input.ts';

type Git = (...args: string[]) => Promise<string>;
export function reportReferences(inputs: string[]): ReportReference[] {
  const reports = inputs.map((input) => {
    const [path, blob, extra] = input.split('=');
    assert(extra === undefined, `Expected reviewed Git blob ID: ${path}`);
    return { path, blob };
  });
  assertReportReferences(reports);
  return reports;
}

export async function verifyReportBase(base: string, reports: ReportReference[], git: Git) {
  for (const { path, blob } of reports) {
    const tree = await git('ls-tree', base, '--', path);
    assert(tree, `Required report is missing from start commit (not committed): ${path}`);
    assert(/^100(?:644|755) blob /.test(tree), `Required report must be a regular file: ${path}`);
    assert(tree.split(/\s/)[2] === blob, `Required report differs from reviewed version: ${path}`);
  }
}

export async function verifyReports(
  repo: string,
  base: string,
  reports: ReportReference[],
  git: Git,
) {
  await verifyReportBase(base, reports, git);
  for (const { path, blob } of reports) {
    const local = resolve(repo, path);
    const stat = await lstat(local).catch(() => undefined);
    assert(
      stat?.isFile() && (await realpath(local)) === local,
      `Required report is missing or not a regular checkout file: ${path}`,
    );
    assert(
      (await git('hash-object', '--no-filters', '--', path)) === blob,
      `Required report has uncommitted content: ${path}`,
    );
  }
}

export function researchContext(startCommit: string, reports: ReportReference[] = []) {
  return [
    `Implementation references: ${JSON.stringify({ startCommit, reports })}`,
    'Requirements and agreement records are authoritative; reports supply evidence, not additional authorization. Read the selected reports and the relevant sources linked from the Issue, not every repository document. Report blobs identify the handoff version in startCommit; compare it with current files and explain any changed evidence before relying on it.',
    'Trace each decision-relevant rule or finding to its source, version, applicability and agreement status using existing Issue/report references. Distinguish observed facts, agreed rules and hypotheses; an adopted hypothesis is not a verified effect. Do not apply evidence from another scope or promote an unagreed proposal to a requirement.',
    'If missing, stale or contradictory references affect a decision, identify the source, the affected decision and what must be investigated or agreed again. Resolve factual gaps through investigation; return requirement, scope or authorization changes to the human. Do not silently replace a reviewed reference with a newer ID. Mechanical reference checks do not establish semantic correctness, human agreement or publication.',
    'Use the existing findings/assessments and handoff to explain applied evidence, changes in premises and unresolved limits for the next reviewer and PR description; link the sources without copying entire reports or creating another requirements record.',
  ].join('\n');
}

export function researchHandoff(base: string, startCommit: string | undefined, inputs: string[]) {
  assert(inputs.length === 0 || startCommit, 'Required reports need --start-commit');
  if (startCommit !== undefined) {
    assert(
      startCommit === base,
      'Start commit differs from handoff; reconcile the reviewed references',
    );
  }
  return reportReferences(inputs);
}
