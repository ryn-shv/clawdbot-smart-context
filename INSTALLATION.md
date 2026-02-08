# Installation Guide - Smart Context v2.1.1

This guide covers installation, post-install setup, and verification for the Smart Context plugin.

---

## Prerequisites

### System Requirements
- **Node.js**: >=18.0.0 (Clawdbot typically uses Node 22)
- **Clawdbot**: >=1.0.0
- **Platform**: macOS (arm64), Linux (x64), Windows (x64)
- **Disk Space**: ~500MB for embedding models (downloaded on first use)
- **Memory**: 200MB RAM minimum for plugin operation

### Clawdbot Installation
Ensure Clawdbot is installed and working:

```bash
# Check Clawdbot version
clawdbot --version

# Check gateway status
clawdbot gateway status
```

---

## Installation Methods

### Method 1: NPM Package (Recommended)

```bash
npm install -g clawdbot-smart-context
```

This will:
1. Install the plugin package globally
2. Run post-install scripts (see below)
3. Set up database schemas
4. Verify Clawdbot patches

### Method 2: From Source

```bash
# Clone repository
git clone https://github.com/ryn-shv/clawdbot-smart-context.git
cd clawdbot-smart-context

# Install dependencies
npm install

# Link globally (for development)
npm link
```

---

## Post-Install Setup

The plugin requires patches to Clawdbot core to enable message filtering in hooks. These are applied automatically during `npm install` but can be re-applied manually:

### Automatic Patch Application

During installation, the `postinstall` script runs:

```bash
npm run postinstall
```

This:
1. Checks if Clawdbot is installed
2. Backs up original files
3. Applies patches to `hooks.js` and `attempt.js`
4. Verifies patch integrity

### Manual Patch Application

If automatic patching fails or after a Clawdbot update:

```bash
# Navigate to plugin directory
cd $(npm root -g)/clawdbot-smart-context

# Apply patches
./scripts/apply-patches.sh

# Verify patches applied
./scripts/check-patches.sh
```

#### What Gets Patched?

The plugin patches two Clawdbot core files:

1. **`dist/plugins/hooks.js`** - Adds message return capability to `before_agent_start` hook
   - Line added: `messages: next.messages ?? acc?.messages`
   
2. **`dist/agents/pi-embedded-runner/run/attempt.js`** - Enables message replacement in agent runner
   - Code added: Message filtering logic after hook execution

**Backups are created automatically** as `*.smart-context-backup`.

---

## Configuration

### Basic Configuration

Add to `~/.clawdbot/clawdbot.json`:

```json
{
  "plugins": {
    "load": {
      "packages": ["clawdbot-smart-context"]
    },
    "entries": {
      "smart-context": {
        "enabled": true,
        "config": {
          "topK": 10,
          "recentN": 3,
          "minScore": 0.65,
          "cachePath": "~/.clawdbot/smart-context-cache.db",
          "debug": false
        }
      }
    }
  }
}
```

### Environment Variables (Alternative)

```bash
# Enable plugin
export SC_ENABLED=true

# Core settings
export SC_TOP_K=10
export SC_RECENT_N=3
export SC_MIN_SCORE=0.65

# Memory system (v2.1+)
export SC_MEMORY=true
export SC_STORAGE_MODE=hybrid

# Debug logging
export SC_DEBUG=true
```

### Configuration Priority

Config is resolved in this order (highest to lowest):
1. Plugin config in `clawdbot.json`
2. Environment variables
3. Default values

---

## Database Initialization

The plugin uses SQLite for caching and memory storage. Database initialization happens automatically on first run.

### Database Location

Default: `~/.clawdbot/smart-context-cache.db`

Override in config:
```json
{
  "cachePath": "/custom/path/to/cache.db"
}
```

### Schema Creation

On first run, the following tables are created:

#### Core Tables
- `embeddings` - Embedding vector cache (content_hash → embedding)
- `message_index` - Message metadata for deduplication

#### Memory Tables (Phase 4)
- `memory_facts` - Structured facts with scopes
- `memory_patterns` - Behavioral patterns
- `memory_interactions` - Fact access tracking
- `memory_summaries` - Semantic summaries (v2.1+)

#### FTS5 Tables (if supported)
- `fts_messages` - Full-text search index
- `fts_summaries` - Summary full-text search (v2.1+)

### Verify Database

```bash
# Check database exists
ls -lh ~/.clawdbot/smart-context-cache.db

# Inspect schema
sqlite3 ~/.clawdbot/smart-context-cache.db ".schema"

# Check table counts
sqlite3 ~/.clawdbot/smart-context-cache.db "
  SELECT 'embeddings' as table_name, COUNT(*) as count FROM embeddings
  UNION ALL
  SELECT 'memory_facts', COUNT(*) FROM memory_facts
  UNION ALL
  SELECT 'memory_summaries', COUNT(*) FROM memory_summaries;
"
```

