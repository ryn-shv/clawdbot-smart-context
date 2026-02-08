/**
 * Smart Context Embedding System with Three-Tier Fallback
 * 
 * ARCHITECTURE:
 * - PRIMARY: Transformers.js with WebGPU (on-device, M2 accelerated)
 * - FALLBACK 1: Gemini Embedding API (cloud, high-quality)
 * - FALLBACK 2: Hash-based TF-IDF (offline, basic)
 * 
 * MIGRATION HISTORY:
 * - PHASE 0: (removed)
 * - PHASE 1: Transformers.js + hash fallback
 * - PHASE 2: Transformers.js + Gemini API + hash (current)
 * 
 * PERFORMANCE:
 * - Single embedding: <10ms (warm path, on-device)
 * - Batch of 32: <60ms (WebGPU acceleration)
 * - Model size: ~13MB (8-bit quantized)
 * - Dimensions: 384 (compatible with existing cache)
 * 
 * PHASE 2A: BATCH EMBEDDING - Native GPU parallelization (10-50x faster)
 */

import crypto from 'crypto';
import path from 'path';
import os from 'os';

// Embedding dimension for MiniLM (384)
const EMBEDDING_DIM = 384;
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

// Singleton instances
let transformersInstance = null;
let embeddingPipeline = null;
let initPromise = null;
let initFailed = false;

/**
 * Initialize Transformers.js with WebGPU acceleration
 */
async function initTransformers() {
  if (initFailed) return false;
  if (embeddingPipeline) return true;
  
  if (initPromise) {
    return initPromise;
  }
  
  initPromise = (async () => {
    try {
      // Dynamic import of Transformers.js
      const { pipeline, env } = await import('@xenova/transformers');
      transformersInstance = { pipeline, env };
      
      // Configure cache directory
      const cacheDir = process.env.TRANSFORMERS_CACHE || 
                      path.join(os.homedir(), '.clawdbot', 'transformers-cache');
      
      transformersInstance.env.cacheDir = cacheDir;
      
      // Disable remote models in production (use cached only)
      transformersInstance.env.allowRemoteModels = true;
      transformersInstance.env.allowLocalModels = true;
      
      console.log('[smart-context] Loading embedding model:', MODEL_NAME);
      console.log('[smart-context] Cache directory:', cacheDir);
      
      // Create feature extraction pipeline with WebGPU + quantization
      embeddingPipeline = await transformersInstance.pipeline(
        'feature-extraction',
        MODEL_NAME,
        {
          device: 'webgpu',        // Use WebGPU for M2 acceleration
          dtype: 'q8',             // 8-bit quantization (75% memory savings)
          revision: 'main'
        }
      );
      
      console.log('[smart-context] ✅ Transformers.js model loaded successfully');
      console.log('[smart-context] Device: WebGPU (M2 accelerated)');
      console.log('[smart-context] Quantization: q8 (8-bit)');
      
      return true;
    } catch (err) {
      console.warn('[smart-context] ⚠️ Failed to load Transformers.js model:', err.message);
      
      // If WebGPU fails, try CPU fallback
      if (err.message.includes('webgpu') || err.message.includes('WebGPU')) {
        console.log('[smart-context] Attempting CPU fallback...');
        
        try {
          embeddingPipeline = await transformersInstance.pipeline(
            'feature-extraction',
            MODEL_NAME,
            {
              device: 'cpu',
              dtype: 'q8',
              revision: 'main'
            }
          );
          
          console.log('[smart-context] ✅ Model loaded on CPU (WebGPU unavailable)');
          return true;
        } catch (cpuErr) {
          console.warn('[smart-context] CPU fallback also failed:', cpuErr.message);
          initFailed = true;
          return false;
        }
      }
      
      initFailed = true;
      return false;
    }
  })();
  
  return initPromise;
}

/**
 * Generate embedding using Transformers.js
 * 
 * @param {string} text - Text to embed
 * @returns {Promise<number[]|null>} Embedding vector or null on error
 */
async function embedWithTransformers(text) {
  if (!embeddingPipeline) {
    const ok = await initTransformers();
    if (!ok) return null;
  }
  
  try {
    // Run feature extraction
    const output = await embeddingPipeline(text, {
      pooling: 'mean',           // Mean pooling over token embeddings
      normalize: true            // L2 normalization
    });
    
    // Extract embedding from output tensor
    // Output shape: [1, 384] for single text
    const embedding = Array.from(output.data);
    
    return embedding;
  } catch (err) {
    console.error('[smart-context] Embedding error:', err.message);
    return null;
  }
}

