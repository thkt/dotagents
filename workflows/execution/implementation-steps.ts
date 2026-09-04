/** @file Outcome: Code and Build share one repository implementation and test step sequence. */

export interface ImplementationUnit {
  id?: string;
  outcome: string;
  contract?: string;
  tests?: Array<{ id: string; name: string }>;
  scope_paths: string[];
}

export function implementationSteps(
  units: readonly ImplementationUnit[],
  testCommand: string,
): unknown[] {
  if (!units.length) throw new Error('implementation requires at least one unit');
  return units.flatMap((unit, index) => {
    const id = unit.id ?? `U-${String(index + 1).padStart(3, '0')}`;
    const tests = unit.tests ?? [];
    const direct = `${id}:direct`;
    const solidify = `${id}:solidify`;
    const gate = (gateId: string, owner: string) => ({
      id: gateId,
      kind: 'gate',
      owner,
      gate: { authority: 'shell', command: testCommand, expect: 'pass' },
    });
    return [
      {
        id: direct,
        kind: 'actor',
        unit_id: id,
        stage: 'direct',
        outcome: unit.outcome,
        contract: unit.contract ?? '',
        tests,
        files: [...new Set(unit.scope_paths)],
      },
      gate(`${id}:test`, direct),
      {
        id: solidify,
        kind: 'actor',
        unit_id: id,
        stage: 'solidify',
        outcome: unit.outcome,
        contract: unit.contract ?? '',
        tests,
        files: [...new Set(unit.scope_paths)],
      },
      gate(`${id}:solidify:test`, solidify),
    ];
  });
}
