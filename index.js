/**
 * Smart Context Plugin for Clawdbot v2.1
 * 
 * Filters message history by semantic relevance before LLM calls.
 * Reduces token usage and improves response quality by focusing on
 * relevant context.
 * 
 * v2.1.0: Hybrid Memory — extracts facts AND summaries from conversations
 * 
 * @author Shiv (Exo)
 * @version 2.1.1
 */

import { createEmbedder } from './embedder.js';
import { createAPIEmbedder } from './embedder-api.js';
import { createCache } from './cache.js';
import { selectMessages, estimateTokens } from './selector.js';
import { initToolResultServices, processToolResult, registerRetrievalTool } from './tool-results/index.js';
import { createLogger, setSessionId, getGlobalMetrics, logSummary, flushAll } from './logger.js';
import { initializeConfig, FEATURE_FLAGS } from './config.js';
import memory from './memory.js';
import extractor from './extractor.js';

// Global plugin logger
const logger = createLogger('plugin', { debug: true });

// Singleton instances
let embedder = null;
let cache = null;
let memoryAPI = null;
let toolServices = null;
let initializationInProgress = false;
let llmClient = null; // LLM client for extraction

// Session stats
const sessionStats = {
  startTime: Date.now(),
  hookCalls: {
    beforeAgentStart: 0,
    afterAgentEnd: 0,
    toolResult: 0
  },
  errors: {
    initialization: 0,
    filtering: 0,
    extraction: 0,
    toolResult: 0
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize embedder and cache lazily
 */
async function ensureInitialized(config, api) {
  if ((embedder && toolServices) || initializationInProgress) return;

  initializationInProgress = true;
  const op = logger.startOp('initialization');
  
  try {
    
    const debug = config?.debug || false;
    
    op.checkpoint('creating embedder');
    
    // Three-tier embedding fallback system:
    // Tier 1 (Primary): Local Transformers.js (free, fast, offline)
    // Tier 2 (Fallback): Gemini API (high quality, requires internet)
    // Tier 3 (Final): Hash-based TF-IDF (built into createEmbedder, always works)
    
    const embeddingConfig = config?.embedding || {};
    
    // TIER 1: Always try local first
    try {
      embedder = createEmbedder({ 
        debug,
        fallbackConfig: embeddingConfig // Pass API config for Tier 2 fallback
      });
      logger.info('Embedder created', { type: 'local-transformers', tier: 1 });
    } catch (err) {
      logger.warn(`Tier 1 (local) failed: ${err.message}`);
      
      // TIER 2: Try Gemini API if configured
      if (embeddingConfig.provider === 'gemini' || embeddingConfig.provider === 'openai') {
        try {
          let apiKey = embeddingConfig.apiKey;
          if (!apiKey) {
            if (embeddingConfig.provider === 'gemini') {
              apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
            } else if (embeddingConfig.provider === 'openai') {
              apiKey = process.env.OPENAI_API_KEY;
            }
          }
          
          if (apiKey) {
            embedder = createAPIEmbedder({
              provider: embeddingConfig.provider,
              apiKey,
              model: embeddingConfig.model,
              debug,
              maxRetries: 3,
              retryDelayMs: 1000
            });
            logger.info('Embedder created', { 
              type: 'api-fallback', 
              provider: embeddingConfig.provider,
              model: embeddingConfig.model,
              tier: 2
            });
          } else {
            throw new Error('No API key available for Tier 2');
          }
        } catch (apiErr) {
          logger.warn(`Tier 2 (${embeddingConfig.provider}) failed: ${apiErr.message}`);
          // TIER 3: Hash-based fallback (built into createEmbedder, will auto-activate)
          embedder = createEmbedder({ debug, forceHashFallback: true });
          logger.info('Embedder created', { type: 'hash-fallback', tier: 3 });
        }
      } else {
        // No API configured, use hash fallback directly
        embedder = createEmbedder({ debug, forceHashFallback: true });
        logger.info('Embedder created', { type: 'hash-fallback', tier: 3 });
      }
    }
    
    op.checkpoint('creating cache');
    cache = createCache({ 
      cachePath: config?.cachePath,
      debug 
    });
    logger.info('Cache initialized');
    
    // Phase 4: Initialize memory system
    op.checkpoint('creating memory system');
    memoryAPI = memory.createMemory(cache, { debug });
    logger.info('Memory system initialized', { 
      enabled: FEATURE_FLAGS.memory,
      storageMode: FEATURE_FLAGS.storageMode
    });
    
    op.checkpoint('initializing tool services');
    toolServices = await initToolResultServices(config, logger);
    logger.info('Tool result services initialized');

    if (api && toolServices) {
      op.checkpoint('registering retrieval tool');
      registerRetrievalTool(api, toolServices, logger);
      logger.info('Retrieval tool registered');
    }
    
    // Phase 4B: Initialize LLM client for extraction
    if (FEATURE_FLAGS.memory && FEATURE_FLAGS.memoryExtract && api) {
      op.checkpoint('creating LLM client for extraction');
      llmClient = createExtractionLLMClient(api, config);
      logger.info('LLM client for extraction initialized', {
        model: FEATURE_FLAGS.extractModel,
        storageMode: FEATURE_FLAGS.storageMode
      });
    }

    op.end({ result: 'success' });
    logger.info(`✅ Smart context v2.1.0 initialized (storageMode: ${FEATURE_FLAGS.storageMode})`);
    
  } catch (err) {
    sessionStats.errors.initialization++;
    op.error(err);
    logger.error(`Initialization failed: ${err.message}`, {
      stack: err.stack?.split('\n').slice(0, 5).join('\n')
    });
  } finally {
    initializationInProgress = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM CLIENT FOR EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create LLM client wrapper for extraction
 * 
 * @param {Object} api - Clawdbot API
 * @param {Object} config - Plugin config
 * @returns {Function} LLM call function
 */
function createExtractionLLMClient(api, config) {
  const model = FEATURE_FLAGS.extractModel;
  
  return async function callLLM(prompt, options = {}) {
    const { systemPrompt, temperature = 0.3, maxTokens = 1000 } = options;
    
    try {
      // Use Clawdbot's LLM client if available
      if (api.llm && typeof api.llm.generate === 'function') {
        const response = await api.llm.generate({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ],
          temperature,
          max_tokens: maxTokens
        });
        
        return response.content || response.text || '';
      }
      
      // Fallback: Try direct Gemini API call
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error('No Gemini API key available for extraction');
      }
      
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemPrompt}\n\n${prompt}` }]
            }
          ],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        })
      });
      
      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
    } catch (err) {
      logger.error('LLM call failed for extraction', { error: err.message });
      throw err;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL PROFILES
// ═══════════════════════════════════════════════════════════════════════════

const MODEL_PROFILES = {
  kimi: {
    topK: 25,
    recentN: 8,
    minScore: 0.5,
    stripOldToolCalls: false
  },
  anthropic: {
    topK: 25,
    recentN: 8,
    minScore: 0.45,
    stripOldToolCalls: false
  },
  gemini: {
    topK: 10,
    recentN: 3,
    minScore: 0.65,
    stripOldToolCalls: true
  },
  default: {
    topK: 10,
    recentN: 3,
    minScore: 0.65,
    stripOldToolCalls: true
  }
};

/**
 * Detect model family from model ID
 */
function detectModelFamily(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'default';
  
  const id = modelId.toLowerCase();
  
  if (id.includes('kimi')) return 'kimi';
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('gemini') || id.includes('google')) return 'gemini';
  if (id.includes('fireworks') && id.includes('kimi')) return 'kimi';
  
  return 'default';
}

/**
 * Get effective config with model profile
 */
function getEffectiveConfig(baseConfig, modelId) {
  const family = detectModelFamily(modelId);
  const profile = MODEL_PROFILES[family] || MODEL_PROFILES.default;

  const userProfiles = baseConfig?.profiles || {};
  const userProfile = userProfiles[family] || {};

  const effective = {
    enabled: baseConfig?.enabled,
    debug: baseConfig?.debug || false,
    cachePath: baseConfig?.cachePath,
    toolResults: baseConfig?.toolResults,
    embedding: baseConfig?.embedding
  };

  Object.assign(effective, profile);
  Object.assign(effective, userProfile);

  logger.debug('Config resolved', {
    modelId,
    family,
    topK: effective.topK,
    recentN: effective.recentN,
    minScore: effective.minScore,
    stripOldToolCalls: effective.stripOldToolCalls
  });

  return effective;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Extract text content from a message
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a message is a tool call/result (should be skipped for extraction)
 */
function isToolMessage(message) {
  if (!message) return true;
  if (message.role === 'tool' || message.role === 'system') return true;
  
  // Check for tool_use content blocks
  if (Array.isArray(message.content)) {
    const hasToolBlocks = message.content.some(
      block => block && (block.type === 'tool_use' || block.type === 'tool_result')
    );
    if (hasToolBlocks) return true;
  }
  
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// HOOK HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * before_agent_start hook handler
 */
async function handleBeforeAgentStart(event, ctx, config, api) {
  sessionStats.hookCalls.beforeAgentStart++;
  const callId = `bas-${Date.now()}-${sessionStats.hookCalls.beforeAgentStart}`;
  
  // Set session ID for log correlation
  const sessionId = ctx?.sessionKey || ctx?.sessionId || ctx?.session?.id || callId;
  setSessionId(sessionId);
  
  const op = logger.startOp('before_agent_start', {
    callId,
    sessionId,
    model: ctx?.modelId || ctx?.model || 'unknown'
  });
  
  try {
    // Check if enabled
    if (config?.enabled === false) {
      logger.decision('skip-disabled', { reason: 'plugin-disabled' });
      op.end({ result: 'skipped', reason: 'disabled' });
      return undefined;
    }

    const { prompt, messages } = event;

    // Validate inputs
    if (!messages || !Array.isArray(messages)) {
      logger.edgeCase('invalid-messages', { 
        type: typeof messages,
        isArray: Array.isArray(messages)
      });
      op.end({ result: 'skipped', reason: 'invalid-messages' });
      return undefined;
    }

    // Initialize on first call
    op.checkpoint('ensuring initialized');
    await ensureInitialized(config, api);

    // Check minimum message count
    const minMessages = (config?.topK || 10) + (config?.recentN || 3);
    if (messages.length <= minMessages) {
      logger.decision('skip-small-history', {
        messageCount: messages.length,
        threshold: minMessages
      });
      op.end({ result: 'skipped', reason: 'small-history' });
      return undefined;
    }

    // Log input stats
    logger.info('Processing request', {
      messageCount: messages.length,
      promptLength: prompt?.length || 0,
      model: ctx?.modelId || ctx?.model,
      sessionId
    });

    // Run selection
    op.checkpoint('running selection');
    const selected = await selectMessages({
      messages,
      prompt,
      embedder,
      cache,
      config: {
        topK: config?.topK || 10,
        recentN: config?.recentN || 3,
        minScore: config?.minScore || 0.65,
        stripOldToolCalls: config?.stripOldToolCalls === true,
        debug: config?.debug || false
      }
    });

    // Calculate stats
    const inputTokens = messages.reduce((sum, m) =>
      sum + estimateTokens(JSON.stringify(m)), 0);
    const outputTokens = selected.reduce((sum, m) =>
      sum + estimateTokens(JSON.stringify(m)), 0);
    const savedTokens = inputTokens - outputTokens;
    const reduction = Math.round((1 - selected.length / messages.length) * 100);

    // Log completion
    op.end({
      result: 'success',
      inputMessages: messages.length,
      outputMessages: selected.length,
      reduction: `${reduction}%`,
      tokensSaved: savedTokens
    });

    if (selected.length < messages.length) {
      logger.info(`📉 Filtered: ${messages.length} → ${selected.length} msgs (${reduction}%, ~${savedTokens} tokens saved)`);
    }

    return { messages: selected };

  } catch (err) {
    sessionStats.errors.filtering++;
    op.error(err);
    logger.error(`Selection error: ${err.message}`, {
      stack: err.stack?.split('\n').slice(0, 5).join('\n')
    });
    return undefined;
  }
}

/**
 * agent_end hook handler (Phase 4B: Extraction)
 * 
 * v2.1.0 CRITICAL FIX: Now passes BOTH user AND assistant messages to extractor
 * Previously only passed the assistant response, which caused empty extractions
 * because assistant messages are code explanations, not facts.
 */
async function handleAfterAgentEnd(event, ctx, config, api) {
  sessionStats.hookCalls.afterAgentEnd++;
  
  // Check if extraction is enabled
  if (!FEATURE_FLAGS.memory || !FEATURE_FLAGS.memoryExtract) {
    return undefined;
  }
  
  const sessionId = ctx?.sessionKey || ctx?.sessionId || ctx?.session?.id || 'unknown';
  
  const op = logger.startOp('agent_end', {
    sessionId,
    storageMode: FEATURE_FLAGS.storageMode
  });
  
  try {
    // Ensure initialized
    await ensureInitialized(config, api);
    
    if (!memoryAPI || !llmClient) {
      op.end({ result: 'skipped', reason: 'not-initialized' });
      return undefined;
    }
    
    // Extract user ID from context
    const userId = ctx?.userId || ctx?.user?.id || ctx?.session?.userId || 'default';
    const agentId = ctx?.agentId || 'main';
    
    // ═══════════════════════════════════════════════════════════════════
    // v2.1.0 BUG FIX: Get BOTH user and assistant messages
    // The old code only extracted from the last assistant message,
    // which produces empty results because assistant messages are
    // code explanations, not user preferences/decisions.
    // ═══════════════════════════════════════════════════════════════════
    
    const messages = event.messages || [];
    
    // Get last N recent user + assistant messages (skip tool messages)
    const recentMessages = messages
      .slice(-8) // Last 8 messages max (up to 4 exchanges)
      .filter(m => !isToolMessage(m));
    
    if (recentMessages.length === 0) {
      op.end({ result: 'skipped', reason: 'no-extractable-messages' });
      return undefined;
    }
    
    // Must have at least one user message in the batch
    const hasUserMessage = recentMessages.some(m => m.role === 'user');
    if (!hasUserMessage) {
      op.end({ result: 'skipped', reason: 'no-user-messages' });
      return undefined;
    }
    
    logger.debug('Processing messages for extraction', {
      sessionId,
      totalMessages: messages.length,
      extractableMessages: recentMessages.length,
      roles: recentMessages.map(m => m.role),
      storageMode: FEATURE_FLAGS.storageMode
    });
    
    // Process ALL recent messages for extraction (async, non-blocking)
    // v2.1.0: Feed them all to the buffer at once
    const extractionPromise = (async () => {
      let lastResult = null;
      
      for (const msg of recentMessages) {
        lastResult = await extractor.processMessage(
          msg,
          { sessionId, userId, agentId },
          {
            memory: memoryAPI,
            embedder,
            llmCall: llmClient,
            cache
          },
          {
            batchSize: FEATURE_FLAGS.extractBatchSize,
            minConfidence: FEATURE_FLAGS.extractMinConfidence,
            resolveConflicts: FEATURE_FLAGS.extractConflicts,
            storageMode: FEATURE_FLAGS.storageMode,
            dedupThreshold: FEATURE_FLAGS.summaryDedupThreshold,
            debug: config?.debug || false
          }
        );
      }
      
      return lastResult;
    })();
    
    extractionPromise.then(result => {
      if (result) {
        logger.info('Extraction completed', {
          sessionId,
          extracted: result.extracted,
          stored: result.stored,
          summaryStored: result.summaryStored,
          storageMode: FEATURE_FLAGS.storageMode
        });
      }
    }).catch(err => {
      sessionStats.errors.extraction++;
      logger.error('Extraction processing error', {
        sessionId,
        error: err.message
      });
    });
    
    op.end({ result: 'queued', messagesQueued: recentMessages.length });
    
  } catch (err) {
    sessionStats.errors.extraction++;
    op.error(err);
    logger.error(`After agent end error: ${err.message}`);
  }
  
  return undefined;
}

/**
 * tool_result hook handler
 */
async function handleToolResult(event, ctx, config, api) {
  sessionStats.hookCalls.toolResult++;
  const callId = `tr-${Date.now()}-${sessionStats.hookCalls.toolResult}`;
  
  const op = logger.startOp('tool_result', {
    callId,
    toolName: event.toolName,
    toolUseId: event.toolUseId
  });
  
  try {
    if (!toolServices) {
      op.checkpoint('lazy init');
      await ensureInitialized(config, api);
    }
    
    if (!toolServices) {
      op.end({ result: 'skipped', reason: 'no-services' });
      return event.result;
    }
    
    const resultSize = JSON.stringify(event.result).length;
    logger.debug('Processing tool result', {
      toolName: event.toolName,
      resultSize,
      toolUseId: event.toolUseId
    });
    
    const processed = await processToolResult({
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      result: event.result,
      sessionId: ctx?.sessionKey || ctx?.sessionId || 'default',
      store: toolServices.store,
      summarizer: toolServices.summarizer,
      config: config
    });

    if (processed.summarized || processed.truncated) {
      logger.info(`📦 Summarized ${event.toolName}: ${processed.originalTokens} → ${processed.processedTokens} tokens`, {
        resultId: processed.resultId,
        reduction: Math.round((1 - processed.processedTokens / processed.originalTokens) * 100) + '%'
      });

      if (processed.content === undefined || processed.content === null) {
        logger.error('Processed content is undefined', { toolName: event.toolName });
        op.end({ result: 'error', reason: 'undefined-content' });
        return event.result;
      }

      op.end({ 
        result: 'summarized',
        originalTokens: processed.originalTokens,
        processedTokens: processed.processedTokens
      });
      return processed.content;
    }
    
    op.end({ result: 'passthrough', reason: 'no-changes-needed' });
  } catch (err) {
    sessionStats.errors.toolResult++;
    op.error(err);
    logger.error(`Tool result processing error: ${err.message}`);
  }
  
  return event.result;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLUGIN REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Plugin registration function (required by Clawdbot)
 */
export function register(api) {
  const config = api.pluginConfig;
  // CRITICAL FIX: Initialize config BEFORE evaluating feature flags
  initializeConfig(config || {});

  const storageMode = FEATURE_FLAGS.storageMode;
  
  logger.marker('SMART CONTEXT PLUGIN v2.1.0 REGISTRATION');
  
  logger.info('Registering smart-context plugin', {
    version: '2.1.0',
    debug: config?.debug || false,
    enabled: config?.enabled !== false,
    memoryEnabled: FEATURE_FLAGS.memory,
    extractionEnabled: FEATURE_FLAGS.memoryExtract,
    storageMode
  });

  // Register before_agent_start hook
  api.on('before_agent_start', async (event, ctx) => {
    const modelId = ctx?.modelId || ctx?.model || event?.model || '';
    const effectiveConfig = getEffectiveConfig(config, modelId);
    return handleBeforeAgentStart(event, ctx, effectiveConfig, api);
  }, {
    name: 'smart-context-filter',
    description: 'Filters message history by semantic relevance (model-aware)',
    priority: 100
  });
  
  logger.info('Registered hook: before_agent_start');

  // Register agent_end hook (Phase 4B: Extraction)
  if (FEATURE_FLAGS.memory && FEATURE_FLAGS.memoryExtract) {
    api.on('agent_end', async (event, ctx) => {
      return handleAfterAgentEnd(event, ctx, config, api);
    }, {
      name: 'smart-context-extractor',
      description: `Extracts facts/summaries from conversations (mode: ${storageMode})`,
      priority: 50
    });
    
    logger.info(`Registered hook: agent_end (extraction enabled, storageMode: ${storageMode})`);
  }

  // Register after_tool_call hook (intercept tool results for summarization)
  api.on('after_tool_call', async (event, ctx) => {
    return handleToolResult(event, ctx, config, api);
  }, {
    name: 'tool-result-summarizer',
    description: 'Summarizes large tool results using Gemini Flash',
    priority: 50
  });
  
  logger.info('Registered hook: after_tool_call');

  // Register shutdown handler to flush logs
  if (typeof process !== 'undefined') {
    const shutdown = () => {
      logger.info('Shutting down smart-context');
      logSummary();
      flushAll();
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', shutdown);
  }

  const hooks = ['before_agent_start', 'after_tool_call'];
  if (FEATURE_FLAGS.memory && FEATURE_FLAGS.memoryExtract) {
    hooks.push('agent_end');
  }

  logger.info('✅ Smart-context hooks registered', {
    hooks,
    profiles: Object.keys(MODEL_PROFILES),
    storageMode
  });
  
  // Log current metrics path
  logger.info('📁 Log files', logger.getLogPaths());
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export const id = 'smart-context';
export const name = 'Smart Context';
export const version = '2.1.0';
export const description = 'Semantic context selection, tool result summarization, and hybrid memory with comprehensive logging';
export const kind = 'hook';

/**
 * Get current session statistics
 */
export function getSessionStats() {
  return {
    ...sessionStats,
    uptime: Date.now() - sessionStats.startTime,
    metrics: getGlobalMetrics()
  };
}

/**
 * Get memory API (Phase 4)
 * @returns {Object|null} Memory API or null if not initialized
 */
export function getMemoryAPI() {
  return memoryAPI;
}

/**
 * Get extractor API (Phase 4B)
 * @returns {Object} Extractor API
 */
export function getExtractorAPI() {
  return extractor;
}

export default {
  id,
  name,
  version,
  description,
  kind,
  register,
  getSessionStats,
  getMemoryAPI,
  getExtractorAPI
};
