# AGENTS.md

## Project
Tessera: per-language coding LLMs (each shipped package < 1 GB) plus a VS Code router extension.
Read docs/ARCHITECTURE.md before starting any task.

## Rules
- Hard constraint: every model package must be < 1.0 GB. CI must fail if exceeded.
- The model package format and registry schema (schemas/*.json) are contracts. Change them only via an explicit schema-version bump and update both Python and TS types.
- Never train or evaluate on data that fails the license allowlist (data/sources/license_allowlist.yaml).
- All eval sets must be decontaminated from training data; do not weaken decontamination to improve scores.
- Keep runtime backends behind the `host/` interface; do not call llama.cpp directly from providers.
- No network calls from the extension except the registry/download path; telemetry is local-only unless the user opts in.

## Commands
- `make check`    lint + typecheck + unit tests (Python + TS)
- `make test-ext` VS Code integration tests (mock llama server)
- `make eval LANG=<lang> MODEL=<path>`
- `make train LANG=<lang> CONFIG=train/configs/<lang>.yaml`
- `make package LANG=<lang>`

## Conventions
- Python 3.11+, ruff + mypy strict; TypeScript strict mode, eslint.
- One config file per language inheriting from train/configs/base.yaml.
- Every new verifier needs a sandbox test proving it rejects malicious/looping code.
- Work milestone by milestone (M0..M9 in ARCHITECTURE.md); each PR must meet that milestone's acceptance criteria and include tests.
