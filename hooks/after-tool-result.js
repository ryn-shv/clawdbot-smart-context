/**
 * after_tool_result Hook Handler (Phase 1B)
 * 
 * Intercepts tool results immediately after execution,
 * before they're added to message history.
 * 
 * NOTE: This hook requires a core Clawdbot patch to enable
 * the 'after_tool_result' hook point. See TOOL_RESULTS_ARCHITECTURE.md
 * for patch details.
 * 
 * Without the patch, use the message transform in before-agent-start.js
 * 
 * @module hooks/after-tool-result
 */

import { processToolResult, estimateTokens } from '../tool-results/index.js';

/**
 * Main hook handler for after_tool_result
 * 
 * @param {Object} event - Hook event
 * @param {string} event.toolUseId - The tool_use ID
 * @param {string} event.toolName - Name of the tool (browser, exec, etc.)
 * @param {string} event.result - Full tool result
 * @param {string} event.sessionId - Current session ID
 * @param {Object} ctx - Hook context
 * @param {Object} config - Plugin configuration
 * @param {Object} services - Shared services (store, truncator, etc.)
 * @param {Object} logger - Logger instance
 * @returns {Object|undefined} Modified result or undefined for no change
 */
export async function handleAfterToolResult(event, ctx, config, services, logger) {
  const { toolUseId, toolName, result, sessionId } = event;
  
  // Skip if tool results storage is disabled
  if (config?.toolResults?.enabled === false) {
    return undefined;
  }
  
  const debug = config?.debug || false;
  const { store, truncator, embedder } = services;
  
  if (!store || !truncator) {
    if (debug) {
      logger?.warn?.('Tool result services not initialized');
    }
    return undefined;
  }
  
  // Check if truncation needed
  const tokenCount = estimateTokens(result);
  
  if (!truncator.shouldTruncate(toolName, result)) {
    // Small result, pass through unchanged
    if (debug) {
      logger?.debug?.(`Tool result ${toolName}:${toolUseId} small enough (${tokenCount} tokens), keeping as-is`);
    }
    return undefined;
  }
  
  // Process and store the result
  try {
    const processed = await processToolResult({
      toolName,
      toolUseId,
      result,
      sessionId,
      store,
      truncator,
      config
    });
    
    if (processed.truncated) {
      if (debug) {
        logger?.info?.(`Stored ${toolName} result ${processed.resultId}: ${processed.originalTokens} → ${processed.truncatedTokens} tokens`);
      }
      
      // Phase 2: Chunk and embed for RAG
      if (config?.rag?.enabled && embedder) {
        await chunkAndEmbed(
          processed.resultId,
          result,
          services,
          config.rag,
          debug ? logger : null
        );
      }
      
      // Return modified result
      return { result: processed.content };
    }
    
    return undefined;
    
  } catch (err) {
    logger?.error?.(`Failed to process tool result: ${err.message}`);
    return undefined;
  }
}

/**
 * Chunk and embed result for RAG (Phase 2)
 */
async function chunkAndEmbed(resultId, fullResult, services, ragConfig, logger) {
  // Phase 2 implementation placeholder
  // 
  // 1. Chunk the full result into ~2k token segments
  // 2. Embed each chunk using services.embedder
  // 3. Store chunks + embeddings in services.store
  //
  // const chunks = chunkText(fullResult, {
  //   chunkSize: ragConfig.chunkSize || 2000,
  //   overlap: ragConfig.chunkOverlap || 200
  // });
  //
  // for (const chunk of chunks) {
  //   const embedding = await services.embedder.embed(chunk.text);
  //   await services.store.saveChunk({
  //     resultId,
  //     chunkIdx: chunk.index,
  //     chunkText: chunk.text,
  //     embedding,
  //     startOffset: chunk.startOffset,
  //     endOffset: chunk.endOffset
  //   });
  // }
  
  if (logger) {
    logger.debug?.(`RAG chunking for ${resultId} - not yet implemented`);
  }
}

/**
 * Simple text chunker (Phase 2 utility)
 * Splits text into chunks of approximately targetTokens size
 */
export function chunkText(text, options = {}) {
  const {
    chunkSize = 2000,  // Target tokens per chunk
    overlap = 200,     // Token overlap between chunks
    separator = '\n'   // Preferred split boundary
  } = options;
  
  const charsPerToken = 4;
  const targetChars = chunkSize * charsPerToken;
  const overlapChars = overlap * charsPerToken;
  
  const chunks = [];
  let offset = 0;
  let chunkIdx = 0;
  
  while (offset < text.length) {
    // Calculate end position
    let end = Math.min(offset + targetChars, text.length);
    
    // Try to end at a natural boundary
    if (end < text.length) {
      // Look for separator near the end
      const searchStart = Math.max(offset, end - 200);
      const lastSep = text.lastIndexOf(separator, end);
      
      if (lastSep > searchStart) {
        end = lastSep + 1;
      }
    }
    
    const chunkText = text.slice(offset, end);
    
    chunks.push({
      index: chunkIdx,
      text: chunkText,
      startOffset: offset,
      endOffset: end,
      tokenCount: Math.ceil(chunkText.length / charsPerToken)
    });
    
    chunkIdx++;
    
    // Move offset with overlap
    offset = end - overlapChars;
    
    // Prevent infinite loop
    if (offset >= text.length - 10) break;
  }
  
  return chunks;
}

export default handleAfterToolResult;
