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
 * v2.1.0: Hybrid extraction pipeline (facts + summaries)
 * - New hybrid prompts extract both facts AND summaries
 * - Storage routing based on storageMode config
 * - Processes BOTH user and assistant messages
 * 
 * @module extractor
 */

import {
  EXTRACTION_SYSTEM_PROMPT,
  HYBRID_EXTRACTION_SYSTEM_PROMPT,
  generateExtractionPrompt,
  generateHybridExtractionPrompt,
  parseExtractionResponse,
  parseHybridExtractionResponse
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
      totalSummariesStored: 0,
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
 * v2.1.0: More permissive — accepts both user and assistant messages
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
  
  // Skip messages with tool_use content blocks (these are function calls, not conversation)
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
  
  // Check time-based trigger
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
 * Call LLM for fact extraction (legacy, facts-only mode)
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
      logger.debug('Calling LLM for facts-only extraction', {
        messageCount: messages.length,
        promptLength: prompt.length
      });
    }
    
    const response = await llmCall(prompt, {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 1000
    });
    
    const facts = parseExtractionResponse(response);
    
    if (debug) {
      logger.debug('Facts-only extraction complete', {
        factsExtracted: facts.length
      });
    }
    
    return facts;
  } catch (err) {
    logger.error('LLM extraction failed', { error: err.message });
    return [];
  }
}

/**
 * v2.1.0: Call LLM for hybrid extraction (facts + summary)
 * 
 * @param {Array<Object>} messages - Messages to extract from
 * @param {Function} llmCall - LLM client function
 * @param {Object} options - Options
 * @returns {Promise<{facts: Array, summary: Object|null}>} Hybrid extraction result
 */
