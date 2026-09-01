/** @file Outcome: Research inputs and agent results cross runtime boundaries only as closed, typed evidence. */

import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError } from '../shared/errors.ts';
import { gitRoot, normalizeRepoPath, realpathInside } from '../shared/repository.ts';
import { isObject, rejectUnknownKeys, stringArray, type JsonObject } from '../shared/schema.ts';
import { parseStageTimings, type StageTimings } from '../shared/codex.ts';

export const RESEARCH_INPUT_PROTOCOL = 'codex-research-input/v1' as const;
export const RESEARCH_REPORT_PROTOCOL = 'codex-research-report/v3' as const;
export const RESEARCH_RESULT_PROTOCOL = 'codex-research-result/v1' as const;
export const RESEARCH_DESCRIPTION_PROTOCOL = 'codex-research-description/v1' as const;

export type ResearchMode = 'understand' | 'plan' | 'diagnose';
export type ExternalSources = 'none' | 'primary' | 'broad';
export type ResearchLanguage = 'english' | 'japanese';
export type EvidenceKind = 'repository' | 'web';
export type FindingKind = 'fact' | 'inference';
export type Confidence = 'high' | 'medium' | 'low';
export type ResearchNextStep = 'think' | 'fix' | 'complete';

const LINE_LOCATOR = /^L\d+(?:-L?\d+)?$/u;
const NEXT_STEP_BY_MODE: Record<ResearchMode, ResearchNextStep> = {
  understand: 'complete',
  plan: 'think',
  diagnose: 'fix',
};

/** Maps a research purpose to its only valid handoff state. */
export function researchNextStep(mode: ResearchMode): ResearchNextStep {
  return NEXT_STEP_BY_MODE[mode];
}

export interface ResearchInput {
  protocol: typeof RESEARCH_INPUT_PROTOCOL;
  repo: string;
  question: string;
  mode: ResearchMode;
  scope_paths: string[];
  external_sources: ExternalSources;
  language: ResearchLanguage;
}

export interface ResearchEvidence {
  kind: EvidenceKind;
  source: string;
  locator: string;
  supports: string;
}

export interface RepositoryReportEvidence extends ResearchEvidence {
  kind: 'repository';
  source_sha256: string;
}

export interface WebReportEvidence extends ResearchEvidence {
  kind: 'web';
}

export type ResearchReportEvidence = RepositoryReportEvidence | WebReportEvidence;

export interface ResearchDraftFinding {
  statement: string;
  kind: FindingKind;
  evidence: ResearchEvidence[];
  implication: string;
}

export interface ResearchUnknown {
  question: string;
  resolution: string;
}

export interface ResearchDraft {
  findings: ResearchDraftFinding[];
  unknowns: ResearchUnknown[];
}

export interface AuditedFinding extends ResearchDraftFinding {
  confidence: Confidence;
  qualification: string | null;
}

export interface ResearchReportFinding extends Omit<AuditedFinding, 'evidence'> {
  id: string;
  evidence: ResearchReportEvidence[];
}

export interface RejectedFinding {
  statement: string;
  reason: string;
}

export interface ResearchAudit {
  answer: string;
  findings: AuditedFinding[];
  rejected: RejectedFinding[];
  unknowns: ResearchUnknown[];
  limitations: string[];
}

export interface ResearchReport extends Omit<ResearchAudit, 'findings'> {
  protocol: typeof RESEARCH_REPORT_PROTOCOL;
  generated_at: string;
  question: string;
  mode: ResearchMode;
  language: ResearchLanguage;
  scope_paths: string[];
  external_sources: ExternalSources;
  repository: {
    head: string | null;
    dirty: boolean;
  };
  findings: ResearchReportFinding[];
  next_step: ResearchNextStep;
  timings: StageTimings;
}

const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['repository', 'web'] },
    source: { type: 'string' },
    locator: { type: 'string' },
    supports: { type: 'string' },
  },
  required: ['kind', 'source', 'locator', 'supports'],
  additionalProperties: false,
} as const;

