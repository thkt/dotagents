# Testing Decisions

Read this reference when choosing acceptance tests or verification gates for a code unit.

## What to test

- Apply repository-specific test policy before this reference.
- Name each test with the condition and observable result. Keep the name valid after implementation refactoring.
- For a bug, add a regression test that reproduces the reported condition and verifies the corrected result.
- Cover each state transition and each side of a boundary that can change the result.
- Cover every operand combination when independent conditions interact in authorization, billing, or core decisions.
- Test timeout, dependency failure, or malformed responses only when the target crosses that dependency boundary.

## Test level

Use the lowest level that can observe the failure.

| Failure visibility                          | Test level  |
| ------------------------------------------- | ----------- |
| Pure decision or transformation             | Unit        |
| Interaction between working components      | Integration |
| Break visible only in the running user path | E2E         |

Keep E2E cases to primary user paths and failures that lower levels cannot observe. Include state-dependent UI, authorization, empty states, and external wiring when they carry the requested outcome.

## Test doubles

Prefer a real dependency with closed side effects, then a fake, then a stub. Use a mock only when the outbound call itself is the required observable behavior.
