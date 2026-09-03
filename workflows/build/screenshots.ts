/** @file Outcome: Declared UI screenshots become validated, controller-owned PR attachments. */

import * as fs from 'node:fs';
import crypto from 'node:crypto';

import type { FlowState } from '../flow/contracts.ts';
import { FlowError } from '../shared/errors.ts';
import { atomicWrite, buildScreenshotPath, screenshotSealPath } from '../shared/storage.ts';
import type { ScreenshotSpec } from './screenshot-contract.ts';

export interface ScreenshotAttachment extends ScreenshotSpec {
  path: string;
}

export interface SealedScreenshotAttachment extends ScreenshotAttachment {
  sha256: string;
}

const SEAL_PROTOCOL = 'codex-build-screenshot-seal';

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

export function screenshotAttachments(state: FlowState): ScreenshotAttachment[] {
  return (state.screenshots ?? []).map((screenshot) => ({
    ...screenshot,
    path: buildScreenshotPath(state.run_id, screenshot.name),
  }));
}

/** Only the last implementation actor captures the completed UI. */
export function actorScreenshotAttachments(
  state: FlowState,
  actorId: string,
): ScreenshotAttachment[] {
  const implementationActors = state.manifest.steps.filter((step) => step.kind === 'actor');
  return implementationActors.at(-1)?.id === actorId ? screenshotAttachments(state) : [];
}

/** Makes each actor attempt prove fresh screenshot output instead of reusing a failed attempt. */
export function resetScreenshotAttachments(
  runId: string,
  attachments: readonly ScreenshotAttachment[],
): void {
  for (const attachment of attachments) fs.rmSync(attachment.path, { force: true });
  fs.rmSync(screenshotSealPath(runId), { force: true });
}

function imageKind(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function inspectScreenshot(attachment: ScreenshotAttachment): string {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      attachment.path,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) throw new Error('not a non-empty regular file');
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const header = Buffer.alloc(12);
    let offset = 0;
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (!read) break;
      if (offset < header.length) {
        chunk.copy(header, offset, 0, Math.min(read, header.length - offset));
      }
      offset += read;
      hash.update(chunk.subarray(0, read));
    }
    const kind = imageKind(header);
    const extension = attachment.name.split('.').at(-1)?.toLowerCase();
    const matchesExtension =
      kind === extension || (kind === 'jpeg' && (extension === 'jpg' || extension === 'jpeg'));
    if (!kind || !matchesExtension) throw new Error('unsupported or mislabeled image');
    return hash.digest('hex');
  } catch {
    throw new FlowError(
      `required screenshot is missing, linked, empty, unsupported, or mislabeled: ${attachment.name}`,
      'postcondition_error',
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/** Seals the exact actor-produced bytes before the workflow advances. */
export function sealScreenshotAttachments(
  runId: string,
  attachments: readonly ScreenshotAttachment[],
): SealedScreenshotAttachment[] {
  const sealed = attachments.map((attachment) => ({
    ...attachment,
    sha256: inspectScreenshot(attachment),
  }));
  if (sealed.length) {
    atomicWrite(screenshotSealPath(runId), {
      protocol: SEAL_PROTOCOL,
      attachments: sealed.map(({ name, sha256 }) => ({ name, sha256 })),
    });
  }
  return sealed;
}

/** Revalidates both the private seal and current bytes before each Ship observation or write. */
function loadSealedScreenshotAttachments(
  runId: string,
  attachments: readonly ScreenshotAttachment[],
): SealedScreenshotAttachment[] {
  if (!attachments.length) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(screenshotSealPath(runId), 'utf8')) as unknown;
  } catch {
    throw new FlowError('required screenshot seal is missing or unreadable', 'postcondition_error');
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !hasExactKeys(raw, ['attachments', 'protocol']) ||
    !('protocol' in raw) ||
    raw.protocol !== SEAL_PROTOCOL ||
    !('attachments' in raw) ||
    !Array.isArray(raw.attachments) ||
    raw.attachments.length !== attachments.length
  ) {
    throw new FlowError('required screenshot seal has an invalid shape', 'postcondition_error');
  }
  const records = raw.attachments as unknown[];
  return attachments.map((attachment, index) => {
    const record = records[index];
    if (
      typeof record !== 'object' ||
      record === null ||
      !hasExactKeys(record, ['name', 'sha256']) ||
      !('name' in record) ||
      record.name !== attachment.name ||
      !('sha256' in record) ||
      typeof record.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) {
      throw new FlowError('required screenshot seal has an invalid shape', 'postcondition_error');
    }
    const sha256 = inspectScreenshot(attachment);
    if (sha256 !== record.sha256) {
      throw new FlowError(
        `required screenshot changed after actor completion: ${attachment.name}`,
        'postcondition_error',
      );
    }
    return { ...attachment, sha256 };
  });
}

export function sealedScreenshotAttachments(state: FlowState): SealedScreenshotAttachment[] {
  return loadSealedScreenshotAttachments(state.run_id, screenshotAttachments(state));
}

export function validateSealedScreenshotAttachments(
  runId: string,
  expected: readonly SealedScreenshotAttachment[],
): void {
  const current = loadSealedScreenshotAttachments(runId, expected);
  for (const [index, attachment] of expected.entries()) {
    if (current[index]?.sha256 !== attachment.sha256) {
      throw new FlowError(`required screenshot seal changed: ${attachment.name}`);
    }
  }
}