const UNKNOWN_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    resolution: { type: 'string' },
  },
  required: ['question', 'resolution'],
  additionalProperties: false,
} as const;

export const RESEARCH_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'inference'] },
          evidence: { type: 'array', items: EVIDENCE_SCHEMA },
          implication: { type: 'string' },
        },
        required: ['statement', 'kind', 'evidence', 'implication'],
        additionalProperties: false,
      },
    },
    unknowns: { type: 'array', items: UNKNOWN_SCHEMA },
  },
  required: ['findings', 'unknowns'],
  additionalProperties: false,
} as const;

export const RESEARCH_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'inference'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          qualification: { type: ['string', 'null'] },
          evidence: { type: 'array', items: EVIDENCE_SCHEMA },
          implication: { type: 'string' },
        },
        required: ['statement', 'kind', 'confidence', 'qualification', 'evidence', 'implication'],
        additionalProperties: false,
      },
    },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        properties: { statement: { type: 'string' }, reason: { type: 'string' } },
        required: ['statement', 'reason'],
        additionalProperties: false,
      },
    },
    unknowns: { type: 'array', items: UNKNOWN_SCHEMA },
    limitations: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'findings', 'rejected', 'unknowns', 'limitations'],
  additionalProperties: false,
} as const;

function requiredString(value: unknown, label: string, code = 'usage_error'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FlowError(`${label} must be a non-empty string`, code);
  }
  return value.trim();
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
  code = 'usage_error',
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new FlowError(`${label} must be ${values.join(', ')}`, code);
  }
  return value as T;
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new FlowError(`${label} must be an array of objects`, 'execution_error');
  }
  return value;
}

function validateScopePath(repo: string, value: string, label: string): string {
  const relative = normalizeRepoPath(value);
  if (!relative) throw new FlowError(`${label} must be a repo-relative path outside .git`);
  const absolute = path.resolve(repo, relative);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stat ||
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    !realpathInside(repo, absolute)
  ) {
    throw new FlowError(`${label} must name an existing file or directory inside the repository`);
  }
  return relative;
}

/** Validates the caller-authored research boundary before any agent starts. */
export function validateResearchInput(raw: unknown): ResearchInput {
  if (!isObject(raw) || raw.protocol !== RESEARCH_INPUT_PROTOCOL) {
    throw new FlowError(`research input.protocol must be ${RESEARCH_INPUT_PROTOCOL}`);
  }
  rejectUnknownKeys(
    raw,
    ['protocol', 'repo', 'question', 'mode', 'scope_paths', 'external_sources', 'language'],
    'research input',
  );
  if (typeof raw.repo !== 'string' || !path.isAbsolute(raw.repo)) {
    throw new FlowError('research input.repo must be absolute');
  }
  const repo = gitRoot(raw.repo, 'research input.repo must be a Git worktree');
  if (fs.realpathSync(raw.repo) !== repo)
    throw new FlowError('research input.repo must equal the Git root');
  const question = requiredString(raw.question, 'research input.question');
  const mode = enumValue(
    raw.mode,
    ['understand', 'plan', 'diagnose'] as const,
    'research input.mode',
  );
  const scopePaths = stringArray(raw.scope_paths, 'research input.scope_paths').map(
    (value, index) => validateScopePath(repo, value, `research input.scope_paths[${index}]`),
  );
  return {
    protocol: RESEARCH_INPUT_PROTOCOL,
    repo,
    question,
    mode,
    scope_paths: [...new Set(scopePaths)],
    external_sources: enumValue(
      raw.external_sources,
      ['none', 'primary', 'broad'] as const,
      'research input.external_sources',
    ),
    language: enumValue(raw.language, ['english', 'japanese'] as const, 'research input.language'),
  };
}

