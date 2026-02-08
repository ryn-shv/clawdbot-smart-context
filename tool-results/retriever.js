/**
 * Tool Result Retriever - Enhanced with Phase 2 Semantic Search
 * 
 * Handles explicit retrieval of stored tool results by the LLM.
 * Supports multiple modes: full, search, lines, around.
 * 
 * PHASE 2 ENHANCEMENTS:
 * - Semantic search over chunks using embeddings
 * - Hybrid keyword + semantic search
 * - Cross-result search capabilities
 * 
 * v2.1.0: Unified memory search across facts + summaries
 * 
 * @module tool-results/retriever
 */

import { estimateTokens } from './store.js';
import { isEnabled, getConfig } from '../config.js';

/**
 * Cosine similarity between two vectors
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
  
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag > 0 ? dot / mag : 0;
}

/**
 * Create retriever instance
 */
export function createRetriever(config = {}) {
  // Store and embedder references will be injected
  let store = config.store || null;
  let embedder = config.embedder || null;
  const debug = config.debug || false;
  
  return {
    // Allow injecting dependencies after creation
    set store(s) { store = s; },
    set embedder(e) { embedder = e; },
    
    /**
     * Retrieve tool result content
     */
    async retrieve(input) {
      const {
        result_id,
        mode = 'full',
        query,
        line,
        start_line,
        end_line,
        context_lines = 10,
        max_tokens = 4000
      } = input;
      
      if (!store) {
        return { error: true, message: 'Tool result store not initialized' };
      }
      
      // Fetch stored result
      const stored = await store.getResult(result_id);
      if (!stored) {
        return {
          error: true,
          message: `Result "${result_id}" not found. It may have expired or the ID is incorrect.`,
          hint: 'Result IDs look like "tr_XXXXXXXX". Check the original tool result message.'
        };
      }
      
      const { fullResult, toolName, tokenCount, createdAt } = stored;
      const lines = fullResult.split('\n');
      
      // Build metadata header
      const metadata = {
        result_id,
        tool_name: toolName,
        total_lines: lines.length,
        total_tokens: tokenCount,
        created_at: new Date(createdAt).toISOString(),
        mode
      };
      
      let content;
      
      switch (mode) {
        case 'full':
          content = retrieveFull(fullResult, max_tokens);
          metadata.truncated = content.length < fullResult.length;
          break;
          
        case 'search':
          if (!query) {
            return { error: true, message: 'Parameter "query" is required for search mode' };
          }
          const searchResult = retrieveSearch(lines, query, context_lines, max_tokens);
          content = searchResult.text;
          metadata.query = query;
          metadata.match_count = searchResult.matchCount;
          metadata.matches = searchResult.matches;
          break;
          
        case 'lines':
          if (start_line === undefined || end_line === undefined) {
            return { 
              error: true, 
              message: 'Parameters "start_line" and "end_line" are required for lines mode' 
            };
          }
          if (start_line < 1 || end_line < start_line || start_line > lines.length) {
            return {
              error: true,
              message: `Invalid line range. File has ${lines.length} lines.`
            };
          }
          content = retrieveLines(lines, start_line, Math.min(end_line, lines.length), max_tokens);
          metadata.range = `${start_line}-${Math.min(end_line, lines.length)}`;
          break;
          
        case 'around':
          if (line === undefined) {
            return { error: true, message: 'Parameter "line" is required for around mode' };
          }
          if (line < 1 || line > lines.length) {
            return {
              error: true,
              message: `Line ${line} out of range. File has ${lines.length} lines.`
            };
          }
          const startAround = Math.max(1, line - context_lines);
          const endAround = Math.min(lines.length, line + context_lines);
          content = retrieveLines(lines, startAround, endAround, max_tokens);
          metadata.center_line = line;
          metadata.range = `${startAround}-${endAround}`;
          break;
          
        default:
          return { 
            error: true, 
            message: `Unknown mode: ${mode}. Valid modes: full, search, lines, around` 
          };
      }
      
      return { metadata, content };
    },
    
    /**
     * PHASE 2: Search across all tool results semantically
     * 
     * @param {Object} params - Search parameters
     * @param {string} params.query - Natural language query
     * @param {string} [params.toolFilter] - Filter by tool name
     * @param {string} [params.sessionFilter] - Filter by session ID
     * @param {number} [params.topK=5] - Number of chunks to return
     * @param {number} [params.minScore=0.7] - Minimum similarity score
     * @returns {Promise<Array>} Relevant chunks with metadata
     */
    async searchResults(params) {
      const {
        query,
        toolFilter,
        sessionFilter,
        topK = 5,
        minScore = 0.7
      } = params;
      
      if (!isEnabled('toolResultIndex')) {
        if (debug) console.log('[tool-results] Tool indexing disabled');
        return [];
      }
      
      if (!store) {
        console.error('[tool-results] Store not initialized');
        return [];
      }
      
      if (!embedder) {
        console.error('[tool-results] Embedder not available');
        return [];
      }
      
      try {
        // Generate query embedding
        const queryEmbedding = await embedder.embed(query);
        
        // Get all chunks with embeddings
        const allChunks = await store._getAllChunksWithEmbeddings();
        
        if (allChunks.length === 0) {
          if (debug) console.log('[tool-results] No indexed chunks available');
          return [];
        }
        
        if (debug) {
          console.log(`[tool-results] Searching ${allChunks.length} chunks for: "${query}"`);
        }
        
        // Apply filters if needed
        let filteredChunks = allChunks;
        
        if (toolFilter || sessionFilter) {
          const resultIds = new Set(allChunks.map(c => c.resultId));
          const resultMetadata = new Map();
          
          for (const resultId of resultIds) {
            const result = await store.getResult(resultId);
            if (result) {
              resultMetadata.set(resultId, {
                toolName: result.toolName,
                sessionId: result.sessionId
              });
            }
          }
          
          filteredChunks = allChunks.filter(chunk => {
            const meta = resultMetadata.get(chunk.resultId);
            if (!meta) return false;
            
            if (toolFilter && meta.toolName !== toolFilter) return false;
            if (sessionFilter && meta.sessionId !== sessionFilter) return false;
            
            return true;
          });
          
          if (debug) {
            console.log(`[tool-results] After filtering: ${filteredChunks.length} chunks`);
          }
        }
        
        // Score all chunks by similarity
        const scored = filteredChunks.map(chunk => {
          const score = cosineSimilarity(queryEmbedding, chunk.embedding);
          return { ...chunk, score };
        });
        
        // Filter by minimum score and sort
        const relevant = scored
          .filter(c => c.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        
        if (debug) {
          console.log(`[tool-results] Found ${relevant.length} relevant chunks (score >= ${minScore})`);
        }
        
        // Fetch result metadata for each chunk
        const enriched = await Promise.all(
          relevant.map(async chunk => {
            const result = await store.getResult(chunk.resultId);
            return {
              chunkId: chunk.chunkId,
              resultId: chunk.resultId,
              chunkIdx: chunk.chunkIdx,
              chunkText: chunk.chunkText,
              tokenCount: chunk.tokenCount,
              score: chunk.score,
              startOffset: chunk.startOffset,
              endOffset: chunk.endOffset,
              // Result metadata
              toolName: result?.toolName,
              sessionId: result?.sessionId,
              createdAt: result?.createdAt
            };
          })
        );
        
        return enriched;
        
      } catch (err) {
        console.error('[tool-results] Search error:', err.message);
        if (debug) console.error(err.stack);
        return [];
      }
    },
    
    /**
     * v2.1.0: Unified memory search across facts AND summaries
     * 
     * Searches both memory_facts and memory_summaries tables,
     * returns combined results with source tagging.
     * 
     * @param {Object} params - Search parameters
     * @param {string} params.query - Natural language query
     * @param {string} params.userId - User ID
     * @param {Object} memoryAPI - Memory API instance
     * @param {Object} [params.options] - Search options
     * @param {number} [params.options.topK=10] - Max results total
     * @param {number} [params.options.factTopK=7] - Max fact results
     * @param {number} [params.options.summaryTopK=5] - Max summary results
     * @param {number} [params.options.minScore=0.3] - Min relevance score
     * @param {string[]} [params.options.projects] - Filter by project slugs
     * @returns {Promise<Array>} Combined, ranked results with source tags
     */
    async searchMemory(params) {
      const { query, userId, options = {} } = params;
      const memoryAPI = params.memoryAPI;
      
      const {
        topK = 10,
        factTopK = 7,
        summaryTopK = 5,
        minScore = 0.3,
        projects
      } = options;
      
      if (!memoryAPI) {
        if (debug) console.log('[retriever] Memory API not available');
        return [];
      }
      
      if (!query || !userId) {
        return [];
      }
      
      const results = [];
      
      // Search facts
      try {
        const facts = await memoryAPI.retrieveFacts({
          userId,
          query,
          options: {
            topK: factTopK,
            minScore,
            scopes: ['user', 'agent']
          }
        });
        
        for (const fact of facts) {
          results.push({
            source: 'fact',
            id: fact.id,
            content: fact.value,
            category: fact.category,
            score: fact.score,
            cosineScore: fact.cosineScore,
            bm25Score: fact.bm25Score,
            createdAt: fact.createdAt,
            updatedAt: fact.updatedAt,
            metadata: fact.metadata
          });
        }
      } catch (err) {
        if (debug) console.error('[retriever] Fact search error:', err.message);
      }
      
      // Search summaries
      try {
        const summaries = await memoryAPI.retrieveSummaries({
          userId,
          query,
          options: {
            topK: summaryTopK,
            minScore,
            projects
          }
        });
        
        for (const summary of summaries) {
          results.push({
            source: 'summary',
            id: summary.id,
            topic: summary.topic,
            content: summary.content,
            entities: summary.entities,
            projects: summary.projects,
            score: summary.score,
            cosineScore: summary.cosineScore,
            bm25Score: summary.bm25Score,
            sourceMessages: summary.sourceMessages,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt
          });
        }
      } catch (err) {
        if (debug) console.error('[retriever] Summary search error:', err.message);
      }
      
      // Sort all results by score and take topK
      results.sort((a, b) => b.score - a.score);
      
      if (debug) {
        const factCount = results.filter(r => r.source === 'fact').length;
        const summaryCount = results.filter(r => r.source === 'summary').length;
        console.log(`[retriever] Memory search: ${factCount} facts + ${summaryCount} summaries for "${query.slice(0, 50)}"`);
      }
      
      return results.slice(0, topK);
    },
    
    /**
     * PHASE 2: Query for relevant chunks (backward compatible alias)
     */
    async queryRelevantChunks(params) {
      return this.searchResults(params);
    }
  };
}

/**
 * Retrieve full content (with token limit)
 */
function retrieveFull(content, maxTokens) {
  const maxChars = maxTokens * 4;
  
  if (content.length <= maxChars) {
    return content;
  }
  
  // Truncate at line boundary if possible
  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  
  if (lastNewline > maxChars * 0.8) {
    return truncated.slice(0, lastNewline) + '\n\n... [content truncated, use mode="lines" for specific ranges]';
  }
  
  return truncated + '\n\n... [content truncated]';
}

/**
 * Search for query in lines with context
 */
function retrieveSearch(lines, query, contextLines, maxTokens) {
  const results = [];
  const pattern = new RegExp(escapeRegex(query), 'gi');
  
  // Find all matching lines
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      results.push({
        lineNumber: i + 1,
        line: lines[i]
      });
    }
  }
  
  if (results.length === 0) {
    return {
      text: `No matches found for "${query}"`,
      matchCount: 0,
      matches: []
    };
  }
  
  // Build output with context
  let output = `Found ${results.length} match${results.length > 1 ? 'es' : ''} for "${query}":\n\n`;
  const maxChars = maxTokens * 4;
  
  for (const match of results) {
    if (output.length > maxChars * 0.9) {
      output += `\n... and ${results.length - results.indexOf(match)} more matches`;
      break;
    }
    
    const start = Math.max(0, match.lineNumber - 1 - contextLines);
    const end = Math.min(lines.length - 1, match.lineNumber - 1 + contextLines);
    
    output += `--- Line ${match.lineNumber} ---\n`;
    
    for (let j = start; j <= end; j++) {
      const marker = j === match.lineNumber - 1 ? '>' : ' ';
      output += `${marker} ${j + 1}: ${lines[j]}\n`;
    }
    
    output += '\n';
  }
  
  return {
    text: output.trim(),
    matchCount: results.length,
    matches: results.slice(0, 10).map(r => r.lineNumber)
  };
}

