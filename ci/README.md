# Continuous integration

The Check workflow builds the extension and runs Python and TypeScript checks
on Linux, macOS, and Windows. A separate matrix runs the pinned Docker
verifier tests for each supported language. The Linux job runs the VS Code
mock-server integration test under Xvfb.

The model workflow requires self-hosted Linux GPU runners and a directory
containing a full release config for each matrix language. Each config must
point to the pinned base, verified corpus and teacher data, local llama.cpp
tools, and matching baseline and competitor reports. Give each job a
separate fresh build directory. The matrix uploads only validated, gated
packages under the decimal 1 GB limit. Sign the candidate index separately
with the release key using `python -m package.sign_registry`.
