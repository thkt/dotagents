/** @file Outcome: Code and Build share one repository implementation and test sequence. */

export interface ImplementationUnit {
  outcome: string;
  scope_paths: string[];
}

export function implementationSteps(
  units: readonly ImplementationUnit[],
  testCommand: string,
): unknown[] {
  if (!units.length) throw new Error('implementation requires at least one unit');
  const files = [...new Set(units.flatMap((unit) => unit.scope_paths))];
  const outcome = units.map((unit) => unit.outcome).join('\n');
  return [
    {
      id: 'implementation:direct',
      kind: 'actor',
      outcome,
      files,
    },
    {
      id: 'test',
      kind: 'gate',
      owner: 'implementation:direct',
      gate: {
        authority: 'shell',
        command: testCommand,
        expect: 'pass',
      },
    },
  ];
}
