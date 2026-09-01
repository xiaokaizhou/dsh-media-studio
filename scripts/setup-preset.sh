#!/usr/bin/env bash
# One-time setup: install the media-studio agent preset into the active
# DSH profile. Run after `pnpm build` or from `prepare` (npm install).
#
# Usage: ./scripts/setup-preset.sh [profile-name]
#   default profile = "web"
#
# What it does:
#   1. Resolve the project's plugin dir + the bundled preset file
#   2. Create $DSH_HOME/profiles/<profile>/agent-presets/media-studio/
#   3. Symlink our agent.cordis.yml into it (so future plugin updates
#      propagate without re-running this script)
#
# Idempotent: safe to run multiple times. Skips with a friendly note if
# the DSH profile directory is not yet initialized.

set -euo pipefail

PROFILE="${1:-web}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRESET_SRC="$PLUGIN_DIR/src/presets/media-studio/agent.cordis.yml"

if [ ! -f "$PRESET_SRC" ]; then
  echo "[media-studio] preset file missing at $PRESET_SRC — plugin not built yet" >&2
  exit 0
fi

# Resolve DSH home — defaults to ~/.dsh, override with DSH_HOME.
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "[media-studio] profile dir missing: $PROFILE_DIR — skipping preset install (will retry once the user runs dsh web)" >&2
  exit 0
fi

PRESET_DIR="$PROFILE_DIR/agent-presets/media-studio"
mkdir -p "$PRESET_DIR"

# Symlink the preset file so plugin upgrades take effect without re-running.
# If the symlink already exists (re-install), replace it atomically.
ln -sfn "$PRESET_SRC" "$PRESET_DIR/agent.cordis.yml"

echo "[media-studio] preset installed → $PRESET_DIR/agent.cordis.yml"
echo "  next:  dsh --profile $PROFILE → pick 'media-studio' in the agent preset selector"
echo "         or pass /preset media-studio in chat"
