import publicContract from '../fixtures/human-decision-recovery/public-contract.json';

// The first two argvShape entries are the runtime and the script path; keep only the CLI arguments.
export function contractArgs(values: Record<string, string>) {
  return publicContract.argvShape.slice(2).map((value) => values[value] ?? value);
}
