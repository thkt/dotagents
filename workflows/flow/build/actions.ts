/** @file Outcome: Every build action is derived, executed, and verified from controller-owned state. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { main as renderPrBody } from './pr-body.ts';
import { inspectDraftPullRequest } from './github.ts';
import { sealedScreenshotAttachments, validateSealedScreenshotAttachments } from './screenshots.ts';
import type {
  ActionParameters,
  ActionStep,
  ActorStep,
  BranchActionParameters,
  BranchActionStep,
  CommitActionParameters,
  FlowDirective,
  FlowState,
  RunActionDirective,
  ShipActionParameters,
  ShipActionStep,
  UnitActionStep,
} from '../contracts.ts';
import { shellSafeText } from '../../shared/command.ts';
import { FlowError, errorCode } from '../../shared/errors.ts';
import { githubPrCreate, runGitHub, type GitHubInvocation } from '../../shared/github.ts';
import { requireLanguageText, resolveConfiguredLanguage } from '../../shared/language.ts';
import {
  gitOutput,
  gitOptionalText,
  gitText,
  nulPaths,
  repositoryInvariant,
  sameRepoSnapshot,
} from '../../shared/repository.ts';
import { isObject } from '../../shared/schema.ts';
import { atomicWrite, prBodyPath, prInputPath } from '../../shared/storage.ts';

type ActionDirective = Extract<FlowDirective, { kind: 'run-action' }>;

interface GitInvocation {
  executable: 'git';
  args: string[];
}
export type CommandInvocation = GitInvocation | GitHubInvocation;

export type CommandExecutor = (invocation: CommandInvocation) => void;

function execute(invocation: CommandInvocation): void {
  if ('operation' in invocation) {
    runGitHub(invocation, 'build-ship');
    return;
  }
  const { executable, args } = invocation;
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new FlowError(
      `${executable} exited with ${result.status ?? 'no status'}${detail ? `: ${detail}` : ''}`,
      'execution_error',
    );
  }
}

/** Translates a typed action directive into the exact external commands it permits. */
export function actionInvocations(repo: string, directive: ActionDirective): CommandInvocation[] {
  switch (directive.action) {
    case 'branch': {
      const existing = gitOptionalText(repo, [
        'rev-parse',
        `refs/heads/${directive.parameters.branch_name}^{commit}`,
      ]);
      if (existing !== null && existing !== directive.parameters.start_point) {
        throw new FlowError('branch changed after manifest validation', 'state_error');
      }
      return [
        {
          executable: 'git',
          args:
            existing === directive.parameters.start_point
              ? ['-C', repo, 'switch', directive.parameters.branch_name]
              : [
                  '-C',
                  repo,
                  'switch',
                  '-c',
                  directive.parameters.branch_name,
                  directive.parameters.start_point,
                ],
        },
      ];
    }
    case 'commit':
      return [
        { executable: 'git', args: ['-C', repo, 'add', '--', ...directive.parameters.files] },
        {
          executable: 'git',
          args: [
            '-C',
            repo,
            'commit',
            '-m',
            directive.parameters.subject,
            ...directive.parameters.trailers.flatMap((trailer) => ['--trailer', trailer]),
          ],
        },
      ];
    case 'ship':
      return [
        {
          executable: 'git',
          args: [
            '-C',
            repo,
            'push',
            '--set-upstream',
            directive.parameters.remote,
            directive.parameters.branch,
          ],
        },
        githubPrCreate(
          directive.parameters.repository,
          directive.parameters.branch,
          directive.parameters.base_branch,
          directive.parameters.title,
          directive.parameters.pr_body_path,
          directive.parameters.attachments,
        ),
      ];
  }
}

/** Executes one controller-approved action without adding agent judgment. */
export function executeAction(
  repo: string,
  directive: ActionDirective,
  runCommand: CommandExecutor = execute,
): void {
  if (directive.action === 'ship') {
    validateSealedScreenshotAttachments(
      directive.parameters.run_id,
      directive.parameters.attachments,
    );
    renderPrBody([
      '--input',
      directive.parameters.pr_input_path,
      '--output',
      directive.parameters.pr_body_path,
    ]);
  }
  for (const invocation of actionInvocations(repo, directive)) runCommand(invocation);
}

function unitFiles(state: FlowState, unit: string): string[] {
  return [
    ...new Set(
      state.manifest.steps
        .filter(
          (step): step is ActorStep => step.kind === 'actor' && step.id.startsWith(`${unit}:`),
        )
        .flatMap((step) => step.files),
    ),
  ];
}

function branchAction(state: FlowState): BranchActionStep {
  const branch = state.manifest.steps.find(
    (step): step is BranchActionStep => step.kind === 'action' && step.action === 'branch',
  );
  if (!branch) throw new FlowError('build has no branch context', 'state_error');
  return branch;
}