function parseEvidence(raw: JsonObject, label: string): ResearchEvidence {
  rejectUnknownKeys(raw, ['kind', 'source', 'locator', 'supports'], label, 'execution_error');
  return {
    kind: enumValue(raw.kind, ['repository', 'web'] as const, `${label}.kind`, 'execution_error'),
    source: requiredString(raw.source, `${label}.source`, 'execution_error'),
    locator: requiredString(raw.locator, `${label}.locator`, 'execution_error'),
    supports: requiredString(raw.supports, `${label}.supports`, 'execution_error'),
  };
}

function parseReportEvidence(raw: JsonObject, label: string): ResearchReportEvidence {
  const kind = enumValue(
    raw.kind,
    ['repository', 'web'] as const,
    `${label}.kind`,
    'execution_error',
  );
  const keys =
    kind === 'repository'
      ? ['kind', 'source', 'locator', 'supports', 'source_sha256']
      : ['kind', 'source', 'locator', 'supports'];
  rejectUnknownKeys(raw, keys, label, 'execution_error');
  const evidence = {
    kind,
    source: requiredString(raw.source, `${label}.source`, 'execution_error'),
    locator: requiredString(raw.locator, `${label}.locator`, 'execution_error'),
    supports: requiredString(raw.supports, `${label}.supports`, 'execution_error'),
  };
  if (kind === 'web') {
    try {
      if (new URL(evidence.source).protocol !== 'https:') throw new Error('not HTTPS');
    } catch {
      throw new FlowError(`${label}.source must be an HTTPS URL`, 'execution_error');
    }
    return { ...evidence, kind: 'web' };
  }
  const normalized = normalizeRepoPath(evidence.source);
  if (!normalized || normalized !== evidence.source || !LINE_LOCATOR.test(evidence.locator)) {
    throw new FlowError(
      `${label} must contain a normalized repository path and line locator`,
      'execution_error',
    );
  }
  const sourceSha256 = requiredString(
    raw.source_sha256,
    `${label}.source_sha256`,
    'execution_error',
  );
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) {
    throw new FlowError(
      `${label}.source_sha256 must be a lowercase SHA-256 digest`,
      'execution_error',
    );
  }
  return { ...evidence, kind: 'repository', source_sha256: sourceSha256 };
}

function parseUnknown(raw: JsonObject, label: string): ResearchUnknown {
  rejectUnknownKeys(raw, ['question', 'resolution'], label, 'execution_error');
  return {
    question: requiredString(raw.question, `${label}.question`, 'execution_error'),
    resolution: requiredString(raw.resolution, `${label}.resolution`, 'execution_error'),
  };
}

function parseFindingContent<T extends ResearchEvidence>(
  raw: JsonObject,
  label: string,
  parseItem: (value: JsonObject, itemLabel: string) => T,
): Omit<ResearchDraftFinding, 'evidence'> & { evidence: T[] } {
  const evidence = objectArray(raw.evidence, `${label}.evidence`).map((item, index) =>
    parseItem(item, `${label}.evidence[${index}]`),
  );
  if (!evidence.length)
    throw new FlowError(`${label}.evidence must not be empty`, 'execution_error');
  return {
    statement: requiredString(raw.statement, `${label}.statement`, 'execution_error'),
    kind: enumValue(raw.kind, ['fact', 'inference'] as const, `${label}.kind`, 'execution_error'),
    evidence,
    implication: requiredString(raw.implication, `${label}.implication`, 'execution_error'),
  };
}

function parseFinding(raw: JsonObject, label: string): ResearchDraftFinding {
  rejectUnknownKeys(
    raw,
    ['statement', 'kind', 'evidence', 'implication'],
    label,
    'execution_error',
  );
  return parseFindingContent(raw, label, parseEvidence);
}

