/**
 * API-Based Embedding Provider for Smart Context
 * 
 * Supports:
 * - Gemini text-embedding-004 (Google)
 * - OpenAI text-embedding-3-small
 * 
 * More reliable than local models, handles larger context windows,
 * and provides better quality embeddings.
 */

import crypto from 'crypto';

const GEMINI_EMBEDDING_MODEL = 'text-embedding-004';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

const EMBEDDING_DIMS = {
  'text-embedding-004': 768,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072
};

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
 * Fallback: Simple TF-IDF-like embedding using word hashing
 */
function embedFallback(text, dim = 768) {
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  
  const vector = new Float32Array(dim).fill(0);
  
  for (const word of words) {
    const hash = crypto.createHash('md5').update(word).digest();
    const idx1 = hash.readUInt16LE(0) % dim;
    const idx2 = hash.readUInt16LE(2) % dim;
    const idx3 = hash.readUInt16LE(4) % dim;
    
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
 * Embed text using Gemini API
 */
async function embedWithGemini(text, apiKey, model = GEMINI_EMBEDDING_MODEL) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: `models/${model}`,
          content: {
            parts: [{ text }]
          }
        })
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }
    
    const data = await response.json();
    return data.embedding.values;
  } catch (err) {
    console.error('[smart-context] Gemini embedding error:', err.message);
    return null;
  }
}

/**
 * Embed text using OpenAI API
 */
async function embedWithOpenAI(text, apiKey, model = OPENAI_EMBEDDING_MODEL) {
  try {
    const response = await fetch(
      'https://api.openai.com/v1/embeddings',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          input: text
        })
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }
    
    const data = await response.json();
    return data.data[0].embedding;
  } catch (err) {
    console.error('[smart-context] OpenAI embedding error:', err.message);
    return null;
  }
}

/**
 * Create an API-based embedder instance
 */
export function createAPIEmbedder(config = {}) {
  const provider = config.provider || 'gemini';  // gemini | openai
  const apiKey = config.apiKey;
  const model = config.model || (provider === 'gemini' ? GEMINI_EMBEDDING_MODEL : OPENAI_EMBEDDING_MODEL);
  const debug = config.debug || false;
  const maxRetries = config.maxRetries || 2;
  const retryDelayMs = config.retryDelayMs || 1000;
  
  if (!apiKey) {
    console.error('[smart-context] API embedder requires apiKey');
    throw new Error('API embedder requires apiKey in config');
  }
  
  const embeddingDim = EMBEDDING_DIMS[model] || 768;
  
  const embedFn = provider === 'gemini' 
    ? (text) => embedWithGemini(text, apiKey, model)
    : (text) => embedWithOpenAI(text, apiKey, model);
  
  /**
   * Embed with retry logic
   */
  async function embedWithRetry(text) {
    let attempt = 0;
    let lastError = null;
    
    while (attempt <= maxRetries) {
      try {
        const embedding = await embedFn(text);
        if (embedding) return embedding;
        
        lastError = new Error('Embedding returned null');
      } catch (err) {
        lastError = err;
      }
      
      attempt++;
      if (attempt <= maxRetries) {
        const delay = retryDelayMs * Math.pow(2, attempt - 1);
        if (debug) {
          console.log(`[smart-context] Retrying embedding (attempt ${attempt}/${maxRetries}) after ${delay}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    if (debug) {
      console.warn(`[smart-context] All embedding retries failed: ${lastError?.message}`);
    }
    return null;
  }
  
  return {
    /**
     * Embed single text
     */
    async embed(text) {
      if (!text || typeof text !== 'string') {
        return embedFallback('', embeddingDim);
      }
      
      // Truncate to fit model context (Gemini: 2048 tokens ~= 8000 chars)
      const maxChars = provider === 'gemini' ? 8000 : 6000;
      const truncated = text.slice(0, maxChars);
      
      const embedding = await embedWithRetry(truncated);
      
      if (embedding) {
        if (debug) console.log('[smart-context] Used API embedding');
        return embedding;
      }
      
      // Fallback to hash-based
      if (debug) console.log('[smart-context] Used fallback embedding');
      return embedFallback(truncated, embeddingDim);
    },
    
    /**
     * Batch embedding (more efficient for multiple texts)
     */
    async embedBatch(texts, { batchSize = 10 } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) {
        return [];
      }
      
      const maxChars = provider === 'gemini' ? 8000 : 6000;
      const truncated = texts.map(text => {
        if (!text || typeof text !== 'string') return '';
        return text.slice(0, maxChars);
      });
      
      // Process in batches with concurrency limit
      const batches = [];
      for (let i = 0; i < truncated.length; i += batchSize) {
        batches.push(truncated.slice(i, i + batchSize));
      }
      
      if (debug) {
        console.log(`[smart-context] Batch embedding: ${texts.length} texts in ${batches.length} batches`);
      }
      
      const results = [];
      
      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(text => this.embed(text))
        );
        results.push(...batchResults);
      }
      
      return results;
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
     * Get embedder info
     */
    info() {
      return {
        provider,
        model,
        dimension: embeddingDim,
        maxChars: provider === 'gemini' ? 8000 : 6000
      };
    }
  };
}

export default { createAPIEmbedder, cosineSimilarity };
