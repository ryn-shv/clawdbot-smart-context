/**
 * Tool Results Store - Enhanced with Phase 2 Chunking & Indexing
 * 
 * SQLite-based storage for full tool results that have been truncated
 * in the message history. Supports TTL, LRU eviction, and idempotency.
 * 
 * PHASE 2 ENHANCEMENTS:
 * - Text chunking (500 tokens, 50 token overlap)
 * - Embedding generation for chunks
 * - Semantic search over chunks
 * 
 * @module tool-results/store
 */

import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { isEnabled, getConfig } from '../config.js';

let Database = null;

/**
 * Generate unique result ID
 * Format: tr_XXXXXXXX (8 hex chars)
 */
export function generateResultId() {
  return 'tr_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Generate unique chunk ID
 * Format: trc_XXXXXXXX (8 hex chars)
 */
export function generateChunkId() {
  return 'trc_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Hash content for idempotency check
 */
export function hashContent(content) {
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Estimate token count for text
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(str.length / 4);
}

/**
 * Chunk text into overlapping segments
 * 
 * @param {string} text - Text to chunk
 * @param {Object} options - Chunking options
 * @param {number} options.maxTokens - Max tokens per chunk (default: 500)
 * @param {number} options.overlap - Token overlap between chunks (default: 50)
 * @returns {Array<{text: string, tokens: number, startOffset: number, endOffset: number}>}
 */
export function chunkText(text, { maxTokens = 500, overlap = 50 } = {}) {
  if (!text || typeof text !== 'string') return [];
  
  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;
  
  const chunks = [];
  let offset = 0;
  
  while (offset < text.length) {
    const end = Math.min(offset + maxChars, text.length);
    let chunkText = text.slice(offset, end);
    
    // Try to break at sentence boundaries if not at end
    if (end < text.length) {
      const lastPeriod = chunkText.lastIndexOf('. ');
      const lastNewline = chunkText.lastIndexOf('\n\n');
      const breakPoint = Math.max(lastPeriod, lastNewline);
      
      // Only use boundary if it's in the second half of the chunk
      if (breakPoint > maxChars / 2) {
        chunkText = text.slice(offset, offset + breakPoint + 1);
      }
    }
    
    chunks.push({
      text: chunkText,
      tokens: estimateTokens(chunkText),
      startOffset: offset,
      endOffset: offset + chunkText.length
    });
    
    // Move offset forward, accounting for overlap
    offset += chunkText.length - overlapChars;
    
    // Prevent infinite loop
    if (chunkText.length === 0) break;
  }
  
  return chunks;
}

/**
 * Serialize embedding to Buffer
 */
function serializeEmbedding(embedding) {
  if (!embedding || !Array.isArray(embedding)) return null;
  
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
  if (!buffer) return null;
  
  const embedding = [];
  for (let i = 0; i < buffer.length; i += 4) {
    embedding.push(buffer.readFloatLE(i));
  }
  return embedding;
}

/**
 * Resolve database path
 */
function resolveDbPath(configPath) {
  if (configPath) {
    return configPath.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), '.clawdbot', 'tool-results.db');
}

/**
 * Create tool results store instance
 */
export function createToolResultStore(config = {}) {
  const dbPath = resolveDbPath(config.dbPath);
  const ttlHours = config.ttlHours ?? 24;
  const maxResults = config.maxResults ?? 1000;
  const debug = config.debug || false;
  
  // Embedder reference (injected from outside)
  let embedder = config.embedder || null;
  
  let db = null;
  let initialized = false;
  let initError = null;
  
  // Prepared statements
  let stmts = {};
  
  /**
   * Initialize database
   */
  async function init() {
    if (initialized) return true;
    if (initError) return false;
    
    try {
      // Ensure directory exists
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Try to import better-sqlite3
      if (!Database) {
        try {
          const mod = await import('better-sqlite3');
          Database = mod.default;
        } catch (err) {
          initError = err;
          console.warn('[tool-results] better-sqlite3 not available, storage disabled');
          return false;
        }
      }
      
      db = new Database(dbPath);
      
      // Create tables
      db.exec(`
        -- Main results table
        CREATE TABLE IF NOT EXISTS tool_results (
          result_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          session_id TEXT,
          tool_use_id TEXT,
          tool_name TEXT NOT NULL,
          full_result TEXT NOT NULL,
          truncated_preview TEXT,
          token_count INTEGER NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          expires_at INTEGER
        );
        
        CREATE INDEX IF NOT EXISTS idx_tr_hash ON tool_results(content_hash);
        CREATE INDEX IF NOT EXISTS idx_tr_session ON tool_results(session_id);
        CREATE INDEX IF NOT EXISTS idx_tr_created ON tool_results(created_at);
        CREATE INDEX IF NOT EXISTS idx_tr_accessed ON tool_results(accessed_at);
        CREATE INDEX IF NOT EXISTS idx_tr_expires ON tool_results(expires_at);
        CREATE INDEX IF NOT EXISTS idx_tr_tool_name ON tool_results(tool_name);
        
        -- Chunks table for Phase 2 RAG
        CREATE TABLE IF NOT EXISTS tool_result_chunks (
          chunk_id TEXT PRIMARY KEY,
          result_id TEXT NOT NULL,
          chunk_idx INTEGER NOT NULL,
          chunk_text TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          embedding BLOB,
          start_offset INTEGER,
          end_offset INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (result_id) REFERENCES tool_results(result_id) ON DELETE CASCADE
        );
        
        CREATE INDEX IF NOT EXISTS idx_trc_result ON tool_result_chunks(result_id, chunk_idx);
        CREATE INDEX IF NOT EXISTS idx_trc_embedding ON tool_result_chunks(embedding) WHERE embedding IS NOT NULL;
      `);
      
      // Prepare statements
      stmts = {
        insert: db.prepare(`
          INSERT INTO tool_results 
          (result_id, content_hash, session_id, tool_use_id, tool_name, 
           full_result, truncated_preview, token_count, metadata, 
           created_at, accessed_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        
        getById: db.prepare(`
          SELECT * FROM tool_results WHERE result_id = ?
        `),
        
        getByHash: db.prepare(`
          SELECT result_id FROM tool_results WHERE content_hash = ?
        `),
        
        updateAccess: db.prepare(`
          UPDATE tool_results SET accessed_at = ? WHERE result_id = ?
        `),
        
        deleteById: db.prepare(`
          DELETE FROM tool_results WHERE result_id = ?
        `),
        
        deleteExpired: db.prepare(`
          DELETE FROM tool_results WHERE expires_at IS NOT NULL AND expires_at < ?
        `),
        
        deleteLRU: db.prepare(`
          DELETE FROM tool_results 
          WHERE result_id IN (
            SELECT result_id FROM tool_results 
            ORDER BY accessed_at ASC 
            LIMIT ?
          )
        `),
        
        count: db.prepare(`
          SELECT COUNT(*) as count FROM tool_results
        `),
        
        stats: db.prepare(`
          SELECT 
            COUNT(*) as total_results,
            SUM(token_count) as total_tokens,
            SUM(LENGTH(full_result)) as total_bytes
          FROM tool_results
        `),
        
        // Chunk statements
        insertChunk: db.prepare(`
          INSERT INTO tool_result_chunks
          (chunk_id, result_id, chunk_idx, chunk_text, token_count, 
           embedding, start_offset, end_offset, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        
        getChunksByResultId: db.prepare(`
          SELECT * FROM tool_result_chunks 
          WHERE result_id = ? 
          ORDER BY chunk_idx
        `),
        
        getAllChunksWithEmbeddings: db.prepare(`
          SELECT * FROM tool_result_chunks 
          WHERE embedding IS NOT NULL
        `),
        
        chunkStats: db.prepare(`
          SELECT 
            COUNT(*) as total_chunks,
            COUNT(CASE WHEN embedding IS NOT NULL THEN 1 END) as chunks_with_embeddings
          FROM tool_result_chunks
        `)
      };
      
      initialized = true;
      
      if (debug) {
        const count = stmts.count.get().count;
        console.log(`[tool-results] Store initialized: ${count} stored results`);
      }
      
      // Schedule cleanup
      setTimeout(() => cleanup().catch(() => {}), 5000);
      
      return true;
    } catch (err) {
      initError = err;
      console.error('[tool-results] Store init failed:', err.message);
      db = null;
      return false;
    }
  }
  
  /**
   * Cleanup expired results and enforce LRU limit
   */
  async function cleanup() {
    if (!db || !initialized) return;
    
    try {
      const now = Date.now();
      
      // Delete expired
      const expired = stmts.deleteExpired.run(now);
      if (expired.changes > 0 && debug) {
        console.log(`[tool-results] Cleaned up ${expired.changes} expired results`);
      }
      
      // Enforce max count via LRU
      const countData = stmts.count.get();
      const count = countData ? countData.count : 0;
      if (count > maxResults) {
        const toDelete = count - maxResults;
        const deleted = stmts.deleteLRU.run(toDelete);
        if (deleted.changes > 0 && debug) {
          console.log(`[tool-results] LRU evicted ${deleted.changes} results`);
        }
      }
    } catch (err) {
      if (debug) console.error('[tool-results] Cleanup error:', err.message);
    }
  }
  
  return {
    // Allow injecting embedder after creation
    set embedder(e) { embedder = e; },
    
    /**
     * Save a tool result
     * Returns existing result_id if content already stored (idempotent)
     */
    async saveResult(data) {
      try {
        if (!await init()) return null;
        
        const {
          resultId = generateResultId(),
          sessionId,
          toolUseId,
          toolName,
          fullResult,
          truncatedPreview = '',
          tokenCount = estimateTokens(fullResult),
          metadata = {}
        } = data;
        
        const contentHash = hashContent(fullResult);
        const now = Date.now();
        const expiresAt = ttlHours > 0 ? now + (ttlHours * 60 * 60 * 1000) : null;
        
        // Check for existing (idempotency)
        const existing = stmts.getByHash.get(contentHash);
        if (existing) {
          // Update access time and return existing ID
          stmts.updateAccess.run(now, existing.result_id);
          if (debug) {
            console.log(`[tool-results] Reusing existing result: ${existing.result_id}`);
          }
          return existing.result_id;
        }
        
        // Insert new
        stmts.insert.run(
          resultId,
          contentHash,
          sessionId || null,
          toolUseId || null,
          toolName,
          fullResult,
          truncatedPreview,
          tokenCount,
          JSON.stringify(metadata),
          now,
          now,
          expiresAt
        );
        
        if (debug) {
          console.log(`[tool-results] Saved result: ${resultId} (${tokenCount} tokens)`);
        }
        
        return resultId;
      } catch (err) {
        console.error('[tool-results] Save error:', err.message);
        return null;
      }
    },
    
    /**
     * PHASE 2: Save result with chunks and embeddings
     * 
     * Chunks the full result, generates embeddings, and stores both.
     * Falls back gracefully if embedder is not available.
     */
    async saveResultWithChunks(data) {
      // First save the main result
      const resultId = await this.saveResult(data);
      if (!resultId) return null;
      
      // Skip chunking if feature is disabled
      if (!isEnabled('toolResultIndex')) {
        if (debug) console.log('[tool-results] Tool indexing disabled, skipping chunks');
        return resultId;
      }
      
      // Skip if no embedder available
      if (!embedder) {
        if (debug) console.log('[tool-results] No embedder available, skipping chunks');
        return resultId;
      }
      
      try {
        if (!await init()) return resultId;
        
        const chunkSize = getConfig('toolIndexChunkSize') || 500;
        const chunkOverlap = getConfig('toolIndexChunkOverlap') || 50;
        
        // Chunk the text
        const chunks = chunkText(data.fullResult, { 
          maxTokens: chunkSize, 
          overlap: chunkOverlap 
        });
        
        if (chunks.length === 0) {
          if (debug) console.log('[tool-results] No chunks generated (empty result)');
          return resultId;
        }
        
        if (debug) {
          console.log(`[tool-results] Generated ${chunks.length} chunks for ${resultId}`);
        }
        
        // Generate embeddings (use batch if available)
        let embeddings;
        if (embedder.embedBatch && chunks.length > 3) {
          embeddings = await embedder.embedBatch(
            chunks.map(c => c.text),
            { batchSize: 10 }
          );
        } else {
          embeddings = await Promise.all(
            chunks.map(c => embedder.embed(c.text))
          );
        }
        
        // Store chunks with embeddings
        const now = Date.now();
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = embeddings[i];
          
          stmts.insertChunk.run(
            generateChunkId(),
            resultId,
            i,
            chunk.text,
            chunk.tokens,
            serializeEmbedding(embedding),
            chunk.startOffset,
            chunk.endOffset,
            now
          );
        }
        
        if (debug) {
          console.log(`[tool-results] Stored ${chunks.length} chunks with embeddings`);
        }
        
        return resultId;
      } catch (err) {
        console.error('[tool-results] Chunk storage error:', err.message);
        // Return resultId even if chunking failed (graceful degradation)
        return resultId;
      }
    },
    
    /**
     * Get a result by ID
     */
    async getResult(resultId) {
      try {
        if (!await init()) return null;
        
        const row = stmts.getById.get(resultId);
        if (!row) return null;
        
        // Update access time
        stmts.updateAccess.run(Date.now(), resultId);
        
        return {
          resultId: row.result_id,
          sessionId: row.session_id,
          toolUseId: row.tool_use_id,
          toolName: row.tool_name,
          fullResult: row.full_result,
          truncatedPreview: row.truncated_preview,
          tokenCount: row.token_count,
          metadata: JSON.parse(row.metadata || '{}'),
          createdAt: row.created_at,
          accessedAt: row.accessed_at
        };
      } catch (err) {
        if (debug) console.error('[tool-results] Get error:', err.message);
        return null;
      }
    },
    
    /**
     * Get chunks for a result
     */
    async getChunks(resultId) {
      try {
        if (!await init()) return [];
        
        const rows = stmts.getChunksByResultId.all(resultId);
        
        return rows.map(row => ({
          chunkId: row.chunk_id,
          resultId: row.result_id,
          chunkIdx: row.chunk_idx,
          chunkText: row.chunk_text,
          tokenCount: row.token_count,
          embedding: deserializeEmbedding(row.embedding),
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          createdAt: row.created_at
        }));
      } catch (err) {
        if (debug) console.error('[tool-results] Get chunks error:', err.message);
        return [];
      }
    },
    
    /**
     * Check if content already stored (by hash)
     */
    async hasContent(content) {
      try {
        if (!await init()) return null;
        
        const hash = hashContent(content);
        const existing = stmts.getByHash.get(hash);
        return existing?.result_id || null;
      } catch (err) {
        return null;
      }
    },
    
    /**
     * Delete a result (cascades to chunks)
     */
    async deleteResult(resultId) {
      try {
        if (!await init()) return false;
        
        const result = stmts.deleteById.run(resultId);
        return result.changes > 0;
      } catch (err) {
        if (debug) console.error('[tool-results] Delete error:', err.message);
        return false;
      }
    },
    
    /**
     * Get storage statistics
     */
    async getStats() {
      try {
        if (!await init()) {
          return { 
            enabled: false, 
            totalResults: 0, 
            totalTokens: 0, 
            totalBytes: 0,
            totalChunks: 0,
            chunksWithEmbeddings: 0
          };
        }
        
        const stats = stmts.stats.get();
        const chunkStats = stmts.chunkStats.get();
        
        return {
          enabled: true,
          totalResults: stats.total_results || 0,
          totalTokens: stats.total_tokens || 0,
          totalBytes: stats.total_bytes || 0,
          totalChunks: chunkStats.total_chunks || 0,
          chunksWithEmbeddings: chunkStats.chunks_with_embeddings || 0,
          indexingEnabled: isEnabled('toolResultIndex')
        };
      } catch {
        return { 
          enabled: false, 
          totalResults: 0, 
          totalTokens: 0, 
          totalBytes: 0,
          totalChunks: 0,
          chunksWithEmbeddings: 0
        };
      }
    },
    
    /**
     * Get all chunks with embeddings (for search)
     * Internal use only - used by retriever
     */
    async _getAllChunksWithEmbeddings() {
      try {
        if (!await init()) return [];
        
        const rows = stmts.getAllChunksWithEmbeddings.all();
        
        return rows.map(row => ({
          chunkId: row.chunk_id,
          resultId: row.result_id,
          chunkIdx: row.chunk_idx,
          chunkText: row.chunk_text,
          tokenCount: row.token_count,
          embedding: deserializeEmbedding(row.embedding),
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          createdAt: row.created_at
        }));
      } catch (err) {
        if (debug) console.error('[tool-results] Get all chunks error:', err.message);
        return [];
      }
    },
    
    /**
     * Get database instance (for advanced queries)
     */
    getDb() {
      return db;
    },
    
    /**
     * Manual cleanup trigger
     */
    cleanup,
    
    /**
     * Close database connection
     */
    close() {
      if (db) {
        try {
          db.close();
        } catch (err) {
          // ignore close errors
        }
        db = null;
        initialized = false;
      }
    }
  };
}

export default { 
  createToolResultStore, 
  generateResultId, 
  generateChunkId,
  hashContent, 
  estimateTokens,
  chunkText
};