function parseAuditedFinding<T extends ResearchEvidence>(
  raw: JsonObject,
  label: string,
  parseItem: (value: JsonObject, itemLabel: string) => T,
): Omit<AuditedFinding, 'evidence'> & { evidence: T[] } {
  const finding = parseFindingContent(raw, label, parseItem);
  return {
    ...finding,
    confidence: enumValue(
      raw.confidence,
      ['high', 'medium', 'low'] as const,
      `${label}.confidence`,
      'execution_error',
    ),
    qualification:
      raw.qualification === null
        ? null
        : requiredString(raw.qualification, `${label}.qualification`, 'execution_error'),
  };
}

function parseRejected(raw: JsonObject, label: string): RejectedFinding {
  rejectUnknownKeys(raw, ['statement', 'reason'], label, 'execution_error');
  return {
    statement: requiredString(raw.statement, `${label}.statement`, 'execution_error'),
    reason: requiredString(raw.reason, `${label}.reason`, 'execution_error'),
  };
}

/** Parses investigator output without relying on TypeScript casts or prompt compliance. */
export function parseResearchDraft(raw: unknown): ResearchDraft {
  if (!isObject(raw))
    throw new FlowError('research investigator returned an invalid object', 'execution_error');
  rejectUnknownKeys(raw, ['findings', 'unknowns'], 'research draft', 'execution_error');
  return {
    findings: objectArray(raw.findings, 'research draft.findings').map((item, index) =>
      parseFinding(item, `research draft.findings[${index}]`),
    ),
    unknowns: objectArray(raw.unknowns, 'research draft.unknowns').map((item, index) =>
      parseUnknown(item, `research draft.unknowns[${index}]`),
    ),
  };
}

/** Parses independent audit output into the only shape allowed to become an artifact. */
export function parseResearchAudit(raw: unknown): ResearchAudit {
  if (!isObject(raw))
    throw new FlowError('research auditor returned an invalid object', 'execution_error');
  rejectUnknownKeys(
    raw,
    ['answer', 'findings', 'rejected', 'unknowns', 'limitations'],
    'research audit',
    'execution_error',
  );
  const findings = objectArray(raw.findings, 'research audit.findings').map((item, index) => {
    const label = `research audit.findings[${index}]`;
    rejectUnknownKeys(
      item,
      ['statement', 'kind', 'confidence', 'qualification', 'evidence', 'implication'],
      label,
      'execution_error',
    );
    return parseAuditedFinding(item, label, parseEvidence);
  });
  const rejected = objectArray(raw.rejected, 'research audit.rejected').map((item, index) =>
    parseRejected(item, `research audit.rejected[${index}]`),
  );
  return {
    answer: requiredString(raw.answer, 'research audit.answer', 'execution_error'),
    findings,
    rejected,
    unknowns: objectArray(raw.unknowns, 'research audit.unknowns').map((item, index) =>
      parseUnknown(item, `research audit.unknowns[${index}]`),
    ),
    limitations: stringArray(raw.limitations, 'research audit.limitations', 'execution_error'),
  };
}

