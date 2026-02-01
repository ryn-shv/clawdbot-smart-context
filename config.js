/**
 * Smart Context Feature Flags
 * 
 * All features are toggled via environment variables OR Clawdbot plugin config.
 * Environment variables take precedence to enable zero-downtime overrides.
 * 
 * PHASE 1 - Accuracy Track
 * - Tool-Chain Groups: Group tool_use + tool_result atomically (default ON)
 * - BM25 Hybrid Scoring: Combine keyword + semantic matching (default OFF)
 * - Dynamic Context Window: Adapt topK based on model limits (default OFF)
 * 
 * PHASE 1 - Performance Track
 * - Query Result Caching: LRU cache for selection results (default ON)
 * 
 * PHASE 2A - Performance Track
 * - Batch Embedding: Batch process uncached embeddings (default OFF)
 * - Parallel Scoring: Concurrent scoring with semaphore (default OFF)
 * 
 * PHASE 2B - Accuracy Track
 * - Tool Result Indexing: Search across past tool results (default OFF)
 * - FTS5 Keyword Search: SQLite full-text search for exact keywords (default OFF)
 * - Thread-Aware Retrieval: Retrieve coherent conversation threads (default OFF)
 * 
 * PHASE 3B - Accuracy Track (Multi-Query Retrieval)
 * - Multi-Query Expansion: Generate query variants for better recall (default OFF)
 * 
 * PHASE 4 - Memory System
 * - Multi-Level Memory: Persistent fact storage across sessions (default OFF)
 * - Memory Extraction: LLM-based fact extraction from conversations (default OFF)
 * - Reciprocal Rank Fusion: Merge multi-query results intelligently (default RRF)
 */

// Plugin config passed from Clawdbot (set via initializeConfig())
let pluginConfig = {};

/**
 * Initialize config from Clawdbot plugin config
 * @param {Object} config - Plugin config from Clawdbot
 */
export function initializeConfig(config = {}) {
  pluginConfig = config;
}

/**
 * Get value from env var or plugin config, with env taking precedence
 * @param {string} envKey - Environment variable name (e.g., 'SC_BATCH_EMBED')
 * @param {string} configKey - Plugin config key (e.g., 'SC_BATCH_EMBED')
 * @param {*} defaultValue - Default value if neither source provides value
 * @returns {*} Resolved value
 */
function getConfigValue(envKey, configKey, defaultValue) {
  // 1. Environment variable (highest priority)
  if (process.env[envKey] !== undefined) {
    const val = process.env[envKey];
    if (val === 'true') return true;
    if (val === 'false') return false;
    return val;
  }
  
  // 2. Plugin config (from Clawdbot JSON)
  if (pluginConfig[configKey] !== undefined) {
    return pluginConfig[configKey];
  }
  
  // 3. Default value
  return defaultValue;
}

/**
 * Get numeric value from env/config with parsing
 * @param {string} envKey - Environment variable name
 * @param {string} configKey - Plugin config key
 * @param {number} defaultValue - Default numeric value
 * @param {boolean} isFloat - Whether to parse as float (default: false = int)
 * @returns {number} Parsed numeric value
 */
