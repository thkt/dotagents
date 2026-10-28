import assert from 'node:assert/strict';
import { expect, afterEach } from 'bun:test';

import { withInterrupts } from '../../../shared/process.ts';
import { publishCli } from '../../../implement/publish.ts';

afterEach(async () => {
  await withInterrupts(async () => {});
});

import { testPublisher } from '../../support/publish-fixture.ts';
testPublisher('interrupted', async (f, io) => {
  const github = f.github;
  f.github = async (args) => {
    const reply = await github(args);
    if (args[2] === 'list') {
      process.emit('SIGINT');
    }
    return reply;
  };
  await assert.rejects(() => withInterrupts(() => publishCli(f.args, io)), /Interrupted execution/);
  expect(f.publications).toEqual(['list']);
});
