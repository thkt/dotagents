/** @file Outcome: Check rejects drift or unsafe entries in the shared Research corpus. */
import { verifyResearchCorpus } from './corpus.ts';
try {
  verifyResearchCorpus(process.cwd());
  process.stdout.write('Research corpus verified.\n');
} catch {
  process.stderr.write(
    'Research corpus verification failed. Check canonical records and generated pairs.\n',
  );
  process.exitCode = 1;
}
