# 🧠 Smart Context for Clawdbot

> Semantic context selection plugin that filters message history by relevance, reducing token usage by 80-95% while maintaining conversation quality.

[![npm version](https://badge.fury.io/js/clawdbot-smart-context.svg)](https://www.npmjs.com/package/clawdbot-smart-context)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## ✨ Features

- **80-95% token reduction** on long conversations
- **Semantic filtering** using local embeddings (no API calls)
- **Hybrid memory system** - facts + summaries (v2.1+)
- **SQLite cache** for instant repeated queries
- **FTS5 full-text search** for keyword-based retrieval
- **Memory extraction** - automatically captures facts from conversations
- **Tool result indexing** - searchable history of past tool outputs
- **Multi-query expansion** for complex questions
- **Cross-encoder reranking** for precision
- **Zero latency** on cache hits (<50ms)

---

## 📦 Quick Start

### Install

```bash
npm install -g clawdbot-smart-context
```

### Configure

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
          "minScore": 0.65
        }
      }
    }
  }
}
```

### Restart

```bash
clawdbot gateway restart
```

### Verify

```bash
clawdbot plugins list
# Should show: smart-context v2.1.1 (enabled)

npx smart-context-health
# Health check will verify everything is working
```

**📖 Full setup guide:** [QUICKSTART.md](./QUICKSTART.md)

---

## 🧩 How It Works

```
┌─────────────────┐
│  User Message   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Smart Context Plugin               │
│  1. Embed query (local model)       │
│  2. Score all messages (cosine)     │
│  3. Select top-K + recent-N         │
│  4. Return filtered messages        │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────┐
│   LLM Call      │
│  10-15 messages │
│  instead of 100+│
└─────────────────┘
```

---

## 🚀 What's New in v2.1.1

### Hybrid Memory System

**Dual extraction:** Facts + Summaries from the same conversation

- **Facts:** Structured, precise ("User prefers TypeScript")
- **Summaries:** Semantic context ("Discussed API design decisions for Voais project")

**Storage modes:**
- `facts` - Structured facts only
- `semantic` - Summaries only
- `hybrid` - Both (recommended)

### Critical Bug Fixes

- ✅ Memory extraction now processes **both user and assistant messages** (previously only assistant)
- ✅ Config system fixed - all flags now properly read from plugin config
- ✅ Hook registration timing fixed - no more missing hooks
- ✅ Extraction prompt improved - captures project decisions from conversations

### Performance

- **Token reduction:** 80-98% on long conversations (verified in production)
- **Cache hit latency:** <100ms
- **Warm path:** 200-500ms with embedding computation
- **Memory retrieval:** <50ms for 100+ facts

---

## 📊 Performance

| Metric | Cold Cache | Warm Cache |
|--------|-----------|------------|
| **First message** | 2-5s | 200-500ms |
| **Subsequent** | 500ms | <50ms |
| **Token savings** | 80-95% | 80-95% |
| **Accuracy** | 95%+ | 95%+ |

**Real example from production:**
```
Input:  240 messages, 260,875 tokens
Output: 10 messages, 5,125 tokens
Saved:  255,750 tokens (98% reduction)
Time:   450ms
```

---

## 🎯 Use Cases

- **Long conversations** (100+ messages)
- **Multi-topic threads** (focus on relevant context)
- **High-context models** (MiniMax, Kimi) - reduce costs
- **Provider switching** - maintain compatibility
- **Persistent memory** - remember user preferences across sessions
- **Project context** - recall decisions and architecture choices

---

## ⚙️ Configuration

### Basic

```json
{
  "topK": 10,          // Keep 10 most relevant messages
  "recentN": 3,        // Always keep last 3 messages
  "minScore": 0.65     // Similarity threshold (0-1)
}
```

### Enable Memory

```json
{
  "SC_MEMORY": true,
  "SC_STORAGE_MODE": "hybrid"
}
```

### Advanced Features

```json
{
  "fts5": { "enabled": true },          // Full-text search
  "multiQuery": { "enabled": true },    // Multi-query expansion
  "reranker": { "enabled": true },      // Cross-encoder reranking
  "toolIndex": { "enabled": true }      // Tool result indexing
}
```

**📖 Complete config reference:** [CONFIGURATION.md](./CONFIGURATION.md)

---

## 🧠 Memory System

### Three-Tier Scope

1. **User Scope** - Global facts across all agents
   - Example: "User prefers TypeScript"
   
2. **Agent Scope** - Per-agent learnings
   - Example: "This project uses React"
   
3. **Session Scope** - Ephemeral facts (24h TTL)
   - Example: "Currently debugging login issue"

### Hybrid Extraction (v2.1+)

**Single LLM call produces:**
- Structured facts for precision lookup
- Semantic summaries for context recall
- Entity and project tagging
- Automatic deduplication

### Testing Memory

```bash
cd $(npm root -g)/clawdbot-smart-context
node test-memory.js
```

Expected output:
```
✅ ALL TESTS PASSED - Memory system working correctly!
```

**📖 Version history:** [CHANGELOG.md](./CHANGELOG.md)

---

## 🛠️ Installation & Setup

### System Requirements

- **Node.js:** >=18.0.0 (Clawdbot typically uses Node 22)
- **Clawdbot:** >=1.0.0
- **Platform:** macOS (arm64), Linux (x64), Windows (x64)
- **Disk Space:** ~500MB for embedding models (downloaded on first use)

### Post-Install

The plugin requires patches to Clawdbot core. These are applied automatically during `npm install`.

**Verify patches:**
```bash
npx smart-context-patches --check
```

**Reapply if needed:**
```bash
npx smart-context-patches
```

**📖 Detailed installation:** [INSTALLATION.md](./INSTALLATION.md)

---

## 🧪 Testing

### Run Test Suite

```bash
# Memory system tests
npm test

