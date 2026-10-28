import { expect } from 'bun:test';

import {
  ok,
  testRevision,
  noRevisionPublication,
  stoppedRevision,
} from '../../support/revision-fixture.ts';
testRevision('commit_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][0] === 'git' && args[0].includes('commit')) {
      return { ...ok(), code: 1, stderr: 'commit rejected fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /commit rejected fixture/);
  expect(result.publication).toBe('not_attempted');
  noRevisionPublication(f);
});

testRevision('push_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][0] === 'git' && args[0].includes('push')) {
      expect(f.pr.isDraft).toBe(true);
      f.hooks.pushes++;
      return { ...ok(), code: 1, stderr: 'push rejected fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /push rejected fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('push_interrupt', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][0] === 'git' && args[0].includes('push')) {
      process.emit('SIGINT');
      throw Error('Interrupted push fixture');
    }
    return result;
  };
  const result = await stoppedRevision(f, /Interrupted push fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('edit_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][1] === 'pr' && args[0][2] === 'edit' && !args[0].includes('--attach')) {
      expect(f.pr.isDraft).toBe(true);
      f.hooks.edits++;
      return { ...ok(), code: 1, stderr: 'body update failed fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /body update failed fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('edit_interrupt', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][1] === 'pr' && args[0][2] === 'edit' && !args[0].includes('--attach')) {
      process.emit('SIGTERM');
    }
    return result;
  };
  const result = await stoppedRevision(f, /Interrupted execution/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('draft_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][2] === 'ready') {
      expect(args[0]).toEqual([
        'gh',
        'pr',
        'ready',
        f.pr.url,
        '--repo',
        'team/component',
        '--undo',
      ]);
      expect(f.hooks.pushes).toBe(0);
      return { ...ok(), code: 1, stderr: 'draft conversion failed fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /draft conversion failed fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  noRevisionPublication(f);
});

testRevision('draft_unknown', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][2] === 'ready') {
      throw Error('draft conversion response lost fixture');
    }
    return result;
  };
  const result = await stoppedRevision(f, /draft conversion response lost fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  noRevisionPublication(f);
});
