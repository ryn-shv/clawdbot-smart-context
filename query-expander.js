/**
 * Query Expander for Multi-Query Retrieval (Phase 3B)
 * 
 * Generates semantic variations of user queries to improve recall.
 * Supports both LLM-based and rule-based expansion strategies.
 * 
 * Example:
 *   Input: "database error"
 *   Output: [
 *     "database error",
 *     "SQL connection failure",
 *     "PostgreSQL timeout issue",
 *     "database query problems"
 *   ]
 * 
 * Expected improvement: 15-20% recall boost for ambiguous queries
 */

import { createLogger } from './logger.js';
import { getConfig } from './config.js';

const logger = createLogger('query-expander', { debug: true });

// LRU Cache for query expansions (avoid redundant LLM calls)
const EXPANSION_CACHE = new Map();
const EXPANSION_CACHE_MAX = 100;
const EXPANSION_CACHE_TTL = 300000; // 5 minutes

/**
 * Clean expired cache entries
 */
function cleanExpansionCache() {
  const now = Date.now();
  for (const [key, entry] of EXPANSION_CACHE) {
    if (now - entry.timestamp > EXPANSION_CACHE_TTL) {
      EXPANSION_CACHE.delete(key);
    }
  }
  
  // LRU eviction if cache is full
  if (EXPANSION_CACHE.size > EXPANSION_CACHE_MAX) {
    const entries = [...EXPANSION_CACHE.entries()];
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, EXPANSION_CACHE.size - EXPANSION_CACHE_MAX);
    for (const [key] of toRemove) {
      EXPANSION_CACHE.delete(key);
    }
  }
}

/**
 * Rule-based query expansion (no LLM required)
 * 
 * Strategy:
 * 1. Extract key terms
 * 2. Generate synonyms and related terms
 * 3. Create alternative phrasings
 * 4. Simplify complex queries
 */
class RuleBasedExpander {
  constructor() {
    // Common synonyms for technical terms
    this.synonyms = {
      'error': ['failure', 'issue', 'problem', 'exception', 'fault'],
      'fix': ['solve', 'resolve', 'repair', 'patch', 'correct'],
      'database': ['db', 'SQL', 'PostgreSQL', 'MySQL', 'data store'],
      'connection': ['connect', 'link', 'network', 'socket'],
      'timeout': ['timed out', 'timeout error', 'connection timeout'],
      'deploy': ['deployment', 'release', 'publish', 'push'],
      'build': ['compile', 'build process', 'compilation'],
      'test': ['testing', 'unit test', 'test suite'],
      'api': ['endpoint', 'REST API', 'API call'],
      'config': ['configuration', 'settings', 'setup'],
      'auth': ['authentication', 'authorization', 'login', 'credentials'],
    };
    
    // Related technical terms
    this.relatedTerms = {
      'database': ['query', 'table', 'schema', 'index'],
      'api': ['request', 'response', 'endpoint', 'HTTP'],
      'error': ['stack trace', 'exception', 'bug'],
      'deploy': ['production', 'staging', 'CI/CD'],
    };
  }
  
  /**
   * Expand query using rules
   */
  expandQuery(query, count = 3) {
    const variants = new Set([query]); // Always include original
    const lowercaseQuery = query.toLowerCase();
    
    // Strategy 1: Synonym replacement
    for (const [word, syns] of Object.entries(this.synonyms)) {
      if (lowercaseQuery.includes(word)) {
        for (const syn of syns.slice(0, 2)) {
          const variant = lowercaseQuery.replace(word, syn);
          variants.add(variant);
          if (variants.size >= count + 1) break;
        }
      }
      if (variants.size >= count + 1) break;
    }
    
    // Strategy 2: Add related terms
    if (variants.size < count + 1) {
      for (const [term, related] of Object.entries(this.relatedTerms)) {
        if (lowercaseQuery.includes(term)) {
          for (const rel of related.slice(0, 1)) {
            variants.add(`${lowercaseQuery} ${rel}`);
            if (variants.size >= count + 1) break;
          }
        }
        if (variants.size >= count + 1) break;
      }
    }
    
    // Strategy 3: Simplify question forms
    if (variants.size < count + 1) {
      const simplified = this.simplifyQuery(query);
      if (simplified !== query) {
        variants.add(simplified);
      }
    }
    
    // Strategy 4: Extract key terms only
    if (variants.size < count + 1) {
      const keyTerms = this.extractKeyTerms(query);
      if (keyTerms !== query) {
        variants.add(keyTerms);
      }
    }
    
    const result = Array.from(variants).slice(0, count + 1);
    return result;
  }
  
  /**
   * Simplify query by removing question words and filler
   */
  simplifyQuery(query) {
    let simplified = query.toLowerCase();
    
    // Remove question words
    const questionWords = ['how', 'what', 'where', 'when', 'why', 'who', 'which'];
    for (const word of questionWords) {
      simplified = simplified.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
    }
    
    // Remove filler words
    const fillers = ['do', 'does', 'did', 'can', 'could', 'would', 'should', 'i', 'the', 'a', 'an'];
    for (const word of fillers) {
      simplified = simplified.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
    }
    
    // Clean up whitespace
    simplified = simplified.replace(/\s+/g, ' ').trim();
    
    return simplified || query;
  }
  
  /**
   * Extract key technical terms
   */
  extractKeyTerms(query) {
    const words = query.toLowerCase().split(/\s+/);
    const keyWords = words.filter(word => {
      // Keep words > 3 chars or technical terms
      return word.length > 3 || this.synonyms[word] || this.relatedTerms[word];
    });
    
    return keyWords.join(' ') || query;
  }
}

/**
 * LLM-based query expansion
 */
class LLMExpander {
  constructor(llm) {
    this.llm = llm;
  }
  
