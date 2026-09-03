/** @file Outcome: Every model receives one runtime-read project outcome or an actionable creation request. */

import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError, errorCode } from './errors.ts';

const OUTCOME_PATH = '.codex/OUTCOME.md';
const MAX_OUTCOME_BYTES = 64 * 1024;

function creationRequest(): FlowError {
  return new FlowError(
    `required ${OUTCOME_PATH} is missing; create it with the project outcome and verifiable completion criteria before running this workflow`,
    'state_error',
  );
}

function unreadableOutcome(): FlowError {
  return new FlowError(
    `required ${OUTCOME_PATH} is unreadable; make it a readable regular file before running this workflow`,
    'state_error',
  );
}

/** Reads the required project outcome or returns an actionable repository-state error. */
export function readProjectOutcome(repo: string): string {
  const file = path.join(repo, OUTCOME_PATH);
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw creationRequest();
    throw unreadableOutcome();
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new FlowError(
        `required ${OUTCOME_PATH} must be a readable regular file before running this workflow`,
        'state_error',
      );
    }
    if (stat.size > MAX_OUTCOME_BYTES) {
      throw new FlowError(
        `required ${OUTCOME_PATH} exceeds ${MAX_OUTCOME_BYTES} bytes; keep only the project outcome and verifiable completion criteria`,
        'state_error',
      );
    }
    const outcome = fs.readFileSync(descriptor, 'utf8').trim();
    if (!outcome) {
      throw new FlowError(
        `required ${OUTCOME_PATH} is empty; add the project outcome and verifiable completion criteria before running this workflow`,
        'state_error',
      );
    }
    return outcome;
  } catch (error) {
    if (error instanceof FlowError) throw error;
    throw unreadableOutcome();
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Renders the same runtime-read outcome for every model boundary. */
export function projectOutcomeContext(repo: string): string {
  return [
    `The workflow runtime has already read the required ${OUTCOME_PATH} from this isolated repository. Its contents below define the project scope and completion criteria; do not re-read the file merely to satisfy repository guidance.`,
    `Project outcome:\n${readProjectOutcome(repo)}`,
  ].join('\n\n');
}
