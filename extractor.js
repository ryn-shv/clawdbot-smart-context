/**
 * Phase 4B: Fact Extraction Pipeline
 * 
 * Monitors conversations and extracts important facts using LLM.
 * Implements batch extraction with configurable triggers.
 * 
 * v2.0.2 FIXES:
 * - Now computes and stores embeddings for extracted facts
 * - Added embedder parameter to processMessage and extractFromBuffer
 * - Facts are stored with embeddings for semantic search
 * 
 * @module extractor
 */

import {
  EXTRACTION_SYSTEM_PROMPT,
  generateExtractionPrompt,
  parseExtractionResponse
} from './extraction-prompts.js';
import { batchResolveConflicts } from './conflict-resolver.js';
import { createLogger } from './logger.js';

const logger = createLogger('extractor', { debug: true });

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACTION STATE
// ═══════════════════════════════════════════════════════════════════════════

// Per-session extraction state
const sessionState = new Map();

/**
 * Get or create session extraction state
 */
function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      messageBuffer: [],
      lastExtraction: 0,
      totalExtractions: 0,
      totalFactsExtracted: 0,
      totalEmbeddingsStored: 0
    });
  }
  return sessionState.get(sessionId);
}

/**
 * Clear session state (cleanup)
 */
export function clearSessionState(sessionId) {
  sessionState.delete(sessionId);
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE FILTERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if message should be considered for extraction
 * 
 * @param {Object} message - Message object
 * @returns {boolean} True if message is extractable
 */
function isExtractableMessage(message) {
  // Skip tool calls
  if (message.role === 'tool' || message.type === 'tool_result') {
    return false;
  }
  
  // Skip system messages
  if (message.role === 'system') {
    return false;
  }
  
  // Only process user and assistant messages
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false;
  }
  
  // Skip messages with tool_use content blocks
  if (Array.isArray(message.content)) {
    const hasToolUse = message.content.some(
      block => block.type === 'tool_use' || block.type === 'tool_result'
    );
    if (hasToolUse) return false;
  }
  
  // Skip empty messages
  const content = typeof message.content === 'string' 
    ? message.content 
    : JSON.stringify(message.content);
  
  if (!content || content.trim().length < 10) {
    return false;
  }
  
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACTION TRIGGERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if extraction should be triggered
 * 
 * @param {Object} state - Session state
 * @param {Object} config - Extraction config
 * @returns {boolean} True if should extract now
 */
function shouldTriggerExtraction(state, config) {
  const {
    batchSize = 5,
    minInterval = 30000 // 30 seconds minimum between extractions
  } = config;
  
  // Check batch size trigger
  if (state.messageBuffer.length >= batchSize) {
    return true;
  }
  
  // Check time-based trigger (if buffer has messages and enough time passed)
  // Works for first extraction too (lastExtraction = 0 means use buffer start time)
  if (state.messageBuffer.length > 0) {
    const timeReference = state.lastExtraction > 0 
      ? state.lastExtraction 
      : state.messageBuffer[0].timestamp || Date.now();
    const timeSince = Date.now() - timeReference;
    if (timeSince >= minInterval) {
      return true;
    }
  }
  
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Call LLM for fact extraction
 * 
 * @param {Array<Object>} messages - Messages to extract from
 * @param {Function} llmCall - LLM client function
 * @param {Object} options - Options
 * @returns {Promise<Array>} Extracted facts
 */
async function extractFactsWithLLM(messages, llmCall, options = {}) {
  const { debug = false } = options;
  
  try {
    const prompt = generateExtractionPrompt(messages);
    
    if (debug) {
      logger.debug('Calling LLM for extraction', {
        messageCount: messages.length,
        promptLength: prompt.length
      });
    }
    
    const response = await llmCall(prompt, {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      temperature: 0.3, // Low temperature for consistent extraction
      maxTokens: 1000
    });
    
    // DEBUG: Log raw LLM response
    if (debug) {
      logger.debug('Raw LLM extraction response', {
        responsePreview: response?.slice(0, 200),
        responseLength: response?.length
      });
    }
    
    const facts = parseExtractionResponse(response);
    
    // DEBUG: Log parsed facts
    if (debug) {
      logger.debug('Parsed extraction result', {
        factsCount: facts.length,
        factsPreview: facts.map(f => f.fact?.slice(0, 50))
      });
    }
    
    if (debug) {
      logger.debug('LLM extraction complete', {
        factsExtracted: facts.length
      });
    }
    
    return facts;
  } catch (err) {
    logger.error('LLM extraction failed', { error: err.message });
    // Return empty array on error instead of throwing
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.0.2: EMBEDDING COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute embeddings for extracted facts
 * 
 * v2.0.2: New function to add embeddings to facts before storage
 * 
 * @param {Array<Object>} facts - Extracted facts without embeddings
 * @param {Object} embedder - Embedder instance
 * @param {Object} cache - Cache instance for storing embeddings
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Facts with embeddings attached
 */
async function computeFactEmbeddings(facts, embedder, cache, options = {}) {
  const { debug = false } = options;
  
  if (!embedder || !facts || facts.length === 0) {
    return facts;
  }
  
  const factsWithEmbeddings = [];
  let embeddingsComputed = 0;
  let embeddingsCached = 0;
  let embeddingsFailed = 0;
  
  for (const fact of facts) {
    const factText = fact.fact || fact.value;
    
    if (!factText) {
      factsWithEmbeddings.push(fact);
      continue;
    }
    
    try {
      // Check cache first
      let embedding = null;
      
      if (cache) {
        embedding = await cache.get(factText);
        if (embedding) {
          embeddingsCached++;
        }
      }
      
      // Compute embedding if not cached
      if (!embedding && embedder) {
        embedding = await embedder.embed(factText);
        embeddingsComputed++;
        
        // Store in cache for future use
        if (cache && embedding) {
          await cache.set(factText, embedding);
        }
      }
      
      // Add embedding to fact
      factsWithEmbeddings.push({
        ...fact,
        embedding: embedding || null
      });
      
    } catch (err) {
      embeddingsFailed++;
      if (debug) {
        logger.debug('Failed to compute embedding for fact', {
          fact: factText.slice(0, 50),
          error: err.message
        });
      }
      // Still include fact without embedding
      factsWithEmbeddings.push({
        ...fact,
        embedding: null
      });
    }
  }
  
  if (debug) {
    logger.debug('Computed embeddings for facts', {
      total: facts.length,
      computed: embeddingsComputed,
      cached: embeddingsCached,
      failed: embeddingsFailed
    });
  }
  
  return factsWithEmbeddings;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACT STORAGE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Store extracted facts in memory
 * 
 * v2.0.2: Now expects facts to have embeddings attached
 * 
 * @param {Array<Object>} facts - Extracted facts with embeddings
 * @param {Object} memory - Memory API instance
 * @param {Object} context - Extraction context
 * @param {Object} options - Options
 * @returns {Promise<Object>} Storage results
 */
async function storeExtractedFacts(facts, memory, context, options = {}) {
  const {
    minConfidence = 0.7,
    debug = false
  } = options;
  
  const { userId, agentId, sessionId, scope = 'user' } = context;
  
  const results = {
    stored: 0,
    skipped: 0,
    updated: 0,
    errors: 0,
    embeddingsStored: 0
  };
  
  for (const fact of facts) {
    // Skip low-confidence facts
    if (fact.confidence < minConfidence) {
      results.skipped++;
      if (debug) {
        logger.debug('Skipped low-confidence fact', {
          fact: fact.fact,
          confidence: fact.confidence
        });
      }
      continue;
    }
    
    try {
      // v2.0.2: Include embedding in storeFact call
      const result = await memory.storeFact({
        userId,
        agentId,
        sessionId,
        scope,
        value: fact.fact,
        category: fact.category,
        embedding: fact.embedding, // v2.0.2: Pass embedding!
        metadata: {
          extracted_at: Date.now(),
          source_context: fact.source_context,
          confidence: fact.confidence,
          extraction_method: 'llm',
          has_embedding: !!fact.embedding
        }
      });
      
      if (result.created) {
        results.stored++;
      } else {
        results.updated++;
      }
      
      if (result.embeddingStored) {
        results.embeddingsStored++;
      }
      
      if (debug) {
        logger.debug('Stored fact', {
          factId: result.factId,
          created: result.created,
          embeddingStored: result.embeddingStored,
          fact: fact.fact.slice(0, 50)
        });
      }
    } catch (err) {
      results.errors++;
      logger.error('Failed to store fact', {
        fact: fact.fact,
        error: err.message
      });
    }
  }
  
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXTRACTION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process new message for extraction
 * 
 * v2.0.2: Added embedder parameter for computing fact embeddings
 * 
 * @param {Object} message - New message
 * @param {Object} context - Context (sessionId, userId, agentId)
 * @param {Object} services - Services (memory, llmCall, cache, embedder)
 * @param {Object} config - Extraction config
 * @returns {Promise<Object|null>} Extraction results if triggered, null otherwise
 */
export async function processMessage(message, context, services, config) {
  const { sessionId } = context;
  const { memory, llmCall, cache, embedder } = services;
  
  // Get session state
  const state = getSessionState(sessionId);
  
  // Filter message
  if (!isExtractableMessage(message)) {
    return null;
  }
  
  // Add to buffer
  state.messageBuffer.push(message);
  
  // Check if should extract
  if (!shouldTriggerExtraction(state, config)) {
    return null;
  }
  
  // Trigger extraction
  return await extractFromBuffer(state, context, services, config);
}

/**
 * Extract facts from message buffer
 * 
 * v2.0.2: Now computes embeddings for extracted facts
 * 
 * @param {Object} state - Session state
 * @param {Object} context - Context (userId, agentId, sessionId)
 * @param {Object} services - Services (memory, llmCall, cache, embedder)
 * @param {Object} config - Extraction config
 * @returns {Promise<Object>} Extraction results
 */
async function extractFromBuffer(state, context, services, config) {
  const { memory, llmCall, cache, embedder } = services;
  const { userId, agentId, sessionId } = context;
  
  const op = logger.startOp('extract_batch', {
    sessionId,
    bufferSize: state.messageBuffer.length
  });
  
  try {
    // Extract facts using LLM
    let extractedFacts = await extractFactsWithLLM(
      state.messageBuffer,
      llmCall,
      { debug: config.debug }
    );
    
    op.checkpoint('facts_extracted', { count: extractedFacts.length });
    
    if (extractedFacts.length === 0) {
      // No facts extracted, clear buffer
      state.messageBuffer = [];
      state.lastExtraction = Date.now();
      
      op.end({ result: 'no_facts' });
      return {
        extracted: 0,
        stored: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        embeddingsStored: 0
      };
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // v2.0.2 FIX: Compute embeddings BEFORE conflict resolution
    // This ensures all facts have embeddings for storage
    // ═══════════════════════════════════════════════════════════════════
    if (embedder) {
      extractedFacts = await computeFactEmbeddings(
        extractedFacts,
        embedder,
        cache,
        { debug: config.debug }
      );
      op.checkpoint('embeddings_computed', {
        withEmbeddings: extractedFacts.filter(f => f.embedding).length
      });
    }
    
    // Resolve conflicts
    let factsToStore = extractedFacts;
    
    if (config.resolveConflicts !== false) {
      const actions = await batchResolveConflicts(
        extractedFacts,
        memory,
        userId,
        cache,
        llmCall,
        { debug: config.debug }
      );
      
      op.checkpoint('conflicts_resolved', { actions: actions.length });
      
      // Apply conflict resolution actions
      factsToStore = [];
      
      for (const action of actions) {
        if (action.action === 'add') {
          factsToStore.push(action.fact);
        } else if (action.action === 'update') {
          // Update existing fact (include embedding if available)
          await memory.updateFact(action.fact.id, {
            value: action.fact.value,
            metadata: action.fact.metadata,
            embedding: action.fact.embedding
          });
        }
        // Skip 'keep' and 'defer' actions
      }
    }
    
    // Store facts (now with embeddings)
    const results = await storeExtractedFacts(
      factsToStore,
      memory,
      { userId, agentId, sessionId, scope: 'user' },
      { minConfidence: config.minConfidence || 0.7, debug: config.debug }
    );
    
    // Update state
    state.messageBuffer = [];
    state.lastExtraction = Date.now();
    state.totalExtractions++;
    state.totalFactsExtracted += results.stored + results.updated;
    state.totalEmbeddingsStored += results.embeddingsStored;
    
    op.end({
      result: 'success',
      extracted: extractedFacts.length,
      ...results
    });
    
    logger.info('Extraction batch complete', {
      sessionId,
      extracted: extractedFacts.length,
      stored: results.stored,
      updated: results.updated,
      skipped: results.skipped,
      embeddingsStored: results.embeddingsStored
    });
    
    return {
      extracted: extractedFacts.length,
      ...results
    };
  } catch (err) {
    op.error(err);
    logger.error('Extraction batch failed', {
      sessionId,
      error: err.message
    });
    
    // Clear buffer to avoid repeated failures
    state.messageBuffer = [];
    state.lastExtraction = Date.now();
    
    return {
      extracted: 0,
      stored: 0,
      updated: 0,
      skipped: 0,
      errors: 1,
      embeddingsStored: 0,
      error: err.message
    };
  }
}

/**
 * Force extraction for current session (manual trigger)
 * 
 * @param {string} sessionId - Session ID
 * @param {Object} context - Context (userId, agentId)
 * @param {Object} services - Services (memory, llmCall, cache, embedder)
 * @param {Object} config - Extraction config
 * @returns {Promise<Object>} Extraction results
 */
export async function forceExtraction(sessionId, context, services, config) {
  const state = getSessionState(sessionId);
  
  if (state.messageBuffer.length === 0) {
    return {
      extracted: 0,
      stored: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      embeddingsStored: 0
    };
  }
  
  return await extractFromBuffer(
    state,
    { ...context, sessionId },
    services,
    config
  );
}

/**
 * Get extraction statistics for session
 * 
 * @param {string} sessionId - Session ID
 * @returns {Object} Session statistics
 */
export function getSessionStats(sessionId) {
  const state = sessionState.get(sessionId);
  
  if (!state) {
    return {
      bufferSize: 0,
      totalExtractions: 0,
      totalFactsExtracted: 0,
      totalEmbeddingsStored: 0,
      lastExtraction: null
    };
  }
  
  return {
    bufferSize: state.messageBuffer.length,
    totalExtractions: state.totalExtractions,
    totalFactsExtracted: state.totalFactsExtracted,
    totalEmbeddingsStored: state.totalEmbeddingsStored || 0,
    lastExtraction: state.lastExtraction || null
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  processMessage,
  forceExtraction,
  getSessionStats,
  clearSessionState
};
