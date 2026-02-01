/**
 * Cross-Encoder Reranker for Smart Context - Phase 3A
 * 
 * Implements two-stage retrieval:
 * 1. Bi-encoder: Fast semantic search to get top N candidates
 * 2. Cross-encoder: Precise pairwise relevance scoring to rerank
 * 
 * Expected: 10-15% improvement in Precision@K
 * Latency: +200-500ms for 100 candidates
 * 
 * Models supported:
 * - ms-marco-MiniLM-L-6-v2 (default, best speed/accuracy)
 * - ms-marco-electra-base (more accurate, slower)
 * 
 * Uses @xenova/transformers for pure JavaScript inference (no Python deps)
 */

import { pipeline } from '@xenova/transformers';
import { createLogger } from './logger.js';
import { isEnabled, getConfig } from './config.js';

const logger = createLogger('reranker', { debug: true, trace: false });

// Singleton model instance
let rerankerPipeline = null;
let modelLoadPromise = null;
let modelLoadFailed = false;

/**
 * Cross-Encoder Reranker Class
 * 
 * Loads a cross-encoder model and provides reranking functionality.
 * Model is cached in memory as a singleton for performance.
 */
export class CrossEncoderReranker {
  constructor(modelName = null) {
    this.modelName = modelName || getConfig('crossEncoderModel') || 'cross-encoder/ms-marco-MiniLM-L-6-v2';
    this.loaded = false;
  }

  /**
   * Load the cross-encoder model (singleton pattern)
   * 
   * @returns {Promise<boolean>} Success status
   */
  async loadModel() {
    // Return existing instance if available
    if (rerankerPipeline) {
      this.loaded = true;
      return true;
    }

    // Return false immediately if previous load failed
    if (modelLoadFailed) {
      logger.warn('reranker', 'Model load previously failed, using fallback');
      return false;
    }

    // Wait for existing load promise
    if (modelLoadPromise) {
      return modelLoadPromise;
    }

    // Start new load
    modelLoadPromise = (async () => {
      try {
        const startTime = Date.now();
        logger.info('reranker', `Loading cross-encoder model: ${this.modelName}`);

        // Load text-classification pipeline for cross-encoder
        rerankerPipeline = await pipeline('text-classification', this.modelName, {
          quantized: true,  // Use quantized model for faster inference
          device: 'cpu',     // CPU inference (GPU not widely available)
        });

        const loadTime = Date.now() - startTime;
        logger.info('reranker', `Model loaded successfully in ${loadTime}ms`);

        this.loaded = true;
        return true;
      } catch (error) {
        logger.error('reranker', `Failed to load cross-encoder model: ${error.message}`);
        modelLoadFailed = true;
        return false;
      }
    })();

    return modelLoadPromise;
  }

  /**
   * Score query-document pairs using cross-encoder
   * 
   * @param {string} query - Search query
   * @param {Array<{text: string}>} candidates - Candidate messages with text field
   * @returns {Promise<Array<number>>} Relevance scores (0-1 range)
   */
  async scoreQueryDocPairs(query, candidates) {
    // Ensure model is loaded
    const loaded = await this.loadModel();
    if (!loaded) {
      logger.warn('reranker', 'Model not loaded, returning uniform scores');
      return candidates.map(() => 0.5); // Neutral scores as fallback
    }

    if (!candidates || candidates.length === 0) {
      return [];
    }

    try {
      const startTime = Date.now();

      // Build input pairs: [query, doc_text]
      const pairs = candidates.map(candidate => {
        const text = candidate.text || candidate.content || JSON.stringify(candidate);
        return `${query} [SEP] ${text}`;
      });

      logger.debug('reranker', `Scoring ${pairs.length} query-doc pairs`);

      // Run inference
      const results = await rerankerPipeline(pairs, {
        top_k: null,  // Return all scores
      });

      // Extract relevance scores
      // Cross-encoder outputs logits, we need to extract the "relevant" class score
      const scores = results.map(result => {
        // Handle different output formats
        if (Array.isArray(result)) {
          // Find the label that indicates relevance (usually 'LABEL_1' or 'positive')
          const positiveScore = result.find(r => 
            r.label === 'LABEL_1' || 
            r.label === 'positive' || 
            r.label === '1'
          );
          return positiveScore ? positiveScore.score : 0.5;
        } else if (result.score !== undefined) {
          return result.score;
        } else {
          return 0.5; // Fallback
        }
      });

      const inferenceTime = Date.now() - startTime;
      const avgLatency = inferenceTime / candidates.length;

      logger.info('reranker', 
        `Scored ${candidates.length} pairs in ${inferenceTime}ms ` +
        `(${avgLatency.toFixed(1)}ms per pair)`
      );

      return scores;
    } catch (error) {
      logger.error('reranker', `Scoring failed: ${error.message}`);
      // Return uniform scores as fallback
      return candidates.map(() => 0.5);
    }
  }

