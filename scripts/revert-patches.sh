#!/bin/bash
#
# Revert Smart Context patches from Clawdbot
# Restores original files from backups
#

set -e

CLAWDBOT_DIR="${CLAWDBOT_DIR:-$HOME/.npm-global/lib/node_modules/clawdbot}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Reverting Smart Context Patches"
echo "================================"
echo ""

HOOKS_FILE="$CLAWDBOT_DIR/dist/plugins/hooks.js"
ATTEMPT_FILE="$CLAWDBOT_DIR/dist/agents/pi-embedded-runner/run/attempt.js"

restore_file() {
    local file="$1"
    local backup="${file}.smart-context-backup"
    local name="$(basename "$file")"
    
    if [ -f "$backup" ]; then
        cp "$backup" "$file"
        echo -e "${GREEN}✓${NC} Restored: $name"
        return 0
    else
        echo -e "${YELLOW}○${NC} No backup found for: $name"
        return 1
    fi
}

restore_file "$HOOKS_FILE"
restore_file "$ATTEMPT_FILE"

echo ""
echo -e "${GREEN}Revert complete.${NC}"
echo "Restart Clawdbot gateway: clawdbot gateway restart"
