/** @file Outcome: Workflow failures retain stable classifications and safe human-readable messages. */

export class FlowError extends Error {
  readonly code: string;

  constructor(message: string, code = 'usage_error') {
    super(message);
    this.code = code;
  }
}

export class UsageError extends Error {
  readonly code = 'USAGE';
}

export function usageError(message: string): UsageError {
  return new UsageError(message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof FlowError) return error.code;
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