async function extractHybridWithLLM(messages, llmCall, options = {}) {
  const { debug = false, context = {} } = options;
  
  try {
    const prompt = generateHybridExtractionPrompt(messages, context);
    
    if (debug) {
      logger.debug('Calling LLM for hybrid extraction', {
        messageCount: messages.length,
        promptLength: prompt.length,
        storageMode: 'hybrid'
      });
    }
    
    const response = await llmCall(prompt, {
      systemPrompt: HYBRID_EXTRACTION_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 4000 // v2.1.1: Generous limit to prevent truncation
    });
    
    if (debug) {
      logger.debug('Raw hybrid LLM response', {
        responsePreview: response?.slice(0, 300),
        responseLength: response?.length
      });
    }
    
    const result = parseHybridExtractionResponse(response);
    
    if (debug) {
      logger.debug('Hybrid extraction parsed', {
        factsCount: result.facts.length,
        hasSummary: !!result.summary,
        summaryTopic: result.summary?.topic?.slice(0, 50),
        factsPreview: result.facts.map(f => f.fact?.slice(0, 50))
      });
    }
    
    return result;
  } catch (err) {
    logger.error('Hybrid LLM extraction failed', { error: err.message });
    return { facts: [], summary: null };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.0.2: EMBEDDING COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute embeddings for extracted facts
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
      let embedding = null;
      
      if (cache) {
        embedding = await cache.get(factText);
        if (embedding) {
          embeddingsCached++;
        }
      }
      
      if (!embedding && embedder) {
        embedding = await embedder.embed(factText);
        embeddingsComputed++;
        
        if (cache && embedding) {
          await cache.set(factText, embedding);
        }
      }
      
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

/**
 * v2.1.0: Compute embedding for a summary
 * 
 * @param {Object} summary - Summary object
 * @param {Object} embedder - Embedder instance
 * @param {Object} cache - Cache instance
 * @param {Object} options - Options
 * @returns {Promise<Array<number>|null>} Embedding or null
 */
async function computeSummaryEmbedding(summary, embedder, cache, options = {}) {
  const { debug = false } = options;
  
  if (!embedder || !summary || !summary.content) {
    return null;
  }
  
  const text = `${summary.topic}: ${summary.content}`;
  
  try {
    // Check cache first
    let embedding = cache ? await cache.get(text) : null;
    
    if (!embedding) {
      embedding = await embedder.embed(text);
      if (cache && embedding) {
        await cache.set(text, embedding);
      }
    }
    
    return embedding;
  } catch (err) {
    if (debug) {
      logger.debug('Failed to compute summary embedding', { error: err.message });
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACT STORAGE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Store extracted facts in memory
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
      const result = await memory.storeFact({
        userId,
        agentId,
        sessionId,
        scope,
        value: fact.fact,
        category: fact.category,
        embedding: fact.embedding,
        metadata: {
          extracted_at: Date.now(),
          source_context: fact.source_context,
          confidence: fact.confidence,
          extraction_method: 'llm',
          has_embedding: !!fact.embedding,
          entity: fact.entity || null,
          project: fact.project || null
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

/**
 * v2.1.0: Store extracted summary in memory
 * 
 * @param {Object} summary - Summary object {topic, content, entities, projects}
 * @param {Object} memory - Memory API instance
 * @param {Object} context - Extraction context
 * @param {Object} options - Options
 * @returns {Promise<Object>} Storage result
 */
async function storeExtractedSummary(summary, memory, context, options = {}) {
  const { debug = false, embedding = null, dedupThreshold = 0.85 } = options;
  const { userId, agentId, sessionId } = context;
  
  if (!summary || !summary.topic || !summary.content) {
    return { stored: false, reason: 'invalid-summary' };
  }
  
  try {
    const result = await memory.storeSummary({
      userId,
      agentId,
      sessionId,
      topic: summary.topic,
      content: summary.content,
      entities: summary.entities || [],
      projects: summary.projects || [],
      embedding,
      sourceMessages: context.sourceMessages || 0,
      dedupThreshold
    });
    
    if (debug) {
      logger.debug('Stored summary', {
        summaryId: result.summaryId,
        created: result.created,
        merged: result.merged,
        topic: summary.topic.slice(0, 50)
      });
    }
    
    return { stored: true, ...result };
  } catch (err) {
    logger.error('Failed to store summary', {
      topic: summary.topic,
      error: err.message
    });
    return { stored: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXTRACTION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process new message for extraction
 * 
 * v2.1.0: Supports hybrid extraction and accepts both user + assistant messages
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
 * Extract from message buffer
 * 
 * v2.1.0: Hybrid extraction pipeline with storageMode routing
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
  const storageMode = config.storageMode || 'hybrid';
  
  const op = logger.startOp('extract_batch', {
    sessionId,
    bufferSize: state.messageBuffer.length,
    storageMode
  });
  
  try {
    let extractedFacts = [];
    let extractedSummary = null;
    
    // ═══════════════════════════════════════════════════════════════════
    // Route extraction based on storageMode
    // ═══════════════════════════════════════════════════════════════════
    
    if (storageMode === 'facts') {
      // Legacy facts-only mode (v2.0.x behavior)
      extractedFacts = await extractFactsWithLLM(
        state.messageBuffer,
        llmCall,
        { debug: config.debug }
      );
    } else {
      // Hybrid or semantic mode — use new hybrid prompt
      const hybridResult = await extractHybridWithLLM(
        state.messageBuffer,
        llmCall,
        { 
          debug: config.debug,
          context: config.extractionContext || {}
        }
      );
      
      if (storageMode === 'semantic') {
        // Semantic-only: discard facts, keep summary
        extractedFacts = [];
        extractedSummary = hybridResult.summary;
      } else {
        // Hybrid: keep both
        extractedFacts = hybridResult.facts;
        extractedSummary = hybridResult.summary;
      }
    }
    
    op.checkpoint('extraction_complete', { 
      factsCount: extractedFacts.length, 
      hasSummary: !!extractedSummary 
    });
    
    // Early exit if nothing extracted
    if (extractedFacts.length === 0 && !extractedSummary) {
      state.messageBuffer = [];
      state.lastExtraction = Date.now();
      
      op.end({ result: 'no_extraction' });
      return {
        extracted: 0,
        stored: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        embeddingsStored: 0,
        summaryStored: false
      };
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // Process facts (if any)
    // ═══════════════════════════════════════════════════════════════════
    
    let factResults = {
      stored: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      embeddingsStored: 0
    };
    
    if (extractedFacts.length > 0) {
      // Compute embeddings
      if (embedder) {
        extractedFacts = await computeFactEmbeddings(
          extractedFacts,
          embedder,
          cache,
          { debug: config.debug }
        );
        op.checkpoint('fact_embeddings_computed', {
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
        
        factsToStore = [];
        
        for (const action of actions) {
          if (action.action === 'add') {
            factsToStore.push(action.fact);
          } else if (action.action === 'update') {
            await memory.updateFact(action.fact.id, {
              value: action.fact.value,
              metadata: action.fact.metadata,
              embedding: action.fact.embedding
            });
          }
        }
      }
      
      // Store facts
      factResults = await storeExtractedFacts(
        factsToStore,
        memory,
        { userId, agentId, sessionId, scope: 'user' },
        { minConfidence: config.minConfidence || 0.7, debug: config.debug }
      );
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // Process summary (if any) — v2.1.0
    // ═══════════════════════════════════════════════════════════════════
    
    let summaryResult = { stored: false };
    
    if (extractedSummary) {
      // Compute summary embedding
      let summaryEmbedding = null;
      if (embedder) {
        summaryEmbedding = await computeSummaryEmbedding(
          extractedSummary,
          embedder,
          cache,
          { debug: config.debug }
        );
        op.checkpoint('summary_embedding_computed', { hasEmbedding: !!summaryEmbedding });
      }
      
      summaryResult = await storeExtractedSummary(
        extractedSummary,
        memory,
        { 
          userId, agentId, sessionId, 
          sourceMessages: state.messageBuffer.length 
        },
        { 
          debug: config.debug, 
          embedding: summaryEmbedding,
          dedupThreshold: config.dedupThreshold || 0.85
        }
      );
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // Update state
    // ═══════════════════════════════════════════════════════════════════
    
    state.messageBuffer = [];
    state.lastExtraction = Date.now();
    state.totalExtractions++;
    state.totalFactsExtracted += factResults.stored + factResults.updated;
    state.totalEmbeddingsStored += factResults.embeddingsStored;
    if (summaryResult.stored) {
      state.totalSummariesStored++;
    }
    
    const totalResult = {
      extracted: extractedFacts.length,
      ...factResults,
      summaryStored: summaryResult.stored,
      summaryMerged: summaryResult.merged || false,
      summaryId: summaryResult.summaryId || null
    };
    
    op.end({
      result: 'success',
      ...totalResult
    });
    
    logger.info('Extraction batch complete', {
      sessionId,
      storageMode,
      extracted: extractedFacts.length,
      stored: factResults.stored,
      updated: factResults.updated,
      skipped: factResults.skipped,
      embeddingsStored: factResults.embeddingsStored,
      summaryStored: summaryResult.stored,
      summaryMerged: summaryResult.merged || false
    });
    
    return totalResult;
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
      summaryStored: false,
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
      embeddingsStored: 0,
      summaryStored: false
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
      totalSummariesStored: 0,
      totalEmbeddingsStored: 0,
      lastExtraction: null
    };
  }
  
  return {
    bufferSize: state.messageBuffer.length,
    totalExtractions: state.totalExtractions,
    totalFactsExtracted: state.totalFactsExtracted,
    totalSummariesStored: state.totalSummariesStored || 0,
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
