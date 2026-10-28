import { test } from 'bun:test';
import { scenarios, runScenario, isAssuranceScenario } from '../../support/ci.ts';

for (const scenario of scenarios.filter((scenario) => !isAssuranceScenario(scenario))) {
  test(`CI execution: ${scenario.name}`, () => runScenario(scenario));
}
