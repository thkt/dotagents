#!/usr/bin/env bun
/** @file Outcome: The Build executable exposes only the shared runner's Build contract. */

import type { CommandResult } from '../execution/contracts.ts';
import { reportMain, workflowMain } from '../execution/engine.ts';
import { isMainModule } from '../shared/environment.ts';

export function main(argv: string[] = process.argv.slice(2)): Promise<CommandResult> {
  return workflowMain('build', argv);
}

if (isMainModule(import.meta.url)) reportMain(main());
