/**
 * Tokenizer for BM25 Hybrid Scoring
 * 
 * Simple but effective tokenization for keyword-based matching.
 * Used in conjunction with semantic similarity for hybrid scoring.
 */

/**
 * Tokenize text for BM25 scoring
 * 
 * Converts text to lowercase, removes punctuation, and splits on whitespace.
 * Filters out very short tokens (< 2 chars) to reduce noise.
 * 
 * @param {string} text - Text to tokenize
 * @returns {string[]} - Array of tokens
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  return text
    .toLowerCase()
    // Replace punctuation and special chars with spaces
    .replace(/[^\w\s]/g, ' ')
    // Split on whitespace
    .split(/\s+/)
    // Filter short tokens and empty strings
    .filter(token => token.length >= 2);
}

/**
 * Extract unique tokens from text
 * 
 * @param {string} text - Text to tokenize
 * @returns {Set<string>} - Set of unique tokens
 */
export function uniqueTokens(text) {
  return new Set(tokenize(text));
}

/**
 * Compute term frequency for a document
 * 
 * @param {string} text - Document text
 * @returns {Map<string, number>} - Map of token to frequency
 */
export function termFrequency(text) {
  const tokens = tokenize(text);
  const freq = new Map();
  
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }
  
  return freq;
}

/**
 * Tokenize and return both tokens and unique count
 * 
 * @param {string} text - Text to tokenize
 * @returns {{ tokens: string[], unique: number, length: number }}
 */
export function tokenizeWithStats(text) {
  const tokens = tokenize(text);
  const unique = new Set(tokens);
  
  return {
    tokens,
    unique: unique.size,
    length: tokens.length
  };
}

export default { tokenize, uniqueTokens, termFrequency, tokenizeWithStats };