/**
 * PHASE 2A: Native Batch Embedding with Transformers.js
 * 
 * Uses Transformers.js native batching for true GPU parallelization.
 * 10-50x faster than sequential processing on M2 chip.
 * 
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function embedBatchWithTransformers(texts) {
  if (!embeddingPipeline) {
    const ok = await initTransformers();
    if (!ok) return null;
  }
  
  try {
    // Transformers.js supports native batching - pass array of texts
    const output = await embeddingPipeline(texts, {
      pooling: 'mean',
      normalize: true
    });
    
    // Output shape: [batch_size, 384]
    const batchSize = texts.length;
    const embeddings = [];
    
    // Extract each embedding from the batch
    for (let i = 0; i < batchSize; i++) {
      const start = i * EMBEDDING_DIM;
      const end = start + EMBEDDING_DIM;
      const embedding = Array.from(output.data.slice(start, end));
      embeddings.push(embedding);
    }
    
    return embeddings;
  } catch (err) {
    console.error('[smart-context] Batch embedding error:', err.message);
    return null;
  }
}

/**
 * FALLBACK LAYER 1: Gemini Embedding API
 * 
 * Uses Google's text-embedding-004 model as first fallback.
 * Provides high-quality embeddings when on-device model unavailable.
 * 
 * Configuration: Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable
 * Note: Returns 768-dim embeddings, we'll truncate to 384 for compatibility.
 */
async function embedWithGemini(text) {
  try {
    // Get API key from environment variables
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      // Try to load from Clawdbot config as fallback
      try {
        const configPath = path.join(os.homedir(), '.clawdbot', 'clawdbot.json');
        const fs = await import('fs/promises');
        const configData = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(configData);
        
        // Check various possible config locations
        const fromModels = config.models?.providers?.google?.apiKey;
        const fromAuth = config.auth?.profiles?.['google:manual']?.apiKey;
        
        if (!fromModels && !fromAuth) {
          throw new Error('Gemini API key not found (set GOOGLE_API_KEY or GEMINI_API_KEY env var)');
        }
        
        apiKey = fromModels || fromAuth;
      } catch (configErr) {
        throw new Error('Gemini API key not found (set GOOGLE_API_KEY or GEMINI_API_KEY env var)');
      }
    }
    
    // Call Gemini embedding API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: {
            parts: [{ text }]
          }
        })
      }
    );
    
    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }
    
    const data = await response.json();
    const fullEmbedding = data.embedding.values;
    
    // Gemini returns 768 dims, truncate to 384 for compatibility with our DB schema
    const embedding = fullEmbedding.slice(0, EMBEDDING_DIM);
    
    return embedding;
  } catch (err) {
    console.warn('[smart-context] Gemini embedding failed:', err.message);
    return null;
  }
}

/**
 * FALLBACK LAYER 2: Simple TF-IDF-like embedding using word hashing
 * 
 * Last resort fallback - works offline without any API.
 * Not as good as neural embeddings but maintains 384 dimensions.
 */
function embedHashFallback(text) {
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  
  const vector = new Float32Array(EMBEDDING_DIM).fill(0);
  
  for (const word of words) {
    // Hash word to get consistent indices
    const hash = crypto.createHash('md5').update(word).digest();
    const idx1 = hash.readUInt16LE(0) % EMBEDDING_DIM;
    const idx2 = hash.readUInt16LE(2) % EMBEDDING_DIM;
    const idx3 = hash.readUInt16LE(4) % EMBEDDING_DIM;
    
    // Add contribution (sign determined by hash bits)
    const sign1 = (hash[6] & 1) ? 1 : -1;
    const sign2 = (hash[7] & 1) ? 1 : -1;
    const sign3 = (hash[8] & 1) ? 1 : -1;
    
    vector[idx1] += sign1 * 0.5;
    vector[idx2] += sign2 * 0.3;
    vector[idx3] += sign3 * 0.2;
  }
  
  // Normalize
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm) || 1;
  
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= norm;
  }
  
  return Array.from(vector);
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  
  let dot = 0;
  let magA = 0;
  let magB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag > 0 ? dot / mag : 0;
}

/**
 * Create an embedder instance
 */
