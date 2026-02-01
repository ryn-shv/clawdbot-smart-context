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

- [GitHub Repository](https://github.com/shivammehta007/clawdbot-smart-context)
- [npm Package](https://www.npmjs.com/package/clawdbot-smart-context)
- [Issue Tracker](https://github.com/shivammehta007/clawdbot-smart-context/issues)
- [Clawdbot Docs](https://docs.clawd.bot)

---

**Made with ⚡ by the Clawdbot community**
