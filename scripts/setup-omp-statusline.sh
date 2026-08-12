#!/usr/bin/env bash
# setup-omp-statusline.sh — apply the phone-width omp status line, the
# titanium-cache theme (card-file-box cache icon), and remove the
# deepseek-v4-flash display-name override. Idempotent.
#
# Usage: bash scripts/setup-omp-statusline.sh
set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
	echo "error: bun not found on PATH (omp runs on bun)" >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/setup-omp-statusline.mjs"