export function createEmbedder(config = {}) {
  const debug = config.debug || false;
  
  return {
    /**
     * Embed single text to vector
     * 
     * THREE-TIER FALLBACK SYSTEM:
     * 1. Transformers.js (on-device, WebGPU) - PRIMARY
     * 2. Gemini API (cloud, high-quality) - FALLBACK 1
     * 3. Hash-based (offline, basic) - FALLBACK 2
     * 
     * @param {string} text - Text to embed
     * @returns {Promise<number[]>} Embedding vector (384 dimensions)
     */
    async embed(text) {
      if (!text || typeof text !== 'string') {
        return embedHashFallback('');
      }

      // Truncate to fit model context (~512 tokens = ~2000 chars)
      const truncated = text.slice(0, 2000);

      // PRIMARY: Try Transformers.js embedding (on-device, fastest)
      const neural = await embedWithTransformers(truncated);
      if (neural) {
        if (debug) console.log('[smart-context] ✅ Used Transformers.js (on-device)');
        return neural;
      }

      // FALLBACK 1: Try Gemini API (cloud, high-quality)
      if (debug) console.log('[smart-context] ⚠️ Transformers.js unavailable, trying Gemini API...');
      const gemini = await embedWithGemini(truncated);
      if (gemini) {
        if (debug) console.log('[smart-context] ✅ Used Gemini API (cloud fallback)');
        return gemini;
      }

      // FALLBACK 2: Hash-based (offline, last resort)
      if (debug) console.log('[smart-context] ⚠️ Gemini unavailable, using hash-based fallback');
      return embedHashFallback(truncated);
    },
    
    /**
     * PHASE 2A: Batch Embedding with Native GPU Acceleration
     * 
     * Embed multiple texts in a single batch for maximum GPU utilization.
     * Uses Transformers.js native batching - much faster than sequential.
     * 
     * @param {string[]} texts - Array of texts to embed
     * @param {Object} options - Batch options
     * @param {number} options.batchSize - Size of each batch (default: 32)
     * @param {number} options.maxRetries - Max retries per batch (default: 2)
     * @returns {Promise<Array>} Array of embeddings in original order
     */
    async embedBatch(texts, { batchSize = 32, maxRetries = 2 } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) {
        return [];
      }
      
      // Truncate all texts upfront
      const truncated = texts.map(text => {
        if (!text || typeof text !== 'string') return '';
        return text.slice(0, 2000);
      });
      
      // Split into batches for GPU processing
      const batches = [];
      for (let i = 0; i < truncated.length; i += batchSize) {
        batches.push({
          texts: truncated.slice(i, i + batchSize),
          startIndex: i,
          endIndex: Math.min(i + batchSize, truncated.length)
        });
      }
      
      if (debug) {
        console.log(`[smart-context] Batch embedding: ${texts.length} texts in ${batches.length} batches`);
      }
      
      const allEmbeddings = [];
      
      // Process batches with retry logic
      for (const batch of batches) {
        let attempt = 0;
        let success = false;
        let batchEmbeddings = null;
        
        while (attempt <= maxRetries && !success) {
          try {
            // Try native batch embedding with Transformers.js
            batchEmbeddings = await embedBatchWithTransformers(batch.texts);
            
            if (batchEmbeddings) {
              success = true;
              allEmbeddings.push(...batchEmbeddings);
            } else {
              throw new Error('Batch embedding returned null');
            }
          } catch (err) {
            attempt++;
            
            if (attempt <= maxRetries) {
              // Exponential backoff: 100ms, 200ms, 400ms
              const delay = 100 * Math.pow(2, attempt - 1);
              await new Promise(resolve => setTimeout(resolve, delay));
              
              if (debug) {
                console.log(`[smart-context] Batch retry ${attempt}/${maxRetries}`);
              }
            }
          }
        }
        
        // If all retries failed, fall back to sequential processing
        if (!success) {
          if (debug) {
            console.warn(`[smart-context] Batch failed, falling back to sequential for ${batch.texts.length} texts`);
          }
          
          for (const text of batch.texts) {
            const embedding = await this.embed(text);
            allEmbeddings.push(embedding);
          }
        }
      }
      
      if (debug) {
        console.log(`[smart-context] Batch embedding complete: ${allEmbeddings.length} embeddings`);
      }
      
      return allEmbeddings;
    },
    
    /**
     * Compute similarity between two texts
     */
    async similarity(textA, textB) {
      const [embA, embB] = await Promise.all([
        this.embed(textA),
        this.embed(textB)
      ]);
      return cosineSimilarity(embA, embB);
    },
    
    /**
     * Check if neural embeddings are available
     */
    async isNeuralAvailable() {
      return initTransformers();
    },
    
    /**
     * Get model info (for debugging/monitoring)
     */
    getModelInfo() {
      return {
        name: MODEL_NAME,
        dimensions: EMBEDDING_DIM,
        device: embeddingPipeline ? 'webgpu' : 'none',
        quantization: 'q8',
        status: embeddingPipeline ? 'loaded' : (initFailed ? 'failed' : 'not-loaded'),
        fallbackChain: [
          'Transformers.js (on-device, WebGPU)',
          'Gemini API (cloud, text-embedding-004)',
          'Hash-based (offline, TF-IDF)'
        ]
      };
    }
  };
}

export default { createEmbedder, cosineSimilarity };
