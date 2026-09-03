/** @file Outcome: UI screenshot requirements resolve once and fail closed before Ship. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import {
  actorScreenshotAttachments,
  resetScreenshotAttachments,
  sealScreenshotAttachments,
  sealedScreenshotAttachments,
  screenshotAttachments,
} from '../../build/screenshots.ts';
import type { FlowState } from '../../flow/contracts.ts';
import { screenshotSealPath } from '../../shared/storage.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function state(root: string): FlowState {
  const previous = process.env.CODEX_FLOW_RUNTIME_DIR;
  process.env.CODEX_FLOW_RUNTIME_DIR = root;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.CODEX_FLOW_RUNTIME_DIR;
    else process.env.CODEX_FLOW_RUNTIME_DIR = previous;
  });
  return {
    run_id: 'screenshot-run',
    screenshots: [{ name: 'home.png', alt: 'Home screen' }],
    manifest: {
      steps: [{ id: 'implementation:direct', kind: 'actor' }],
    },
  } as FlowState;
}

test('assigns screenshots to the shared implementation actor', () => {
  const root = temporaryDirectory('codex-build-screenshots-');
  const value = state(root);
  const attachments = actorScreenshotAttachments(value, 'implementation:direct');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.name, 'home.png');
  assert.match(attachments[0]?.path ?? '', /screenshots\/home\.png$/u);
});

test('accepts image bytes and rejects missing or non-image screenshot outputs', () => {
  const root = temporaryDirectory('codex-build-screenshots-');
  const value = state(root);
  const attachments = screenshotAttachments(value);
  assert.throws(
    () => sealScreenshotAttachments(value.run_id, attachments),
    /required screenshot is missing, linked, empty, unsupported, or mislabeled/u,
  );

  fs.mkdirSync(path.dirname(attachments[0]!.path), { recursive: true });
  fs.writeFileSync(attachments[0]!.path, 'not an image');
  assert.throws(
    () => sealScreenshotAttachments(value.run_id, attachments),
    /required screenshot is missing, linked, empty, unsupported, or mislabeled/u,
  );

  fs.writeFileSync(attachments[0]!.path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const sealed = sealScreenshotAttachments(value.run_id, attachments);
  assert.equal(sealed[0]?.sha256.length, 64);
  assert.deepEqual(sealedScreenshotAttachments(value), sealed);

  const sealPath = screenshotSealPath(value.run_id);
  const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(sealPath, JSON.stringify({ ...seal, extra: true }));
  assert.throws(() => sealedScreenshotAttachments(value), /seal has an invalid shape/u);
  sealScreenshotAttachments(value.run_id, attachments);

  fs.appendFileSync(attachments[0]!.path, 'changed');
  assert.throws(
    () => sealedScreenshotAttachments(value),
    /required screenshot changed after actor completion/u,
  );
  resetScreenshotAttachments(value.run_id, attachments);
  assert.equal(fs.existsSync(attachments[0]!.path), false);
});

test('rejects a symlink and an image whose bytes do not match its extension', () => {
  const root = temporaryDirectory('codex-build-screenshots-');
  const value = state(root);
  const attachment = screenshotAttachments(value)[0]!;
  fs.mkdirSync(path.dirname(attachment.path), { recursive: true });
  const target = path.join(root, 'target.png');
  fs.writeFileSync(target, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  fs.symlinkSync(target, attachment.path);
  assert.throws(
    () => sealScreenshotAttachments(value.run_id, [attachment]),
    /missing, linked, empty, unsupported, or mislabeled/u,
  );

  fs.rmSync(attachment.path);
  const mislabeled = { ...attachment, name: 'home.jpg' };
  fs.writeFileSync(mislabeled.path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  assert.throws(
    () => sealScreenshotAttachments(value.run_id, [mislabeled]),
    /missing, linked, empty, unsupported, or mislabeled/u,
  );
});
