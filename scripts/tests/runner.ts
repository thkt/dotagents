import { main } from '../test-runtime/runner.ts';
export * from '../test-runtime/runner.ts';

if (import.meta.main) {
  await main();
}
