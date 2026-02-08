# Configuration Guide - Smart Context v2.1.1

Complete reference for all configuration options.

---

## Configuration Methods

Smart Context supports three configuration methods (in priority order):

1. **Plugin config** in `~/.clawdbot/clawdbot.json` (highest priority)
2. **Environment variables**
3. **Default values** (lowest priority)

---

## Basic Configuration

### Minimal Setup

```json
{
  "plugins": {
    "load": {
      "packages": ["clawdbot-smart-context"]
    },
    "entries": {
      "smart-context": {
        "enabled": true
      }
    }
  }
}
```

All options use defaults.

---

### Recommended Setup

```json
{
  "plugins": {
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

---

## Core Options

### `enabled`

- **Type:** boolean
- **Default:** `true`
- **Description:** Master switch to enable/disable the plugin

```json
{
  "enabled": true
}
```

---

### `topK`

- **Type:** integer
- **Default:** `10`
- **Range:** 1-50
- **Description:** Number of most relevant messages to keep

**Impact:**
- Lower = more aggressive filtering, higher token savings
- Higher = more context retained, lower token savings

**Examples:**
```json
{ "topK": 5 }   // Aggressive (95%+ savings)
{ "topK": 10 }  // Balanced (85-90% savings)
{ "topK": 20 }  // Conservative (70-80% savings)
```

---

### `recentN`

- **Type:** integer
- **Default:** `3`
- **Range:** 1-10
- **Description:** Always keep the last N messages for conversation continuity

**Impact:**
- Ensures recent context is always included (even if similarity is low)
- Critical for follow-up questions and pronoun references

**Examples:**
```json
{ "recentN": 2 }  // Minimal continuity
{ "recentN": 3 }  // Recommended
{ "recentN": 5 }  // High continuity
```

---

### `minScore`

- **Type:** number
- **Default:** `0.65`
- **Range:** 0.0-1.0
- **Description:** Minimum cosine similarity score to include a message

**Impact:**
- Higher = stricter filtering, only highly relevant messages
- Lower = more permissive, includes loosely related messages

**Examples:**
```json
{ "minScore": 0.80 }  // Very strict
{ "minScore": 0.65 }  // Balanced (recommended)
{ "minScore": 0.50 }  // Permissive
```

---

### `cachePath`

- **Type:** string
- **Default:** `~/.clawdbot/smart-context-cache.db`
- **Description:** SQLite database path for embeddings and memory

```json
{
  "cachePath": "/custom/path/to/cache.db"
}
```

**Note:** Path supports `~` expansion.

---

### `debug`

- **Type:** boolean
- **Default:** `false`
- **Description:** Enable verbose debug logging

```json
{
  "debug": true
}
```

**Output:** Detailed logs in `~/.clawdbot/logs/smart-context-plugin.log`

---

## Advanced Options

### `stripOldToolCalls`

- **Type:** boolean
- **Default:** `false`
- **Description:** Remove old tool calls from filtered messages

**Use case:** Provider compatibility issues with tool calls

```json
{
  "stripOldToolCalls": true
}
```

---

## Memory System Configuration (v2.1+)

### `SC_MEMORY`

- **Type:** boolean
- **Default:** `false`
- **Description:** Enable memory system (fact and summary storage)

```json
{
  "SC_MEMORY": true
}
```

**Enables:**
- Fact extraction from conversations
- Summary generation
- Persistent memory across sessions

---

### `SC_STORAGE_MODE`

- **Type:** string
- **Default:** `"hybrid"`
- **Options:** `"facts"`, `"semantic"`, `"hybrid"`
- **Description:** Memory storage mode

```json
{
  "SC_STORAGE_MODE": "hybrid"
}
```

**Modes:**
- `facts` - Structured facts only
- `semantic` - Summaries only
- `hybrid` - Both facts and summaries (recommended)

---

### `SC_MEMORY_EXTRACT`

- **Type:** boolean
- **Default:** auto (enabled with `SC_MEMORY`)
- **Description:** Enable automatic memory extraction

```json
{
  "SC_MEMORY_EXTRACT": true
}
```

---

### `SC_EXTRACT_BATCH_SIZE`

- **Type:** integer
- **Default:** `5`
- **Range:** 1-20
- **Description:** Number of messages to accumulate before extraction

```json
{
  "SC_EXTRACT_BATCH_SIZE": 8
}
```

**Impact:**
- Lower = more frequent extraction, higher API costs
- Higher = less frequent extraction, might miss short conversations

---

### `SC_EXTRACT_MIN_CONFIDENCE`

- **Type:** number
- **Default:** `0.7`
- **Range:** 0.0-1.0
- **Description:** Minimum confidence score to store extracted facts

```json
{
  "SC_EXTRACT_MIN_CONFIDENCE": 0.8
}
```

---

### `SC_EXTRACT_MODEL`

- **Type:** string
- **Default:** `"gemini-2.0-flash-exp"`
- **Description:** LLM model for fact extraction

```json
{
  "SC_EXTRACT_MODEL": "claude-sonnet-4"
}
```

**Supported models:** Any model ID supported by Clawdbot

---

### `SC_MEMORY_MAX_FACTS`

- **Type:** integer
- **Default:** `10`
- **Range:** 1-50
- **Description:** Maximum facts to inject into context

```json
{
  "SC_MEMORY_MAX_FACTS": 15
}
```

---

### `SC_MEMORY_MIN_SCORE`

- **Type:** number
- **Default:** `0.75`
- **Range:** 0.0-1.0
- **Description:** Minimum similarity score for memory retrieval

```json
{
  "SC_MEMORY_MIN_SCORE": 0.80
}
```

---

### `SC_MEMORY_SESSION_TTL`

- **Type:** integer
- **Default:** `86400000` (24 hours)
- **Description:** Session-scoped fact TTL in milliseconds

```json
{
  "SC_MEMORY_SESSION_TTL": 43200000
}
```

**Example:** `43200000` = 12 hours

---

### `SC_MEMORY_AGENT_LIMIT`

- **Type:** integer
- **Default:** `500`
- **Description:** Max agent-scoped facts per user

```json
{
  "SC_MEMORY_AGENT_LIMIT": 1000
}
```

---

### `SC_MEMORY_USER_LIMIT`

- **Type:** integer
- **Default:** `1000`
- **Description:** Max user-scoped facts

```json
{
  "SC_MEMORY_USER_LIMIT": 2000
}
```

---

### `SC_SUMMARY_DEDUP_THRESHOLD`

- **Type:** number
- **Default:** `0.85`
- **Range:** 0.5-1.0
- **Description:** Cosine similarity threshold for summary deduplication

```json
{
  "SC_SUMMARY_DEDUP_THRESHOLD": 0.90
}
```

**Impact:**
- Higher = more aggressive dedup, fewer summaries
- Lower = keep more similar summaries

---

### `SC_SUMMARY_MAX_LENGTH`

- **Type:** integer
- **Default:** `500`
- **Range:** 100-2000
- **Description:** Maximum characters for summary content

```json
{
  "SC_SUMMARY_MAX_LENGTH": 800
}
```

---

### `SC_SUMMARY_LIMIT`

- **Type:** integer
- **Default:** `500`
- **Range:** 50-5000
- **Description:** Maximum summaries per user before LRU eviction

```json
{
  "SC_SUMMARY_LIMIT": 1000
}
```

---

## Phase 2-3 Feature Flags (Experimental)

### FTS5 Full-Text Search

```json
{
  "fts5": {
    "enabled": true
  }
}
```

**Impact:** 2x speedup on keyword queries, hybrid semantic+keyword search

---

### Multi-Query Expansion

```json
{
  "multiQuery": {
    "enabled": true,
    "maxQueries": 3,
    "strategy": "rule-based"
  }
}
```

**Options:**
- `strategy`: `"rule-based"` or `"llm-based"`
- `maxQueries`: Number of expanded queries (1-5)

**Impact:** 50% recall improvement on complex questions

---

### Cross-Encoder Reranking

```json
{
  "reranker": {
    "enabled": true,
    "model": "cross-encoder/ms-marco-MiniLM-L-6-v2"
  }
}
```

**Impact:** 10-15% precision improvement, <500ms latency

---

### Tool Result Indexing

```json
{
  "toolIndex": {
    "enabled": true
  }
}
```

**Impact:** Searchable history of past tool outputs

---

## Environment Variable Reference

All config options can be set via environment variables:

```bash
# Core options
export SC_ENABLED=true
export SC_TOP_K=10
export SC_RECENT_N=3
export SC_MIN_SCORE=0.65
export SC_DEBUG=true

