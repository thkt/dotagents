import { assuranceModes, registerMode } from '../../support/codex-actor.ts';

for (const mode of assuranceModes) {
  registerMode(mode);
}
