#!/usr/bin/env bun
/** @file Outcome: The Code executable exposes only the shared runner's direct-change contract. */

import type { CommandResult } from '../execution/contracts.ts';
import { reportMain, workflowMain } from '../execution/engine.ts';
import { isMainModule } from '../shared/environment.ts';

export function main(argv: string[] = process.argv.slice(2)): Promise<CommandResult> {
  return workflowMain('code', argv);
}

if (isMainModule(import.meta.url)) reportMain(main());
