import { test, expect } from 'bun:test';
import { captureUnavailable } from '../capture.ts';

test('configured browser executable launch failures remain unavailable', () => {
  // Observed from the real Playwright 1.63 JSON reporter with launchOptions.executablePath.
  expect(
    captureUnavailable({
      message:
        "Error: launch: Failed to launch chromium because executable doesn't exist at /nonexistent/capture-browser",
    }),
  ).toBe(true);
});

test('test filesystem errors remain capture failures', () => {
  expect(
    captureUnavailable({
      message: "Error: EACCES: permission denied, open '/target/unwritable.txt'",
    }),
  ).toBe(false);
});

test('macOS browser launch permission denial remains unavailable', () => {
  expect(
    captureUnavailable({
      message:
        'Error: launch: Target page, context or browser has been closed\nBrowser logs:\nbootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.123: Permission denied (1100)',
    }),
  ).toBe(true);
});
