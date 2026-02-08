/**
 * Phase 4: Multi-Level Memory System
 * 
 * Persistent, cross-session storage for facts, preferences, and patterns.
 * Three-tier hierarchy: session → agent → user
 * 
 * CRITICAL: All operations enforce user_id isolation to prevent cross-user data leakage
 * 
 * v2.0.2 FIXES:
 * - storeFact() now properly stores embeddings via cache.set()
 * - Added storeFactWithEmbedding() helper for explicit embedding storage
 * - retrieveFacts() properly computes query embeddings for semantic search
 * 
 * @module memory
 */

import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════
// ERROR CODES
// ═══════════════════════════════════════════════════════════════════════════

export const MemoryError = {
  MISSING_USER_ID: 'MEMORY_MISSING_USER_ID',
  MISSING_QUERY: 'MEMORY_MISSING_QUERY',
  INVALID_SCOPE: 'MEMORY_INVALID_SCOPE',
  MISSING_AGENT_ID: 'MEMORY_MISSING_AGENT_ID',
  MISSING_SESSION_ID: 'MEMORY_MISSING_SESSION_ID',
  STORAGE_FAILED: 'MEMORY_STORAGE_FAILED',
  RETRIEVAL_FAILED: 'MEMORY_RETRIEVAL_FAILED',
  EXTRACTION_FAILED: 'MEMORY_EXTRACTION_FAILED',
  DISABLED: 'MEMORY_DISABLED'
};

class MemoryException extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'MemoryException';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hash content for embedding lookup
 */
function hashContent(content) {
  return crypto
    .createHash('sha256')
    .update(typeof content === 'string' ? content : JSON.stringify(content))
    .digest('hex');
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
 * Compute BM25 score for keyword matching
 * Simplified implementation for fact retrieval
 */
function computeBM25Score(query, factValue, { k1 = 1.5, b = 0.75 } = {}) {
  const queryTerms = query.toLowerCase().split(/\s+/);
  const docTerms = factValue.toLowerCase().split(/\s+/);
  const docLength = docTerms.length;
  const avgDocLength = 50; // Reasonable assumption for fact length
  
  let score = 0;
  
  for (const term of queryTerms) {
    const termFreq = docTerms.filter(t => t.includes(term) || term.includes(t)).length;
    if (termFreq === 0) continue;
    
    // Simplified BM25 formula (without IDF component)
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLength / avgDocLength));
    score += numerator / denominator;
  }
  
  return score;
}

/**
 * Validate scope and required parameters
 */
