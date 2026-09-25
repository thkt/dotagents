import { isRecord } from '../values.ts';

// Projections preserve missing/invalid values. Each caller owns response validation
// and diagnostics; normalization must not supply a successful default.
type PrTarget = {
  state: unknown;
  commit: unknown;
  base: unknown;
  draft: unknown;
};

type PrPublication = PrTarget & {
  url: unknown;
  author: unknown;
  branch: unknown;
  repository: unknown;
  body: unknown;
};

type ExpectedTarget = { commit: string; base: string };
type ExpectedPublication = ExpectedTarget & {
  url: string;
  actor: string;
  branch: string;
  repository: string;
  body: string;
};

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function restPrPublication(pr: Record<string, unknown>) {
  return {
    // REST and GraphQL have distinct state vocabularies; do not accept arbitrary casing.
    state: pr.state === 'open' ? 'OPEN' : pr.state === 'closed' ? 'CLOSED' : undefined,
    commit: field(pr.head, 'sha'),
    base: field(pr.base, 'ref'),
    draft: pr.draft,
    url: pr.html_url,
    author: field(pr.user, 'login'),
    branch: field(pr.head, 'ref'),
    repository: field(field(pr.head, 'repo'), 'full_name'),
    body: pr.body,
    baseRepository: field(field(pr.base, 'repo'), 'full_name'),
  };
}

export function graphQlPrTarget(pr: Record<string, unknown>): PrTarget {
  return {
    state: pr.state,
    commit: pr.headRefOid,
    base: pr.baseRefName,
    draft: pr.isDraft,
  };
}

export function graphQlPrPublication(pr: Record<string, unknown>): PrPublication {
  const owner = field(pr.headRepositoryOwner, 'login');
  const name = field(pr.headRepository, 'name');
  return {
    ...graphQlPrTarget(pr),
    url: pr.url,
    author: field(pr.author, 'login'),
    branch: pr.headRefName,
    repository:
      typeof owner === 'string' && typeof name === 'string' ? `${owner}/${name}` : undefined,
    body: pr.body,
  };
}

export function matchPrTarget(pr: PrTarget, expected: ExpectedTarget) {
  return {
    target: pr.state === 'OPEN' && pr.commit === expected.commit && pr.base === expected.base,
    draft: pr.draft === true,
  };
}

export function matchPrPublication(pr: PrPublication, expected: ExpectedPublication) {
  const match = matchPrTarget(pr, expected);
  return {
    ...match,
    target:
      match.target &&
      pr.url === expected.url &&
      pr.branch === expected.branch &&
      pr.repository === expected.repository,
    author: pr.author === expected.actor,
    body: pr.body === expected.body,
  };
}

export function referencesIssue(body: string, issue: string) {
  return new RegExp(`Closes #${issue}(?![0-9])`).test(body);
}
