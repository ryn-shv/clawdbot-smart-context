/**
 * Tool Results Module
 * 
 * Provides storage, summarization, and retrieval for large tool results.
 * Reduces message history bloat by storing full results externally
 * and replacing with semantic summaries (or truncated previews as fallback).
 * 
 * @module tool-results
 */

// Re-export all components
export { 
  createToolResultStore, 
  generateResultId, 
  hashContent, 
  estimateTokens 
} from './store.js';

export { 
  createSummarizer,
  createTruncator  // Backward compatibility alias
} from './summarizer.js';

export { 
  createRetriever, 
  formatRAGContext 
} from './retriever.js';

export { 
  retrieveToolResultSchema, 
  createToolHandler, 
  registerRetrievalTool 
} from './tool-definition.js';

/**
 * Initialize all tool result services
 * @param {Object} config - Configuration
 * @param {Object} logger - Logger instance
 * @returns {Object} Initialized services
 */
export async function initToolResultServices(config, logger) {
  try {
    const { createToolResultStore } = await import('./store.js');
    const { createSummarizer } = await import('./summarizer.js');
    const { createRetriever } = await import('./retriever.js');
    
    const toolResultConfig = config?.toolResults || {};
    const debug = config?.debug || false;
    
    // Create store
    const store = createToolResultStore({
      dbPath: toolResultConfig.dbPath || toolResultConfig.storage?.db_path,
      ttlHours: toolResultConfig.ttlHours || toolResultConfig.storage?.ttl_hours,
      maxResults: toolResultConfig.maxStoredResults || toolResultConfig.storage?.max_stored_results,
      debug
    });
    
    // Create summarizer (replaces truncator)
    const summarizationConfig = toolResultConfig.summarization || {};
    const summarizer = createSummarizer({
      // Gemini API config
      apiKey: summarizationConfig.api_key || process.env.GEMINI_API_KEY,
      model: summarizationConfig.model || 'gemini-2.0-flash-exp',
      fallbackModel: summarizationConfig.fallback_model || 'gemini-1.5-flash-8b',
      timeoutMs: summarizationConfig.timeout_ms || 5000,
      maxRetries: summarizationConfig.max_retries ?? 1,
      enabled: summarizationConfig.enabled !== false,
      
      // Thresholds per tool
      thresholds: summarizationConfig.thresholds || toolResultConfig.thresholds,
      
      // Summary length limits
      lengthLimits: summarizationConfig.summary_length || {
        min: 150,
        max: 500,
        target: 300
      },
      
      // Fallback truncation
      previewTokens: toolResultConfig.truncation?.preview_tokens || toolResultConfig.previewTokens || 400,
      showHeadTail: toolResultConfig.truncation?.show_head_tail !== false,
      
      debug
    });
    
    // Create retriever
    const retriever = createRetriever({
      store,
      embedder: null, // Will be set by caller if RAG is enabled
      ragConfig: config?.rag
    });
    
    if (debug) {
      // Use setImmediate to not block initialization if getStats is slow
      setImmediate(async () => {
        try {
          const stats = await store.getStats();
          logger?.info?.('Tool results store: ' + (stats.totalResults || 0) + ' results, ' + (stats.totalTokens || 0) + ' tokens');
          logger?.info?.('Summarization: enabled=' + (summarizationConfig.enabled !== false) + ', model=' + (summarizationConfig.model || 'gemini-2.0-flash-exp'));
        } catch (e) {}
      });
    }
    
    return {
      store,
      summarizer,
      truncator: summarizer, // Backward compatibility alias
      retriever
    };
  } catch (err) {
    logger?.error?.('Failed to initialize tool result services: ' + err.message);
    // Return dummy services that don't do anything to prevent crashes
    return {
      store: { saveResult: () => null, getResult: () => null, close: () => {} },
      summarizer: { shouldSummarize: () => false, summarize: (t, c) => c },
      truncator: { shouldTruncate: () => false, truncate: (t, c) => c },
      retriever: { retrieve: () => ({ error: true, message: 'Not initialized' }) }
    };
  }
}

/**
 * Process a tool result - store if large, return summarized/truncated version
 * @param {Object} params - Processing parameters
 * @returns {Object} Result with possibly summarized content
 */
export async function processToolResult(params) {
  const { 
    toolName, 
    toolUseId, 
    result, 
    sessionId,
    store,
    summarizer,
    truncator, // Backward compatibility
    config = {}
  } = params;
  
  try {
    // Use summarizer or fall back to truncator for backward compatibility
    const processor = summarizer || truncator;
    
    // Check if summarization needed
    const { estimateTokens } = await import('./store.js');
    const tokenCount = estimateTokens(result);
    
    if (!processor.shouldSummarize?.(toolName, result) && !processor.shouldTruncate?.(toolName, result)) {
      // Small result, pass through unchanged
      return { 
        truncated: false, 
        summarized: false,
        content: result,
        tokenCount 
      };
    }
    
    // Store full result
    const resultId = await store.saveResult({
      sessionId,
      toolUseId,
      toolName,
      fullResult: result,
      tokenCount
    });
    
    if (!resultId) {
      // Storage failed, return original
      if (config.debug) console.warn('[tool-results] Failed to store result, passing through');
      return { 
        truncated: false, 
        summarized: false,
        content: result,
        tokenCount 
      };
    }
    
    // Generate summarized/truncated version
    const processedContent = processor.summarize 
      ? await processor.summarize(toolName, result, { resultId, tokenCount })
      : processor.truncate(toolName, result, { resultId, tokenCount });
    
    return {
      truncated: !processor.summarize,
      summarized: !!processor.summarize,
      resultId,
      content: processedContent,
      originalTokens: tokenCount,
      processedTokens: estimateTokens(processedContent)
    };
  } catch (err) {
    if (config.debug) console.error('[tool-results] Process error: ' + err.message);
    return { 
      truncated: false, 
      summarized: false,
      content: result,
      tokenCount: result.length / 4 
    };
  }
}

export default {
  initToolResultServices,
  processToolResult
};
