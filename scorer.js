/**
 * Hybrid Scorer for Smart Context
 * 
 * Combines BM25 (keyword-based) + Cosine Similarity (semantic) scoring
 * for improved retrieval precision, especially for exact keyword queries.
 */

import { tokenize } from './tokenizer.js';
import { cosineSimilarity } from './embedder.js';

/**
 * BM25 Scorer with Hybrid Support
 * 
 * Implements BM25 ranking function with configurable parameters.
 * Supports hybrid scoring by combining BM25 with cosine similarity.
 */
export class HybridScorer {
  /**
   * @param {string[]} documents - Array of document texts
   * @param {Object} weights - Scoring weights
   * @param {number} weights.bm25 - Weight for BM25 score (default 0.4)
   * @param {number} weights.cosine - Weight for cosine similarity (default 0.6)
   * @param {Object} params - BM25 parameters
   * @param {number} params.k1 - Term frequency saturation (default 1.2)
   * @param {number} params.b - Length normalization (default 0.75)
   */
  constructor(documents, weights = { bm25: 0.4, cosine: 0.6 }, params = {}) {
    this.documents = documents;
    this.weights = weights;
    this.k1 = params.k1 || 1.2;
    this.b = params.b || 0.75;
    
    // Precompute IDF scores
    this.idf = this.computeIDF();
    
    // Precompute average document length
    this.avgDocLen = this.computeAvgDocLen();
    
    // Cache tokenized documents
    this.tokenizedDocs = documents.map(doc => tokenize(doc));
  }
  
  /**
   * Compute Inverse Document Frequency (IDF) for all terms
   * 
   * IDF(term) = log((N - df(term) + 0.5) / (df(term) + 0.5) + 1)
   * where N = total documents, df = document frequency
   * 
   * @returns {Map<string, number>} - Map of term to IDF score
   */
  computeIDF() {
    const docCount = this.documents.length;
    const termDocCounts = new Map();
    
    // Count how many documents contain each term
    for (const doc of this.documents) {
      const terms = new Set(tokenize(doc));
      for (const term of terms) {
        termDocCounts.set(term, (termDocCounts.get(term) || 0) + 1);
      }
    }
    
    // Compute IDF for each term
    const idf = new Map();
    for (const [term, df] of termDocCounts) {
      // BM25 IDF formula (with +1 to ensure positivity)
      idf.set(term, Math.log((docCount - df + 0.5) / (df + 0.5) + 1));
    }
    
    return idf;
  }
  
  /**
   * Compute average document length (in tokens)
   * 
   * @returns {number} - Average document length
   */
  computeAvgDocLen() {
    const totalTokens = this.documents.reduce(
      (sum, doc) => sum + tokenize(doc).length, 
      0
    );
    return totalTokens / this.documents.length;
  }
  
  /**
   * Compute term frequency for a tokenized document
   * 
   * @param {string[]} tokens - Tokenized document
   * @returns {Map<string, number>} - Map of term to frequency
   */
  computeTermFreq(tokens) {
    const termFreq = new Map();
    for (const term of tokens) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }
    return termFreq;
  }
  
  /**
   * Compute BM25 score for a query against a document
   * 
   * BM25(q,d) = Σ IDF(term) × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × (|d| / avgdl)))
   * 
   * @param {string} query - Query text
   * @param {number} docIndex - Index of document to score
   * @returns {number} - Normalized BM25 score [0, 1]
   */
  bm25Score(query, docIndex) {
    const queryTerms = tokenize(query);
    const docTokens = this.tokenizedDocs[docIndex];
    const docLen = docTokens.length;
    
    // Compute term frequencies for this document
    const termFreq = this.computeTermFreq(docTokens);
    
    let score = 0;
    for (const term of queryTerms) {
      const tf = termFreq.get(term) || 0;
      const termIdf = this.idf.get(term) || 0;
      
      // BM25 formula
      const numerator = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen));
      
      score += termIdf * (numerator / denominator);
    }
    
    // Normalize to [0, 1] range
    // Empirically, BM25 scores rarely exceed 10 for typical documents
    return Math.min(1, score / 10);
  }
  
  /**
   * Compute hybrid score combining BM25 and cosine similarity
   * 
   * @param {string} query - Query text
   * @param {number} docIndex - Index of document to score
   * @param {number[]} queryEmbedding - Query embedding vector
   * @param {number[]} docEmbedding - Document embedding vector
   * @returns {number} - Hybrid score [0, 1]
   */
  hybridScore(query, docIndex, queryEmbedding, docEmbedding) {
    const bm25 = this.bm25Score(query, docIndex);
    const cosine = cosineSimilarity(queryEmbedding, docEmbedding);
    
    // Weighted combination
    return this.weights.bm25 * bm25 + this.weights.cosine * cosine;
  }
  
  /**
   * Score all documents against a query
   * 
   * @param {string} query - Query text
   * @param {number[]} queryEmbedding - Query embedding (optional, for hybrid)
   * @param {number[][]} docEmbeddings - Document embeddings (optional, for hybrid)
   * @returns {Array<{index: number, bm25: number, cosine?: number, hybrid?: number}>}
   */
  scoreAll(query, queryEmbedding = null, docEmbeddings = null) {
    const scores = [];
    
    for (let i = 0; i < this.documents.length; i++) {
      const result = { index: i };
      
      // Always compute BM25
      result.bm25 = this.bm25Score(query, i);
      
      // If embeddings provided, compute hybrid
      if (queryEmbedding && docEmbeddings && docEmbeddings[i]) {
        result.cosine = cosineSimilarity(queryEmbedding, docEmbeddings[i]);
        result.hybrid = this.weights.bm25 * result.bm25 + this.weights.cosine * result.cosine;
      }
      
      scores.push(result);
    }
    
    return scores;
  }
}

/**
 * Create a hybrid scorer from documents
 * 
 * @param {string[]} documents - Array of document texts
 * @param {Object} weights - Scoring weights
 * @returns {HybridScorer}
 */
export function createHybridScorer(documents, weights) {
  return new HybridScorer(documents, weights);
}

export default { HybridScorer, createHybridScorer };
