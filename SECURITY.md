# Security

Please do not open public issues for sensitive security reports.

`fm-bench` shells out to Apple's local `fm` command and can optionally store prompts and model outputs in reports. Treat prompt files and JSON reports as potentially sensitive.

## How fm-bench handles untrusted input

`fm` output, report files, and prompt files are treated as untrusted:

- `fm` is spawned with an argument array (never a shell), so prompts and model names cannot become shell syntax.
- ANSI escapes and control characters are stripped from `fm` output and from report fields before anything is printed to a terminal.
- Generated HTML escapes `<`, `>`, `&`, and quotes, including inside the embedded JSON block.
- Generated CSV quotes separators and neutralises cells that begin with `=`, `+`, `@`, or a non-numeric `-`, so prompts and model output cannot be evaluated as spreadsheet formulas.
- Report loading rejects malformed JSON with an actionable error and never evaluates it.
- In-flight `fm` child processes are terminated on SIGINT/SIGTERM so an interrupted run does not leave orphaned processes behind.

## Reporting

If you find a security issue, report it privately through [GitHub private vulnerability reporting](https://github.com/dvnold/fm-bench/security/advisories/new). Only the latest release receives security fixes.

Published npm releases carry [provenance](https://docs.npmjs.com/generating-provenance-statements) linking each tarball to the GitHub Actions run that built it: `npm view fm-bench dist.attestations`.
