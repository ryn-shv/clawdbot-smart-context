# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] - 2025-02-09

### Fixed
- **Critical**: Memory extraction now processes BOTH user and assistant messages (previously only assistant)
- **Critical**: Fixed config system - all 41 flags now properly read plugin config via `getConfigValue()`
- **Critical**: Fixed hook registration timing - `initializeConfig()` now runs before hooks register
- Fixed extraction prompt to be more generous - captures project decisions from conversational context
- Fixed extraction buffer to include user messages - solves empty extraction bug
- All 3 hooks now properly registered: `before_agent_start`, `tool_result`, `agent_end`

### Added
- **Hybrid Memory v2.1**: Dual extraction system (facts + summaries)
- New `memory_summaries` table with FTS5 full-text search
- Summary deduplication using topic similarity (configurable threshold)
- Entity and project tagging for summaries
- New config flags: `SC_STORAGE_MODE`, `SC_SUMMARY_DEDUP_THRESHOLD`, `SC_SUMMARY_MAX_LENGTH`
- Hybrid extraction prompt - single LLM call produces both facts and summaries
- Summary retrieval with hybrid BM25 + semantic search
- Comprehensive test suite (28/28 memory core tests passing)

### Changed
- Extraction now uses full conversation context (user + assistant exchanges)
- Default storage mode is now `hybrid` (facts + summaries)
- Improved prompt engineering - captures decisions from code explanations
- Enhanced logging with structured operation tracking

### Performance
- 80-98% token reduction on long conversations (verified in production)
- <100ms cache hit latency
- 200-500ms warm path with embedding computation
- Memory retrieval: <50ms for 100+ facts

### Documentation
- Complete README with installation guide
- Quick start guide for new users
- Architecture overview with diagrams
- Troubleshooting section
- Configuration options reference
- Testing guide

## [2.0.5] - 2025-02-07

### Fixed
- Version bump for hook name consistency

## [2.0.4] - 2025-02-07

### Fixed
- Renamed `after_agent_end` to `agent_end` for Clawdbot hook compatibility
- Fixed session ID stability across hook calls
- Improved hook registration logging

## [2.0.3] - 2025-02-06

### Removed
- Removed `node-llama-cpp` optional dependency (unused)

### Changed
- Simplified dependency tree - Transformers.js is primary embedder
- Updated documentation to reflect dependency changes

## [2.0.2] - 2025-02-06

### Fixed
- **CRITICAL**: `storeFact()` now properly stores embeddings via `cache.set()`
- **CRITICAL**: Extractor now computes embeddings for extracted facts
- `retrieveFacts()` properly handles missing embeddings with BM25 fallback
- Hybrid scoring: 60% cosine similarity + 40% BM25

### Added
- `memory.stats()` includes embedding coverage percentage
- `bulkStoreFacts()` for efficient batch storage with embeddings
- End-to-end test script (`test-memory.js`)

## [2.0.1] - 2025-02-05

### Added
- Initial Phase 4 Memory System release
- Schema initialization for memory tables (`memory_facts`, `memory_patterns`, `memory_interactions`)
- Basic fact storage and retrieval
- LLM-based fact extraction from conversations
- User/agent/session scope isolation

## [2.0.0] - 2025-02-01

### Added
- **Phase 1**: Core semantic filtering with embedding-based scoring
- **Phase 2**: FTS5 full-text search, tool result indexing, thread-aware retrieval
- **Phase 3**: Multi-query expansion, cross-encoder reranking
- SQLite cache with covering indexes for performance
- Query result caching (LRU, 60s TTL)
- Tool chain integrity (zero orphan errors)
- Parallel embedding and scoring with semaphores
- Comprehensive logging system with structured output
- Configuration via environment variables and plugin config
- 80-95% token reduction on long conversations

### Architecture
- Modular plugin system with 34 implementation files
- Three-tier embedder fallback: Transformers.js → API → mock
- Database schema with 8+ covering indexes
- Hook-based integration: `before_agent_start`, `tool_result`, `agent_end`

### Performance
- <50ms cache hit latency
- 200-500ms warm path with embeddings
- 2-5s cold start (first run model download)

## [1.0.0] - Initial Concept

### Added
- Proof-of-concept semantic filtering
- Basic embedding cache
- Manual message selection

---

## Migration Notes

### Upgrading from 2.0.x to 2.1.x

The 2.1.x release introduces hybrid memory (facts + summaries) with **backward-compatible** changes:

1. **No data migration needed** - existing facts remain accessible
2. **New tables added** - `memory_summaries` table created automatically
3. **Config changes** - new flags available but defaults maintain 2.0.x behavior
4. **To enable hybrid mode**: Set `SC_STORAGE_MODE=hybrid` in config

### Breaking Changes from 1.x to 2.x

- Complete rewrite - not backward compatible with 1.x
- New configuration schema
- Database schema changes (migrate by exporting/importing facts)

---

## Version Support

| Version | Status | Support Until |
|---------|--------|---------------|
| 2.1.x   | Active | Current |
| 2.0.x   | Maintenance | 2025-06 |
| 1.x     | End of Life | - |

---

For detailed upgrade guides, see [MIGRATION.md](./MIGRATION.md).
