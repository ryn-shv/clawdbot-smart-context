# Quick Start Guide - Smart Context v2.1.1

Get Smart Context up and running in 5 minutes.

---

## Step 1: Install (1 minute)

```bash
npm install -g clawdbot-smart-context
```

The post-install script will:
- ✅ Find your Clawdbot installation
- ✅ Apply required patches
- ✅ Verify everything is set up

---

## Step 2: Configure (2 minutes)

Edit `~/.clawdbot/clawdbot.json`:

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
          "minScore": 0.65
        }
      }
    }
  }
}
```

**Quick Config Explanation:**
- `topK: 10` - Keep the 10 most relevant messages
- `recentN: 3` - Always keep the last 3 messages (for conversation flow)
- `minScore: 0.65` - Similarity threshold (0-1, higher = stricter)

---

## Step 3: Restart Clawdbot (1 minute)

```bash
clawdbot gateway restart
```

---

## Step 4: Verify (1 minute)

### Check Plugin Loaded

```bash
clawdbot plugins list
```

Expected output:
```
smart-context v2.1.1 (enabled)
```

### Check Logs

```bash
tail -f ~/.clawdbot/logs/gateway.log | grep smart-context
```

Expected output:
```json
{"message":"Registering smart-context plugin","data":{"version":"2.1.1"}}
{"message":"Cache initialized"}
{"message":"Memory system initialized","data":{"enabled":false}}
{"message":"✅ Smart context v2.1 initialized"}
```

### Run Health Check

```bash
npx smart-context-health
```

Expected:
```
✅ Health check passed!
   Smart Context is ready to use.
```

---

## Step 5: Test It! (Optional)

Have a conversation with Clawdbot and watch the token savings:

```bash
# In another terminal, watch the logs:
tail -f ~/.clawdbot/logs/smart-context-plugin.log | grep "Filtered"
```

You'll see output like:
```
Filtered: 120 messages → 13 messages (89.2% reduction)
Filtered: 240 messages → 15 messages (93.8% reduction)
```

---

## Common Configuration Scenarios

### Scenario 1: Maximum Token Savings (Long Conversations)

```json
{
  "topK": 8,
  "recentN": 2,
  "minScore": 0.75
}
```

**Result:** 95%+ token reduction, very aggressive filtering

---

### Scenario 2: Balanced (Recommended Default)

```json
{
  "topK": 10,
  "recentN": 3,
  "minScore": 0.65
}
```

**Result:** 85-90% token reduction, maintains quality

---

### Scenario 3: Conservative (Preserve More Context)

```json
{
  "topK": 20,
  "recentN": 5,
  "minScore": 0.55
}
```

**Result:** 70-80% token reduction, maximum context retention

---

## Enable Advanced Features

### Memory System (Facts + Summaries)

Add to config:

```json
{
  "smart-context": {
    "config": {
      "SC_MEMORY": true,
      "SC_STORAGE_MODE": "hybrid"
    }
  }
}
```

This enables:
- ✅ Automatic fact extraction from conversations
- ✅ Semantic summaries for context recall
- ✅ Persistent memory across sessions

Test it:
```bash
cd $(npm root -g)/clawdbot-smart-context
node test-memory.js
```

---

### Full-Text Search (FTS5)

```json
{
  "fts5": { "enabled": true }
}
```

Enables keyword-based search in addition to semantic similarity.

---

### Multi-Query Expansion

```json
{
  "multiQuery": { "enabled": true }
}
```

Breaks complex questions into sub-queries for better retrieval.

---

## Troubleshooting Quick Fixes

### Plugin Not Loading?

```bash
# 1. Check installation
npm list -g clawdbot-smart-context

# 2. Check config syntax
cat ~/.clawdbot/clawdbot.json | jq .

# 3. Check logs
tail -20 ~/.clawdbot/logs/gateway.log
```

---

### Patches Not Applied?

```bash
# Re-apply patches
cd $(npm root -g)/clawdbot-smart-context
npm run apply-patches

# Verify
npm run check-patches
```

---

### Native Module Errors?

```bash
# Rebuild with correct Node version
cd $(npm root -g)/clawdbot-smart-context
rm -rf node_modules
npm install

# Restart
clawdbot gateway restart
```

---

## What's Next?

- **Tune performance**: See [CONFIGURATION.md](./CONFIGURATION.md)
- **Understand architecture**: See the [README](./README.md)
- **Full installation guide**: See [INSTALLATION.md](./INSTALLATION.md)
- **Report issues**: https://github.com/ryn-shv/clawdbot-smart-context/issues

---

## Need Help?

- 📖 **Full docs**: [INSTALLATION.md](./INSTALLATION.md)
- 🐛 **Issues**: https://github.com/ryn-shv/clawdbot-smart-context/issues
- 💬 **Clawdbot community**: https://discord.gg/clawdbot

---

**That's it! You're now saving 80-95% on token costs while maintaining conversation quality.** 🚀
