#!/bin/bash
#
# Smart Context Health Check
# Verifies installation, patches, database, and configuration
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CLAWDBOT_DIR="${CLAWDBOT_DIR:-$HOME/.npm-global/lib/node_modules/clawdbot}"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Smart Context Health Check           ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo

ALL_OK=true

# 1. Check Node.js version
echo -e "${BLUE}🔍 Checking Node.js...${NC}"
NODE_VERSION=$(node --version | sed 's/v//')
MAJOR_VERSION=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$MAJOR_VERSION" -ge 18 ]; then
    echo -e "  ${GREEN}✓${NC} Node.js $NODE_VERSION (>=18 required)"
else
    echo -e "  ${RED}✗${NC} Node.js $NODE_VERSION (>=18 required)"
    ALL_OK=false
fi

# 2. Check if plugin is installed
echo -e "\n${BLUE}🔍 Checking plugin installation...${NC}"
if npm list -g clawdbot-smart-context &>/dev/null; then
    VERSION=$(npm list -g clawdbot-smart-context --depth=0 2>/dev/null | grep clawdbot-smart-context | awk '{print $2}')
    echo -e "  ${GREEN}✓${NC} Plugin installed (version $VERSION)"
else
    echo -e "  ${RED}✗${NC} Plugin not installed"
    echo -e "      Run: npm install -g clawdbot-smart-context"
    ALL_OK=false
fi

# 3. Check Clawdbot installation
echo -e "\n${BLUE}🔍 Checking Clawdbot...${NC}"
if [ -d "$CLAWDBOT_DIR" ]; then
    echo -e "  ${GREEN}✓${NC} Clawdbot found at: $CLAWDBOT_DIR"
else
    echo -e "  ${RED}✗${NC} Clawdbot not found at: $CLAWDBOT_DIR"
    echo -e "      Set CLAWDBOT_DIR if installed elsewhere"
    ALL_OK=false
fi

# 4. Check patches
echo -e "\n${BLUE}🔍 Checking patches...${NC}"
if [ -d "$CLAWDBOT_DIR" ]; then
    HOOKS_FILE="$CLAWDBOT_DIR/dist/plugins/hooks.js"
    ATTEMPT_FILE="$CLAWDBOT_DIR/dist/agents/pi-embedded-runner/run/attempt.js"
    
    HOOKS_PATCHED=false
    ATTEMPT_PATCHED=false
    
    if grep -q "messages: next.messages" "$HOOKS_FILE" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} hooks.js patched"
        HOOKS_PATCHED=true
    else
        echo -e "  ${YELLOW}○${NC} hooks.js not patched"
        ALL_OK=false
    fi
    
    if grep -q "hookResult?.messages" "$ATTEMPT_FILE" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} attempt.js patched"
        ATTEMPT_PATCHED=true
    else
        echo -e "  ${YELLOW}○${NC} attempt.js not patched"
        ALL_OK=false
    fi
    
    if [ "$HOOKS_PATCHED" = false ] || [ "$ATTEMPT_PATCHED" = false ]; then
        echo -e "      ${YELLOW}Run:${NC} npm run apply-patches"
    fi
fi

# 5. Check database
echo -e "\n${BLUE}🔍 Checking database...${NC}"
DB_PATH="$HOME/.clawdbot/smart-context-cache.db"

if [ -f "$DB_PATH" ]; then
    DB_SIZE=$(ls -lh "$DB_PATH" | awk '{print $5}')
    echo -e "  ${GREEN}✓${NC} Database exists ($DB_SIZE)"
    
    # Check table counts (if sqlite3 is available)
    if command -v sqlite3 &>/dev/null; then
        EMBEDDINGS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM embeddings" 2>/dev/null || echo "0")
        FACTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM memory_facts" 2>/dev/null || echo "0")
        SUMMARIES=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM memory_summaries" 2>/dev/null || echo "0")
        
        echo -e "      Embeddings: $EMBEDDINGS"
        echo -e "      Facts: $FACTS"
        echo -e "      Summaries: $SUMMARIES"
    fi
else
    echo -e "  ${YELLOW}○${NC} Database not created yet (will be created on first use)"
fi

# 6. Check configuration
echo -e "\n${BLUE}🔍 Checking configuration...${NC}"
CONFIG_FILE="$HOME/.clawdbot/clawdbot.json"

if [ -f "$CONFIG_FILE" ]; then
    if grep -q "smart-context" "$CONFIG_FILE" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Plugin configured in clawdbot.json"
        
        # Check if enabled
        if command -v jq &>/dev/null; then
            ENABLED=$(jq -r '.plugins.entries["smart-context"].enabled // false' "$CONFIG_FILE" 2>/dev/null)
            if [ "$ENABLED" = "true" ]; then
                echo -e "      Status: ${GREEN}enabled${NC}"
            else
                echo -e "      Status: ${YELLOW}disabled${NC}"
            fi
        fi
    else
        echo -e "  ${YELLOW}○${NC} Plugin not configured in clawdbot.json"
        echo -e "      See INSTALLATION.md for configuration guide"
    fi
else
    echo -e "  ${YELLOW}○${NC} Config file not found: $CONFIG_FILE"
fi

# 7. Check logs
echo -e "\n${BLUE}🔍 Checking logs...${NC}"
LOG_FILE="$HOME/.clawdbot/logs/smart-context-plugin.log"

if [ -f "$LOG_FILE" ]; then
    LOG_SIZE=$(ls -lh "$LOG_FILE" | awk '{print $5}')
    LAST_LINE=$(tail -n 1 "$LOG_FILE" 2>/dev/null)
    echo -e "  ${GREEN}✓${NC} Log file exists ($LOG_SIZE)"
    
    # Check for recent activity (last 5 minutes)
    if [ -n "$(find "$LOG_FILE" -mmin -5 2>/dev/null)" ]; then
        echo -e "      ${GREEN}Recent activity detected${NC}"
    fi
else
    echo -e "  ${YELLOW}○${NC} No log file yet (plugin not run)"
fi

# 8. Check model cache
echo -e "\n${BLUE}🔍 Checking embedding models...${NC}"
MODEL_CACHE="$HOME/.cache/transformers.js"

if [ -d "$MODEL_CACHE" ]; then
    CACHE_SIZE=$(du -sh "$MODEL_CACHE" 2>/dev/null | awk '{print $1}')
    echo -e "  ${GREEN}✓${NC} Model cache exists ($CACHE_SIZE)"
else
    echo -e "  ${YELLOW}○${NC} Models not downloaded yet (will download on first use, ~500MB)"
fi

# Summary
echo
echo -e "${BLUE}═══════════════════════════════════════════${NC}"

if [ "$ALL_OK" = true ]; then
    echo -e "${GREEN}✅ Health check passed!${NC}"
    echo -e "${GREEN}   Smart Context is ready to use.${NC}"
else
    echo -e "${YELLOW}⚠️  Health check found issues${NC}"
    echo -e "${YELLOW}   See messages above for remediation steps.${NC}"
fi

echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo

# Next steps
if [ "$ALL_OK" = false ]; then
    echo -e "${BLUE}📋 Remediation Steps:${NC}"
    echo -e "   1. Apply patches: ${YELLOW}npm run apply-patches${NC}"
    echo -e "   2. Configure plugin in ~/.clawdbot/clawdbot.json"
    echo -e "   3. Restart Clawdbot: ${YELLOW}clawdbot gateway restart${NC}"
    echo -e "   4. Run health check again"
    echo
fi

exit $([ "$ALL_OK" = true ] && echo 0 || echo 1)