/** Parses a persisted report so downstream workflows consume the same closed contract that research writes. */
export function parseResearchReport(raw: unknown): ResearchReport {
  if (!isObject(raw) || raw.protocol !== RESEARCH_REPORT_PROTOCOL) {
    throw new FlowError(
      `research report.protocol must be ${RESEARCH_REPORT_PROTOCOL}`,
      'execution_error',
    );
  }
  rejectUnknownKeys(
    raw,
    [
      'protocol',
      'generated_at',
      'question',
      'mode',
      'language',
      'scope_paths',
      'external_sources',
      'repository',
      'answer',
      'findings',
      'rejected',
      'unknowns',
      'limitations',
      'next_step',
      'timings',
    ],
    'research report',
    'execution_error',
  );
  const generatedAt = requiredString(
    raw.generated_at,
    'research report.generated_at',
    'execution_error',
  );
  if (
    Number.isNaN(Date.parse(generatedAt)) ||
    new Date(generatedAt).toISOString() !== generatedAt
  ) {
    throw new FlowError(
      'research report.generated_at must be a canonical ISO timestamp',
      'execution_error',
    );
  }
  const mode = enumValue(
    raw.mode,
    ['understand', 'plan', 'diagnose'] as const,
    'research report.mode',
    'execution_error',
  );
  const timingsValue = raw.timings;
  const timings = parseStageTimings(timingsValue, 'research report.timings', 'execution_error');
  const nextStep = enumValue(
    raw.next_step,
    ['think', 'fix', 'complete'] as const,
    'research report.next_step',
    'execution_error',
  );
  if (nextStep !== researchNextStep(mode)) {
    throw new FlowError('research report.next_step does not match mode', 'execution_error');
  }
  if (!isObject(raw.repository)) {
    throw new FlowError('research report.repository must be an object', 'execution_error');
  }
  rejectUnknownKeys(
    raw.repository,
    ['head', 'dirty'],
    'research report.repository',
    'execution_error',
  );
  const repositoryHead = raw.repository.head;
  if (
    repositoryHead !== null &&
    (typeof repositoryHead !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(repositoryHead))
  ) {
    throw new FlowError(
      'research report.repository.head must be a Git object id or null',
      'execution_error',
    );
  }
  if (typeof raw.repository.dirty !== 'boolean') {
    throw new FlowError('research report.repository.dirty must be boolean', 'execution_error');
  }
  const findings = objectArray(raw.findings, 'research report.findings').map((item, index) => {
    const label = `research report.findings[${index}]`;
    rejectUnknownKeys(
      item,
      ['id', 'statement', 'kind', 'confidence', 'qualification', 'evidence', 'implication'],
      label,
      'execution_error',
    );
    const id = requiredString(item.id, `${label}.id`, 'execution_error');
    if (!/^F-\d{3}$/u.test(id)) throw new FlowError(`${label}.id is invalid`, 'execution_error');
    return {
      id,
      ...parseAuditedFinding(item, label, parseReportEvidence),
    };
  });
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    throw new FlowError('research report finding ids must be unique', 'execution_error');
  }
  const scopePaths = stringArray(raw.scope_paths, 'research report.scope_paths', 'execution_error');
  if (scopePaths.some((source) => normalizeRepoPath(source) !== source)) {
    throw new FlowError(
      'research report.scope_paths must contain normalized repository paths',
      'execution_error',
    );
  }
  const externalSources = enumValue(
    raw.external_sources,
    ['none', 'primary', 'broad'] as const,
    'research report.external_sources',
    'execution_error',
  );
  if (
    externalSources === 'none' &&
    findings.some((finding) => finding.evidence.some((evidence) => evidence.kind === 'web'))
  ) {
    throw new FlowError(
      'research report contains web evidence while external sources are disabled',
      'execution_error',
    );
  }
  const unknowns = objectArray(raw.unknowns, 'research report.unknowns').map((item, index) =>
    parseUnknown(item, `research report.unknowns[${index}]`),
  );
  if (!findings.length && !unknowns.length) {
    throw new FlowError(
      'research report must contain a finding or an explicit unknown',
      'execution_error',
    );
  }
  return {
    protocol: RESEARCH_REPORT_PROTOCOL,
    generated_at: generatedAt,
    question: requiredString(raw.question, 'research report.question', 'execution_error'),
    mode,
    language: enumValue(
      raw.language,
      ['english', 'japanese'] as const,
      'research report.language',
      'execution_error',
    ),
    scope_paths: scopePaths,
    external_sources: externalSources,
    repository: { head: repositoryHead, dirty: raw.repository.dirty },
    answer: requiredString(raw.answer, 'research report.answer', 'execution_error'),
    findings,
    rejected: objectArray(raw.rejected, 'research report.rejected').map((item, index) =>
      parseRejected(item, `research report.rejected[${index}]`),
    ),
    unknowns,
    limitations: stringArray(raw.limitations, 'research report.limitations', 'execution_error'),
    next_step: nextStep,
    timings,
  };
}