function getNumericValue(envKey, configKey, defaultValue, isFloat = false) {
  const raw = getConfigValue(envKey, configKey, null);
  if (raw === null) return defaultValue;
  
  const parsed = isFloat ? parseFloat(raw) : parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get string value from env/config
 * @param {string} envKey - Environment variable name
 * @param {string} configKey - Plugin config key
 * @param {string} defaultValue - Default string value
 * @returns {string} Resolved string value
 */
function getStringValue(envKey, configKey, defaultValue) {
  const raw = getConfigValue(envKey, configKey, null);
  return raw !== null ? String(raw) : defaultValue;
}

export const FEATURE_FLAGS = {
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: ACCURACY TRACK
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * Tool-Chain Groups (DEFAULT: ON)
   * 
   * Groups tool_use + tool_result messages into atomic units.
   * Prevents orphan tool_results by scoring/selecting groups instead of
   * individual messages.
   * 
   * Expected: 100% tool chain integrity (zero orphans ever)
   * Risk: Very Low
   * Disable with: SC_TOOL_CHAINS=false
   */
  get toolChainGroups() { return getConfigValue('SC_TOOL_CHAINS', 'SC_TOOL_CHAINS', true) !== false; },
  
  /**
   * BM25 Hybrid Scoring (DEFAULT: OFF)
   * 
   * Combines BM25 (keyword-based) + cosine similarity (semantic).
   * Improves precision for exact keyword queries (error codes, function names).
   * 
   * Default weights: BM25=0.4, Cosine=0.6
   * Expected: 20-30% precision boost for exact keyword queries
   * Risk: Low
   * Enable with: SC_BM25_HYBRID=true
   */
  get bm25Hybrid() { return getConfigValue('SC_BM25_HYBRID', 'SC_BM25_HYBRID', false) === true; },
  
  /**
   * Dynamic Context Window (DEFAULT: OFF)
   * 
   * Calculates optimal topK based on model context limits and query complexity.
   * Model limits: Claude 200K, GPT-4o 128K, Gemini 1-2M
   * 
   * Expected: Better resource utilization per model
   * Risk: Low
   * Enable with: SC_DYNAMIC_WINDOW=true
   */
  get dynamicWindow() { return getConfigValue('SC_DYNAMIC_WINDOW', 'SC_DYNAMIC_WINDOW', false) === true; },
  
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: PERFORMANCE TRACK
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * Query Result Caching (DEFAULT: ON)
   * 
   * LRU cache for selection results to avoid re-scoring on repeated queries.
   * 60-second TTL, 100-entry limit
   * 
   * Expected: 30-50% latency reduction on cache hits
   * Risk: Very Low
   * Disable with: SC_QUERY_CACHE=false
   */
  get queryResultCache() { return getConfigValue('SC_QUERY_CACHE', 'SC_QUERY_CACHE', true) !== false; },
  
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2A: PERFORMANCE TRACK
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * Batch Embedding (DEFAULT: OFF)
   * 
   * Processes uncached embeddings in batches for better throughput.
   * Detects all uncached texts upfront, embeds in parallel batches,
   * updates cache after completion.
   * 
   * Expected: 40-60% latency reduction for uncached scenarios
   * Risk: Low (graceful fallback to sequential on errors)
   * Enable with: SC_BATCH_EMBED=true
   */
  get batchEmbed() { return getConfigValue('SC_BATCH_EMBED', 'SC_BATCH_EMBED', false) === true; },
  
  /**
   * Parallel Scoring (DEFAULT: OFF)
   * 
   * Scores messages concurrently with semaphore-based rate limiting.
   * Uses Promise.all with controlled concurrency (default: 10).
   * 
   * Expected: 25-40% speedup for large histories (>100 messages)
   * Risk: Low (memory monitoring, fallback to sequential)
   * Enable with: SC_PARALLEL_SCORE=true
   */
  get parallelScore() { return getConfigValue('SC_PARALLEL_SCORE', 'SC_PARALLEL_SCORE', false) === true; },
  
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2B: ACCURACY TRACK
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * Tool Result Indexing (DEFAULT: OFF)
   * 
   * Indexes tool_result messages in a searchable format to enable
   * reuse of cached tool results from previous sessions.
   * Stores tool_name, args, and result text with embeddings.
   * 
   * Expected: Faster retrieval of relevant tool results
   * Risk: Low (optional feature, no breaking changes)
   * Enable with: SC_TOOL_INDEX=true
   */
  get toolResultIndex() { return getConfigValue('SC_TOOL_INDEX', 'SC_TOOL_INDEX', false) === true; },
  
  /**
   * FTS5 Keyword Search (DEFAULT: OFF)
   * 
   * SQLite FTS5 full-text search for exact keyword matching.
   * Combines with semantic search for hybrid scoring.
   * 
   * Expected: Better precision for exact keyword queries
   * Risk: Low (graceful fallback to semantic-only)
   * Enable with: SC_FTS5_SEARCH=true
   */
  get fts5Search() { return getConfigValue('SC_FTS5_SEARCH', 'SC_FTS5_SEARCH', false) === true; },
  
  /**
   * Thread-Aware Retrieval (DEFAULT: OFF)
   * 
   * Expands selected messages to include surrounding context
   * (N messages before/after) to preserve conversation threads.
   * 
   * Expected: More coherent context for the model
   * Risk: Low (optional post-processing)
   * Enable with: SC_THREAD_AWARE=true
   */
  get threadAware() { return getConfigValue('SC_THREAD_AWARE', 'SC_THREAD_AWARE', false) === true; },
  
  /**
   * Cross-Encoder Reranking - PHASE 3A (DEFAULT: OFF)
   * Two-stage retrieval for 10-15% precision boost
   * Enable with: SC_CROSS_ENCODER=true
   */
  get crossEncoderRerank() { return getConfigValue('SC_CROSS_ENCODER', 'SC_CROSS_ENCODER', false) === true; },
  get crossEncoderModel() { return getStringValue('SC_CROSS_ENCODER_MODEL', 'SC_CROSS_ENCODER_MODEL', 'cross-encoder/ms-marco-MiniLM-L-6-v2'); },
  get crossEncoderCandidates() { return getNumericValue('SC_CROSS_ENCODER_CANDIDATES', 'SC_CROSS_ENCODER_CANDIDATES', 100); },
  get crossEncoderMinHistory() { return getNumericValue('SC_CROSS_ENCODER_MIN_HISTORY', 'SC_CROSS_ENCODER_MIN_HISTORY', 50); },
  
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3B: ACCURACY TRACK (Multi-Query Retrieval)
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * Multi-Query Expansion (DEFAULT: OFF)
   * 
   * Generates semantic variations of user queries to improve recall.
   * Expands query into 3-5 alternative phrasings, searches with each,
   * and fuses results using RRF or simple deduplication.
   * 
   * Example:
   *   Query: "database error"
   *   Expanded: ["database error", "SQL connection failure", 
   *              "PostgreSQL timeout issue", "database query problems"]
   * 
   * Expected: 15-20% recall improvement for ambiguous queries
   * Risk: Low (graceful fallback to single query, +500ms-1s latency)
   * Enable with: SC_MULTI_QUERY=true
   */
  get multiQuery() { return getConfigValue('SC_MULTI_QUERY', 'SC_MULTI_QUERY', false) === true; },
  
  /**
   * Multi-Query Count (DEFAULT: 3)
   * 
   * Number of query variations to generate.
   * Higher values = more coverage but slower.
   * 
   * Recommended: 3-5
   * Override with: SC_MULTI_QUERY_COUNT=5
   */
  get multiQueryCount() { return getNumericValue('SC_MULTI_QUERY_COUNT', 'SC_MULTI_QUERY_COUNT', 3); },
  
  /**
   * Multi-Query Fusion Strategy (DEFAULT: rrf)
   * 
   * How to merge results from multiple query variants:
   * - 'rrf': Reciprocal Rank Fusion (paper: Cormack et al 2009)
   * - 'simple': Round-robin deduplication
   * 
   * RRF is more sophisticated but both work well.
   * Override with: SC_MULTI_QUERY_FUSION=simple
   */
  get multiQueryFusion() { return getStringValue('SC_MULTI_QUERY_FUSION', 'SC_MULTI_QUERY_FUSION', 'rrf'); },
  
  /**
   * Multi-Query Expansion Strategy (DEFAULT: auto)
   * 
   * How to generate query variants:
   * - 'auto': Use LLM if available, fallback to rule-based
   * - 'llm': Always use LLM (requires LLM client)
   * - 'rule': Always use rule-based (no LLM, synonyms + patterns)
   * 
   * Rule-based is faster but less sophisticated than LLM.
   * Override with: SC_MULTI_QUERY_STRATEGY=rule
   */
  get multiQueryStrategy() { return getStringValue('SC_MULTI_QUERY_STRATEGY', 'SC_MULTI_QUERY_STRATEGY', 'auto'); },
  
  /**
   * RRF Constant K (DEFAULT: 60)
   * 
   * Constant used in RRF formula: score(d) = Σ 1/(k + rank(d))
   * Higher k = less weight on top-ranked items
   * 
   * Recommended: 60 (from original paper)
   * Override with: SC_RRF_K=60
   */
  get rrfK() { return getNumericValue('SC_RRF_K', 'SC_RRF_K', 60); },

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 4: MEMORY SYSTEM
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * Memory System (DEFAULT: OFF)
   * 
   * Enables multi-level fact storage and retrieval across sessions.
   * Adds persistent memory for user facts, agent learnings, and session context.
   * 
   * Three-tier hierarchy:
   * - User scope: Global facts visible to all agents
   * - Agent scope: Per-agent learnings and patterns
   * - Session scope: Ephemeral facts for current conversation only
   * 
   * Expected: Cross-session fact recall, personalized responses
   * Risk: Low (feature-flagged, non-breaking, graceful degradation)
   * Enable with: SC_MEMORY=true
   */
  get memory() { return getConfigValue('SC_MEMORY', 'SC_MEMORY', false) === true; },
  
  /**
   * Memory Extraction (DEFAULT: OFF, auto-enabled when SC_MEMORY=true)
   * 
   * Enables LLM-based fact extraction from conversations.
   * Runs asynchronously after assistant responses to extract
   * permanent facts about the user.
   * 
   * Requires memory to be enabled.
   * 
   * Expected: Automatic learning of user preferences and context
   * Risk: Medium (LLM cost, extraction quality depends on prompts)
   * Enable with: SC_MEMORY_EXTRACT=true
   */
  get memoryExtract() {
    const explicit = getConfigValue('SC_MEMORY_EXTRACT', 'SC_MEMORY_EXTRACT', null);
    if (explicit !== null) return explicit === true;
    // Auto-enable if memory is enabled
    return this.memory;
  },
  
  /**
   * Extraction Batch Size (DEFAULT: 5)
   * 
   * Number of messages to accumulate before triggering extraction.
   * Higher values = less frequent extraction, lower LLM costs.
   * Lower values = more responsive, higher costs.
   * 
   * Recommended: 3-10
   * Override with: SC_EXTRACT_BATCH_SIZE=3
   */
  get extractBatchSize() { return getNumericValue('SC_EXTRACT_BATCH_SIZE', 'SC_EXTRACT_BATCH_SIZE', 5); },
  
  /**
   * Extraction Min Confidence (DEFAULT: 0.7)
   * 
   * Minimum confidence score to store extracted facts.
   * Higher = only store highly confident facts.
   * Lower = store more facts but potentially less reliable.
   * 
   * Valid range: 0.0 to 1.0
   * Recommended: 0.7-0.9
   * Override with: SC_EXTRACT_MIN_CONFIDENCE=0.8
   */
  get extractMinConfidence() { return getNumericValue('SC_EXTRACT_MIN_CONFIDENCE', 'SC_EXTRACT_MIN_CONFIDENCE', 0.7, true); },
  
  /**
   * Extraction Model (DEFAULT: gemini-2.5-flash)
   * 
   * LLM model to use for fact extraction.
   * Gemini Flash is cheap and fast, ideal for extraction tasks.
   * 
   * Options: gemini-2.5-flash, gemini-1.5-flash, gpt-4o-mini
   * Override with: SC_EXTRACT_MODEL=gpt-4o-mini
   */
  get extractModel() { return getStringValue('SC_EXTRACT_MODEL', 'SC_EXTRACT_MODEL', 'gemini-2.5-flash'); },
  
  /**
   * Conflict Resolution (DEFAULT: true)
   * 
   * Enable automatic conflict resolution for contradicting facts.
   * Uses LLM to detect conflicts and apply resolution strategies.
   * 
   * If disabled, all facts are stored without conflict checking.
   * Override with: SC_EXTRACT_CONFLICTS=false
   */
  get extractConflicts() { return getConfigValue('SC_EXTRACT_CONFLICTS', 'SC_EXTRACT_CONFLICTS', true) !== false; },
  
  /**
   * Max Facts to Inject (DEFAULT: 10)
   * 
   * Maximum number of relevant facts to inject into context.
   * Higher values = more context, more tokens.
   * 
   * Recommended: 5-15 depending on model context limits
   * Override with: SC_MEMORY_MAX_FACTS=15
   */
  get memoryMaxFacts() { return getNumericValue('SC_MEMORY_MAX_FACTS', 'SC_MEMORY_MAX_FACTS', 10); },
  
  /**
   * Memory Similarity Threshold (DEFAULT: 0.75)
   * 
   * Minimum similarity score for fact retrieval.
   * Higher = more precise, fewer facts retrieved.
   * Lower = more recall, potentially less relevant facts.
   * 
   * Valid range: 0.0 to 1.0
   * Recommended: 0.70-0.80
   * Override with: SC_MEMORY_MIN_SCORE=0.8
   */
  get memoryMinScore() { return getNumericValue('SC_MEMORY_MIN_SCORE', 'SC_MEMORY_MIN_SCORE', 0.75, true); },
  
  /**
   * Session Fact TTL (DEFAULT: 24h)
   * 
   * Time-to-live for session-scoped facts in milliseconds.
   * Session facts are automatically cleaned up after this duration.
   * 
   * Default: 86400000 (24 hours)
   * Override with: SC_MEMORY_SESSION_TTL=43200000  (12 hours)
   */
  get memorySessionTTL() { return getNumericValue('SC_MEMORY_SESSION_TTL', 'SC_MEMORY_SESSION_TTL', 86400000); },
  
  /**
   * Agent Fact Limit (DEFAULT: 500)
   * 
   * Maximum facts to keep per user+agent combination.
   * Oldest facts (by last_accessed_at) are evicted when limit exceeded.
   * 
   * Recommended: 500-1000 depending on storage constraints
   * Override with: SC_MEMORY_AGENT_LIMIT=1000
   */
  get memoryAgentLimit() { return getNumericValue('SC_MEMORY_AGENT_LIMIT', 'SC_MEMORY_AGENT_LIMIT', 500); },
  
  /**
   * User Fact Limit (DEFAULT: 1000)
   * 
   * Maximum global facts per user.
   * Prevents unbounded growth of user-scope memory.
   * 
   * Recommended: 1000-2000
   * Override with: SC_MEMORY_USER_LIMIT=2000
   */
  get memoryUserLimit() { return getNumericValue('SC_MEMORY_USER_LIMIT', 'SC_MEMORY_USER_LIMIT', 1000); },

  // CONFIGURATION OVERRIDES
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * BM25 Hybrid Scoring Weights
   * 
   * Controls the balance between keyword and semantic matching.
   * Valid range: 0.0 to 1.0 (must sum to 1.0)
   */
  get bm25Weight() { return getNumericValue('SC_BM25_WEIGHT', 'SC_BM25_WEIGHT', 0.4, true); },
  get cosineWeight() { return getNumericValue('SC_COSINE_WEIGHT', 'SC_COSINE_WEIGHT', 0.6, true); },
  
  /**
   * Dynamic Window Limits
   * 
   * Controls the min/max topK values when dynamic window is enabled.
   */
  get minTopK() { return getNumericValue('SC_MIN_TOPK', 'SC_MIN_TOPK', 5); },
  get maxTopK() { return getNumericValue('SC_MAX_TOPK', 'SC_MAX_TOPK', 50); },
  
  /**
   * Batch Embedding Configuration
   * 
   * Controls batch size for embedBatch() calls.
   */
  get batchEmbedSize() { return getNumericValue('SC_BATCH_EMBED_SIZE', 'SC_BATCH_EMBED_SIZE', 10); },
  
  /**
   * Parallel Scoring Configuration
   * 
   * Controls concurrency limit for parallel scoring semaphore.
   */
  get parallelConcurrency() { return getNumericValue('SC_PARALLEL_CONCURRENCY', 'SC_PARALLEL_CONCURRENCY', 10); },
  
  /**
   * Thread-Aware Retrieval Configuration
   * 
   * Controls window size for thread expansion (messages before/after).
   */
  get threadWindowSize() { return getNumericValue('SC_THREAD_WINDOW', 'SC_THREAD_WINDOW', 3); },
  
  /**
   * Tool Indexing Configuration
   */
  get toolIndexChunkSize() { return getNumericValue('SC_TOOL_CHUNK_SIZE', 'SC_TOOL_CHUNK_SIZE', 500); },
  get toolIndexChunkOverlap() { return getNumericValue('SC_TOOL_CHUNK_OVERLAP', 'SC_TOOL_CHUNK_OVERLAP', 50); },
  
  /**
   * Thread Detection Configuration
   */
  get threadSimilarityThreshold() { return getNumericValue('SC_THREAD_SIMILARITY', 'SC_THREAD_SIMILARITY', 0.7, true); },
  get threadMaxGap() { return getNumericValue('SC_THREAD_MAX_GAP', 'SC_THREAD_MAX_GAP', 5); },
  
  /**
   * Debug Mode
   * 
   * Enables verbose logging for feature flag behavior.
   */
  get debug() { return getConfigValue('SC_DEBUG', 'SC_DEBUG', false) === true; },
};

/**
 * Check if a feature is enabled
 */
export function isEnabled(flag) {
  const value = FEATURE_FLAGS[flag];
  return value === true || value === 'true';
}

/**
 * Get a configuration value
 */
export function getConfig(key) {
  return FEATURE_FLAGS[key];
}

/**
 * Get all feature flags (for debugging)
 */
export function getAllFlags() {
  // Need to access each getter to get current values
  const flags = {};
  for (const key of Object.keys(Object.getOwnPropertyDescriptors(FEATURE_FLAGS))) {
    flags[key] = FEATURE_FLAGS[key];
  }
  return flags;
}

/**
 * Validate configuration on startup
 */
export function validateConfig() {
  const warnings = [];
  
  // Validate BM25 weights
  const bm25Weight = FEATURE_FLAGS.bm25Weight;
  const cosineWeight = FEATURE_FLAGS.cosineWeight;
  const weightSum = bm25Weight + cosineWeight;
  
  if (Math.abs(weightSum - 1.0) > 0.01) {
    warnings.push(
      `BM25 + Cosine weights should sum to 1.0 (current: ${weightSum.toFixed(2)}). ` +
      `Check SC_BM25_WEIGHT and SC_COSINE_WEIGHT`
    );
  }
  
  // Validate dynamic window limits
  const minTopK = FEATURE_FLAGS.minTopK;
  const maxTopK = FEATURE_FLAGS.maxTopK;
  
  if (minTopK > maxTopK) {
    warnings.push(
      `minTopK (${minTopK}) > maxTopK (${maxTopK}). ` +
      `Check SC_MIN_TOPK and SC_MAX_TOPK`
    );
  }
  
  // Validate batch embed size
  const batchSize = FEATURE_FLAGS.batchEmbedSize;
  if (batchSize < 1 || batchSize > 50) {
    warnings.push(
      `batchEmbedSize (${batchSize}) out of range [1, 50]. ` +
      `Check SC_BATCH_EMBED_SIZE`
    );
  }
  
  // Validate parallel concurrency
  const concurrency = FEATURE_FLAGS.parallelConcurrency;
  if (concurrency < 1 || concurrency > 100) {
    warnings.push(
      `parallelConcurrency (${concurrency}) out of range [1, 100]. ` +
      `Check SC_PARALLEL_CONCURRENCY`
    );
  }
  
  // Validate thread window size
  const windowSize = FEATURE_FLAGS.threadWindowSize;
  if (windowSize < 1 || windowSize > 10) {
    warnings.push(
      `threadWindowSize (${windowSize}) out of range [1, 10]. ` +
      `Check SC_THREAD_WINDOW`
    );
  }
  
  // Validate multi-query count
  const multiQueryCount = FEATURE_FLAGS.multiQueryCount;
  if (multiQueryCount < 1 || multiQueryCount > 10) {
    warnings.push(
      `multiQueryCount (${multiQueryCount}) out of range [1, 10]. ` +
      `Check SC_MULTI_QUERY_COUNT`
    );
  }
  
  // Validate multi-query fusion strategy
  const fusion = FEATURE_FLAGS.multiQueryFusion;
  if (fusion !== 'rrf' && fusion !== 'simple') {
    warnings.push(
      `multiQueryFusion must be 'rrf' or 'simple' (got: ${fusion}). ` +
      `Check SC_MULTI_QUERY_FUSION`
    );
  }
  
  // Validate multi-query strategy
  const strategy = FEATURE_FLAGS.multiQueryStrategy;
  if (strategy !== 'auto' && strategy !== 'llm' && strategy !== 'rule') {
    warnings.push(
      `multiQueryStrategy must be 'auto', 'llm', or 'rule' (got: ${strategy}). ` +
      `Check SC_MULTI_QUERY_STRATEGY`
    );
  }
  
  // Validate RRF K
  const rrfK = FEATURE_FLAGS.rrfK;
  if (rrfK < 1 || rrfK > 1000) {
    warnings.push(
      `rrfK (${rrfK}) out of range [1, 1000]. ` +
      `Check SC_RRF_K`
    );
  }
  
  // Validate extraction batch size
  const extractBatch = FEATURE_FLAGS.extractBatchSize;
  if (extractBatch < 1 || extractBatch > 20) {
    warnings.push(
      `extractBatchSize (${extractBatch}) out of range [1, 20]. ` +
      `Check SC_EXTRACT_BATCH_SIZE`
    );
  }
  
  // Validate extraction confidence
  const extractConf = FEATURE_FLAGS.extractMinConfidence;
  if (extractConf < 0 || extractConf > 1) {
    warnings.push(
      `extractMinConfidence (${extractConf}) out of range [0, 1]. ` +
      `Check SC_EXTRACT_MIN_CONFIDENCE`
    );
  }
  
  return warnings;
}

// Validate on module load
const configWarnings = validateConfig();
if (configWarnings.length > 0 && FEATURE_FLAGS.debug) {
  console.warn('[smart-context] Configuration warnings:');
  configWarnings.forEach(w => console.warn(`  - ${w}`));
}

export default { isEnabled, getConfig, getAllFlags, FEATURE_FLAGS };
