/**
 * Phase 4B: Fact Conflict Resolution
 * 
 * Detects and resolves contradicting facts using semantic similarity
 * and conflict resolution strategies.
 * 
 * @module conflict-resolver
 */

import { generateConflictPrompt, parseConflictResponse } from './extraction-prompts.js';

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUTION STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════

export const ResolutionStrategy = {
  KEEP_LATEST: 'keep_latest',           // Replace with newer fact
  KEEP_HIGHEST_CONFIDENCE: 'keep_highest_confidence', // Keep most confident
  MERGE: 'merge',                        // Combine both facts
  ASK_USER: 'ask_user'                  // Needs user clarification
};

// ═══════════════════════════════════════════════════════════════════════════
// SIMILARITY-BASED CONFLICT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute cosine similarity between two embeddings
 * 
 * @param {Array<number>} a - First embedding
 * @param {Array<number>} b - Second embedding
 * @returns {number} Similarity score (0-1)
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  
  let dot = 0;
  let magA = 0;
  let magB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Detect if two facts might be related based on semantic similarity
 * 
 * @param {Object} existingFact - Existing fact from memory
 * @param {Object} newFact - Newly extracted fact
 * @param {Object} cache - Cache instance for embeddings
 * @param {number} threshold - Similarity threshold (default: 0.8)
 * @returns {Promise<boolean>} True if facts are semantically related
 */
