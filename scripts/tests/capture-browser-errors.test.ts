import { test, expect } from 'bun:test';
import { captureUnavailable } from '../capture/capture.ts';

test('configured browser executable launch failures remain unavailable', () => {
  // Requiring a browserType prefix would miss executablePath failures in Playwright 1.63.
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