function actionParameters(state: FlowState, step: BranchActionStep): BranchActionParameters;
function actionParameters(state: FlowState, step: UnitActionStep): CommitActionParameters;
function actionParameters(state: FlowState, step: ShipActionStep): ShipActionParameters;
function actionParameters(state: FlowState, step: ActionStep): ActionParameters;
function actionParameters(state: FlowState, step: ActionStep): ActionParameters {
  if (step.action === 'branch') {
    return { branch_name: step.branch_name, start_point: step.start_point };
  }
  if (!state.build_plan)
    throw new FlowError(`${step.id} has no validated Plan context`, 'state_error');
  if (step.action === 'commit') {
    const unit = /^(U-\d{3}):commit$/u.exec(step.id)?.[1];
    const planUnit = state.build_plan.units.find((candidate) => candidate.id === unit);
    if (!unit || !planUnit)
      throw new FlowError(`${step.id} has no validated Plan unit`, 'state_error');
    return {
      files: unitFiles(state, unit),
      subject: step.subject,
      trailers: [
        `Unit: ${unit}`,
        `Contract: ${shellSafeText(planUnit.contract)}`,
        ...(planUnit.tests.length
          ? [`Tests: ${planUnit.tests.map(({ id }) => id).join(', ')}`]
          : []),
        ...(planUnit.seam ? ['Seam: true'] : []),
        `Issue: #${state.build_plan.issue}`,
      ],
    };
  }
  const branch = branchAction(state);
  return {
    run_id: state.run_id,
    remote: step.remote,
    repository: step.repository,
    branch: branch.branch_name,
    base_branch: step.base_branch,
    title: state.build_plan.title,
    pr_input_path: prInputPath(state.run_id),
    pr_body_path: prBodyPath(state.run_id),
    attachments: sealedScreenshotAttachments(state),
  };
}

/** Derives the only action directive allowed for the current typed build step. */
export function actionDirective(state: FlowState, step: ActionStep): RunActionDirective {
  const common = { kind: 'run-action' as const, step_id: step.id };
  switch (step.action) {
    case 'branch':
      return { ...common, action: step.action, parameters: actionParameters(state, step) };
    case 'commit':
      return { ...common, action: step.action, parameters: actionParameters(state, step) };
    case 'ship':
      return { ...common, action: step.action, parameters: actionParameters(state, step) };
  }
}