/**
 * Retrieve specific line range
 */
function retrieveLines(lines, start, end, maxTokens) {
  const selected = lines.slice(start - 1, end);
  let output = '';
  const maxChars = maxTokens * 4;
  
  for (let i = 0; i < selected.length; i++) {
    const lineNum = start + i;
    const line = `${lineNum}: ${selected[i]}\n`;
    
    if (output.length + line.length > maxChars) {
      output += `\n... [truncated at line ${lineNum - 1}, use smaller range]`;
      break;
    }
    
    output += line;
  }
  
  return output.trim();
}

/**
 * Escape regex special characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format RAG context for injection (Phase 2)
 */
export function formatRAGContext(chunks) {
  if (!chunks || chunks.length === 0) return '';
  
  let output = '📚 RELEVANT TOOL RESULTS FROM PAST:\n\n';
  
  for (const chunk of chunks) {
    const score = Math.round((chunk.score || 0) * 100);
    const toolName = chunk.toolName || 'unknown';
    const date = chunk.createdAt ? new Date(chunk.createdAt).toISOString().split('T')[0] : 'unknown';
    
    output += `┌─ [${toolName}] ${date} (relevance: ${score}%)\n`;
    output += `│  Result ID: ${chunk.resultId}\n`;
    output += `│  Chunk ${chunk.chunkIdx + 1}\n`;
    output += '├─────────────────────────────────────────\n';
    
    // Indent chunk text
    const lines = chunk.chunkText.split('\n');
    for (const line of lines) {
      output += `│  ${line}\n`;
    }
    
    output += '└─────────────────────────────────────────\n\n';
  }
  
  return output;
}

