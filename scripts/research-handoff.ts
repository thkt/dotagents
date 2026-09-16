import assert from 'node:assert/strict';
import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { relativeDirectory } from './input.ts';

type Git = (...args: string[]) => Promise<string>;
export interface ReportReference {
  path: string;
  blob: string;
}

export function reportReferences(inputs: string[]): ReportReference[] {
  const reports = inputs.map((input) => {
    const [path, blob, extra] = input.split('=');
    assert(
      path && relativeDirectory(path) && path.startsWith('research/') && path.endsWith('.md'),
      'Required report must be a repo-relative research/*.md path',
    );
    assert(
      blob && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob) && extra === undefined,
      `Expected reviewed Git blob ID: ${path}`,
    );
    return { path, blob };
  });
  assert(
    new Set(reports.map((report) => report.path)).size === reports.length,
    'Duplicate required report',
  );
  return reports;
}

export async function verifyReports(
  repo: string,
  base: string,
  reports: ReportReference[],
  git: Git,
) {
  for (const { path, blob } of reports) {
    const tree = await git('ls-tree', base, '--', path);
    assert(tree, `Required report is missing from start commit (not committed): ${path}`);
    assert(/^100(?:644|755) blob /.test(tree), `Required report must be a regular file: ${path}`);
    assert(tree.split(/\s/)[2] === blob, `Required report differs from reviewed version: ${path}`);
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

export async function researchHandoff(
  repo: string,
  base: string,
  startCommit: string | undefined,
  inputs: string[],
  git: Git,
) {
  assert(inputs.length === 0 || startCommit, 'Required reports need --start-commit');
  if (startCommit !== undefined) {
    assert(
      startCommit === base,
      'Start commit differs from handoff; reconcile the reviewed references',
    );
  }
  const reports = reportReferences(inputs);
  await verifyReports(repo, base, reports, git);
  return reports;
}
