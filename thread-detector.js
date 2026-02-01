/**
 * Thread Detector for Smart Context - Phase 2
 * 
 * Detects conversation threads based on topic similarity.
 * Groups related messages into threads for better context coherence.
 * 
 * FEATURES:
 * - Topic similarity detection (cosine similarity of embeddings)
 * - Thread topic tracking (exponential moving average)
 * - Thread gap detection (max messages between related topics)
 * - Thread resumption (return to earlier threads)
 * 
 * @module thread-detector
 */

import { cosineSimilarity } from './embedder.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('thread-detector', { debug: false });

/**
 * Extract text content from message
 */
function extractMessageText(msg) {
  if (!msg) return '';
  
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(block => block && typeof block === 'object')
      .map(block => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (block.type === 'toolResult' || block.type === 'tool_result') {
          const result = block.content || block.result || '';
          const summary = typeof result === 'string' 
            ? result.slice(0, 300) 
            : JSON.stringify(result).slice(0, 300);
          return `[Tool: ${summary}...]`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  
  return '';
}

/**
 * Thread Detector Class
 */
export class ThreadDetector {
  constructor(config = {}) {
    this.similarityThreshold = config.topicSimilarityThreshold || 
                               getConfig('threadSimilarityThreshold') || 
                               0.7;
    this.maxThreadGap = config.maxThreadGap || 
                        getConfig('threadMaxGap') || 
                        5;
    this.debug = config.debug || false;
  }
  
  /**
   * Detect threads in message history
   * 
   * @param {Array} messages - Message array
   * @param {Object} embedder - Embedder instance
   * @returns {Promise<Array>} Array of threads
   */
  async detectThreads(messages, embedder) {
    if (!messages || messages.length === 0) {
      return [];
    }
    
    if (!embedder) {
      console.error('[thread-detector] No embedder provided');
      return this._fallbackSingleThread(messages);
    }
    
    const op = logger.startOp('detectThreads', { messageCount: messages.length });
    
    try {
      const threads = [];
      let currentThread = null;
      let gapCounter = 0;
      
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const msgText = extractMessageText(msg);
        
        // Skip empty messages
        if (!msgText || msgText.length < 10) {
          if (currentThread) {
            gapCounter++;
            // If gap is too large, close current thread
            if (gapCounter > this.maxThreadGap) {
              threads.push(currentThread);
              currentThread = null;
              gapCounter = 0;
            }
          }
          continue;
        }
        
        // Generate embedding for this message
        let msgEmbedding;
        try {
          msgEmbedding = await embedder.embed(msgText);
        } catch (err) {
          console.error('[thread-detector] Embedding error:', err.message);
          // Skip this message
          continue;
        }
        
        // First message or no current thread
        if (!currentThread) {
          currentThread = this.createThread(threads.length, i, msg, msgEmbedding);
          gapCounter = 0;
          continue;
        }
        
        // Calculate similarity to current thread topic
        const similarity = cosineSimilarity(msgEmbedding, currentThread.topicEmbedding);
        
        if (this.debug) {
          console.log(`[thread-detector] Msg ${i}: similarity=${similarity.toFixed(3)}`);
        }
        
        if (similarity >= this.similarityThreshold) {
          // Continue current thread
          this.addToThread(currentThread, i, msg, msgEmbedding);
          gapCounter = 0;
        } else {
          // Check if this message matches an older thread
          const matchingOldThread = this.findMatchingOldThread(
            threads, 
            msgEmbedding, 
            i, 
            this.similarityThreshold
          );
          
          if (matchingOldThread) {
            // Resume old thread
            if (this.debug) {
              console.log(`[thread-detector] Msg ${i}: resuming thread ${matchingOldThread.id}`);
            }
            
            // Close current thread
            threads.push(currentThread);
            
            // Resume old thread (mark it as resumed)
            matchingOldThread.resumed = true;
            this.addToThread(matchingOldThread, i, msg, msgEmbedding);
            currentThread = matchingOldThread;
            gapCounter = 0;
          } else {
            // Start new thread
            if (this.debug) {
              console.log(`[thread-detector] Msg ${i}: starting new thread`);
            }
            
            threads.push(currentThread);
            currentThread = this.createThread(threads.length, i, msg, msgEmbedding);
            gapCounter = 0;
          }
        }
      }
      
      // Don't forget the last thread
      if (currentThread) {
        threads.push(currentThread);
      }
      
      // Post-processing: merge threads if needed
      const merged = this.mergeSmallThreads(threads);
      
      op.end({ 
        threadCount: merged.length,
        avgThreadSize: merged.length > 0 
          ? Math.round(merged.reduce((sum, t) => sum + t.messages.length, 0) / merged.length)
          : 0
      });
      
      if (this.debug) {
        console.log(`[thread-detector] Detected ${merged.length} threads`);
        for (const thread of merged) {
          console.log(`  Thread ${thread.id}: ${thread.messages.length} messages (indices ${thread.messages[0].index}-${thread.messages[thread.messages.length - 1].index})`);
        }
      }
      
      return merged;
      
    } catch (err) {
      console.error('[thread-detector] Thread detection failed:', err.message);
      op.end({ error: err.message });
      // Fallback to single thread
      return this._fallbackSingleThread(messages);
    }
  }
  
  /**
   * Create a new thread
   */
  createThread(id, index, msg, embedding) {
    return {
      id,
      messages: [{ index, msg, embedding }],
      topicEmbedding: [...embedding],  // Copy embedding
      startIndex: index,
      endIndex: index,
      resumed: false
    };
  }
  
  /**
   * Add message to thread
   */
  addToThread(thread, index, msg, embedding) {
    thread.messages.push({ index, msg, embedding });
    thread.endIndex = index;
    
    // Update topic embedding using exponential moving average
    // Newer messages have more influence
    const alpha = 2 / (thread.messages.length + 1);
    
    for (let i = 0; i < thread.topicEmbedding.length; i++) {
      thread.topicEmbedding[i] = (1 - alpha) * thread.topicEmbedding[i] + alpha * embedding[i];
    }
    
    // Normalize (keep unit vector)
    let norm = 0;
    for (let i = 0; i < thread.topicEmbedding.length; i++) {
      norm += thread.topicEmbedding[i] * thread.topicEmbedding[i];
    }
    norm = Math.sqrt(norm) || 1;
    
    for (let i = 0; i < thread.topicEmbedding.length; i++) {
      thread.topicEmbedding[i] /= norm;
    }
  }
  
  /**
   * Find matching thread from previous threads
   */
  findMatchingOldThread(threads, msgEmbedding, currentIndex, threshold) {
    // Look at recent threads (last 3) to see if we're resuming
    const recentThreads = threads.slice(-3);
    
    let bestMatch = null;
    let bestScore = threshold;
    
    for (const thread of recentThreads) {
      // Don't resume threads that are too recent (within last 2 messages)
      if (currentIndex - thread.endIndex < 3) continue;
      
      const similarity = cosineSimilarity(msgEmbedding, thread.topicEmbedding);
      
      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatch = thread;
      }
    }
    
    return bestMatch;
  }
  
  /**
   * Merge threads that are too small (< 2 messages)
   */
  mergeSmallThreads(threads) {
    if (threads.length === 0) return [];
    
    const merged = [threads[0]];
    
    for (let i = 1; i < threads.length; i++) {
      const thread = threads[i];
      const lastThread = merged[merged.length - 1];
      
      // Merge if thread is too small and close to previous
      if (thread.messages.length < 2 && 
          (thread.startIndex - lastThread.endIndex) < 5) {
        
        // Merge into last thread
        for (const msgData of thread.messages) {
          this.addToThread(lastThread, msgData.index, msgData.msg, msgData.embedding);
        }
      } else {
        merged.push(thread);
      }
    }
    
    return merged;
  }
  
  /**
   * Fallback: treat all messages as single thread
   */
  _fallbackSingleThread(messages) {
    return [{
      id: 0,
      messages: messages.map((msg, index) => ({
        index,
        msg,
        embedding: null
      })),
      topicEmbedding: null,
      startIndex: 0,
      endIndex: messages.length - 1,
      fallback: true
    }];
  }
  
  /**
   * Score threads by relevance to a query
   * 
   * @param {Array} threads - Threads from detectThreads()
   * @param {Array} queryEmbedding - Query embedding
   * @returns {Array} Threads sorted by relevance
   */
  scoreThreads(threads, queryEmbedding) {
    if (!queryEmbedding) return threads;
    
    return threads.map(thread => {
      // Score thread by similarity of its topic embedding to query
      const score = thread.topicEmbedding 
        ? cosineSimilarity(queryEmbedding, thread.topicEmbedding)
        : 0;
      
      return { ...thread, score };
    }).sort((a, b) => b.score - a.score);
  }
  
  /**
   * Expand selected messages to include thread context
   * 
   * Given a set of selected message indices, expand to include
   * surrounding context from the same thread.
   * 
   * @param {Array<number>} selectedIndices - Indices of selected messages
   * @param {Array} threads - Threads from detectThreads()
   * @param {Object} options - Expansion options
   * @returns {Array<number>} Expanded indices
   */
  expandWithThreadContext(selectedIndices, threads, options = {}) {
    const windowBefore = options.windowBefore || 2;
    const windowAfter = options.windowAfter || 1;
    
    const selectedSet = new Set(selectedIndices);
    const expandedSet = new Set(selectedIndices);
    
    for (const index of selectedIndices) {
      // Find which thread this message belongs to
      const thread = threads.find(t => 
        t.messages.some(m => m.index === index)
      );
      
      if (!thread) continue;
      
      // Find position in thread
      const posInThread = thread.messages.findIndex(m => m.index === index);
      if (posInThread === -1) continue;
      
      // Add surrounding messages from same thread
      const start = Math.max(0, posInThread - windowBefore);
      const end = Math.min(thread.messages.length - 1, posInThread + windowAfter);
      
      for (let i = start; i <= end; i++) {
        expandedSet.add(thread.messages[i].index);
      }
    }
    
    // Return sorted array
    return Array.from(expandedSet).sort((a, b) => a - b);
  }
}

/**
 * Create thread detector instance
 */
export function createThreadDetector(config = {}) {
  return new ThreadDetector(config);
}

export default { ThreadDetector, createThreadDetector };
