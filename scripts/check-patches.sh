#!/bin/bash
#
# Check if Smart Context patches are applied to Clawdbot
#

CLAWDBOT_DIR="${CLAWDBOT_DIR:-$HOME/.npm-global/lib/node_modules/clawdbot}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Smart Context Patch Status"
echo "=========================="
echo ""

HOOKS_FILE="$CLAWDBOT_DIR/dist/plugins/hooks.js"
ATTEMPT_FILE="$CLAWDBOT_DIR/dist/agents/pi-embedded-runner/run/attempt.js"

check_file() {
    local file="$1"
    local marker="$2"
    local name="$3"
    
    if [ ! -f "$file" ]; then
        echo -e "${RED}✗${NC} $name: FILE NOT FOUND"
        return 1
    fi
    
    if grep -q "$marker" "$file" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $name: Patched"
        return 0
    else
        echo -e "${YELLOW}○${NC} $name: Not patched"
        return 1
    fi
}

HOOKS_OK=false
ATTEMPT_OK=false
MODELID_OK=false

check_file "$HOOKS_FILE" "messages: next.messages" "hooks.js (message return)" && HOOKS_OK=true
check_file "$ATTEMPT_FILE" "hookResult?.messages" "attempt.js (message replace)" && ATTEMPT_OK=true
check_file "$ATTEMPT_FILE" "modelId: params.modelId" "attempt.js (modelId ctx)" && MODELID_OK=true

echo ""

if [ "$HOOKS_OK" = true ] && [ "$ATTEMPT_OK" = true ] && [ "$MODELID_OK" = true ]; then
    echo -e "${GREEN}All patches are applied!${NC}"
    exit 0
else
    echo -e "${YELLOW}Some patches are missing.${NC}"
    echo "Run ./apply-patches.sh to apply them."
    exit 1
fi
