/** @file Outcome: Every build action is derived, executed, and verified from controller-owned state. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { main as renderPrBody } from './pr-body.ts';
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
import { configuredCodexLanguage } from '../../shared/environment.ts';
import { FlowError, errorCode } from '../../shared/errors.ts';
import {
  gitOutput,
  gitText,
  nulPaths,
  repositoryInvariant,
  sameRepoSnapshot,
} from '../../shared/repository.ts';
import { isObject } from '../../shared/schema.ts';
import { atomicWrite, prBodyPath, prInputPath } from '../../shared/storage.ts';
import { textMatchesLanguage } from '../../shared/text.ts';

type ActionDirective = Extract<FlowDirective, { kind: 'run-action' }>;

export interface CommandInvocation {
  executable: string;
  args: string[];
}

export type CommandExecutor = (invocation: CommandInvocation) => void;

function execute({ executable, args }: CommandInvocation): void {
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
    case 'branch':
      return [
        {
          executable: 'git',
          args: [
            '-C',
            repo,
            'switch',
            '-c',
            directive.parameters.branch_name,
            directive.parameters.start_point,
          ],
        },
      ];
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
        {
          executable: 'gh',
          args: [
            'pr',
            'create',
            '--draft',
            '--repo',
            directive.parameters.repository,
            '--head',
            directive.parameters.branch,
            '--base',
            directive.parameters.base_branch,
            '--title',
            directive.parameters.title,
            '--body-file',
            directive.parameters.pr_body_path,
          ],
        },
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
        `Contract: ${planUnit.contract}`,
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
    remote: step.remote,
    repository: step.repository,
    branch: branch.branch_name,
    base_branch: step.base_branch,
    title: shellSafeText(state.build_plan.title),
    pr_input_path: prInputPath(state.run_id),
    pr_body_path: prBodyPath(state.run_id),
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
  const language = configuredCodexLanguage('japanese');
  if (!textMatchesLanguage(state.build_plan.title, language)) {
    throw new FlowError(
      `published issue title must match the configured Codex language: ${language}`,
      'decision_error',
    );
  }
  const currentReports = [
    ...new Map(state.gate_reports.map((report) => [report.gate_id, report])).values(),
  ];
  const upstream = currentReports.flatMap((report) =>
    report.evidence.kind === 'structured' ? [report.evidence.report] : [],
  );
  const values = (key: string): unknown[] =>
    upstream.flatMap((report) => (Array.isArray(report[key]) ? report[key] : []));
  const allPassed = currentReports.every((report) => report.verdict === 'pass');
  atomicWrite(prInputPath(state.run_id), {
    issue: state.build_plan.issue,
    tests_pass: allPassed,
    gates_pass: allPassed,
    scope_deviations: values('scope_deviations'),
    untouched_plan_files: values('untouched_plan_files'),
    missing_tests: values('missing_tests'),
    manual_checks: state.build_plan.manual_verification,
    advisories: [],
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
      break;
  }
}
