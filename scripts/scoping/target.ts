import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { command } from '../shared/process.ts';
import { issueNumber, readTarget } from '../shared/target.ts';

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: { write: { type: 'boolean' } },
      strict: true,
    });
    const checkout = positionals[0];
    assert(checkout && positionals.length <= 2, 'Usage: target.ts CHECKOUT [ISSUE] [--write]');
    const target = await readTarget(
      checkout,
      async (argv, cwd) => {
        const result = await command(argv, cwd, '', 30000);
        assert(result.code === 0 && !result.timedOut, `Target check failed: ${argv[0]}`);
        return result.stdout.trim();
      },
      values.write ?? false,
    );
    if (positionals[1]) {
      issueNumber(positionals[1], target.config.repository);
    }
    console.log(JSON.stringify(target, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
