PYTHON ?= python3

.PHONY: check
check:
	$(PYTHON) tools/generate_contracts.py --check
	$(PYTHON) -m ruff check .
	$(PYTHON) -m mypy tools tests data eval verifiers package train ci
	$(PYTHON) -m unittest discover -s tests
	npm --prefix vscode-extension run check
	npm --prefix vscode-extension run build
	PYTHON=$(PYTHON) node --test vscode-extension/test/*.test.cjs

.PHONY: test-ext
test-ext:
	npm --prefix vscode-extension run build
	node vscode-extension/test/run.cjs

LANGUAGE ?= $(if $(filter command line,$(origin LANG)),$(LANG),python)
EVAL_ARGS ?=
.PHONY: eval
eval:
	$(PYTHON) -m eval.report --lang "$(LANGUAGE)" --model "$(MODEL)" $(EVAL_ARGS)

CONFIG ?= train/configs/$(LANGUAGE).yaml
BUILD_DIR ?= artifacts/build
QUANT ?= Q4_K_M
LICENSE_ID ?= Apache-2.0
LICENSE_FILE ?= artifacts/base/LICENSE
.PHONY: train package
train:
	$(PYTHON) -m train.run --lang "$(LANGUAGE)" --config "$(CONFIG)"

package:
	$(PYTHON) -m package.build_manifest \
		--gguf "$(BUILD_DIR)/model.$(QUANT).gguf" \
		--metadata "$(BUILD_DIR)/metadata.json" \
		--report "$(BUILD_DIR)/eval_report.json" \
		--license-file "$(LICENSE_FILE)" \
		--license-id "$(LICENSE_ID)" \
		--output "$(BUILD_DIR)/$(LANGUAGE).tcm"

.PHONY: vsix
vsix:
	mkdir -p artifacts
	npm --prefix vscode-extension run package
