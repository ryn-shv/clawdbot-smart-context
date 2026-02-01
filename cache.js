/**
 * Embedding Cache for Smart Context
 * 
 * SQLite-based cache to avoid re-embedding messages on every turn.
 * Keyed by content hash for deduplication.
 * 
 * PERFORMANCE ENHANCEMENTS (Phase 1):
 * - Covering Indexes: Optimized indexes for common query patterns
 * - Connection Pooling (SC_CONN_POOL): Reuse SQLite connections
 * 
 * ACCURACY ENHANCEMENTS (Phase 2B):
 * - Tool Result Indexing: Search across past tool results
 * - FTS5 Keyword Search: Full-text search for exact keyword matching
 */

import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';

let Database = null;

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE FLAGS
// ═══════════════════════════════════════════════════════════════════════════

const FEATURE_FLAGS = {
  connectionPool: process.env.SC_CONN_POOL === 'true',  // Default OFF (cautious rollout)
  toolResultIndex: process.env.SC_TOOL_INDEX === 'true',  // Phase 2B (default OFF)
  fts5Search: process.env.SC_FTS5_SEARCH === 'true',  // Phase 2B (default OFF)
};

function isEnabled(flag) {
  return FEATURE_FLAGS[flag] === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTION POOLING (Phase 1 - Performance)
// ═══════════════════════════════════════════════════════════════════════════

class SQLitePool {
  constructor(dbPath, { maxConnections = 3, idleTimeoutMs = 60000 } = {}) {
    this.dbPath = dbPath;
    this.maxConnections = maxConnections;
    this.idleTimeoutMs = idleTimeoutMs;
    this.available = [];
    this.inUse = new Set();
    this.Database = null;
    this.cleanupInterval = null;
  }
  
  async init() {
    if (!this.Database) {
      const mod = await import('better-sqlite3');
      this.Database = mod.default;
    }
    
    // Start idle connection cleanup
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this._cleanupIdleConnections();
      }, this.idleTimeoutMs);
    }
  }
  
  _cleanupIdleConnections() {
    const now = Date.now();
    const toClose = [];
    
    for (const conn of this.available) {
      if (now - conn._lastUsed > this.idleTimeoutMs) {
        toClose.push(conn);
      }
    }
    
    for (const conn of toClose) {
      const idx = this.available.indexOf(conn);
      if (idx >= 0) {
        this.available.splice(idx, 1);
        try {
          conn.close();
        } catch (e) {
          // Ignore close errors
        }
      }
    }
    
    if (toClose.length > 0) {
      console.log(`[smart-context] Closed ${toClose.length} idle connections`);
    }
  }
  
  async acquire() {
    await this.init();
    
    // Reuse available connection
    if (this.available.length > 0) {
      const conn = this.available.pop();
      this.inUse.add(conn);
      return conn;
    }
    
    // Create new connection if under limit
    if (this.inUse.size < this.maxConnections) {
      const conn = new this.Database(this.dbPath);
      conn._lastUsed = Date.now();
      this.inUse.add(conn);
      return conn;
    }
    
    // Wait for available connection
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.available.length > 0) {
          clearInterval(checkInterval);
          const conn = this.available.pop();
          this.inUse.add(conn);
          resolve(conn);
        }
      }, 10);
    });
  }
  
  release(conn) {
    this.inUse.delete(conn);
    conn._lastUsed = Date.now();
    this.available.push(conn);
  }
  
  async withConnection(fn) {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }
  
  closeAll() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    for (const conn of [...this.available, ...this.inUse]) {
      try {
        conn.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    
    this.available = [];
    this.inUse.clear();
  }
  
  stats() {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      maxConnections: this.maxConnections,
      idleTimeoutMs: this.idleTimeoutMs
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hash content for cache key
 */
function hashContent(content) {
  return crypto
    .createHash('sha256')
    .update(typeof content === 'string' ? content : JSON.stringify(content))
    .digest('hex');
}

/**
 * Serialize embedding to Buffer
 */
function serializeEmbedding(embedding) {
  const buffer = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

/**
 * Deserialize embedding from Buffer
 */
function deserializeEmbedding(buffer) {
  const embedding = [];
  for (let i = 0; i < buffer.length; i += 4) {
    embedding.push(buffer.readFloatLE(i));
  }
  return embedding;
}

/**
 * Resolve cache path
 */
function resolveCachePath(configPath) {
  if (configPath) {
    return configPath.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), '.clawdbot', 'smart-context-cache.db');
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2B: TOOL RESULT EXTRACTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract tool name, args, and result from a tool_result message
 */
function extractToolResultInfo(message) {
  if (!message) return null;
  
  // Handle tool_result role (OpenAI/Anthropic format)
  if (message.role === 'toolResult' && message.toolCallId) {
    return {
      toolCallId: message.toolCallId,
      toolName: message.toolName || 'unknown',
      result: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      timestamp: message.timestamp || Date.now()
    };
  }
  
  // Handle tool_result blocks in user message
  if (message.role === 'user' && Array.isArray(message.content)) {
    const toolResults = [];
    
    for (const block of message.content) {
      if (block && (block.type === 'tool_result' || block.type === 'toolResult')) {
        const resultText = typeof block.content === 'string' 
          ? block.content 
          : JSON.stringify(block.content);
        
        toolResults.push({
          toolCallId: block.tool_use_id || block.id || 'unknown',
          toolName: block.name || block.tool_name || 'unknown',
          result: resultText,
          timestamp: message.timestamp || Date.now()
        });
      }
    }
    
    return toolResults.length > 0 ? toolResults : null;
  }
  
  return null;
}

/**
 * Compute cosine similarity between two embeddings
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  
  let dot = 0;
  let magA = 0;
  let magB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create embedding cache instance
 */
export function createCache(config = {}) {
  const cachePath = resolveCachePath(config.cachePath);
  const debug = config.debug || false;
  
  let db = null;
  let pool = null;
  let getStmt = null;
  let setStmt = null;
  let initialized = false;
  
  /**
   * Initialize database with covering indexes
   */
  async function init() {
    if (initialized) return;
    
    try {
      // Ensure directory exists
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Try to import better-sqlite3
      if (!Database) {
        try {
          const mod = await import('better-sqlite3');
          Database = mod.default;
        } catch (err) {
          console.warn('[smart-context] better-sqlite3 not available, cache disabled');
          return;
        }
      }
      
      // Initialize connection pool or single connection
      if (isEnabled('connectionPool')) {
        pool = new SQLitePool(cachePath, {
          maxConnections: 3,
          idleTimeoutMs: 60000
        });
        await pool.init();
        db = await pool.acquire();
        if (debug) {
          console.log('[smart-context] Connection pool enabled:', pool.stats());
        }
      } else {
        db = new Database(cachePath);
      }
      
      // Create embeddings table
      db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          content_hash TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL
        );
      `);
      
      // ═══════════════════════════════════════════════════════════════════
      // COVERING INDEXES (Phase 1 - Performance Optimization)
      // ═══════════════════════════════════════════════════════════════════
      // These indexes optimize common query patterns:
      // 1. idx_accessed_at: Fast cleanup of old entries
      // 2. idx_accessed_hash: Covering index for access-time-based queries
      // ═══════════════════════════════════════════════════════════════════
      
      db.exec(`
        -- Optimize cache cleanup queries (ORDER BY accessed_at)
        CREATE INDEX IF NOT EXISTS idx_accessed_at 
        ON embeddings(accessed_at);
        
        -- Covering index for access-time + hash lookups
        -- Covers queries that need both accessed_at and content_hash
        CREATE INDEX IF NOT EXISTS idx_accessed_hash 
        ON embeddings(accessed_at, content_hash);
      `);
      
      // ═══════════════════════════════════════════════════════════════════
      // PHASE 2B: TOOL RESULT INDEX
      // ═══════════════════════════════════════════════════════════════════
      
      if (isEnabled('toolResultIndex')) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tool_result_index (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            tool_call_id TEXT,
            timestamp INTEGER NOT NULL,
            result_text TEXT NOT NULL,
            embedding BLOB NOT NULL,
            created_at INTEGER NOT NULL
          );
          
          -- Index for tool name lookups
          CREATE INDEX IF NOT EXISTS idx_tool_name 
          ON tool_result_index(tool_name);
          
          -- Index for session + timestamp lookups
          CREATE INDEX IF NOT EXISTS idx_session_time 
          ON tool_result_index(session_key, timestamp DESC);
          
          -- Index for timestamp-based cleanup
          CREATE INDEX IF NOT EXISTS idx_timestamp 
          ON tool_result_index(timestamp DESC);
        `);
        
        if (debug) {
          const count = db.prepare('SELECT COUNT(*) as count FROM tool_result_index').get();
          console.log(`[smart-context] Tool result index initialized: ${count.count} entries`);
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════
      // PHASE 2B: FTS5 FULL-TEXT SEARCH INDEX
      // ═══════════════════════════════════════════════════════════════════
      
      if (isEnabled('fts5Search')) {
        try {
          db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages 
            USING fts5(
              message_id UNINDEXED,
              content,
              tokenize='porter unicode61'
            );
          `);
          
          if (debug) {
            console.log('[smart-context] FTS5 index initialized');
          }
        } catch (err) {
          console.warn('[smart-context] FTS5 not available:', err.message);
        }
      }
      

      // ═══════════════════════════════════════════════════════════════════
      // PHASE 4: MULTI-LEVEL MEMORY SYSTEM
      // ═══════════════════════════════════════════════════════════════════
      // Three-tier memory storage: session → agent → user
      // CRITICAL: All tables include user_id for cross-user isolation
      
      db.exec(`
        -- memory_facts: Stores actual facts/memories with vector support
        CREATE TABLE IF NOT EXISTS memory_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL CHECK(scope IN ('user', 'agent', 'session')),
          user_id TEXT NOT NULL,
          agent_id TEXT,
          session_id TEXT,
          key TEXT,
          value TEXT NOT NULL,
          category TEXT,
          content_hash TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          metadata TEXT
        );
        
        -- memory_patterns: Stores behavioral patterns (FIXED: added user_id)
        CREATE TABLE IF NOT EXISTS memory_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          pattern_type TEXT NOT NULL,
          observation_count INTEGER DEFAULT 1,
          confidence REAL DEFAULT 0.5,
          description TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(user_id, agent_id, pattern_type)
        );
        
        -- memory_interactions: Audit log for facts
        CREATE TABLE IF NOT EXISTS memory_interactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fact_id INTEGER NOT NULL,
          interaction_type TEXT NOT NULL CHECK(interaction_type IN ('extracted', 'retrieved', 'reinforced', 'corrected', 'deleted')),
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (fact_id) REFERENCES memory_facts(id) ON DELETE CASCADE
        );
        
        -- ═══════════════════════════════════════════════════════════════
        -- INDEXES (Critical for performance at scale)
        -- ═══════════════════════════════════════════════════════════════
        
        -- Fast user+scope retrieval
        CREATE INDEX IF NOT EXISTS idx_facts_user_scope 
        ON memory_facts(user_id, scope);
        
        -- LRU cleanup
        CREATE INDEX IF NOT EXISTS idx_facts_lru 
        ON memory_facts(scope, last_accessed_at);
        
        -- Session expiration
        CREATE INDEX IF NOT EXISTS idx_facts_session 
        ON memory_facts(session_id, created_at) 
        WHERE scope = 'session';
        
        -- Content hash lookup (links to embeddings table)
        CREATE INDEX IF NOT EXISTS idx_facts_content_hash 
        ON memory_facts(content_hash);
        
        -- Key-based upsert
        CREATE INDEX IF NOT EXISTS idx_facts_key 
        ON memory_facts(user_id, key) 
        WHERE key IS NOT NULL;
        
        -- Pattern retrieval
        CREATE INDEX IF NOT EXISTS idx_patterns_user_agent 
        ON memory_patterns(user_id, agent_id);
        
        -- Interaction audit
        CREATE INDEX IF NOT EXISTS idx_interactions_fact 
        ON memory_interactions(fact_id);
        
        CREATE INDEX IF NOT EXISTS idx_interactions_time 
        ON memory_interactions(timestamp);
      `);
      
      if (debug) {
        const factCount = db.prepare('SELECT COUNT(*) as count FROM memory_facts').get();
        const patternCount = db.prepare('SELECT COUNT(*) as count FROM memory_patterns').get();
        console.log(`[smart-context] Phase 4 memory initialized: ${factCount.count} facts, ${patternCount.count} patterns`);
      }

      // Release pooled connection
      if (pool) {
        pool.release(db);
        db = null;
      }
      
      // Prepare statements (for non-pooled mode)
      if (!pool) {
        getStmt = db.prepare('SELECT embedding FROM embeddings WHERE content_hash = ?');
        setStmt = db.prepare(`
          INSERT OR REPLACE INTO embeddings (content_hash, embedding, created_at, accessed_at)
          VALUES (?, ?, ?, ?)
        `);
      }
      
      initialized = true;
      
      if (debug) {
        const conn = pool ? await pool.acquire() : db;
        try {
          const count = conn.prepare('SELECT COUNT(*) as count FROM embeddings').get();
          console.log(`[smart-context] Cache initialized: ${count.count} cached embeddings`);
          
          // Log index stats
          const indexes = conn.prepare(`
            SELECT name, tbl_name FROM sqlite_master 
            WHERE type='index' AND tbl_name='embeddings'
          `).all();
          console.log(`[smart-context] Indexes created:`, indexes.map(i => i.name));
        } finally {
          if (pool) pool.release(conn);
        }
      }
      
      // Cleanup old entries (keep last 10000)
      setTimeout(() => {
        cleanupOldEntries(debug);
      }, 5000);
      
    } catch (err) {
      console.error('[smart-context] Cache init failed:', err.message);
      db = null;
      pool = null;
    }
  }
  
  /**
   * Cleanup old cache entries
   */
  async function cleanupOldEntries(debug) {
    try {
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return;
      
      try {
        const deleted = conn.prepare(`
          DELETE FROM embeddings 
          WHERE content_hash NOT IN (
            SELECT content_hash FROM embeddings 
            ORDER BY accessed_at DESC LIMIT 10000
          )
        `).run();
        
        if (deleted.changes > 0 && debug) {
          console.log(`[smart-context] Cleaned up ${deleted.changes} old cache entries`);
        }
        
        // Cleanup old tool results (keep last 5000)
        if (isEnabled('toolResultIndex')) {
          const deletedTools = conn.prepare(`
            DELETE FROM tool_result_index 
            WHERE id NOT IN (
              SELECT id FROM tool_result_index 
              ORDER BY timestamp DESC LIMIT 5000
            )
          `).run();
          
          if (deletedTools.changes > 0 && debug) {
            console.log(`[smart-context] Cleaned up ${deletedTools.changes} old tool results`);
          }
        }
      } finally {
        if (pool) pool.release(conn);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
  
  return {
    /**
     * Get cached embedding
     */
    async get(content) {
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return null;
      
      try {
        const hash = hashContent(content);
        const stmt = pool 
          ? conn.prepare('SELECT embedding FROM embeddings WHERE content_hash = ?')
          : getStmt;
        const row = stmt.get(hash);
        
        if (row) {
          // Update access time (using covering index)
          conn.prepare('UPDATE embeddings SET accessed_at = ? WHERE content_hash = ?')
            .run(Date.now(), hash);
          
          return deserializeEmbedding(row.embedding);
        }
        
        return null;
      } catch (err) {
        if (debug) console.error('[smart-context] Cache get error:', err.message);
        return null;
      } finally {
        if (pool) pool.release(conn);
      }
    },
    
    /**
     * Store embedding in cache
     */
    async set(content, embedding) {
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return;
      
      try {
        const hash = hashContent(content);
        const now = Date.now();
        const stmt = pool
          ? conn.prepare(`
              INSERT OR REPLACE INTO embeddings (content_hash, embedding, created_at, accessed_at)
              VALUES (?, ?, ?, ?)
            `)
          : setStmt;
        stmt.run(hash, serializeEmbedding(embedding), now, now);
      } catch (err) {
        if (debug) console.error('[smart-context] Cache set error:', err.message);
      } finally {
        if (pool) pool.release(conn);
      }
    },
    
    /**
     * Get hash for content (for external use)
     */
    hash(content) {
      return hashContent(content);
    },
    
    /**
     * PHASE 2B: Index tool result for searchable retrieval
     */
    async indexToolResult(message, sessionKey, embedder) {
      if (!isEnabled('toolResultIndex')) return;
      
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return;
      
      try {
        const toolResults = extractToolResultInfo(message);
        if (!toolResults) return;
        
        // Handle single result or array of results
        const results = Array.isArray(toolResults) ? toolResults : [toolResults];
        
        for (const toolResult of results) {
          const { toolCallId, toolName, result, timestamp } = toolResult;
          
          // Truncate very long results (keep first 5000 chars)
          const resultText = result.length > 5000 
            ? result.slice(0, 5000) + '...[truncated]' 
            : result;
          
          // Compute embedding for result text
          let embedding;
          const cached = await this.get(resultText);
          if (cached) {
            embedding = cached;
          } else {
            embedding = await embedder.embed(resultText);
            await this.set(resultText, embedding);
          }
          
          // Store in tool_result_index
          conn.prepare(`
            INSERT INTO tool_result_index 
            (session_key, tool_name, tool_call_id, timestamp, result_text, embedding, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            sessionKey,
            toolName,
            toolCallId,
            timestamp,
            resultText,
            serializeEmbedding(embedding),
            Date.now()
          );
        }
        
        if (debug) {
          console.log(`[smart-context] Indexed ${results.length} tool result(s) for session ${sessionKey}`);
        }
      } catch (err) {
        if (debug) console.error('[smart-context] Tool result indexing error:', err.message);
      } finally {
        if (pool) pool.release(conn);
      }
    },
    
    /**
     * PHASE 2B: Search tool results by query
     */
    async searchToolResults(query, embedder, { topK = 5, toolName = null, sessionKey = null } = {}) {
      if (!isEnabled('toolResultIndex')) return [];
      
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return [];
      
      try {
        // Compute query embedding
        let queryEmbedding;
        const cached = await this.get(query);
        if (cached) {
          queryEmbedding = cached;
        } else {
          queryEmbedding = await embedder.embed(query);
          await this.set(query, queryEmbedding);
        }
        
        // Build SQL query with optional filters
        let sql = 'SELECT * FROM tool_result_index WHERE 1=1';
        const params = [];
        
        if (toolName) {
          sql += ' AND tool_name = ?';
          params.push(toolName);
        }
        
        if (sessionKey) {
          sql += ' AND session_key = ?';
          params.push(sessionKey);
        }
        
        sql += ' ORDER BY timestamp DESC LIMIT 1000';
        
        const rows = conn.prepare(sql).all(...params);
        
        // Compute similarities
        const scored = rows.map(row => {
          const embedding = deserializeEmbedding(row.embedding);
          const similarity = cosineSimilarity(queryEmbedding, embedding);
          return { ...row, similarity };
        });
        
        // Sort by similarity and return top K
        scored.sort((a, b) => b.similarity - a.similarity);
        
        const results = scored.slice(0, topK).map(row => ({
          toolName: row.tool_name,
          toolCallId: row.tool_call_id,
          resultText: row.result_text,
          timestamp: row.timestamp,
          sessionKey: row.session_key,
          similarity: row.similarity
        }));
        
        if (debug) {
          console.log(`[smart-context] Found ${results.length} relevant tool results for query: ${query.slice(0, 50)}...`);
        }
        
        return results;
      } catch (err) {
        if (debug) console.error('[smart-context] Tool result search error:', err.message);
        return [];
      } finally {
        if (pool) pool.release(conn);
      }
    },
    
    /**
     * PHASE 2B: Index message for FTS5 keyword search
     */
    async indexMessageForFTS(messageId, content) {
      if (!isEnabled('fts5Search')) return;
      
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return;
      
      try {
        const contentText = typeof content === 'string' 
          ? content 
          : JSON.stringify(content);
        
        conn.prepare(`
          INSERT OR REPLACE INTO fts_messages (message_id, content)
          VALUES (?, ?)
        `).run(messageId, contentText);
      } catch (err) {
        if (debug) console.error('[smart-context] FTS5 indexing error:', err.message);
      } finally {
        if (pool) pool.release(conn);
      }
    },
    
    
    /**
     * PHASE 2: Bulk index messages for FTS5 (optimized for batch operations)
     * 
     * Indexes multiple messages at once, deduplicating and batching SQL inserts.
     * Called once per selectMessages() invocation to ensure all messages are indexed.
     * 
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Indexing options
     * @param {boolean} options.debug - Enable debug logging
     * @returns {Promise<number>} - Number of messages indexed
     */
    async indexMessagesForFTS(messages, { debug = false } = {}) {
      if (!isEnabled('fts5Search')) return 0;
      if (!messages || messages.length === 0) return 0;
      
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return 0;
      
      try {
        const startTime = Date.now();
        let indexedCount = 0;
        
        // Check which messages are already indexed
        const existingIds = new Set();
        
        try {
          const rows = conn.prepare('SELECT message_id FROM fts_messages').all();
          rows.forEach(row => existingIds.add(row.message_id));
        } catch (err) {
          // FTS table might not exist, that's ok
        }
        
        // Prepare batch insert statement
        const insertStmt = conn.prepare(`
          INSERT OR REPLACE INTO fts_messages (message_id, content)
          VALUES (?, ?)
        `);
        
        // Begin transaction for batch insert
        conn.prepare('BEGIN').run();
        
        try {
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg) continue;
            
            // Generate message ID (use existing or create from index)
            const messageId = msg.id || `msg-${i}-${Date.now()}`;
            
            // Skip if already indexed
            if (existingIds.has(messageId)) continue;
            
            // Extract text content
            let contentText = '';
            
            if (typeof msg.content === 'string') {
              contentText = msg.content;
            } else if (Array.isArray(msg.content)) {
              contentText = msg.content
                .filter(block => block && typeof block === 'object')
                .map(block => {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    return block.text;
                  }
                  if ((block.type === 'toolResult' || block.type === 'tool_result') && block.content) {
                    const result = typeof block.content === 'string' 
                      ? block.content 
                      : JSON.stringify(block.content);
                    return result.slice(0, 1000);  // Limit tool results
                  }
                  return '';
                })
                .filter(Boolean)
                .join('\n');
            }
            
            // Skip empty messages or very short ones
            if (!contentText || contentText.length < 10) continue;
            
            // Limit content length to avoid bloating FTS index
            if (contentText.length > 5000) {
              contentText = contentText.slice(0, 5000) + '...';
            }
            
            // Insert into FTS index
            insertStmt.run(messageId, contentText);
            indexedCount++;
          }
          
          conn.prepare('COMMIT').run();
          
        } catch (err) {
          conn.prepare('ROLLBACK').run();
          throw err;
        }
        
        const indexTime = Date.now() - startTime;
        
        if (debug && indexedCount > 0) {
          console.log(`[smart-context] Indexed ${indexedCount} messages for FTS5 in ${indexTime}ms`);
        }
        
        return indexedCount;
        
      } catch (err) {
        if (debug) console.error('[smart-context] Bulk FTS5 indexing error:', err.message);
        return 0;
      } finally {
        if (pool) pool.release(conn);
      }
    },
    /**
     * PHASE 2B: Search messages using FTS5 keyword matching
     */
    async searchKeywords(query, { topK = 10 } = {}) {
      if (!isEnabled('fts5Search')) return [];
      
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return [];
      
      try {
        // Use FTS5 MATCH syntax
        const rows = conn.prepare(`
          SELECT message_id, content, rank 
          FROM fts_messages 
          WHERE fts_messages MATCH ? 
          ORDER BY rank 
          LIMIT ?
        `).all(query, topK);
        
        return rows.map(row => ({
          messageId: row.message_id,
          content: row.content,
          rank: row.rank
        }));
      } catch (err) {
        if (debug) console.error('[smart-context] FTS5 search error:', err.message);
        return [];
      } finally {
        if (pool) pool.release(conn);
      }
    },
    
    /**
     * Get cache stats
     */
    async stats() {
      await init();
      
      const conn = pool ? await pool.acquire() : db;
      if (!conn) return { enabled: false, count: 0, poolEnabled: false };
      
      try {
        const row = conn.prepare('SELECT COUNT(*) as count FROM embeddings').get();
        const stats = { 
          enabled: true, 
          count: row.count,
          poolEnabled: isEnabled('connectionPool'),
          toolResultIndexEnabled: isEnabled('toolResultIndex'),
          fts5SearchEnabled: isEnabled('fts5Search')
        };
        
        if (pool) {
          stats.pool = pool.stats();
        }
        
        if (isEnabled('toolResultIndex')) {
          const toolCount = conn.prepare('SELECT COUNT(*) as count FROM tool_result_index').get();
          stats.toolResultCount = toolCount.count;
        }
        
        if (isEnabled('fts5Search')) {
          try {
            const ftsCount = conn.prepare('SELECT COUNT(*) as count FROM fts_messages').get();
            stats.ftsMessageCount = ftsCount.count;
          } catch {
            stats.ftsMessageCount = 0;
          }
        }
        
        return stats;
      } catch {
        return { enabled: false, count: 0, poolEnabled: false };
      } finally {
        if (pool) pool.release(conn);
      }
    },
    
    /**
     * Get pool stats (if pooling enabled)
     */
    poolStats() {
      if (!pool) return null;
      return pool.stats();
    },
    

    /**
     * PHASE 4: Get database connection for memory operations
     * @internal - Used by memory.js module
     */
    async _getConnection() {
      await init();
      
      if (pool) {
        return await pool.acquire();
      }
      
      return db;
    },
    
    /**
     * PHASE 4: Release database connection
     * @internal - Used by memory.js module
     */
    _releaseConnection(conn) {
      if (pool && conn) {
        pool.release(conn);
      }
      // For non-pooled mode, conn === db, so no release needed
    },

    /**
     * Close database connection(s)
     */
    close() {
      if (pool) {
        pool.closeAll();
        pool = null;
      } else if (db) {
        db.close();
        db = null;
      }
      initialized = false;
    }
  };
}

export default { createCache };
