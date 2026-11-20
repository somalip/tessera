## Tessera for VS Code 0.3.2

Download `tessera.vsix` and choose **Install from VSIX…** in the VS Code Extensions view. Follow the repository's runtime setup instructions to configure llama.cpp and a coding model.

## Experimental Qwen3.5-0.8B models

| Variant | Task |
| --- | --- |
| documentation-tiny | Markdown documentation |
| english-tiny | English copyediting |
| diagrams-tiny | Mermaid diagram generation |
| summaries-tiny | Summaries and action items |

The four variants use Q8_0 weights from Apache-2.0 Qwen3.5-0.8B and differ in their embedded chat templates. They received no additional training. Each is available as a standalone GGUF and a TCM archive with the model manifest, Apache-2.0 license, and smoke evaluation report. The reports cover one prompt per variant. These experimental packages are outside the signed model registry.

`SHA256SUMS.txt` contains a checksum for each download.
