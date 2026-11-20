# Releases

Build the VS Code installer from a clean checkout of the intended release commit with `make vsix`. To prepare the experimental downloads linked by the website, place the four GGUF/TCM pairs in `artifacts/general-models/<specialty>/`. The [model notes](../docs/research/general-models/README.md) describe the upstream checkpoint and smoke evaluations.

With the Python development dependencies installed, verify the installer, model sizes, embedded weights, and model reports:

```sh
.venv/bin/python -m tools.prepare_release
```

The command lists the upload paths and writes `artifacts/SHA256SUMS.txt`. Using an authenticated GitHub CLI, publish from the repository root after pushing the release commit:

```sh
gh release create tinycoders-downloads-v1 \
  --repo somalip/tessera --target "$(git rev-parse HEAD)" \
  --title "Tessera 0.3.2 and experimental model downloads" --prerelease \
  --notes-file releases/tinycoders-downloads-v1.md \
  artifacts/tessera.vsix docs/research/general-models/LICENSE artifacts/SHA256SUMS.txt \
  artifacts/general-models/{documentation,english,diagrams,summaries}/*-tiny.Q8_0.gguf \
  artifacts/general-models/{documentation,english,diagrams,summaries}/*-tiny.tcm
```

Verify the assets on GitHub Releases before deploying the landing page. Trained candidates must pass the [evaluation gates](../eval/README.md) and the [registry release checks](../registry/README.md) before shipping.
