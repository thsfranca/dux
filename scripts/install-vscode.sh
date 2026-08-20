#!/usr/bin/env bash
# Build a .vsix and install Dux into Visual Studio Code.
# Usage:
#   ./scripts/install-vscode.sh
#   VSCODE_CLI=code ./scripts/install-vscode.sh
#   VSCODE_CLI=/path/to/code ./scripts/install-vscode.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

resolve_code_cli() {
  if [[ -n "${VSCODE_CLI:-}" ]]; then
    echo "$VSCODE_CLI"
    return
  fi

  if command -v code >/dev/null 2>&1; then
    command -v code
    return
  fi

  local candidates=(
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    "/usr/local/bin/code"
    "$HOME/.local/bin/code"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done

  return 1
}

if ! CODE_CLI="$(resolve_code_cli)"; then
  cat >&2 <<'EOF'
Could not find the Visual Studio Code CLI (`code`).

Install it from VS Code:
  Command Palette → “Shell Command: Install 'code' command in PATH”

Or set VSCODE_CLI to the full path, for example:
  VSCODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ./scripts/install-vscode.sh
EOF
  exit 1
fi

echo "Using VS Code CLI: $CODE_CLI"
echo "Installing dependencies…"
npm install

echo "Compiling TypeScript…"
npm run compile

echo "Packaging .vsix…"
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository

VSIX="$(ls -1t ./*.vsix 2>/dev/null | head -n 1 || true)"
if [[ -z "$VSIX" ]]; then
  echo "No .vsix was produced." >&2
  exit 1
fi

echo "Installing $VSIX…"
"$CODE_CLI" --install-extension "$VSIX" --force

cat <<EOF

Installed Dux into Visual Studio Code.

Next:
  1. Restart VS Code (or reload the window)
  2. Run: opencode serve
  3. Open Chat and mention @opencode

Uninstall later with:
  $CODE_CLI --uninstall-extension thsfranca.dux
EOF
