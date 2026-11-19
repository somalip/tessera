# TinyCoders architecture

The offline build plane produces size-bounded GGUF packages. The local VS Code
runtime consumes the versioned model manifest and registry schemas, and sends
inference requests to a llama.cpp process on loopback.

The manifest SHA-256 covers the GGUF bytes. The registry entry SHA-256 covers
the entire .tcm ZIP. Registry signatures cover the raw UTF-8 index bytes.
Model packages have a strict decimal 1 GB limit.

Milestones M0 through M9 and their acceptance criteria are defined in the README.