  /**
   * Rerank candidates using cross-encoder scores
   * 
   * @param {string} query - Search query
   * @param {Array<Object>} candidates - Candidate messages (must have 'score' field from bi-encoder)
   * @param {number} topK - Number of top results to return
   * @returns {Promise<Array<Object>>} Reranked and filtered candidates
   */
  async rerank(query, candidates, topK) {
    if (!candidates || candidates.length === 0) {
      return [];
    }

    // Skip reranking if disabled or candidates <= topK
    if (!isEnabled('crossEncoderRerank')) {
      logger.debug('reranker', 'Cross-encoder disabled, skipping reranking');
      return candidates.slice(0, topK);
    }

    if (candidates.length <= topK) {
      logger.debug('reranker', `Only ${candidates.length} candidates, skipping reranking`);
      return candidates;
    }

    try {
      const startTime = Date.now();

      // Get cross-encoder scores
      const rerankerScores = await this.scoreQueryDocPairs(query, candidates);

      // Combine bi-encoder and cross-encoder scores
      const rerankedCandidates = candidates.map((candidate, idx) => ({
        ...candidate,
        biEncoderScore: candidate.score,  // Preserve original score
        rerankerScore: rerankerScores[idx],
        // Weighted combination: favor cross-encoder (0.7) over bi-encoder (0.3)
        finalScore: (rerankerScores[idx] * 0.7) + (candidate.score * 0.3),
      }));

      // Sort by final score and take top K
      rerankedCandidates.sort((a, b) => b.finalScore - a.finalScore);
      const topResults = rerankedCandidates.slice(0, topK);

      const totalTime = Date.now() - startTime;

      logger.info('reranker',
        `Reranked ${candidates.length} → ${topK} candidates in ${totalTime}ms`
      );

      // Log score distribution for debugging
      if (logger.isDebugEnabled()) {
        const avgRerankerScore = rerankerScores.reduce((a, b) => a + b, 0) / rerankerScores.length;
        const minRerankerScore = Math.min(...rerankerScores);
        const maxRerankerScore = Math.max(...rerankerScores);

        logger.debug('reranker',
          `Score distribution - avg: ${avgRerankerScore.toFixed(3)}, ` +
          `min: ${minRerankerScore.toFixed(3)}, max: ${maxRerankerScore.toFixed(3)}`
        );
      }

      return topResults;
    } catch (error) {
      logger.error('reranker', `Reranking failed: ${error.message}, falling back to bi-encoder`);
      // Graceful degradation: return original bi-encoder ranking
      return candidates.slice(0, topK);
    }
  }

  /**
   * Batch rerank multiple queries (for benchmarking)
   * 
   * @param {Array<{query: string, candidates: Array}>} batches
   * @param {number} topK
   * @returns {Promise<Array<Array>>} Reranked results for each query
   */
  async batchRerank(batches, topK) {
    const results = [];
    for (const batch of batches) {
      const reranked = await this.rerank(batch.query, batch.candidates, topK);
      results.push(reranked);
    }
    return results;
  }

  /**
   * Get reranker statistics
   * 
   * @returns {Object} Model info and status
   */
  getStats() {
    return {
      enabled: isEnabled('crossEncoderRerank'),
      loaded: this.loaded,
      modelName: this.modelName,
      failed: modelLoadFailed,
    };
  }

  /**
   * Unload model from memory (for testing/cleanup)
   */
  unload() {
    rerankerPipeline = null;
    modelLoadPromise = null;
    this.loaded = false;
    logger.info('reranker', 'Model unloaded');
  }
}

/**
 * Create or get singleton reranker instance
 * 
 * @returns {CrossEncoderReranker}
 */
let singletonReranker = null;

export function getReranker() {
  if (!singletonReranker) {
    singletonReranker = new CrossEncoderReranker();
  }
  return singletonReranker;
}

/**
 * Convenience function for one-off reranking
 * 
 * @param {string} query
 * @param {Array} candidates
 * @param {number} topK
 * @returns {Promise<Array>}
 */
export async function rerank(query, candidates, topK) {
  const reranker = getReranker();
  return reranker.rerank(query, candidates, topK);
}

export default { CrossEncoderReranker, getReranker, rerank };