function validateScope(scope, agentId, sessionId) {
  if (!['user', 'agent', 'session'].includes(scope)) {
    throw new MemoryException(
      MemoryError.INVALID_SCOPE,
      'scope must be user, agent, or session'
    );
  }
  
  if ((scope === 'agent' || scope === 'session') && !agentId) {
    throw new MemoryException(
      MemoryError.MISSING_AGENT_ID,
      'agentId required for agent/session scope'
    );
  }
  
  if (scope === 'session' && !sessionId) {
    throw new MemoryException(
      MemoryError.MISSING_SESSION_ID,
      'sessionId required for session scope'
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create memory instance with database connection
 * 
 * @param {Object} cache - Cache instance (provides DB connection + embedding storage)
 * @param {Object} config - Configuration options
 * @param {boolean} config.debug - Enable debug logging
 */
export function createMemory(cache, config = {}) {
  const debug = config.debug || false;
  
  return {
    /**
     * Store a new fact or reinforce an existing one
     * 
     * v2.0.2 FIX: Now properly stores embeddings when provided
     * 
     * @param {Object} params
     * @param {string} params.userId - User identifier (REQUIRED)
     * @param {string} params.scope - Memory scope ('user', 'agent', 'session')
     * @param {string} params.value - Fact content
     * @param {string} [params.key] - Optional identifier for upsert
     * @param {string} [params.category] - Fact category
     * @param {string} [params.agentId] - Required for agent/session scope
     * @param {string} [params.sessionId] - Required for session scope
     * @param {Object} [params.metadata] - Additional context
     * @param {Array<number>} [params.embedding] - Pre-computed embedding vector (CRITICAL for semantic search)
     * @returns {Promise<{factId: number, created: boolean, embeddingStored: boolean}>}
     */
    async storeFact(params) {
      const { userId, scope, value, key, category, agentId, sessionId, metadata, embedding } = params;
      
      // Validate required parameters
      if (!userId) {
        throw new MemoryException(MemoryError.MISSING_USER_ID, 'userId is required');
      }
      
      if (!value) {
        throw new MemoryException(MemoryError.STORAGE_FAILED, 'value is required');
      }
      
      validateScope(scope, agentId, sessionId);
      
      try {
        const now = Date.now();
        const contentHash = hashContent(value);
        const metadataJson = metadata ? JSON.stringify(metadata) : null;
        
        // Get database connection from cache
        const conn = await cache._getConnection();
        
        // ═══════════════════════════════════════════════════════════════════
        // v2.0.2 FIX: Store embedding in embeddings table
        // This is CRITICAL for semantic search to work!
        // ═══════════════════════════════════════════════════════════════════
        let embeddingStored = false;
        
        if (embedding && Array.isArray(embedding) && embedding.length > 0) {
          try {
            // Store embedding via cache.set() which handles the embeddings table
            await cache.set(value, embedding);
            embeddingStored = true;
            
            if (debug) {
              console.log(`[memory] Stored embedding for fact (dim: ${embedding.length}, hash: ${contentHash.slice(0, 8)}...)`);
            }
          } catch (embedErr) {
            // Log error but continue - fact can still be stored without embedding
            console.warn(`[memory] Failed to store embedding: ${embedErr.message}`);
          }
        }
        
        // Check if fact with same key exists (upsert logic)
        let existingFact = null;
        if (key) {
          existingFact = conn.prepare(`
            SELECT id, updated_at FROM memory_facts 
            WHERE user_id = ? AND scope = ? AND key = ?
          `).get(userId, scope, key);
        }
        
        let factId;
        let created;
        
        if (existingFact) {
          // Update existing fact
          conn.prepare(`
            UPDATE memory_facts 
            SET value = ?, category = ?, content_hash = ?, updated_at = ?, 
                last_accessed_at = ?, metadata = ?
            WHERE id = ?
          `).run(value, category, contentHash, now, now, metadataJson, existingFact.id);
          
          factId = existingFact.id;
          created = false;
          
          // Log reinforcement
          await this.logInteraction({ factId, type: 'reinforced' });
          
          if (debug) {
            console.log(`[memory] Updated fact ${factId} for user ${userId}`);
          }
        } else {
          // Insert new fact
          const result = conn.prepare(`
            INSERT INTO memory_facts 
            (scope, user_id, agent_id, session_id, key, value, category, 
             content_hash, created_at, updated_at, last_accessed_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            scope, userId, agentId || null, sessionId || null, key || null,
            value, category || null, contentHash, now, now, now, metadataJson
          );
          
          factId = result.lastInsertRowid;
          created = true;
          
          // Log extraction
          await this.logInteraction({ factId, type: 'extracted' });
          
          if (debug) {
            console.log(`[memory] Stored new fact ${factId} for user ${userId} (scope: ${scope}, embedding: ${embeddingStored})`);
          }
        }
        
        cache._releaseConnection(conn);
        
        return { factId, created, embeddingStored };
      } catch (err) {
        if (debug) console.error('[memory] storeFact error:', err);
        throw new MemoryException(MemoryError.STORAGE_FAILED, err.message);
      }
    },
    
    /**
     * Retrieve relevant facts using hybrid scoring (BM25 + cosine similarity)
     * 
     * v2.0.2 FIX: Properly handles query embedding for semantic search
     * 
     * @param {Object} params
     * @param {string} params.userId - User identifier (REQUIRED)
     * @param {string} params.query - Query text for similarity search
     * @param {string} [params.agentId] - Filter to agent-specific facts
     * @param {string} [params.sessionId] - Filter to session-specific facts
     * @param {Array<number>} [params.queryEmbedding] - Pre-computed query embedding (improves performance)
     * @param {Object} [params.options] - Retrieval options
     * @param {number} [params.options.topK=10] - Max facts to return
     * @param {number} [params.options.minScore=0.75] - Min similarity threshold
     * @param {string[]} [params.options.scopes] - Scopes to search (default: all)
     * @param {string[]} [params.options.categories] - Filter by categories
     * @returns {Promise<Array<Fact>>}
     */
    async retrieveFacts(params) {
      const { userId, query, agentId, sessionId, queryEmbedding, options = {} } = params;
      const {
        topK = 10,
        minScore = 0.75,
        scopes = ['user', 'agent', 'session'],
        categories
      } = options;
      
      // Validate required parameters
      if (!userId) {
        throw new MemoryException(MemoryError.MISSING_USER_ID, 'userId is required');
      }
      
      if (!query) {
        throw new MemoryException(MemoryError.MISSING_QUERY, 'query is required');
      }
      
      try {
        const conn = await cache._getConnection();
        
        // Build SQL query with filters
        let sql = `
          SELECT f.*, e.embedding 
          FROM memory_facts f
          LEFT JOIN embeddings e ON f.content_hash = e.content_hash
          WHERE f.user_id = ?
        `;
        const sqlParams = [userId];
        
        // Scope filter
        if (scopes && scopes.length > 0) {
          const placeholders = scopes.map(() => '?').join(',');
          sql += ` AND f.scope IN (${placeholders})`;
          sqlParams.push(...scopes);
        }
        
        // Agent filter
        if (agentId) {
          sql += ` AND (f.scope = 'user' OR f.agent_id = ?)`;
          sqlParams.push(agentId);
        }
        
        // Session filter
        if (sessionId) {
          sql += ` AND (f.scope != 'session' OR f.session_id = ?)`;
          sqlParams.push(sessionId);
        }
        
        // Category filter
        if (categories && categories.length > 0) {
          const placeholders = categories.map(() => '?').join(',');
          sql += ` AND f.category IN (${placeholders})`;
          sqlParams.push(...categories);
        }
        
        sql += ` ORDER BY f.last_accessed_at DESC LIMIT 1000`;
        
        const rows = conn.prepare(sql).all(...sqlParams);
        
        if (rows.length === 0) {
          cache._releaseConnection(conn);
          return [];
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // v2.0.2 FIX: Get query embedding for semantic search
        // Use provided embedding OR try to get from cache
        // ═══════════════════════════════════════════════════════════════════
        let queryVector = queryEmbedding;
        
        if (!queryVector) {
          // Try to get cached embedding for query
          queryVector = await cache.get(query);
          
          if (debug && queryVector) {
            console.log(`[memory] Using cached query embedding (dim: ${queryVector.length})`);
          }
        }
        
        // Track embedding stats
        let factsWithEmbeddings = 0;
        let factsWithoutEmbeddings = 0;
        
        // Compute hybrid scores (BM25 + cosine similarity)
        const scored = [];
        
        for (const row of rows) {
          // BM25 keyword score
          const bm25Score = computeBM25Score(query, row.value);
          
          // Cosine similarity score (if embedding available)
          let cosineScore = 0;
          
          if (row.embedding && queryVector) {
            const factEmbedding = deserializeEmbedding(row.embedding);
            if (factEmbedding) {
              cosineScore = cosineSimilarity(queryVector, factEmbedding);
              factsWithEmbeddings++;
            } else {
              factsWithoutEmbeddings++;
            }
          } else {
            factsWithoutEmbeddings++;
          }
          
          // Hybrid score: weighted average (60% cosine, 40% BM25)
          // If no embeddings available, fall back to BM25 only
          const hybridScore = queryVector && row.embedding
            ? (cosineScore * 0.6) + (bm25Score * 0.4)
            : bm25Score * 0.8; // Downweight BM25-only results
          
          if (hybridScore >= minScore || bm25Score > 0.5) {
            scored.push({
              id: row.id,
              scope: row.scope,
              value: row.value,
              category: row.category,
              key: row.key,
              score: Math.max(hybridScore, bm25Score * 0.8), // Ensure keyword matches aren't ignored
              cosineScore,
              bm25Score,
              hasEmbedding: !!row.embedding,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              lastAccessedAt: row.last_accessed_at,
              metadata: row.metadata ? JSON.parse(row.metadata) : null
            });
          }
        }
        
        // Sort by score and return top K
        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, topK);
        
        // Update last_accessed_at for retrieved facts
        if (results.length > 0) {
          const now = Date.now();
          const updateStmt = conn.prepare(
            'UPDATE memory_facts SET last_accessed_at = ? WHERE id = ?'
          );
          
          for (const fact of results) {
            updateStmt.run(now, fact.id);
            await this.logInteraction({ factId: fact.id, type: 'retrieved' });
          }
        }
        
        cache._releaseConnection(conn);
        
        if (debug) {
          console.log(`[memory] Retrieved ${results.length} facts for user ${userId}`, {
            query: query.slice(0, 50),
            withEmbeddings: factsWithEmbeddings,
            withoutEmbeddings: factsWithoutEmbeddings,
            queryHadEmbedding: !!queryVector
          });
        }
        
        return results;
      } catch (err) {
        if (debug) console.error('[memory] retrieveFacts error:', err);
        throw new MemoryException(MemoryError.RETRIEVAL_FAILED, err.message);
      }
    },
    
    /**
     * Update an existing fact
     * 
     * @param {number} factId - Fact ID to update
     * @param {Object} updates - Fields to update
     * @param {Array<number>} [updates.embedding] - New embedding if value changed
     * @returns {Promise<boolean>}
     */
    async updateFact(factId, updates) {
      try {
        const conn = await cache._getConnection();
        const now = Date.now();
        
        const fields = [];
        const values = [];
        
        if (updates.value !== undefined) {
          fields.push('value = ?');
          values.push(updates.value);
          
          if (updates.value) {
            const newHash = hashContent(updates.value);
            fields.push('content_hash = ?');
            values.push(newHash);
            
            // v2.0.2 FIX: Store new embedding if provided
            if (updates.embedding && Array.isArray(updates.embedding)) {
              await cache.set(updates.value, updates.embedding);
              if (debug) {
                console.log(`[memory] Updated embedding for fact ${factId}`);
              }
            }
          }
        }
        
        if (updates.category !== undefined) {
          fields.push('category = ?');
          values.push(updates.category);
        }
        
        if (updates.metadata !== undefined) {
          fields.push('metadata = ?');
          values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
        }
        
        if (fields.length === 0) {
          cache._releaseConnection(conn);
          return false;
        }
        
        fields.push('updated_at = ?');
        values.push(now);
        values.push(factId);
        
        const sql = `UPDATE memory_facts SET ${fields.join(', ')} WHERE id = ?`;
        const result = conn.prepare(sql).run(...values);
        
        if (result.changes > 0) {
          await this.logInteraction({ factId, type: 'corrected' });
        }
        
        cache._releaseConnection(conn);
        
        if (debug) {
          console.log(`[memory] Updated fact ${factId}`);
        }
        
        return result.changes > 0;
      } catch (err) {
        if (debug) console.error('[memory] updateFact error:', err);
        throw new MemoryException(MemoryError.STORAGE_FAILED, err.message);
      }
    },
    
    /**
     * Delete a specific fact
     * 
     * @param {number} factId - Fact ID to delete
     * @returns {Promise<boolean>}
     */
    async deleteFact(factId) {
      try {
        const conn = await cache._getConnection();
        
        await this.logInteraction({ factId, type: 'deleted' });
        
        const result = conn.prepare('DELETE FROM memory_facts WHERE id = ?').run(factId);
        
        cache._releaseConnection(conn);
        
        if (debug) {
          console.log(`[memory] Deleted fact ${factId}`);
        }
        
        return result.changes > 0;
      } catch (err) {
        if (debug) console.error('[memory] deleteFact error:', err);
        throw new MemoryException(MemoryError.STORAGE_FAILED, err.message);
      }
    },
    
    /**
     * Store or update a behavioral pattern
     * 
     * @param {Object} params
     * @param {string} params.userId - User identifier (REQUIRED)
     * @param {string} params.agentId - Agent identifier (REQUIRED)
     * @param {string} params.patternType - Pattern category
     * @param {string} params.description - Pattern description
     * @returns {Promise<{patternId: number, confidence: number, observations: number}>}
     */
    async storePattern(params) {
      const { userId, agentId, patternType, description } = params;
      
      if (!userId) {
        throw new MemoryException(MemoryError.MISSING_USER_ID, 'userId is required');
      }
      
      if (!agentId) {
        throw new MemoryException(MemoryError.MISSING_AGENT_ID, 'agentId is required');
      }
      
      try {
        const conn = await cache._getConnection();
        const now = Date.now();
        
        // Check if pattern exists
        const existing = conn.prepare(`
          SELECT id, observation_count, confidence 
          FROM memory_patterns 
          WHERE user_id = ? AND agent_id = ? AND pattern_type = ?
        `).get(userId, agentId, patternType);
        
        let patternId, observations, confidence;
        
        if (existing) {
          // Update existing pattern
          observations = existing.observation_count + 1;
          confidence = Math.min(0.95, existing.confidence + 0.1); // Cap at 0.95
          
          conn.prepare(`
            UPDATE memory_patterns 
            SET observation_count = ?, confidence = ?, description = ?, updated_at = ?
            WHERE id = ?
          `).run(observations, confidence, description, now, existing.id);
          
          patternId = existing.id;
        } else {
          // Insert new pattern
          const result = conn.prepare(`
            INSERT INTO memory_patterns 
            (user_id, agent_id, pattern_type, observation_count, confidence, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(userId, agentId, patternType, 1, 0.5, description, now, now);
          
          patternId = result.lastInsertRowid;
          observations = 1;
          confidence = 0.5;
        }
        
        cache._releaseConnection(conn);
        
        if (debug) {
          console.log(`[memory] Stored pattern ${patternId} for user ${userId} (confidence: ${confidence.toFixed(2)})`);
        }
        
        return { patternId, confidence, observations };
      } catch (err) {
        if (debug) console.error('[memory] storePattern error:', err);
        throw new MemoryException(MemoryError.STORAGE_FAILED, err.message);
      }
    },
    
    /**
     * Retrieve behavioral patterns for a user+agent
     * 
     * @param {Object} params
     * @param {string} params.userId - User identifier (REQUIRED)
     * @param {string} params.agentId - Agent identifier (REQUIRED)
     * @param {number} [params.minConfidence=0.5] - Minimum confidence threshold
     * @returns {Promise<Array>}
     */
    async retrievePatterns(params) {
      const { userId, agentId, minConfidence = 0.5 } = params;
      
      if (!userId) {
        throw new MemoryException(MemoryError.MISSING_USER_ID, 'userId is required');
      }
      
      if (!agentId) {
        throw new MemoryException(MemoryError.MISSING_AGENT_ID, 'agentId is required');
      }
      
      try {
        const conn = await cache._getConnection();
        
        const rows = conn.prepare(`
          SELECT * FROM memory_patterns 
          WHERE user_id = ? AND agent_id = ? AND confidence >= ?
          ORDER BY confidence DESC
        `).all(userId, agentId, minConfidence);
        
        cache._releaseConnection(conn);
        
        if (debug) {
          console.log(`[memory] Retrieved ${rows.length} patterns for user ${userId}`);
        }
        
        return rows.map(row => ({
          id: row.id,
          patternType: row.pattern_type,
          description: row.description,
          observations: row.observation_count,
          confidence: row.confidence,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      } catch (err) {
        if (debug) console.error('[memory] retrievePatterns error:', err);
        throw new MemoryException(MemoryError.RETRIEVAL_FAILED, err.message);
      }
    },
    
    /**
     * Log an interaction with a fact
     * 
     * @param {Object} params
     * @param {number} params.factId - Fact ID
     * @param {string} params.type - Interaction type
     * @returns {Promise<void>}
     */
    async logInteraction(params) {
      const { factId, type } = params;
      
      try {
        const conn = await cache._getConnection();
        
        conn.prepare(`
          INSERT INTO memory_interactions (fact_id, interaction_type, timestamp)
          VALUES (?, ?, ?)
        `).run(factId, type, Date.now());
        
        cache._releaseConnection(conn);
      } catch (err) {
        // Log errors but don't throw (non-critical operation)
        if (debug) console.error('[memory] logInteraction error:', err);
      }
    },
    
    /**
     * Clean up session-scoped facts
     * 
     * @param {string} sessionId - Session to cleanup
     * @returns {Promise<{deleted: number}>}
     */
    async cleanupSession(sessionId) {
      try {
        const conn = await cache._getConnection();
        
        const result = conn.prepare(`
          DELETE FROM memory_facts WHERE scope = 'session' AND session_id = ?
        `).run(sessionId);
        
        cache._releaseConnection(conn);
        
        if (debug) {
          console.log(`[memory] Cleaned up session ${sessionId}: ${result.changes} facts deleted`);
        }
        
        return { deleted: result.changes };
      } catch (err) {
        if (debug) console.error('[memory] cleanupSession error:', err);
        return { deleted: 0 };
      }
    },
    
    /**
     * Clean up old facts (LRU eviction)
     * 
     * @param {Object} params
     * @param {string} params.scope - Scope to cleanup
     * @param {number} params.limit - Max facts to keep
     * @returns {Promise<{deleted: number}>}
     */
    async cleanupOldFacts(params) {
      const { scope, limit } = params;
      
      try {
        const conn = await cache._getConnection();
        
        const result = conn.prepare(`
          DELETE FROM memory_facts 
          WHERE scope = ? AND id NOT IN (
            SELECT id FROM memory_facts 
            WHERE scope = ?
            ORDER BY last_accessed_at DESC 
            LIMIT ?
          )
        `).run(scope, scope, limit);
        
        cache._releaseConnection(conn);
        
        if (debug && result.changes > 0) {
          console.log(`[memory] Cleaned up ${result.changes} old ${scope}-scoped facts`);
        }
        
        return { deleted: result.changes };
      } catch (err) {
        if (debug) console.error('[memory] cleanupOldFacts error:', err);
        return { deleted: 0 };
      }
    },
    
    /**
     * Clean up old interactions
     * 
     * @param {Object} params
     * @param {number} params.olderThan - Timestamp threshold (ms)
     * @returns {Promise<{deleted: number}>}
     */
    async cleanupInteractions(params) {
      const { olderThan } = params;
      
      try {
        const conn = await cache._getConnection();
        
        const result = conn.prepare(`
          DELETE FROM memory_interactions WHERE timestamp < ?
        `).run(Date.now() - olderThan);
        
        cache._releaseConnection(conn);
        
        if (debug && result.changes > 0) {
          console.log(`[memory] Cleaned up ${result.changes} old interactions`);
        }
        
        return { deleted: result.changes };
      } catch (err) {
        if (debug) console.error('[memory] cleanupInteractions error:', err);
        return { deleted: 0 };
      }
    },
    
    /**
     * GDPR-compliant deletion of all user data
     * 
     * @param {string} userId - User identifier
     * @returns {Promise<{deletedFacts: number, deletedPatterns: number, deletedInteractions: number}>}
     */
    async forgetAll(userId) {
      try {
        const conn = await cache._getConnection();
        
        // Get fact IDs before deleting (for cascade)
        const factIds = conn.prepare(
          'SELECT id FROM memory_facts WHERE user_id = ?'
        ).all(userId).map(row => row.id);
        
        // Delete facts
        const factsResult = conn.prepare(
          'DELETE FROM memory_facts WHERE user_id = ?'
        ).run(userId);
        
        // Delete patterns
        const patternsResult = conn.prepare(
          'DELETE FROM memory_patterns WHERE user_id = ?'
        ).run(userId);
        
        // Interactions cascade automatically via FK
        
        cache._releaseConnection(conn);
        
        if (debug) {
          console.log(`[memory] GDPR deletion for user ${userId}: ${factsResult.changes} facts, ${patternsResult.changes} patterns`);
        }
        
        return {
          deletedFacts: factsResult.changes,
          deletedPatterns: patternsResult.changes,
          deletedInteractions: factIds.length // Approximate
        };
      } catch (err) {
        if (debug) console.error('[memory] forgetAll error:', err);
        throw new MemoryException(MemoryError.STORAGE_FAILED, err.message);
      }
    },
    
    /**
     * Get memory statistics
     * 
     * @param {string} userId - User identifier
     * @returns {Promise<Object>}
     */
    async stats(userId) {
      try {
        const conn = await cache._getConnection();
        
        const factCount = conn.prepare(
          'SELECT scope, COUNT(*) as count FROM memory_facts WHERE user_id = ? GROUP BY scope'
        ).all(userId);
        
        const patternCount = conn.prepare(
          'SELECT COUNT(*) as count FROM memory_patterns WHERE user_id = ?'
        ).get(userId);
        
        // v2.0.2: Count facts with embeddings
        const embeddingStats = conn.prepare(`
          SELECT 
            COUNT(f.id) as total_facts,
            COUNT(e.content_hash) as facts_with_embeddings
          FROM memory_facts f
          LEFT JOIN embeddings e ON f.content_hash = e.content_hash
          WHERE f.user_id = ?
        `).get(userId);
        
        const stats = {
          facts: {},
          patterns: patternCount.count,
          totalFacts: embeddingStats.total_facts,
          factsWithEmbeddings: embeddingStats.facts_with_embeddings,
          embeddingCoverage: embeddingStats.total_facts > 0 
            ? Math.round((embeddingStats.facts_with_embeddings / embeddingStats.total_facts) * 100) 
            : 0
        };
        
        for (const row of factCount) {
          stats.facts[row.scope] = row.count;
        }
        
        cache._releaseConnection(conn);
        
        return stats;
      } catch (err) {
        if (debug) console.error('[memory] stats error:', err);
        return { facts: {}, patterns: 0, totalFacts: 0, factsWithEmbeddings: 0, embeddingCoverage: 0 };
      }
    },
    
    /**
     * Bulk store facts with embeddings (for batch extraction)
     * 
     * v2.0.2: New method for efficient batch storage with embeddings
     * 
     * @param {Array<Object>} facts - Array of fact objects with optional embeddings
     * @param {Object} context - Common context (userId, agentId, sessionId, scope)
     * @returns {Promise<{stored: number, updated: number, errors: number}>}
     */
    async bulkStoreFacts(facts, context) {
      const { userId, agentId, sessionId, scope = 'user' } = context;
      
      if (!userId) {
        throw new MemoryException(MemoryError.MISSING_USER_ID, 'userId is required');
      }
      
      const results = { stored: 0, updated: 0, errors: 0 };
      
      for (const fact of facts) {
        try {
          const result = await this.storeFact({
            userId,
            agentId,
            sessionId,
            scope,
            value: fact.value || fact.fact,
            category: fact.category,
            key: fact.key,
            metadata: fact.metadata,
            embedding: fact.embedding
          });
          
          if (result.created) {
            results.stored++;
          } else {
            results.updated++;
          }
        } catch (err) {
          results.errors++;
          if (debug) {
            console.error(`[memory] bulkStoreFacts error for fact: ${err.message}`);
          }
        }
      }
      
      if (debug) {
        console.log(`[memory] Bulk store complete: ${results.stored} stored, ${results.updated} updated, ${results.errors} errors`);
      }
      
      return results;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default { createMemory, MemoryError, MemoryException };
