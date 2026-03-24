#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing ecosystem CLIs..."
bun install -g opencode-ai || { echo "ERROR: Failed to install opencode-ai"; exit 1; }
bun install -g @os-eco/seeds-cli || { echo "ERROR: Failed to install @os-eco/seeds-cli"; exit 1; }
bun install -g @os-eco/canopy-cli || { echo "ERROR: Failed to install @os-eco/canopy-cli"; exit 1; }
bun install -g @os-eco/beads-cli || { echo "ERROR: Failed to install @os-eco/beads-cli"; exit 1; }

# mulch is a runtime dep in package.json — available after bun install + bun link
# only install globally if not already on PATH
if ! command -v mulch &>/dev/null; then
  echo "==> mulch not found on PATH, installing globally..."
  bun install -g @os-eco/mulch-cli || { echo "ERROR: Failed to install @os-eco/mulch-cli"; exit 1; }
else
  echo "==> mulch already available: $(which mulch)"
fi

echo "==> Generating .overstory/config.local.yaml..."
mkdir -p .overstory
# config.local.yaml is gitignored and deep-merged on top of config.yaml
# only override keys that differ from defaults
cat > .overstory/config.local.yaml << 'EOF'
project:
  root: /workspaces/overstory
runtime:
  default: opencode
EOF
echo "==> config.local.yaml written"

echo "==> Verifying opencode installation..."
# ov doctor does NOT check opencode — verify separately
which opencode || { echo "ERROR: opencode binary not found on PATH"; exit 1; }
echo "==> opencode found: $(which opencode)"

echo "==> Running ov doctor..."
ov doctor

echo "==> DevContainer setup complete!"
