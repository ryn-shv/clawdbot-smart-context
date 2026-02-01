/**
 * Tool Definition for retrieve_tool_result
 * 
 * Defines the tool schema and handler for the LLM to retrieve
 * full content from truncated tool results.
 * 
 * @module tool-results/tool-definition
 */

/**
 * Tool schema for Clawdbot format
 * NOTE: Clawdbot uses 'parameters' NOT 'input_schema'!
 */
export const retrieveToolResultSchema = {
  name: 'retrieve_tool_result',

  description: `Retrieve full or partial content from a previously truncated tool result.

When you see "[STORED: tr_XXXXXXXX]" in a tool result, the full content was stored and can be retrieved with this tool.

**Modes:**
- \`full\`: Get the entire stored content (may be truncated to max_tokens)
- \`search\`: Find lines containing a keyword/phrase with surrounding context
- \`lines\`: Get a specific line range (1-indexed)
- \`around\`: Get context around a specific line number

**Examples:**
- Get full result: \`retrieve_tool_result(result_id="tr_abc123")\`
- Search for errors: \`retrieve_tool_result(result_id="tr_abc123", mode="search", query="error")\`
- Get lines 50-100: \`retrieve_tool_result(result_id="tr_abc123", mode="lines", start_line=50, end_line=100)\`
- Get context around line 75: \`retrieve_tool_result(result_id="tr_abc123", mode="around", line=75)\``,

  // CRITICAL: Use 'parameters' for Clawdbot compatibility (not 'input_schema')
  parameters: {
    type: 'object',
    properties: {
      result_id: {
        type: 'string',
        description: 'The result ID from a truncated tool result (format: "tr_XXXXXXXX")'
      },
      mode: {
        type: 'string',
        enum: ['full', 'search', 'lines', 'around'],
        description: 'Retrieval mode: full (default), search (keyword), lines (range), around (context)'
      },
      query: {
        type: 'string',
        description: 'For "search" mode: the text or pattern to search for'
      },
      line: {
        type: 'integer',
        description: 'For "around" mode: the center line number to get context around'
      },
      start_line: {
        type: 'integer',
        description: 'For "lines" mode: starting line number (1-indexed, inclusive)'
      },
      end_line: {
        type: 'integer',
        description: 'For "lines" mode: ending line number (inclusive)'
      },
      context_lines: {
        type: 'integer',
        description: 'For "search" and "around" modes: number of context lines to show around matches (default: 10)'
      },
      max_tokens: {
        type: 'integer',
        description: 'Maximum tokens to return in the response (default: 4000)'
      }
    },
    required: ['result_id']
  }
};

/**
 * Create tool handler function
 * @param {Object} services - Injected services (store, retriever)
 * @returns {Function} Tool handler
 */
export function createToolHandler(services) {
  return async function handleRetrieveToolResult(input, ctx) {
    const retriever = services?.retriever;
    
    if (!retriever) {
      return {
        error: true,
        message: 'Tool result retrieval is not available. The service may not be initialized.'
      };
    }
    
    try {
      const result = await retriever.retrieve(input);
      
      if (result.error) {
        // Return error in a format the LLM can understand
        return formatError(result);
      }
      
      // Format successful response
      return formatSuccess(result);
      
    } catch (err) {
      return {
        error: true,
        message: `Retrieval failed: ${err.message}`
      };
    }
  };
}

/**
 * Format successful retrieval response
 */
function formatSuccess(result) {
  const { metadata, content } = result;
  
  let header = `📄 Retrieved from: ${metadata.result_id}\n`;
  header += `Tool: ${metadata.tool_name} | `;
  header += `Mode: ${metadata.mode} | `;
  header += `Total: ${metadata.total_lines} lines (~${metadata.total_tokens} tokens)\n`;
  
  if (metadata.mode === 'search' && metadata.match_count !== undefined) {
    header += `Found: ${metadata.match_count} matches for "${metadata.query}"\n`;
  }
  
  if (metadata.range) {
    header += `Range: lines ${metadata.range}\n`;
  }
  
  if (metadata.truncated) {
    header += `⚠️ Content truncated to fit max_tokens\n`;
  }
  
  header += '\n---\n';
  
  return header + content;
}

/**
 * Format error response
 */
function formatError(result) {
  let msg = `❌ ${result.message}`;
  
  if (result.hint) {
    msg += `\n💡 ${result.hint}`;
  }
  
  return msg;
}

/**
 * Register tool with Clawdbot API
 *
 * CRITICAL FIX: Clawdbot expects tools to have:
 *   1. `parameters` field (NOT `input_schema`)
 *   2. `execute` method directly in the tool object
 *   3. Handler should NOT be passed as second argument (it's ignored)
 */
export function registerRetrievalTool(api, services, logger) {
  if (!api.registerTool) {
    logger.warn('Tool registration not available - retrieve_tool_result not registered');
    return false;
  }

  try {
    // Capture retriever reference for the execute closure
    const retriever = services?.retriever;

    // Tool object with execute method included (Clawdbot's expected format)
    const tool = {
      name: 'retrieve_tool_result',
      description: `Retrieve full or partial content from a previously truncated tool result.

When you see "[STORED: tr_XXXXXXXX]" in a tool result, the full content was stored and can be retrieved with this tool.

**Modes:**
- \`full\`: Get the entire stored content (may be truncated to max_tokens)
- \`search\`: Find lines containing a keyword/phrase with surrounding context
- \`lines\`: Get a specific line range (1-indexed)
- \`around\`: Get context around a specific line number`,

      // CRITICAL: Use 'parameters' NOT 'input_schema'!
      parameters: {
        type: 'object',
        properties: {
          result_id: {
            type: 'string',
            description: 'The result ID from a truncated tool result (format: "tr_XXXXXXXX")'
          },
          mode: {
            type: 'string',
            enum: ['full', 'search', 'lines', 'around'],
            description: 'Retrieval mode: full (default), search, lines, or around'
          },
          query: {
            type: 'string',
            description: 'For "search" mode: the text to search for'
          },
          line: {
            type: 'integer',
            description: 'For "around" mode: the center line number'
          },
          start_line: {
            type: 'integer',
            description: 'For "lines" mode: starting line number'
          },
          end_line: {
            type: 'integer',
            description: 'For "lines" mode: ending line number'
          },
          context_lines: {
            type: 'integer',
            description: 'Context lines around matches (default: 10)'
          },
          max_tokens: {
            type: 'integer',
            description: 'Maximum tokens to return (default: 4000)'
          }
        },
        required: ['result_id']
      },

      // CRITICAL: Execute method must be directly in the tool object!
      async execute(_toolCallId, input) {
        if (!retriever) {
          return formatError({
            error: true,
            message: 'Tool result retrieval is not available. The service may not be initialized.'
          });
        }

        try {
          // Apply defaults for optional parameters
          const params = {
            ...input,
            mode: input.mode || 'full',
            context_lines: input.context_lines ?? 10,
            max_tokens: input.max_tokens ?? 4000
          };

          const result = await retriever.retrieve(params);

          if (result.error) {
            return formatError(result);
          }

          return formatSuccess(result);
        } catch (err) {
          return formatError({
            error: true,
            message: `Retrieval failed: ${err.message}`
          });
        }
      }
    };

    logger.info('Registering retrieve_tool_result tool');
    // Register tool object directly - no separate handler argument!
    api.registerTool(tool);
    logger.info('✅ Tool registered successfully');
    return true;
  } catch (err) {
    logger.error(`❌ Tool registration failed: ${err.message}`);
    return false;
  }
}

export default {
  retrieveToolResultSchema,
  createToolHandler,
  registerRetrievalTool
};