export async function detectPotentialConflict(existingFact, newFact, cache, threshold = 0.8) {
  try {
    // Must be same category to conflict
    if (existingFact.category !== newFact.category) {
      return false;
    }
    
    // Get embeddings for both facts
    const existingEmbedding = await cache.get(existingFact.value);
    const newEmbedding = await cache.get(newFact.fact);
    
    if (!existingEmbedding || !newEmbedding) {
      // Fallback to simple string comparison
      return existingFact.value.toLowerCase().includes(newFact.fact.toLowerCase()) ||
             newFact.fact.toLowerCase().includes(existingFact.value.toLowerCase());
    }
    
    const similarity = cosineSimilarity(existingEmbedding, newEmbedding);
    
    return similarity >= threshold;
  } catch (err) {
    // On error, assume no conflict (safe default)
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM-BASED CONFLICT ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Use LLM to analyze if facts conflict and suggest resolution
 * 
 * @param {Object} existingFact - Existing fact from memory
 * @param {Object} newFact - Newly extracted fact
 * @param {Function} llmCall - LLM client function
 * @returns {Promise<Object>} Conflict analysis result
 */
export async function analyzeConflictWithLLM(existingFact, newFact, llmCall) {
  try {
    const prompt = generateConflictPrompt(existingFact, newFact);
    
    const response = await llmCall(prompt);
    
    const analysis = parseConflictResponse(response);
    
    if (!analysis) {
      // LLM returned invalid response, assume no conflict
      return {
        conflicts: false,
        reason: 'LLM analysis failed',
        resolution: ResolutionStrategy.KEEP_LATEST
      };
    }
    
    return analysis;
  } catch (err) {
    // On error, keep latest (safe default)
    return {
      conflicts: false,
      reason: `Error: ${err.message}`,
      resolution: ResolutionStrategy.KEEP_LATEST
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFLICT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve conflict between two facts
 * 
 * @param {Object} existingFact - Existing fact from memory
 * @param {Object} newFact - Newly extracted fact
 * @param {string} strategy - Resolution strategy
 * @returns {Object} Resolution action { action: 'keep'|'update'|'merge'|'defer', fact }
 */
export function resolveConflict(existingFact, newFact, strategy) {
  switch (strategy) {
    case ResolutionStrategy.KEEP_LATEST:
      // Update existing fact with new value
      return {
        action: 'update',
        fact: {
          id: existingFact.id,
          value: newFact.fact,
          confidence: newFact.confidence,
          metadata: {
            ...existingFact.metadata,
            updated_from: existingFact.value,
            updated_reason: 'newer_information',
            source_context: newFact.source_context
          }
        }
      };
    
    case ResolutionStrategy.KEEP_HIGHEST_CONFIDENCE:
      // Keep the fact with higher confidence
      if (newFact.confidence > (existingFact.confidence || 0)) {
        return {
          action: 'update',
          fact: {
            id: existingFact.id,
            value: newFact.fact,
            confidence: newFact.confidence,
            metadata: {
              ...existingFact.metadata,
              replaced_lower_confidence: existingFact.value,
              source_context: newFact.source_context
            }
          }
        };
      } else {
        return {
          action: 'keep',
          fact: existingFact
        };
      }
    
    case ResolutionStrategy.MERGE:
      // Combine both facts into one
      return {
        action: 'update',
        fact: {
          id: existingFact.id,
          value: `${existingFact.value}; ${newFact.fact}`,
          confidence: Math.max(existingFact.confidence || 0, newFact.confidence),
          metadata: {
            ...existingFact.metadata,
            merged_with: newFact.fact,
            merge_confidence: newFact.confidence,
            source_context: newFact.source_context
          }
        }
      };
    
    case ResolutionStrategy.ASK_USER:
      // Defer resolution, log for user review
      return {
        action: 'defer',
        fact: {
          existing: existingFact,
          new: newFact,
          reason: 'ambiguous_conflict'
        }
      };
    
    default:
      // Unknown strategy, keep existing
      return {
        action: 'keep',
        fact: existingFact
      };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FULL CONFLICT DETECTION & RESOLUTION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect and resolve conflicts between new fact and existing facts
 * 
 * @param {Object} newFact - Newly extracted fact
 * @param {Array<Object>} existingFacts - Existing facts from memory
 * @param {Object} cache - Cache instance for embeddings
 * @param {Function} llmCall - LLM client function
 * @param {Object} options - Options
 * @returns {Promise<Object>} Resolution result { hasConflict, resolution, action }
 */
export async function detectAndResolveConflicts(newFact, existingFacts, cache, llmCall, options = {}) {
  const {
    similarityThreshold = 0.8,
    useLLM = true,
    debug = false
  } = options;
  
  // Find potentially conflicting facts
  const potentialConflicts = [];
  
  for (const existingFact of existingFacts) {
    const isRelated = await detectPotentialConflict(
      existingFact,
      newFact,
      cache,
      similarityThreshold
    );
    
    if (isRelated) {
      potentialConflicts.push(existingFact);
    }
  }
  
  if (potentialConflicts.length === 0) {
    // No conflicts, safe to add
    return {
      hasConflict: false,
      resolution: null,
      action: { action: 'add', fact: newFact }
    };
  }
  
  if (debug) {
    console.log(`[conflict-resolver] Found ${potentialConflicts.length} potential conflicts for: "${newFact.fact}"`);
  }
  
  // Analyze each conflict
  for (const existingFact of potentialConflicts) {
    let analysis;
    
    if (useLLM && llmCall) {
      // Use LLM for sophisticated conflict analysis
      analysis = await analyzeConflictWithLLM(existingFact, newFact, llmCall);
    } else {
      // Fallback: simple heuristic (keep highest confidence)
      analysis = {
        conflicts: true,
        reason: 'Similar facts detected',
        resolution: ResolutionStrategy.KEEP_HIGHEST_CONFIDENCE
      };
    }
    
    if (analysis.conflicts) {
      // Resolve the conflict
      const resolution = resolveConflict(existingFact, newFact, analysis.resolution);
      
      if (debug) {
        console.log(`[conflict-resolver] Conflict with fact ${existingFact.id}: ${analysis.reason} -> ${analysis.resolution}`);
      }
      
      return {
        hasConflict: true,
        resolution: analysis,
        action: resolution
      };
    }
  }
  
  // No actual conflicts found after analysis
  return {
    hasConflict: false,
    resolution: null,
    action: { action: 'add', fact: newFact }
  };
}

/**
 * Batch conflict detection and resolution
 * 
 * @param {Array<Object>} newFacts - Newly extracted facts
 * @param {Object} memory - Memory API instance
 * @param {string} userId - User ID
 * @param {Object} cache - Cache instance
 * @param {Function} llmCall - LLM client function
 * @param {Object} options - Options
 * @returns {Promise<Array>} Array of resolution actions
 */
export async function batchResolveConflicts(newFacts, memory, userId, cache, llmCall, options = {}) {
  const actions = [];
  
  for (const newFact of newFacts) {
    // Retrieve existing facts in same category
    const existingFacts = await memory.retrieveFacts({
      userId,
      query: newFact.fact,
      options: {
        categories: [newFact.category],
        topK: 20,
        minScore: 0.6
      }
    });
    
    // Detect and resolve conflicts
    const result = await detectAndResolveConflicts(
      newFact,
      existingFacts,
      cache,
      llmCall,
      options
    );
    
    actions.push(result.action);
  }
  
  return actions;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  ResolutionStrategy,
  detectPotentialConflict,
  analyzeConflictWithLLM,
  resolveConflict,
  detectAndResolveConflicts,
  batchResolveConflicts
};
