/**
 * Message Validator for Smart Context
 * 
 * Validates messages before they're returned from selectMessages
 * to ensure no malformed tool_use blocks slip through.
 * 
 * CRITICAL: Anthropic API requires tool_use_id to match pattern ^[a-zA-Z0-9_-]+$
 */

import { createLogger } from './logger.js';

const logger = createLogger('validator', { debug: true });

// Anthropic's required pattern for tool_use_id
const VALID_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a tool_use_id format (Anthropic-compatible)
 */
export function isValidToolUseId(id) {
  if (!id || typeof id !== 'string' || id.length === 0) return false;
  return VALID_TOOL_USE_ID_PATTERN.test(id);
}

/**
 * Validate a tool_use block
 */
export function isValidToolUse(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type !== 'tool_use') return true;
  
  // Must have non-empty name
  if (!block.name || typeof block.name !== 'string' || block.name.length === 0) {
    return false;
  }
  
  // Must have valid tool_use_id format
  if (!isValidToolUseId(block.id)) {
    return false;
  }
  
  return true;
}

/**
 * Validate a tool_result block
 */
export function isValidToolResult(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type !== 'tool_result') return true;

  // Must have valid tool_use_id format
  if (!isValidToolUseId(block.tool_use_id)) {
    return false;
  }
  
  // Must have content (can be empty string but not undefined/null)
  if (block.content === undefined || block.content === null) {
    return false;
  }
  
  return true;
}

/**
 * Validate a content block
 */
export function isValidContentBlock(block) {
  if (!block || typeof block !== 'object') return false;
  
  if (block.type === 'tool_use') return isValidToolUse(block);
  if (block.type === 'tool_result') return isValidToolResult(block);
  
  return true;
}

/**
 * Validate an entire message
 */
export function isValidMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (!msg.role || typeof msg.role !== 'string') return false;
  
  if (Array.isArray(msg.content)) {
    return msg.content.every(isValidContentBlock);
  }
  
  return true;
}

/**
 * Sanitize content blocks, removing invalid ones
 */
export function sanitizeContent(content, debug = false) {
  if (!Array.isArray(content)) return content;

  return content.filter(block => {
    const valid = isValidContentBlock(block);
    if (!valid && debug) {
      const reason = [];
      if (block?.type === 'tool_use') {
        if (!block?.name) reason.push('missing name');
        if (!isValidToolUseId(block?.id)) reason.push(`invalid id format: "${block?.id}"`);
      }
      if (block?.type === 'tool_result') {
        if (!isValidToolUseId(block?.tool_use_id)) reason.push(`invalid tool_use_id format: "${block?.tool_use_id}"`);
        if (block?.content === undefined || block?.content === null) reason.push('missing content');
      }
      logger.warn('Removing invalid block:', {
        type: block?.type,
        name: block?.name,
        id: block?.id,
        tool_use_id: block?.tool_use_id,
        reason: reason.join(', ')
      });
    }
    return valid;
  });
}

/**
 * Sanitize a message, fixing or removing invalid content
 */
export function sanitizeMessage(msg, debug = false) {
  if (!msg || typeof msg !== 'object') return null;
  if (!msg.role) return null;

  if (Array.isArray(msg.content)) {
    const sanitized = sanitizeContent(msg.content, debug);
    if (sanitized.length === 0) return null;
    return { ...msg, content: sanitized };
  }

  return msg;
}

/**
 * Validate and sanitize an array of messages
 */
export function validateMessages(messages, debug = false) {
  if (!Array.isArray(messages)) return messages;

  const sanitized = messages
    .map(msg => sanitizeMessage(msg, debug))
    .filter(msg => msg !== null);

  if (sanitized.length < messages.length) {
    const removed = messages.length - sanitized.length;
    logger.info(`Removed ${removed} invalid messages`);
    if (debug && removed > 0) {
      // Log some details about what was removed
      const invalidMsgs = messages.filter((m, i) => {
        const s = sanitizeMessage(m, false);
        return s === null;
      });
      logger.debug('Sample of removed messages:',
        invalidMsgs.slice(0, 3).map(m => ({
          role: m?.role,
          contentType: Array.isArray(m?.content) ? 'array' : typeof m?.content,
          contentLength: Array.isArray(m?.content) ? m.content.length : 0
        }))
      );
    }
  }

  return sanitized;
}

/**
 * Count invalid blocks in messages (for diagnostics)
 */
export function countInvalidBlocks(messages, debug = false) {
  if (!Array.isArray(messages)) return { total: 0, byType: {} };
  
  const counts = {
    total: 0,
    byType: {
      tool_use_missing_name: 0,
      tool_use_invalid_id: 0,
      tool_result_invalid_id: 0,
      tool_result_missing_content: 0,
      other: 0
    }
  };
  
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      
      if (block.type === 'tool_use') {
        if (!block.name || typeof block.name !== 'string') {
          counts.total++;
          counts.byType.tool_use_missing_name++;
        } else if (!isValidToolUseId(block.id)) {
          counts.total++;
          counts.byType.tool_use_invalid_id++;
          if (debug) logger.debug(`Invalid tool_use id: "${block.id}"`);
        }
      }
      
      if (block.type === 'tool_result') {
        if (!isValidToolUseId(block.tool_use_id)) {
          counts.total++;
          counts.byType.tool_result_invalid_id++;
          if (debug) logger.debug(`Invalid tool_result tool_use_id: "${block.tool_use_id}"`);
        } else if (block.content === undefined || block.content === null) {
          counts.total++;
          counts.byType.tool_result_missing_content++;
        }
      }
    }
  }
  
  return counts;
}

export default {
  isValidToolUseId,
  isValidToolUse,
  isValidToolResult,
  isValidContentBlock,
  isValidMessage,
  sanitizeContent,
  sanitizeMessage,
  validateMessages,
  countInvalidBlocks,
  VALID_TOOL_USE_ID_PATTERN
};
