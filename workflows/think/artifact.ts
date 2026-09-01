/** @file Outcome: One verified think decision has a canonical build-plan value and a readable durable view. */

import { atomicWrite, atomicWriteText, thinkArtifactDirectory } from '../shared/storage.ts';
import { artifactPaths } from '../shared/artifacts.ts';
import { oneLine } from '../shared/text.ts';
import { renderPlanMarkdown } from '../flow/build/authoring.ts';
import type { ThinkReport } from './contracts.ts';

/** Renders the verified JSON report without inventing claims or plan content. */
export function renderThinkMarkdown(report: ThinkReport): string {
  const japanese = report.language === 'japanese';
  const labels = japanese
    ? {
        title: '設計判断',
        decision: '決定',
        rationale: '理由',
        alternatives: '見送った案',
        evidence: '根拠',
        research: '追加調査',
        review: 'レビュー補足',
        next: '次の状態',
      }
    : {
        title: 'Design decision',
        decision: 'Decision',
        rationale: 'Rationale',
        alternatives: 'Alternatives',
        evidence: 'Evidence',
        research: 'Research required',
        review: 'Review notes',
        next: 'Next state',
      };
  const lines = [
    `# ${labels.title}: ${oneLine(report.request)}`,
    '',
    `- Generated: ${report.generated_at}`,
    `- Task type: ${report.task_type}`,
    `- Readiness: ${report.readiness}`,
    `- Repository HEAD: ${report.repository.head ?? 'unborn'}`,
    `- Working tree dirty: ${report.repository.dirty}`,
    '',
    '## Timings (ms)',
    '',
    ...Object.entries(report.timings).map(([stage, elapsed]) => `- ${stage}: ${elapsed}`),
    '',
    `## ${labels.decision}`,
    '',
    oneLine(report.decision),
    '',
    `## ${labels.rationale}`,
    '',
    report.rationale,
    '',
  ];
  if (report.alternatives.length) {
    lines.push(
      `## ${labels.alternatives}`,
      '',
      ...report.alternatives.map(
        (item) => `- ${oneLine(item.summary)} — ${oneLine(item.rejected_because)}`,
      ),
      '',
    );
  }
  if (report.evidence.length) {
    lines.push(
      `## ${labels.evidence}`,
      '',
      ...report.evidence.map((item) => {
        const reference =
          item.kind === 'research'
            ? `${item.source}#${item.locator}`
            : `${item.source}:${item.locator}`;
        return `- ${item.id} \`${reference}\` — ${oneLine(item.supports)}`;
      }),
      '',
    );
  }
  if (report.plan) lines.push(renderPlanMarkdown(report.plan, report.language).trimEnd(), '');
  if (report.research_questions.length) {
    lines.push(
      `## ${labels.research}`,
      '',
      ...report.research_questions.map((item) => `- ${oneLine(item)}`),
      '',
    );
  }
  if (report.review_notes.length) {
    lines.push(
      `## ${labels.review}`,
      '',
      ...report.review_notes.map((item) => `- ${oneLine(item)}`),
      '',
    );
  }
  lines.push(`## ${labels.next}`, '', report.next_step, '');
  return `${lines.join('\n')}\n`;
}

/** Writes a verified report beneath the repository's private think-artifact directory. */
export function persistThinkReport(
  repo: string,
  report: ThinkReport,
): { json: string; markdown: string } {
  const paths = artifactPaths(
    thinkArtifactDirectory(repo),
    report.request,
    new Date(report.generated_at),
    'think',
  );
  atomicWrite(paths.json, report);
  atomicWriteText(paths.markdown, renderThinkMarkdown(report));
  return paths;
}