# Health check
npm run health-check

# Verify patches
npm run check-patches
```

### Manual Testing

Start a long conversation with Clawdbot and watch the logs:

```bash
tail -f ~/.clawdbot/logs/smart-context-plugin.log | grep "Filtered"
```

You'll see:
```
Filtered: 120 messages → 13 messages (89.2% reduction)
```

---

## 🔧 Troubleshooting

### Quick Fixes

```bash
# Plugin not loading?
clawdbot plugins list
npm list -g clawdbot-smart-context

# Patches not applied?
npm run apply-patches
clawdbot gateway restart

# Native module errors?
cd $(npm root -g)/clawdbot-smart-context
rm -rf node_modules && npm install

# Health check
npm run health-check
```

**📖 Full troubleshooting guide:** [INSTALLATION.md#troubleshooting](./INSTALLATION.md#troubleshooting)

---

## 📚 Documentation

- **[QUICKSTART.md](./QUICKSTART.md)** - Get started in 5 minutes
- **[INSTALLATION.md](./INSTALLATION.md)** - Complete installation guide
- **[CONFIGURATION.md](./CONFIGURATION.md)** - All configuration options
- **[CHANGELOG.md](./CHANGELOG.md)** - Version history and migration notes

---

## 🎯 Roadmap

### ✅ Completed (v2.1.1)

- Core semantic filtering
- FTS5 full-text search
- Multi-query expansion
- Cross-encoder reranking
- Memory system with facts + summaries
- Hybrid extraction pipeline
- Tool result indexing

### 🔜 Planned

- **Phase 4B:** LLM-based extraction triggers
- Dynamic project context from stored memories
- Cross-project pattern detection
- Summary consolidation over time
- Importance scoring with temporal decay

---

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

**Issues:** https://github.com/ryn-shv/clawdbot-smart-context/issues

---

## 📄 License

MIT © rynshv

See [LICENSE](./LICENSE) for details.

---

## 🔗 Links

- **GitHub:** https://github.com/ryn-shv/clawdbot-smart-context
- **npm:** https://www.npmjs.com/package/clawdbot-smart-context
- **Issues:** https://github.com/ryn-shv/clawdbot-smart-context/issues
- **Clawdbot Docs:** https://docs.clawd.bot

---

## 🌟 Acknowledgments

Built with:
- [Transformers.js](https://huggingface.co/docs/transformers.js) - Local embeddings
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - Fast SQLite
- [Clawdbot](https://clawd.bot) - AI agent framework

---

**Made with ⚡ by the Clawdbot community**

---

## Version History

### v2.1.1 (2025-02-09) - Current

- Hybrid memory system (facts + summaries)
- Critical bug fixes in extraction and config
- Enhanced documentation
- Installation automation

### v2.0.x

- Initial public release
- Core semantic filtering
- Phase 1-4 features implemented

**Full changelog:** [CHANGELOG.md](./CHANGELOG.md)
