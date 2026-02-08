#!/bin/bash
#
# Smart Context Patches for Clawdbot
# Applies patches to enable message filtering in before_agent_start hook
#
# Usage: ./apply-patches.sh
#
# Run this after every Clawdbot update!
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAWDBOT_DIR="${CLAWDBOT_DIR:-$HOME/.npm-global/lib/node_modules/clawdbot}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "Smart Context Patches for Clawdbot"
echo "======================================"
echo ""

# Check Clawdbot installation
if [ ! -d "$CLAWDBOT_DIR" ]; then
    echo -e "${RED}ERROR: Clawdbot not found at $CLAWDBOT_DIR${NC}"
    echo "Set CLAWDBOT_DIR environment variable if installed elsewhere."
    exit 1
fi

echo -e "Clawdbot directory: ${GREEN}$CLAWDBOT_DIR${NC}"
echo ""

# File paths
HOOKS_FILE="$CLAWDBOT_DIR/dist/plugins/hooks.js"
ATTEMPT_FILE="$CLAWDBOT_DIR/dist/agents/pi-embedded-runner/run/attempt.js"

# Backup function
backup_file() {
    local file="$1"
    local backup="${file}.smart-context-backup"
    if [ ! -f "$backup" ]; then
        cp "$file" "$backup"
        echo -e "  ${GREEN}✓${NC} Backed up: $(basename "$file")"
    else
        echo -e "  ${YELLOW}○${NC} Backup exists: $(basename "$file")"
    fi
}

# Check if already patched
check_patched() {
    local file="$1"
    local marker="$2"
    if grep -q "$marker" "$file" 2>/dev/null; then
        return 0  # Already patched
    fi
    return 1  # Not patched
}

echo "Step 1: Checking current state..."
echo ""

HOOKS_PATCHED=false
ATTEMPT_PATCHED=false

if check_patched "$HOOKS_FILE" "messages: next.messages"; then
    echo -e "  ${GREEN}✓${NC} hooks.js already patched"
    HOOKS_PATCHED=true
else
    echo -e "  ${YELLOW}○${NC} hooks.js needs patching"
fi

if check_patched "$ATTEMPT_FILE" "hookResult?.messages"; then
    echo -e "  ${GREEN}✓${NC} attempt.js already patched"
    ATTEMPT_PATCHED=true
else
    echo -e "  ${YELLOW}○${NC} attempt.js needs patching"
fi

echo ""

if [ "$HOOKS_PATCHED" = true ] && [ "$ATTEMPT_PATCHED" = true ]; then
    echo -e "${GREEN}All patches already applied!${NC}"
    echo "No changes needed."
    exit 0
fi

echo "Step 2: Creating backups..."
echo ""

backup_file "$HOOKS_FILE"
backup_file "$ATTEMPT_FILE"

echo ""
echo "Step 3: Applying patches..."
echo ""

# Patch hooks.js
if [ "$HOOKS_PATCHED" = false ]; then
    # Find and replace the runBeforeAgentStart function
    # We need to add: messages: next.messages ?? acc?.messages,
    
    # Use sed to insert the line after systemPrompt
    if sed -i.tmp 's/systemPrompt: next.systemPrompt ?? acc?.systemPrompt,/systemPrompt: next.systemPrompt ?? acc?.systemPrompt,\n            messages: next.messages ?? acc?.messages,  \/\/ PATCHED: smart-context/' "$HOOKS_FILE"; then
        rm -f "${HOOKS_FILE}.tmp"
        echo -e "  ${GREEN}✓${NC} Patched hooks.js"
    else
        echo -e "  ${RED}✗${NC} Failed to patch hooks.js"
        exit 1
    fi
fi

# Patch attempt.js
if [ "$ATTEMPT_PATCHED" = false ]; then
    # Find the prependContext block and add message handling after it
    # We need to add the message replacement code after the prependContext if block
    
    PATCH_CODE='                        // PATCHED: Smart context - allow hooks to filter/replace messages\n                        if (hookResult?.messages \&\& Array.isArray(hookResult.messages)) {\n                            const originalCount = activeSession.messages.length;\n                            activeSession.agent.replaceMessages(hookResult.messages);\n                            log.debug(`hooks: replaced messages (${originalCount} -> ${hookResult.messages.length})`);\n                        }'
    
    # Insert after the closing brace of the prependContext if block
    if sed -i.tmp "/log.debug(\`hooks: prepended context to prompt/a\\
$PATCH_CODE" "$ATTEMPT_FILE"; then
        rm -f "${ATTEMPT_FILE}.tmp"
        echo -e "  ${GREEN}✓${NC} Patched attempt.js"
    else
        echo -e "  ${RED}✗${NC} Failed to patch attempt.js"
        exit 1
    fi
fi

echo ""
echo "Step 4: Verifying patches..."
echo ""

VERIFY_OK=true

if check_patched "$HOOKS_FILE" "messages: next.messages"; then
    echo -e "  ${GREEN}✓${NC} hooks.js verified"
else
    echo -e "  ${RED}✗${NC} hooks.js verification failed"
    VERIFY_OK=false
fi

if check_patched "$ATTEMPT_FILE" "hookResult?.messages"; then
    echo -e "  ${GREEN}✓${NC} attempt.js verified"
else
    echo -e "  ${RED}✗${NC} attempt.js verification failed"
    VERIFY_OK=false
fi

echo ""

if [ "$VERIFY_OK" = true ]; then
    echo -e "${GREEN}======================================"
    echo "Patches applied successfully!"
    echo "======================================${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Restart Clawdbot gateway: clawdbot gateway restart"
    echo "  2. Test smart context filtering"
    echo ""
    echo "If issues occur, restore backups with: ./revert-patches.sh"
else
    echo -e "${RED}Patch verification failed!${NC}"
    echo "Run ./revert-patches.sh to restore original files."
    exit 1
fi