---

## Verification

### 1. Check Plugin Loading

```bash
# List loaded plugins
clawdbot plugins list

# Should see: smart-context v2.1.1 (enabled)
```

### 2. Check Logs

```bash
# Watch gateway logs
tail -f ~/.clawdbot/logs/gateway.log | grep smart-context

# Expected output:
# {"message":"Registering smart-context plugin","data":{"version":"2.1.1"}}
# {"message":"Cache initialized"}
# {"message":"Memory system initialized","data":{"enabled":true}}
# {"message":"✅ Smart context v2.1 initialized"}
```

### 3. Test Memory System

Run the included test script:

```bash
cd $(npm root -g)/clawdbot-smart-context
node test-memory.js
```

Expected output:
```
Running Smart Context Memory Tests...

✓ Store fact with embedding
✓ Retrieve facts by semantic similarity  
✓ Store summary with deduplication
✓ Hybrid retrieval (facts + summaries)
✓ User isolation (facts don't leak)
✓ Session cleanup

✅ ALL TESTS PASSED - Memory system working correctly!
```

### 4. Test Semantic Filtering

Start Clawdbot and have a conversation:

```bash
clawdbot gateway restart

# In your Clawdbot chat:
# 1. Have a long conversation (50+ messages)
# 2. Check logs for filtering:
tail -f ~/.clawdbot/logs/smart-context-plugin.log | grep "Filtered"

# Expected:
# Filtered: 240 messages → 15 messages (93.8% reduction)
```

### 5. Verify Patches

```bash
cd $(npm root -g)/clawdbot-smart-context
./scripts/check-patches.sh

# Expected output:
# ✓ hooks.js (message return): Patched
# ✓ attempt.js (message replace): Patched
# All patches are applied!
```

---

## Troubleshooting

### Issue: Plugin Not Loading

**Symptoms:**
- Plugin not listed in `clawdbot plugins list`
- No smart-context logs in gateway.log

**Solutions:**

1. **Check package installation:**
   ```bash
   npm list -g clawdbot-smart-context
   ```

2. **Verify config syntax:**
   ```bash
   cat ~/.clawdbot/clawdbot.json | jq '.plugins'
   # Should output valid JSON
   ```

3. **Check file permissions:**
   ```bash
   ls -l $(npm root -g)/clawdbot-smart-context
   # Files should be readable
   ```

4. **Restart gateway with verbose logging:**
   ```bash
   clawdbot gateway stop
   DEBUG=* clawdbot gateway start
   ```

---

### Issue: Native Module Errors

**Symptoms:**
```
Error: MODULE_NOT_FOUND: better-sqlite3
# or
Error: NODE_MODULE_VERSION mismatch
```

**Solution:**

Native modules must be compiled with the **same Node version** that Clawdbot uses.

```bash
# Find Clawdbot's Node version
head -n1 $(which clawdbot)
# e.g., #!/usr/local/bin/node

# Rebuild with correct Node
cd $(npm root -g)/clawdbot-smart-context
rm -rf node_modules
PATH="/usr/local/bin:$PATH" /usr/local/bin/npm install

# Restart gateway
clawdbot gateway restart
```

---

### Issue: Patches Not Applied

**Symptoms:**
```
./scripts/check-patches.sh
○ hooks.js: Not patched
```

**Solution:**

```bash
cd $(npm root -g)/clawdbot-smart-context

# Reapply patches
./scripts/apply-patches.sh

# If that fails, check Clawdbot location
export CLAWDBOT_DIR=/path/to/clawdbot
./scripts/apply-patches.sh

# Restart gateway
clawdbot gateway restart
```

To find Clawdbot location:
```bash
which clawdbot
# Then: ls -l /path/from/above
# Follow symlinks to find actual installation
```

---

### Issue: Embedding Errors

**Symptoms:**
```
Error: Failed to load embedding model
# or
Error: ENOSPC (no space left on device)
```

**Solutions:**

1. **Check disk space (models are ~500MB):**
   ```bash
   df -h ~
   ```

2. **Clear npm cache if needed:**
   ```bash
   npm cache clean --force
   ```

3. **Manual model download:**
   ```bash
   # The plugin downloads models to:
   ~/.cache/transformers.js/
   
   # Verify download:
   ls -lh ~/.cache/transformers.js/
   ```

---

### Issue: Database Errors

**Symptoms:**
```
Error: SQLITE_CANTOPEN: unable to open database file
# or
Error: database is locked
```

**Solutions:**

