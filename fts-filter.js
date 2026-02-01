/**
 * FTS5 Pre-Filtering for Smart Context - Phase 2
 * 
 * Fast keyword-based pre-filtering before semantic search using SQLite FTS5.
 * 
 * WORKFLOW:
 * 1. Extract keywords from query (remove stop words)
 * 2. FTS5 MATCH query to find top N candidates (fast SQL operation)
 * 3. Return filtered message list (semantic search operates on this subset)
 * 
 * BENEFITS:
 * - 2x faster for keyword-heavy queries (error codes, function names, API endpoints)
 * - Reduces embedding/scoring workload from 100+ messages to ~50
 * - Combines with BM25/semantic for final ranking
 */

import { isEnabled } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// KEYWORD EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'what', 'which', 'who', 'when',
  'where', 'why', 'how'
]);

/**
 * Extract meaningful keywords from query text
 * 
 * Removes:
 * - Common stop words (the, a, an, etc.)
 * - Short words (< 3 chars)
 * - Punctuation
 * 
 * Preserves:
 * - Error codes (ENOENT, 404, etc.)
 * - Function names (read_file, validateInput)
 * - Technical terms (API, HTTP, JSON)
 * - Domain-specific keywords
 * 
 * @param {string} query - Query text
 * @returns {string[]} - Array of keywords
 */
export function extractKeywords(query) {
  if (!query || typeof query !== 'string') {
    return [];
  }
  
  // Preserve quoted phrases as single keywords
  const quotedPhrases = [];
  const quotedMatches = query.match(/["']([^"']+)["']/g);
  if (quotedMatches) {
    quotedMatches.forEach(match => {
      const phrase = match.slice(1, -1).trim();
      if (phrase.length > 0) {
        quotedPhrases.push(phrase);
      }
    });
  }
  
  // Remove quoted phrases from query before tokenizing
  let cleanQuery = query.replace(/["']([^"']+)["']/g, ' ');
  
  // First pass: identify uppercase abbreviations and error codes BEFORE lowercasing
  const uppercaseMatches = cleanQuery.match(/\b[A-Z]{2,}\b/g) || [];
  const errorCodeMatches = cleanQuery.match(/\bE[A-Z]+\b/g) || [];
  const specialTerms = [...new Set([...uppercaseMatches, ...errorCodeMatches])];
  
  // Tokenize remaining text (now safe to lowercase)
  const tokens = cleanQuery
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // Remove punctuation (but keep underscores)
    .split(/\s+/)
    .filter(word => {
      // Keep words that are:
      // 1. Length >= 3 AND not stop word
      // 2. Numbers (404, 500)
      return (word.length >= 3 && !STOP_WORDS.has(word)) || 
             /^\d+$/.test(word);
    });
  
  return [...quotedPhrases, ...specialTerms, ...tokens];
}

/**
 * Build FTS5 MATCH query from keywords
 * 
 * Supports:
 * - OR queries: keyword1 OR keyword2
 * - Phrase queries: "exact phrase"
 * - Prefix matching: keyword*
 * 
 * @param {string[]} keywords - Array of keywords
 * @param {Object} options - Query options
 * @param {boolean} options.usePrefix - Enable prefix matching (default: true)
 * @param {string} options.operator - Join operator: 'OR' or 'AND' (default: 'OR')
 * @returns {string} - FTS5 MATCH query string
 */
export function buildFTS5Query(keywords, { usePrefix = true, operator = 'OR' } = {}) {
  if (!keywords || keywords.length === 0) {
    return '';
  }
  
  const queryTerms = keywords.map(keyword => {
    // Quoted phrases: preserve as-is
    if (keyword.includes(' ')) {
      return `"${keyword}"`;
    }
    
    // Prefix matching for single words (helps with partial matches)
    if (usePrefix && keyword.length >= 4) {
      return `${keyword}*`;
    }
    
    return keyword;
  });
  
  return queryTerms.join(` ${operator} `);
}

/**
 * Detect if query requires exact keyword matching
 * 
 * Indicators:
 * - Contains quoted phrases
 * - Contains error codes (ENOENT, E404)
 * - Contains function names with underscores
 * - Contains file paths (/, ., ~)
 * - Contains technical abbreviations (API, HTTP, SQL)
 * 
 * @param {string} query - Query text
 * @returns {boolean} - True if query needs FTS5 pre-filtering
 */