/**
 * v2.1.0: Format unified memory results for context injection
 * 
 * @param {Array} results - Memory search results (facts + summaries)
 * @returns {string} Formatted context string
 */
export function formatMemoryContext(results) {
  if (!results || results.length === 0) return '';
  
  const facts = results.filter(r => r.source === 'fact');
  const summaries = results.filter(r => r.source === 'summary');
  
  let output = '';
  
  if (facts.length > 0) {
    output += '🧠 REMEMBERED FACTS:\n';
    for (const fact of facts) {
      const score = Math.round((fact.score || 0) * 100);
      output += `  • [${fact.category || 'general'}] ${fact.content} (${score}%)\n`;
    }
    output += '\n';
  }
  
  if (summaries.length > 0) {
    output += '📝 CONVERSATION SUMMARIES:\n';
    for (const summary of summaries) {
      const score = Math.round((summary.score || 0) * 100);
      output += `  ┌─ ${summary.topic} (${score}%)\n`;
      output += `  │  ${summary.content}\n`;
      if (summary.entities && summary.entities.length > 0) {
        output += `  │  Entities: ${summary.entities.join(', ')}\n`;
      }
      output += `  └──\n`;
    }
    output += '\n';
  }
  
  return output;
}

export default { createRetriever, formatRAGContext, formatMemoryContext };
