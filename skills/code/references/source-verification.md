# Source Verification

Read this reference when implementation depends on a framework or library public API whose signature, option, default, lifecycle, or deprecation can vary by version.

## Source

- Confirm the installed version from the repository manifest or lockfile.
- Use that version's official documentation or original specification as the authority.
- Prefer the documented signature over remembered behavior.
- Cite a deep link for a load-bearing, non-obvious API claim. Do not annotate stable standard-library calls or internal project code.

## Unavailable documentation

Mark the API claim as unverified and report the missing source. Do not present remembered behavior as confirmed fact.
