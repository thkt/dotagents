/** @file Outcome: Research and Think share one presentation-independent pending-question and answer-delta contract. */
/**
 * The shared, presentation-independent clarification protocol.
 *
 * This module deliberately knows nothing about a host question UI.  Hosts may
 * decorate these values while displaying them, but persistence and routing use
 * this exact value.  Keeping the protocol here also prevents Research and
 * Think from growing subtly different clarification lifecycles.
 */
import { FlowError } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys, requiredString } from '../shared/schema.ts';

export interface ClarificationChoice {
  label: string;
  description: string;
}

export interface PendingQuestion {
  id: string;
  prompt: string;
  choices: ClarificationChoice[];
  recommendation: string | null;
}

export interface ClarificationAnswer {
  owner: ClarificationOwner;
  question_id: string;
  prompt: string;
  choices: ClarificationChoice[];
  recommendation: string | null;
  selection: string | null;
  answer: string | null;
}

export interface ClarificationBinding {
  task: string;
  repo: string;
  workflow: string;
  root: string;
  leaf: string;
  snapshot: string;
  candidate: string;
  review: string;
  dispatch: string;
}

/** The immutable owner binding travels with a pending question, never through UI data. */
export interface ClarificationOwner extends ClarificationBinding {
  permissions: string;
  selected_context: string;
  handoff: string;
}

const nonblank = (value: unknown, label: string): string => {
  requiredString(value, label);
  return value as string; // Preserve displayed context and free text verbatim.
};

function choices(value: unknown): ClarificationChoice[] {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3))
    throw new FlowError('clarification choices must contain two or three choices');
  const result = value.map((item, index) => {
    if (!isObject(item)) throw new FlowError(`clarification choice ${index} must be an object`);
    rejectUnknownKeys(item, ['label', 'description'], `clarification choice ${index}`);
    return {
      label: nonblank(item.label, `clarification choice ${index}.label`),
      description: nonblank(item.description, `clarification choice ${index}.description`),
    };
  });
  const labels = result.map((item) => item.label.trim());
  if (new Set(labels).size !== labels.length)
    throw new FlowError('clarification labels must be distinct');
  return result;
}

export function parsePendingQuestion(value: unknown): PendingQuestion {
  if (!isObject(value)) throw new FlowError('pending question must be an object');
  rejectUnknownKeys(value, ['id', 'prompt', 'choices', 'recommendation'], 'pending question');
  const result = {
    id: nonblank(value.id, 'pending question.id'),
    prompt: nonblank(value.prompt, 'pending question.prompt'),
    choices: choices(value.choices),
    recommendation:
      value.recommendation === undefined || value.recommendation === null
        ? null
        : nonblank(value.recommendation, 'pending question.recommendation'),
  };
  if (
    result.recommendation !== null &&
    !result.choices.some((item) => item.label === result.recommendation)
  )
    throw new FlowError('pending question recommendation must name a listed choice');
  return result;
}

export function parseClarificationAnswer(value: unknown): ClarificationAnswer {
  if (!isObject(value)) throw new FlowError('clarification answer must be an object');
  rejectUnknownKeys(
    value,
    ['owner', 'question_id', 'prompt', 'choices', 'recommendation', 'selection', 'answer'],
    'clarification answer',
  );
  if (!Object.hasOwn(value, 'recommendation') || value.recommendation === undefined)
    throw new FlowError('clarification answer must preserve recommendation');
  const selection =
    value.selection === null ? null : nonblank(value.selection, 'clarification answer.selection');
  const answer =
    value.answer === null ? null : nonblank(value.answer, 'clarification answer.answer');
  if ((selection === null) === (answer === null))
    throw new FlowError('answer must contain exactly one selection or free-text answer');
  const result = {
    owner: parseClarificationOwner(value.owner),
    question_id: nonblank(value.question_id, 'clarification answer.question_id'),
    prompt: nonblank(value.prompt, 'clarification answer.prompt'),
    choices: choices(value.choices),
    recommendation:
      value.recommendation === undefined || value.recommendation === null
        ? null
        : nonblank(value.recommendation, 'clarification answer.recommendation'),
    selection,
    answer,
  };
  if (
    result.recommendation !== null &&
    !result.choices.some((item) => item.label === result.recommendation)
  )
    throw new FlowError('clarification answer recommendation must name a listed choice');
  if (selection !== null && !result.choices.some((item) => item.label === selection))
    throw new FlowError('clarification selection must name a listed choice');
  return result;
}