1. **Check database path:**
   ```bash
   ls -l ~/.clawdbot/smart-context-cache.db
   ```

2. **Check write permissions:**
   ```bash
   touch ~/.clawdbot/test-write
   rm ~/.clawdbot/test-write
   ```

3. **If database is corrupted:**
   ```bash
   # Backup and recreate
   mv ~/.clawdbot/smart-context-cache.db{,.backup}
   clawdbot gateway restart
   # Database will be recreated
   ```

4. **Check for lock files:**
   ```bash
   ls -la ~/.clawdbot/smart-context-cache.db*
   rm ~/.clawdbot/smart-context-cache.db-shm
   rm ~/.clawdbot/smart-context-cache.db-wal
   ```

---

### Issue: Memory Not Extracting

**Symptoms:**
- Conversations happen but no facts stored
- `SELECT COUNT(*) FROM memory_facts` returns 0

**Solutions:**

1. **Enable memory extraction:**
   ```json
   {
     "smart-context": {
       "config": {
         "SC_MEMORY": true,
         "SC_MEMORY_EXTRACT": true
       }
     }
   }
   ```

2. **Check extraction logs:**
   ```bash
   tail -f ~/.clawdbot/logs/smart-context-plugin.log | grep extraction
   ```

3. **Verify LLM model access:**
   ```bash
   # Extraction uses Gemini Flash by default
   # Check API key:
   echo $GEMINI_API_KEY
   ```

4. **Run test script:**
   ```bash
   node test-memory.js
   ```

---

## Health Check Script

Create a health check script to verify installation:

```bash
#!/bin/bash
# health-check.sh

echo "Smart Context Health Check"
echo "=========================="
echo

# 1. Plugin installed
if npm list -g clawdbot-smart-context &>/dev/null; then
  echo "✓ Plugin installed"
else
  echo "✗ Plugin not installed"
  exit 1
fi

# 2. Patches applied
cd $(npm root -g)/clawdbot-smart-context
if ./scripts/check-patches.sh &>/dev/null; then
  echo "✓ Patches applied"
else
  echo "✗ Patches missing - run ./scripts/apply-patches.sh"
fi

# 3. Database exists
if [ -f ~/.clawdbot/smart-context-cache.db ]; then
  echo "✓ Database exists"
  
  # Count records
  embeddings=$(sqlite3 ~/.clawdbot/smart-context-cache.db "SELECT COUNT(*) FROM embeddings")
  facts=$(sqlite3 ~/.clawdbot/smart-context-cache.db "SELECT COUNT(*) FROM memory_facts" 2>/dev/null || echo 0)
  echo "  - Embeddings: $embeddings"
  echo "  - Facts: $facts"
else
  echo "○ Database not yet created (will be created on first use)"
fi

# 4. Config exists
if grep -q "smart-context" ~/.clawdbot/clawdbot.json 2>/dev/null; then
  echo "✓ Plugin configured"
else
  echo "○ Plugin not configured in clawdbot.json"
fi

echo
echo "Health check complete!"
```

Run:
```bash
chmod +x health-check.sh
./health-check.sh
```

---

## Uninstallation

### Remove Plugin

```bash
npm uninstall -g clawdbot-smart-context
```

### Revert Patches

```bash
cd $(npm root -g)/clawdbot-smart-context
./scripts/revert-patches.sh

# Or manually restore backups:
CLAWDBOT_DIR=~/.npm-global/lib/node_modules/clawdbot
cp $CLAWDBOT_DIR/dist/plugins/hooks.js.smart-context-backup \
   $CLAWDBOT_DIR/dist/plugins/hooks.js
cp $CLAWDBOT_DIR/dist/agents/pi-embedded-runner/run/attempt.js.smart-context-backup \
   $CLAWDBOT_DIR/dist/agents/pi-embedded-runner/run/attempt.js
```

### Remove Data

```bash
# Remove database
rm ~/.clawdbot/smart-context-cache.db

# Remove model cache (optional, ~500MB)
rm -rf ~/.cache/transformers.js/
```

### Remove Config

Edit `~/.clawdbot/clawdbot.json` and remove the `smart-context` entry.

---

## Next Steps

- **Configuration Tuning**: See [CONFIGURATION.md](./CONFIGURATION.md) for advanced options
- **Architecture**: Read the [README](./README.md) to understand how it works
- **Performance**: Check [CONFIGURATION.md](./CONFIGURATION.md) for optimization tips
- **API Reference**: See [README](./README.md) for programmatic usage

---

## Support

- **Issues**: https://github.com/ryn-shv/clawdbot-smart-context/issues
- **Documentation**: https://github.com/ryn-shv/clawdbot-smart-context
- **Clawdbot Docs**: https://docs.clawd.bot
