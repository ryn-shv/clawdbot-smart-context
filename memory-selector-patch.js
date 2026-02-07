/**
 * Memory Integration Patch for selector.js
 * 
 * This module contains helper functions for integrating memory retrieval
 * into the message selection process.
 */

import { isEnabled, getConfig } from './config.js';
import { createLogger } from './logger.js';
import memory from './memory.js';

const logger = createLogger('memory-selector');

/**
 * Retrieve relevant facts from memory in parallel with message scoring
 */
export async function retrieveMemoryFacts(queryText, config) {
  if (!isEnabled('memory') || !config.userId) {
    return null;
  }
  
  const op = logger.startOp('memory-retrieval');
  
  try {
    const facts = await memory.retrieveFacts({
      userId: config.userId,
      agentId: config.agentId,
      sessionId: config.sessionId,
      query: queryText,
      options: {
        topK: getConfig('memoryMaxFacts'),
        minScore: getConfig('memoryMinScore')
      }
    });
    
    op.end({ factCount: facts.length });
    
    if (facts.length > 0) {
      logger.info(`📝 Retrieved ${facts.length} memory facts`);
    }
    
    return facts;
    
  } catch (err) {
    op.error(err);
    logger.error('Memory retrieval failed', { error: err.message });
    return null; // Graceful degradation
  }
}

/**
 * Format retrieved facts into context for injection
 */
export function formatMemoryContext(facts) {
  if (!facts || facts.length === 0) {
    return null;
  }
  
  // Group by category for readability
  const byCategory = {};
  
  for (const fact of facts) {
    const cat = fact.category || 'general';
    if (!byCategory[cat]) {
      byCategory[cat] = [];
    }
    byCategory[cat].push(fact);
  }
  
  // Build formatted sections
  const sections = [];
  
  for (const [category, items] of Object.entries(byCategory)) {
    const header = category.charAt(0).toUpperCase() + category.slice(1);
    const factList = items
      .sort((a, b) => b.score - a.score) // Sort by relevance
      .map(f => `• ${f.value} ${f.scope === 'session' ? '(this session)' : ''}`)
      .join('\n');
    
    sections.push(`**${header}:**\n${factList}`);
  }
  
  return `## Context About This User\n\n${sections.join('\n\n')}`;
}

/**
 * Inject memory context as system message at the beginning of selected messages
 */
export function injectMemoryContext(selectedMessages, memoryContext) {
  if (!memoryContext) {
    return selectedMessages;
  }
  
  // Create system message with memory context
  const memoryMessage = {
    role: 'system',
    content: memoryContext,
    _memory: true, // Internal flag for tracking
    _timestamp: Date.now()
  };
  
  // Prepend to selected messages
  return [memoryMessage, ...selectedMessages];
}