export function shouldUseFTS5(query) {
  if (!query || typeof query !== 'string') {
    return false;
  }
  
  // Check for quoted phrases
  if (/["'].*?["']/.test(query)) {
    return true;
  }
  
  // Check for error codes (ENOENT, E404, etc.)
  if (/\bE[A-Z]+\b/.test(query.toUpperCase())) {
    return true;
  }
  
  // Check for function names (snake_case, camelCase)
  if (/\w+_\w+/.test(query) || /[a-z][A-Z]/.test(query)) {
    return true;
  }
  
  // Check for file paths
  if (/[~\/\\.]/.test(query)) {
    return true;
  }
  
  // Check for technical terms (API, HTTP, SQL, etc.)
  if (/\b(API|HTTP|SQL|JSON|XML|CSV|PDF|URL|URI)\b/i.test(query)) {
    return true;
  }
  
  // Check for numbers (status codes, version numbers)
  if (/\b\d{3,4}\b/.test(query)) {
    return true;
  }
  
  return false;
}

/**
 * Pre-filter messages using FTS5 keyword search
 * 
 * Strategy:
 * 1. Extract keywords from query
 * 2. If no meaningful keywords, return all messages (no filtering)
 * 3. Query FTS5 index for matching message IDs
 * 4. Filter messages to only matched IDs + recent N messages (recency matters)
 * 5. Return filtered list for semantic scoring
 * 
 * @param {Object} cache - Cache instance with searchKeywords method
 * @param {string} query - Query text
 * @param {Array} messages - Array of message objects
 * @param {Object} options - Filtering options
 * @param {number} options.limit - Max candidates to return (default: 50)
 * @param {number} options.recentN - Always keep N recent messages (default: 5)
 * @param {boolean} options.debug - Enable debug logging
 * @returns {Array} - Filtered messages (or original if FTS5 disabled/no matches)
 */
export async function preFilterWithFTS5(cache, query, messages, { 
  limit = 50, 
  recentN = 5,
  debug = false 
} = {}) {
  // Feature flag check
  if (!isEnabled('fts5Search')) {
    if (debug) {
      console.log('[fts-filter] FTS5 disabled, returning all messages');
    }
    return messages;
  }
  
  // Validate inputs
  if (!cache || !messages || messages.length === 0) {
    return messages || [];
  }
  
  // Check if query warrants FTS5 pre-filtering
  if (!shouldUseFTS5(query)) {
    if (debug) {
      console.log('[fts-filter] Query does not require FTS5 (semantic-only query)');
    }
    return messages;
  }
  
  // Extract keywords
  const keywords = extractKeywords(query);
  
  if (keywords.length === 0) {
    if (debug) {
      console.log('[fts-filter] No meaningful keywords extracted, returning all messages');
    }
    return messages;
  }
  
  if (debug) {
    console.log(`[fts-filter] Extracted keywords:`, keywords);
  }
  
  // Build FTS5 query
  const ftsQuery = buildFTS5Query(keywords, { usePrefix: true, operator: 'OR' });
  
  if (debug) {
    console.log(`[fts-filter] FTS5 query: ${ftsQuery}`);
  }
  
  try {
    // Query FTS5 index (limit * 2 to have buffer for duplicates)
    const startTime = Date.now();
    const ftsResults = await cache.searchKeywords(ftsQuery, { topK: limit * 2 });
    const searchTime = Date.now() - startTime;
    
    if (debug) {
      console.log(`[fts-filter] FTS5 search completed in ${searchTime}ms, found ${ftsResults.length} matches`);
    }
    
    // No matches: return all messages (don't over-filter)
    if (ftsResults.length === 0) {
      if (debug) {
        console.log('[fts-filter] No FTS5 matches, returning all messages');
      }
      return messages;
    }
    
    // Build set of matched message IDs
    const matchedIds = new Set(ftsResults.map(r => r.messageId));
    
    // Filter messages:
    // - Include if message ID matched FTS5
    // - Always include recent N messages (preserve recency)
    const filtered = messages.filter((msg, idx) => {
      const msgId = msg.id || `msg-${idx}`;
      const isRecent = idx >= messages.length - recentN;
      const isMatched = matchedIds.has(msgId);
      
      return isMatched || isRecent;
    });
    
    if (debug) {
      const reductionPercent = ((1 - filtered.length / messages.length) * 100).toFixed(1);
      console.log(`[fts-filter] Filtered ${messages.length} → ${filtered.length} messages (${reductionPercent}% reduction)`);
    }
    
    return filtered;
    
  } catch (err) {
    console.error('[fts-filter] FTS5 search failed:', err.message);
    if (debug) {
      console.error('[fts-filter] Error details:', err);
    }
    
    // Graceful fallback: return all messages
    return messages;
  }
}

/**
 * Get FTS5 filter statistics
 * 
 * @param {Object} cache - Cache instance
 * @returns {Promise<Object>} - Statistics object
 */
export async function getFilterStats(cache) {
  if (!isEnabled('fts5Search') || !cache) {
    return {
      enabled: false,
      indexedCount: 0
    };
  }
  
  try {
    const stats = await cache.stats();
    return {
      enabled: true,
      indexedCount: stats.ftsMessageCount || 0
    };
  } catch (err) {
    return {
      enabled: true,
      indexedCount: 0,
      error: err.message
    };
  }
}

export default {
  extractKeywords,
  buildFTS5Query,
  shouldUseFTS5,
  preFilterWithFTS5,
  getFilterStats
};
