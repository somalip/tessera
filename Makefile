PYTHON ?= python3

.PHONY: check
check:
	$(PYTHON) tools/generate_contracts.py --check
	$(PYTHON) -m ruff check .
	$(PYTHON) -m mypy --strict tools tests
	$(PYTHON) -m unittest discover -s tests
	npm --prefix vscode-extension run check

.PHONY: test-ext
test-ext:
	npm --prefix vscode-extension run build
	node vscode-extension/test/run.cjs