export function answerForQuestion(question: PendingQuestion, value: unknown): ClarificationAnswer {
  question = parsePendingQuestion(question);
  const answer = parseClarificationAnswer(value);
  if (
    answer.question_id !== question.id ||
    answer.prompt !== question.prompt ||
    !sameValue(answer.choices, question.choices) ||
    answer.recommendation !== question.recommendation
  )
    throw new FlowError('clarification answer does not exactly match its pending question');
  return answer;
}

export function validateAnswerDelta(
  pending: PendingQuestion,
  history: readonly ClarificationAnswer[],
  additions: readonly ClarificationAnswer[],
  expectedOwner: ClarificationOwner,
): ClarificationAnswer {
  if (additions.length !== 1) throw new FlowError('clarification accepts only one new answer');
  history.forEach(parseClarificationAnswer);
  if (new Set(history.map((item) => item.question_id)).size !== history.length)
    throw new FlowError('clarification history contains a duplicate answer');
  const answer = answerForQuestion(pending, additions[0]);
  if (!sameValue(parseClarificationOwner(expectedOwner), answer.owner))
    throw new FlowError(
      'clarification submission is not bound to its waiting owner',
      'state_error',
    );
  if (history.some((item) => item.question_id === answer.question_id))
    throw new FlowError('clarification answer already exists for this question', 'state_error');
  return answer;
}

/**
 * Validate the durable owner side of a submission.  This intentionally accepts
 * opaque digests/identities: their syntax and meaning belong to the owning
 * workflow, while this shared boundary guarantees that no owner field is blank.
 */
export function parseClarificationOwner(value: unknown): ClarificationOwner {
  if (!isObject(value)) throw new FlowError('clarification owner must be an object');
  const fields = [
    'task',
    'repo',
    'workflow',
    'root',
    'leaf',
    'snapshot',
    'candidate',
    'review',
    'dispatch',
    'permissions',
    'selected_context',
    'handoff',
  ] as const;
  rejectUnknownKeys(value, fields, 'clarification owner');
  return Object.fromEntries(
    fields.map((field) => [field, nonblank(value[field], `owner.${field}`)]),
  ) as unknown as ClarificationOwner;
}

export function sameClarificationQuestion(a: PendingQuestion, b: PendingQuestion): boolean {
  return (
    a.id === b.id &&
    a.prompt === b.prompt &&
    sameValue(a.choices, b.choices) &&
    a.recommendation === b.recommendation
  );
}

/** JSON value equality ignores object key order, but never array order or values. */
export function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string | undefined =>
    JSON.stringify(value, (_key, item) =>
      isObject(item)
        ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x.localeCompare(y)))
        : item,
    );
  return canonical(a) === canonical(b);
}

export interface WaitingResult {
  status: 'waiting';
  question: PendingQuestion;
  owner: ClarificationOwner;
}

/** Checks every original value and the entire accepted prefix before returning a sole append. */
export function inputAnswerDelta(
  original: unknown,
  submitted: unknown,
  pending?: WaitingResult,
): ClarificationAnswer | null {
  if (!isObject(original) || !isObject(submitted))
    throw new FlowError('invalid clarification input', 'state_error');
  const { clarification_answers: old = [], ...before } = original;
  const { clarification_answers: next = [], ...after } = submitted;
  if (!sameValue(before, after))
    throw new FlowError('resume requires the exact original input', 'state_error');
  if (
    !Array.isArray(old) ||
    !Array.isArray(next) ||
    next.length < old.length ||
    !sameValue(old, next.slice(0, old.length))
  )
    throw new FlowError('clarification history changed or is stale', 'state_error');
  if (next.length === old.length) return null;
  if (!pending) throw new FlowError('no matching waiting owner for answer', 'state_error');
  return validateAnswerDelta(
    pending.question,
    old.map(parseClarificationAnswer),
    next.slice(old.length).map(parseClarificationAnswer),
    pending.owner,
  );
}

export const PENDING_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '\\S' },
    prompt: { type: 'string', pattern: '\\S' },
    choices: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', pattern: '\\S' },
          description: { type: 'string', pattern: '\\S' },
        },
        required: ['label', 'description'],
        additionalProperties: false,
      },
    },
    recommendation: { anyOf: [{ type: 'string', pattern: '\\S' }, { type: 'null' }] },
  },
  required: ['id', 'prompt', 'choices', 'recommendation'],
  additionalProperties: false,
} as const;
