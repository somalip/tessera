# Registry

Host a JSON index validated against `schemas/registry.json` and a detached
64-byte Ed25519 signature at the same HTTPS URL with `.sig` appended to the
path. Sign the exact index bytes. Configure `tinycoders.registryUrl` and
`tinycoders.registryPublicKey` in user settings using the trusted PEM public
key. Keep the private key outside the repository.

Each index entry specifies the size and SHA-256 of the .tcm ZIP. Each ZIP
contains the manifest, GGUF, eval report, LICENSE, and optional NOTICE at its
root. The manifest records the individual GGUF size and SHA-256. Version
directories stay installed so they can be selected offline.
