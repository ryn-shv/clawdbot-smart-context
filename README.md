# 🧠 Smart Context for Clawdbot

> Semantic context selection plugin that filters message history by relevance, reducing token usage by 80-95% while maintaining conversation quality.

[![npm version](https://badge.fury.io/js/clawdbot-smart-context.svg)](https://www.npmjs.com/package/clawdbot-smart-context)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Features

- **80-95% token reduction** on long conversations
- **Semantic filtering** using local embeddings (no API calls)
- **SQLite cache** for fast repeated queries
- **FTS5 full-text search** for keyword-based retrieval
- **Memory extraction** - automatically captures facts from conversations
- **Tool result indexing** - searchable history of past tool outputs
- **Multi-query expansion** for complex questions
- **Cross-encoder reranking** for precision
- **Zero latency** on cache hits (<50ms)

## 📦 Installation

```bash
npm install clawdbot-smart-context
```

## 🚀 Quick Start

Add to your `~/.clawdbot/clawdbot.json`:

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

Then restart Clawdbot:

```bash
clawdbot gateway restart
```

## ⚙️ Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `topK` | number | `10` | Number of most relevant messages to keep |
| `recentN` | number | `3` | Always keep last N messages for continuity |
| `minScore` | number | `0.65` | Minimum similarity score (0-1) to include a message |
| `cachePath` | string | `~/.clawdbot/smart-context-cache.db` | SQLite database path |
| `debug` | boolean | `false` | Enable debug logging |

### Advanced Configuration

```json
{
  "smart-context": {
    "enabled": true,
    "config": {
      "topK": 15,
      "recentN": 5,
      "minScore": 0.7,
      "stripOldToolCalls": false,
      "cachePath": "~/my-cache.db",
      "debug": true,
      
      // Phase 2: FTS5 Search
      "fts5": { "enabled": true },
      
      // Phase 3: Advanced Features
      "multiQuery": { "enabled": false },
      "reranker": { "enabled": false },
      
      // Phase 4: Memory & Tool Indexing
      "memory": { "enabled": true, "extract": true },
      "toolIndex": { "enabled": true }
    }
  }
}
```

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
│  2. Score all messages              │
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

## 📊 Performance

| Metric | Cold Cache | Warm Cache |
|--------|-----------|------------|
| **First message** | 2-5s | 200-500ms |
| **Subsequent** | 500ms | <50ms |
| **Token savings** | 80-95% | 80-95% |
| **Accuracy** | 95%+ | 95%+ |

## 🎯 Use Cases

- **Long conversations** (100+ messages)
- **Multi-topic threads** (focus on relevant context)
- **High-context models** (MiniMax, Kimi) - reduce costs
- **Provider switching** - maintain compatibility

---

## 🧠 Phase 4: Memory System (v2.0.2)

The Memory System enables persistent fact storage across sessions, allowing the AI to remember user preferences, project details, and patterns.

### Enabling Memory

Memory is **disabled by default**. Enable it with environment variables or plugin config:

#### Option 1: Environment Variables

```bash
# Enable memory storage and retrieval
export SC_MEMORY=true

# Enable automatic fact extraction (optional, auto-enabled with SC_MEMORY)
export SC_MEMORY_EXTRACT=true
```

#### Option 2: Plugin Config

In `~/.clawdbot/clawdbot.json`:

```json
{
  "plugins": {
    "entries": {
      "smart-context": {
        "enabled": true,
        "config": {
          "SC_MEMORY": true,
          "SC_MEMORY_EXTRACT": true
        }
      }
    }
  }
}
```

### Memory Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SC_MEMORY` | `false` | Enable memory system |
| `SC_MEMORY_EXTRACT` | auto | Enable LLM-based fact extraction (auto-enabled with memory) |
| `SC_EXTRACT_BATCH_SIZE` | `5` | Messages to accumulate before extraction |
| `SC_EXTRACT_MIN_CONFIDENCE` | `0.7` | Minimum confidence to store a fact |
| `SC_EXTRACT_MODEL` | `gemini-2.5-flash` | LLM model for extraction |
| `SC_MEMORY_MAX_FACTS` | `10` | Max facts to inject into context |
| `SC_MEMORY_MIN_SCORE` | `0.75` | Similarity threshold for retrieval |
| `SC_MEMORY_SESSION_TTL` | `86400000` | Session fact TTL (24h) |
| `SC_MEMORY_AGENT_LIMIT` | `500` | Max facts per agent |
| `SC_MEMORY_USER_LIMIT` | `1000` | Max global facts per user |

### Memory Scopes

Facts are stored in three scopes:

1. **User Scope** - Global facts visible to all agents
   - Example: "User prefers TypeScript"
   
2. **Agent Scope** - Per-agent learnings
   - Example: "This project uses React"
   
3. **Session Scope** - Ephemeral, expires after session
   - Example: "Currently debugging login issue"

### How Memory Works

```
┌──────────────────────────────────────────────────────────────┐
│                    MEMORY PIPELINE                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Conversation                                               │
│   ┌─────────┐                                                │
│   │ Message │──┐                                             │
│   └─────────┘  │                                             │
│   ┌─────────┐  │   ┌───────────────┐   ┌─────────────────┐   │
│   │ Message │──┼──▶│ LLM Extraction│──▶│ Compute         │   │
│   └─────────┘  │   │ (Gemini Flash)│   │ Embeddings      │   │
│   ┌─────────┐  │   └───────────────┘   └────────┬────────┘   │
│   │ Message │──┘                                │            │
│   └─────────┘                                   ▼            │
│                                         ┌───────────────┐    │
│                                         │ SQLite Store  │    │
│                                         │ - Facts       │    │
│                                         │ - Embeddings  │    │
│                                         │ - Patterns    │    │
│                                         └───────────────┘    │
│                                                 │            │
│   New Query ──────────────────────────────────┐ │            │
│                                               ▼ ▼            │
│                                         ┌───────────────┐    │
│                                         │ Hybrid Search │    │
│                                         │ BM25 + Cosine │    │
│                                         └───────┬───────┘    │
│                                                 │            │
│                                                 ▼            │
│                                         Relevant Facts       │
│                                         Injected into        │
│                                         Context              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Testing Memory

Run the included test script to verify memory is working:

```bash
cd ~/clawd/patches/smart-context/smart-context
node test-memory.js
```

Expected output:
```
✅ ALL TESTS PASSED - Memory system working correctly!
```

### Important: v2.0.2 Fixes

Version 2.0.2 fixes critical bugs in the memory system:

1. **Embeddings Now Stored** - `storeFact()` properly stores embeddings in the database
2. **Semantic Search Works** - Facts are retrieved using vector similarity, not just keywords
3. **Hybrid Scoring** - 60% cosine similarity + 40% BM25 for best of both worlds

If you were using an earlier version, facts stored without embeddings will fall back to BM25-only scoring (still works, but less accurate).

---

## 🛠️ Features by Phase

### Phase 1: Core Filtering ✅
- Semantic similarity scoring
- SQLite embedding cache
- Message selection

### Phase 2: FTS5 Search ✅
- Keyword-based retrieval
- 2x speedup on keyword queries
- Hybrid semantic + keyword search

### Phase 3: Advanced Features ✅
- **Multi-query expansion** - break complex questions into sub-queries
- **Cross-encoder reranking** - precision scoring

### Phase 4: Memory & Tools ✅
- **Memory extraction** - automatic fact capture
- **Tool result indexing** - searchable tool history
- **v2.0.2**: Proper embedding storage and semantic retrieval

## 📝 Requirements

- **Node.js:** >=18.0.0
- **Clawdbot:** >=1.0.0
- **Platform:** macOS (arm64), Linux (x64), Windows (x64)

## 🔧 Troubleshooting

### Plugin not loading

```bash
# Check if plugin is recognized
clawdbot plugins list

# Check logs
tail -f ~/.clawdbot/logs/gateway.log | grep smart-context
```

### Embedding errors

Ensure you have enough disk space (~500MB for model download on first run).

### Memory not working

1. Check if memory is enabled:
   ```bash
   echo $SC_MEMORY
   # Should output: true
   ```

2. Run the test script:
   ```bash
   node test-memory.js
   ```

3. Check database for stored facts:
   ```bash
   sqlite3 ~/.clawdbot/smart-context-cache.db "SELECT COUNT(*) FROM memory_facts"
   ```

### Performance issues

- Reduce `topK` (try 5-8)
- Increase `minScore` (try 0.75-0.8)
- Disable advanced features if not needed

## 📚 Documentation

- [Configuration Guide](./docs/CONFIGURATION.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Performance Tuning](./docs/PERFORMANCE.md)

## 🤝 Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## 📄 License

MIT © rynshv

## 🔗 Links

- [GitHub Repository](https://github.com/ryn-shv/clawdbot-smart-context)
- [npm Package](https://www.npmjs.com/package/clawdbot-smart-context)
- [Issue Tracker](https://github.com/ryn-shv/clawdbot-smart-context/issues)
- [Clawdbot Docs](https://docs.clawd.bot)

---

## Changelog

### v2.0.2 (2025-01-XX)
- **CRITICAL FIX**: `storeFact()` now properly stores embeddings via `cache.set()`
- **CRITICAL FIX**: Extractor now computes embeddings for extracted facts
- **FIX**: `retrieveFacts()` properly handles missing embeddings with BM25 fallback
- **NEW**: `memory.stats()` includes embedding coverage percentage
- **NEW**: `bulkStoreFacts()` for efficient batch storage with embeddings
- **NEW**: Test script (`test-memory.js`) for end-to-end verification

### v2.0.1
- Initial Phase 4 Memory System release
- Schema initialization for memory tables
- Basic fact storage and retrieval

### v2.0.0
- Major rewrite with modular architecture
- Added tool result summarization
- Performance optimizations

---

**Made with ⚡ by the Clawdbot community**
