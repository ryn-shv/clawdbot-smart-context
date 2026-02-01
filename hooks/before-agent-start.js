/**
 * before_agent_start Hook Handler
 * 
 * Handles message filtering and tool result transformation.
 * Phase 1A: Transform large tool_results in existing messages
 * Phase 2: Add RAG context injection
 * 
 * @module hooks/before-agent-start
 */

import { selectMessages, estimateTokens } from '../selector.js';
import { processToolResult } from '../tool-results/index.js';
import { formatRAGContext } from '../tool-results/retriever.js';

/**
 * Main hook handler
 */
export async function handleBeforeAgentStart(event, ctx, config, services, logger) {
  const { prompt, messages } = event;
  
  if (!messages || !Array.isArray(messages)) {
    return undefined;
  }
  
  const debug = config?.debug || false;
  const toolResultsEnabled = config?.toolResults?.enabled !== false;
  const ragEnabled = config?.rag?.enabled === true;
  
  let processedMessages = messages;
  let tokensSaved = 0;
  let resultsStored = 0;
  
  // Phase 1A: Transform large tool_results in message history
  if (toolResultsEnabled && services?.store && services?.truncator) {
    const transformResult = await transformToolResults(
      messages,
      services,
      ctx?.sessionId,
      config,
      debug ? logger : null
    );
    
    processedMessages = transformResult.messages;
    tokensSaved = transformResult.tokensSaved;
    resultsStored = transformResult.resultsStored;
    
    if (resultsStored > 0 && debug) {
      logger?.info?.(`Stored ${resultsStored} large tool results, saved ~${tokensSaved} tokens`);
    }
  }
  
  // Skip filtering for very short histories
  const minMessages = (config?.topK || 10) + (config?.recentN || 3);
  if (processedMessages.length <= minMessages) {
    if (debug) logger?.debug?.(`Short history (${processedMessages.length}), skipping filter`);
    
    // Even with short history, we might want RAG injection
    if (ragEnabled) {
      return await addRAGContext(processedMessages, prompt, services, config, logger);
    }
    
    // Return transformed messages if any changes were made
    if (resultsStored > 0) {
      return { messages: processedMessages };
    }
    
    return undefined;
  }
  
  // Standard message filtering
  const startTime = Date.now();
  
  try {
    const filtered = await selectMessages({
      messages: processedMessages,
      prompt,
      embedder: services.embedder,
      cache: services.embeddingCache,
      config: {
        topK: config?.topK || 10,
        recentN: config?.recentN || 3,
        minScore: config?.minScore || 0.65,
        stripOldToolCalls: config?.stripOldToolCalls !== false,
        debug
      }
    });
    
    const elapsed = Date.now() - startTime;
    
    // Calculate savings
    const inputTokens = processedMessages.reduce((sum, m) => 
      sum + estimateTokens(JSON.stringify(m)), 0);
    const outputTokens = filtered.reduce((sum, m) => 
      sum + estimateTokens(JSON.stringify(m)), 0);
    const filteringSaved = inputTokens - outputTokens;
    
    if (filtered.length < processedMessages.length && debug) {
      const reduction = Math.round((1 - filtered.length / processedMessages.length) * 100);
      logger?.info?.(`Filtered: ${processedMessages.length} → ${filtered.length} msgs (${reduction}%, ~${filteringSaved + tokensSaved} total tokens saved, ${elapsed}ms)`);
    }
    
    // Phase 2: RAG injection
    if (ragEnabled) {
      return await addRAGContext(filtered, prompt, services, config, logger);
    }
    
    return { messages: filtered };
    
  } catch (err) {
    logger?.error?.(`Selection error: ${err.message}`);
    
    // Return transformed messages on filter error
    if (resultsStored > 0) {
      return { messages: processedMessages };
    }
    
    return undefined;
  }
}

/**
 * Transform large tool_results in message history
 * Stores full results and replaces with truncated versions
 */
async function transformToolResults(messages, services, sessionId, config, logger) {
  const { store, truncator } = services;
  
  let tokensSaved = 0;
  let resultsStored = 0;
  
  const transformed = [];
  
  for (const msg of messages) {
    // Only process user messages (tool_results are in user role)
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      transformed.push(msg);
      continue;
    }
    
    let hasChanges = false;
    const newContent = [];
    
    for (const block of msg.content) {
      // Only process tool_result blocks
      if (block.type !== 'tool_result') {
        newContent.push(block);
        continue;
      }
      
      const resultContent = typeof block.content === 'string' 
        ? block.content 
        : JSON.stringify(block.content);
      
      // Check if already processed (contains [STORED: marker)
      if (resultContent.includes('[STORED: tr_')) {
        newContent.push(block);
        continue;
      }
      
      // Check if truncation needed
      if (!truncator.shouldTruncate(block.name || 'unknown', resultContent)) {
        newContent.push(block);
        continue;
      }
      
      // Process this result
      const processed = await processToolResult({
        toolName: block.name || 'unknown',
        toolUseId: block.tool_use_id,
        result: resultContent,
        sessionId,
        store,
        truncator,
        config
      });
      
      if (processed.truncated) {
        hasChanges = true;
        resultsStored++;
        tokensSaved += processed.originalTokens - processed.truncatedTokens;
        
        newContent.push({
          ...block,
          content: processed.content
        });
        
        if (logger) {
          logger.debug?.(`Stored tool result ${processed.resultId}: ${processed.originalTokens} → ${processed.truncatedTokens} tokens`);
        }
      } else {
        newContent.push(block);
      }
    }
    
    if (hasChanges) {
      transformed.push({ ...msg, content: newContent });
    } else {
      transformed.push(msg);
    }
  }
  
  return {
    messages: transformed,
    tokensSaved,
    resultsStored
  };
}

/**
 * Add RAG context injection (Phase 2)
 */
async function addRAGContext(messages, prompt, services, config, logger) {
  const { retriever, embedder } = services;
  
  if (!retriever || !embedder) {
    return { messages };
  }
  
  try {
    const ragConfig = config?.rag || {};
    
    const chunks = await retriever.queryRelevantChunks({
      query: prompt,
      topK: ragConfig.topK || 3,
      minScore: ragConfig.minScore || 0.7
    });
    
    if (chunks.length > 0) {
      const injection = formatRAGContext(chunks);
      
      if (logger) {
        logger.info?.(`RAG injected ${chunks.length} chunks (~${estimateTokens(injection)} tokens)`);
      }
      
      return {
        messages,
        prependContext: injection
      };
    }
  } catch (err) {
    if (logger) {
      logger.warn?.(`RAG injection failed: ${err.message}`);
    }
  }
  
  return { messages };
}

export default handleBeforeAgentStart;