/** Materializes the verified facts consumed by deterministic PR rendering. */
export function prepareShipInput(state: FlowState): void {
  if (!state.build_plan) throw new FlowError('ship has no validated Plan context', 'state_error');
  const language = resolveConfiguredLanguage('japanese');
  requireLanguageText(state.build_plan.title, language, 'published issue title');
  const currentReports = [
    ...new Map(state.gate_reports.map((report) => [report.gate_id, report])).values(),
  ];
  const upstream = currentReports.flatMap((report) =>
    report.evidence.kind === 'structured' ? [report.evidence.report] : [],
  );
  const values = (key: string): unknown[] =>
    upstream.flatMap((report) => (Array.isArray(report[key]) ? report[key] : []));
  const reviewAdvisories = values('findings').flatMap((finding) => {
    if (
      !isObject(finding) ||
      finding.severity !== 'advisory' ||
      typeof finding.code !== 'string' ||
      typeof finding.message !== 'string'
    ) {
      return [];
    }
    const files = Array.isArray(finding.files)
      ? finding.files.filter((file): file is string => typeof file === 'string')
      : [];
    return [`${finding.code}: ${finding.message}${files.length ? ` [${files.join(', ')}]` : ''}`];
  });
  const allPassed = currentReports.every((report) => report.verdict === 'pass');
  atomicWrite(prInputPath(state.run_id), {
    issue: state.build_plan.issue,
    tests_pass: allPassed,
    gates_pass: allPassed,
    scope_deviations: values('scope_deviations'),
    untouched_plan_files: values('untouched_plan_files'),
    missing_tests: values('missing_tests'),
    manual_checks: state.build_plan.manual_verification,
    screenshots: state.build_plan.screenshots ?? [],
    advisories: reviewAdvisories,
    verification_output: '',
    language,
  });
  try {
    fs.unlinkSync(prBodyPath(state.run_id));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/** Proves that a deterministic build action reached only its declared Git postcondition. */
export function validateActionCompletion(state: FlowState, step: ActionStep): void {
  if (!isObject(state.action_baseline))
    throw new FlowError(`${step.id} has no entry snapshot`, 'state_error');
  const current = repositoryInvariant(state.manifest.repo);
  switch (step.action) {
    case 'branch':
      if (current.branch !== step.branch_name || current.head !== step.start_point) {
        throw new FlowError(
          `${step.id} did not reach ${step.branch_name} at ${step.start_point}`,
          'postcondition_error',
        );
      }
      if (!sameRepoSnapshot(current.changes, state.workflow_baseline)) {
        throw new FlowError(
          `${step.id} changed the workflow baseline files`,
          'postcondition_error',
        );
      }
      break;
    case 'commit': {
      const unit = /^(U-\d{3}):commit$/u.exec(step.id)?.[1];
      if (!unit) throw new FlowError(`${step.id} is not a unit commit`, 'postcondition_error');
      if (current.head === state.action_baseline.head) {
        throw new FlowError(`${step.id} did not create a commit`, 'postcondition_error');
      }
      const parent = gitText(
        state.manifest.repo,
        ['rev-parse', 'HEAD^'],
        `${step.id} parent lookup`,
      );
      if (parent !== state.action_baseline.head) {
        throw new FlowError(
          `${step.id} must create exactly one commit on the verified HEAD`,
          'postcondition_error',
        );
      }
      const committed = nulPaths(
        gitOutput(
          state.manifest.repo,
          ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'],
          `${step.id} path lookup`,
        ),
      );
      const parameters = actionParameters(state, step);
      const allowed = new Set(parameters.files);
      const outside = committed.filter((relative) => !allowed.has(relative));
      if (!committed.length || outside.length) {
        throw new FlowError(
          `${step.id} committed paths outside its unit: ${outside.join(', ') || 'empty commit'}`,
          'scope_error',
        );
      }
      if (!sameRepoSnapshot(current.changes, state.workflow_baseline)) {
        throw new FlowError(
          `${step.id} did not restore the workflow baseline dirty state`,
          'postcondition_error',
        );
      }
      const expectedMessage = [parameters.subject, '', ...parameters.trailers].join('\n').trim();
      const actualMessage = gitText(
        state.manifest.repo,
        ['show', '-s', '--format=%B', 'HEAD'],
        `${step.id} message lookup`,
      );
      if (actualMessage !== expectedMessage) {
        throw new FlowError(
          `${step.id} commit message does not match its typed action contract`,
          'postcondition_error',
        );
      }
      break;
    }
    case 'ship':
      if (
        current.head !== state.action_baseline.head ||
        !sameRepoSnapshot(current.changes, state.workflow_baseline)
      ) {
        throw new FlowError('ship changed local commits or files', 'postcondition_error');
      }
      if (!shipPublicationCompleted(state, step, current.head)) {
        throw new FlowError(
          'ship did not publish the verified HEAD and expected draft pull request',
          'postcondition_error',
        );
      }
      break;
  }
}

function shipPublicationCompleted(
  state: FlowState,
  step: ShipActionStep,
  expectedHead: string | null,
): boolean {
  const branch = branchAction(state).branch_name;
  const remote = spawnSync(
    'git',
    ['-C', state.manifest.repo, 'ls-remote', '--exit-code', step.remote, `refs/heads/${branch}`],
    { encoding: 'utf8' },
  );
  const remoteHead = remote.stdout.trim().split(/\s+/u)[0];
  if (remote.status === 2) return false;
  if (remote.status !== 0) {
    const detail = (remote.stderr || remote.stdout || remote.error?.message || '').trim();
    throw new FlowError(
      `ship remote inspection failed${detail ? `: ${detail}` : ''}`,
      'external_error',
    );
  }
  if (remoteHead !== expectedHead) return false;
  const parameters = actionParameters(state, step);
  if (!fs.existsSync(parameters.pr_body_path)) {
    renderPrBody(['--input', parameters.pr_input_path, '--output', parameters.pr_body_path]);
  }
  const expectedBody = fs.readFileSync(parameters.pr_body_path, 'utf8');
  const inspection = inspectDraftPullRequest({
    repository: step.repository,
    branch,
    baseBranch: step.base_branch,
    title: parameters.title,
    body: expectedBody,
    screenshots: parameters.attachments.map(({ name, alt }) => ({ name, alt })),
  });
  if (inspection.status === 'mismatch') {
    throw new FlowError(inspection.error, 'postcondition_error');
  }
  return inspection.status === 'matched';
}

/** Detects a completed external action so a resumed controller does not repeat it. */
export function actionAlreadyCompleted(state: FlowState, step: ActionStep): boolean {
  if (!isObject(state.action_baseline)) {
    throw new FlowError(`${step.id} has no entry snapshot`, 'state_error');
  }
  const current = repositoryInvariant(state.manifest.repo);
  if (step.action === 'branch' && current.branch !== step.branch_name) return false;
  if (step.action === 'commit' && current.head === state.action_baseline.head) return false;
  if (step.action === 'ship') {
    if (
      current.head !== state.action_baseline.head ||
      !sameRepoSnapshot(current.changes, state.workflow_baseline)
    ) {
      validateActionCompletion(state, step);
    }
    return shipPublicationCompleted(state, step, current.head);
  }
  validateActionCompletion(state, step);
  return true;
}