  async expandQuery(query, count = 3) {
    const prompt = `Generate ${count} alternative phrasings for this search query. Be specific and capture different aspects of the intent. Use technical terminology where appropriate.

Query: "${query}"

Alternative phrasings (one per line):`;
    
    try {
      const response = await this.llm.complete(prompt, { 
        maxTokens: 150,
        temperature: 0.7,
        stopSequences: ['\n\n']
      });
      
      const variants = response.split('\n')
        .map(v => v.trim())
        .map(v => v.replace(/^\d+\.\s*/, '')) // Remove numbering
        .map(v => v.replace(/^[-*]\s*/, ''))  // Remove bullets
        .filter(v => v.length > 0)
        .filter(v => v !== query)              // Deduplicate
        .slice(0, count);
      
      // Always include original query first
      return [query, ...variants];
    } catch (err) {
      logger.error('LLM expansion failed', { error: err.message });
      // Fallback to rule-based
      const fallback = new RuleBasedExpander();
      return fallback.expandQuery(query, count);
    }
  }
}

/**
 * Query Expander with caching and multiple strategies
 */
export class QueryExpander {
  constructor(llm = null, strategy = 'auto') {
    this.llm = llm;
    this.strategy = strategy; // 'llm', 'rule', or 'auto'
    this.ruleExpander = new RuleBasedExpander();
    this.llmExpander = llm ? new LLMExpander(llm) : null;
    
    logger.info('QueryExpander initialized', { 
      strategy,
      hasLLM: !!llm 
    });
  }
  
  /**
   * Expand query with caching
   */
  async expandQuery(query, count = 3) {
    if (!query || query.trim().length === 0) {
      return [query];
    }
    
    // Check cache
    const cacheKey = `${query}|${count}|${this.strategy}`;
    const cached = EXPANSION_CACHE.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < EXPANSION_CACHE_TTL) {
      logger.metric('expansion-cache-hit', 1);
      return cached.variants;
    }
    
    logger.metric('expansion-cache-miss', 1);
    
    // Expand query based on strategy
    let variants;
    
    if (this.strategy === 'llm' && this.llmExpander) {
      variants = await this.llmExpander.expandQuery(query, count);
    } else if (this.strategy === 'rule') {
      variants = this.ruleExpander.expandQuery(query, count);
    } else {
      // Auto: Use LLM if available, else rule-based
      if (this.llmExpander) {
        variants = await this.llmExpander.expandQuery(query, count);
      } else {
        variants = this.ruleExpander.expandQuery(query, count);
      }
    }
    
    // Cache result
    EXPANSION_CACHE.set(cacheKey, {
      variants,
      timestamp: Date.now()
    });
    
    cleanExpansionCache();
    
    logger.info('Query expanded', {
      original: query,
      variants: variants.slice(1), // Don't log original
      strategy: this.strategy
    });
    
    return variants;
  }
  
  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: EXPANSION_CACHE.size,
      maxSize: EXPANSION_CACHE_MAX,
      ttlMs: EXPANSION_CACHE_TTL
    };
  }
  
  /**
   * Clear expansion cache
   */
  clearCache() {
    EXPANSION_CACHE.clear();
    logger.info('Expansion cache cleared');
  }
}

/**
 * Reciprocal Rank Fusion (RRF)
 * 
 * Merges multiple ranked lists into a single ranking using RRF algorithm.
 * 
 * Formula: score(d) = Σ 1 / (k + rank(d))
 * where k is a constant (typically 60)
 * 
 * Reference: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
 */
export function fuseResultsRRF(rankedLists, topK, k = 60) {
  const scores = new Map();
  const itemById = new Map();
  
  // Calculate RRF scores
  for (const rankedList of rankedLists) {
    rankedList.forEach((item, rank) => {
      const itemId = item.id || JSON.stringify(item);
      
      // Store item reference
      if (!itemById.has(itemId)) {
        itemById.set(itemId, item);
      }
      
      // Update RRF score
      const currentScore = scores.get(itemId) || 0;
      const rrfScore = 1 / (k + rank);
      scores.set(itemId, currentScore + rrfScore);
    });
  }
  
  // Sort by fused score and return top K
  const fusedItems = Array.from(itemById.entries())
    .map(([itemId, item]) => ({
      ...item,
      fusedScore: scores.get(itemId),
      fusedRank: 0 // Will be set after sorting
    }))
    .sort((a, b) => b.fusedScore - a.fusedScore);
  
  // Assign fused ranks
  fusedItems.forEach((item, idx) => {
    item.fusedRank = idx;
  });
  
  return fusedItems.slice(0, topK);
}

/**
 * Simple fusion: deduplicate and keep highest scores
 */
export function fuseResultsSimple(rankedLists, topK) {
  const seen = new Set();
  const fused = [];
  
  // Iterate through all lists in parallel (round-robin)
  let position = 0;
  let hasMore = true;
  
  while (hasMore && fused.length < topK * 2) {
    hasMore = false;
    
    for (const rankedList of rankedLists) {
      if (position < rankedList.length) {
        hasMore = true;
        const item = rankedList[position];
        const itemId = item.id || JSON.stringify(item);
        
        if (!seen.has(itemId)) {
          seen.add(itemId);
          fused.push(item);
        }
      }
    }
    
    position++;
  }
  
  return fused.slice(0, topK);
}

/**
 * Export cache management functions
 */
export function getExpansionCacheStats() {
  return {
    size: EXPANSION_CACHE.size,
    maxSize: EXPANSION_CACHE_MAX,
    ttlMs: EXPANSION_CACHE_TTL
  };
}

export function clearExpansionCache() {
  EXPANSION_CACHE.clear();
}

export default QueryExpander;