# Memory system
export SC_MEMORY=true
export SC_STORAGE_MODE=hybrid
export SC_MEMORY_EXTRACT=true
export SC_EXTRACT_BATCH_SIZE=8
export SC_EXTRACT_MIN_CONFIDENCE=0.7
export SC_EXTRACT_MODEL=gemini-2.0-flash-exp

# Memory limits
export SC_MEMORY_MAX_FACTS=10
export SC_MEMORY_MIN_SCORE=0.75
export SC_MEMORY_SESSION_TTL=86400000
export SC_MEMORY_AGENT_LIMIT=500
export SC_MEMORY_USER_LIMIT=1000

# Summary config
export SC_SUMMARY_DEDUP_THRESHOLD=0.85
export SC_SUMMARY_MAX_LENGTH=500
export SC_SUMMARY_LIMIT=500

# Feature flags
export SC_FTS5_SEARCH=false
export SC_MULTI_QUERY=false
export SC_RERANK=false
export SC_TOOL_INDEX=false
```

---

## Complete Configuration Examples

### Example 1: Production - Maximum Savings

```json
{
  "smart-context": {
    "enabled": true,
    "config": {
      "topK": 8,
      "recentN": 2,
      "minScore": 0.75,
      "debug": false,
      
      "SC_MEMORY": true,
      "SC_STORAGE_MODE": "hybrid",
      "SC_EXTRACT_BATCH_SIZE": 10,
      "SC_EXTRACT_MIN_CONFIDENCE": 0.8
    }
  }
}
```

**Profile:**
- 95%+ token reduction
- High-confidence memory extraction
- Aggressive filtering

---

### Example 2: Development - Full Features

```json
{
  "smart-context": {
    "enabled": true,
    "config": {
      "topK": 15,
      "recentN": 5,
      "minScore": 0.55,
      "debug": true,
      
      "SC_MEMORY": true,
      "SC_STORAGE_MODE": "hybrid",
      "SC_EXTRACT_BATCH_SIZE": 5,
      "SC_EXTRACT_MIN_CONFIDENCE": 0.6,
      
      "fts5": { "enabled": true },
      "multiQuery": { "enabled": true },
      "reranker": { "enabled": true },
      "toolIndex": { "enabled": true }
    }
  }
}
```

**Profile:**
- All features enabled
- Verbose logging
- Maximum recall

---

### Example 3: Memory-Only Mode

```json
{
  "smart-context": {
    "enabled": true,
    "config": {
      "topK": 10,
      "recentN": 3,
      "minScore": 0.65,
      
      "SC_MEMORY": true,
      "SC_STORAGE_MODE": "facts",
      "SC_MEMORY_MAX_FACTS": 20,
      "SC_MEMORY_MIN_SCORE": 0.70
    }
  }
}
```

**Profile:**
- Facts only (no summaries)
- High fact injection limit
- Stricter retrieval threshold

---

## Performance Tuning

### High-Throughput Workloads

```json
{
  "topK": 8,
  "recentN": 2,
  "minScore": 0.70,
  "SC_EXTRACT_BATCH_SIZE": 15
}
```

**Goal:** Minimize processing time per message

---

### High-Accuracy Workloads

```json
{
  "topK": 20,
  "recentN": 5,
  "minScore": 0.60,
  "multiQuery": { "enabled": true },
  "reranker": { "enabled": true }
}
```

**Goal:** Maximum retrieval quality

---

### Cost-Optimized

```json
{
  "topK": 5,
  "recentN": 2,
  "minScore": 0.80,
  "SC_EXTRACT_BATCH_SIZE": 20,
  "SC_EXTRACT_MIN_CONFIDENCE": 0.85
}
```

**Goal:** Minimize API costs (LLM + embedding)

---

## Troubleshooting Configuration

### Check Current Config

```bash
# View resolved config in logs
tail -f ~/.clawdbot/logs/smart-context-plugin.log | grep "Config resolved"
```

Output:
```json
{
  "message": "Config resolved",
  "data": {
    "modelId": "claude-sonnet-4",
    "topK": 10,
    "recentN": 3,
    "minScore": 0.65
  }
}
```

---

### Validate Config Syntax

```bash
cat ~/.clawdbot/clawdbot.json | jq '.plugins.entries["smart-context"]'
```

---

### Reset to Defaults

Remove the `config` block:

```json
{
  "smart-context": {
    "enabled": true
  }
}
```

---

## Next Steps

- **Quick Start**: [QUICKSTART.md](./QUICKSTART.md)
- **Installation**: [INSTALLATION.md](./INSTALLATION.md)
- **Performance**: [CONFIGURATION.md](./CONFIGURATION.md)

---

## Support

- 🐛 **Issues**: https://github.com/ryn-shv/clawdbot-smart-context/issues
- 📖 **Docs**: https://github.com/ryn-shv/clawdbot-smart-context
