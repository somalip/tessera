PYTHON ?= python3

.PHONY: check
check:
	$(PYTHON) tools/generate_contracts.py --check
	$(PYTHON) -m ruff check .
	$(PYTHON) -m mypy --strict --explicit-package-bases tools tests data eval verifiers
	$(PYTHON) -m unittest discover -s tests
	npm --prefix vscode-extension run check
	npm --prefix vscode-extension run build
	node --test vscode-extension/test/*.test.cjs

.PHONY: test-ext
test-ext:
	npm --prefix vscode-extension run build
	node vscode-extension/test/run.cjs

LANGUAGE ?= $(if $(filter command line,$(origin LANG)),$(LANG),python)
EVAL_ARGS ?=
.PHONY: eval
eval:
	$(PYTHON) -m eval.report --lang "$(LANGUAGE)" --model "$(MODEL)" $(EVAL_ARGS)
