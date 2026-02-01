/**
 * Tool Result Summarizer
 * 
 * Uses Gemini Flash to generate semantic summaries of large tool results.
 * Preserves key information from ENTIRE output in 200-500 char summaries.
 * Falls back to truncation on API failure.
 * 
 * @module tool-results/summarizer
 */

import { estimateTokens } from './store.js';

/**
 * Default token thresholds per tool (when to summarize)
 */
const DEFAULT_THRESHOLDS = {
  browser: 500,       // Browser snapshots are information-dense
  exec: 1500,         // CLI output can be very verbose
  Read: 2500,         // File contents
  web_fetch: 2500,    // Web page content
  web_search: 10000,  // Search results (usually small)
  process: 1500,      // Process logs
  default: 2000       // Fallback
};

/**
 * Summary length limits (characters)
 */
const DEFAULT_LENGTH_LIMITS = {
  min: 150,
  max: 500,
  target: 300
};

/**
 * Per-tool summarization prompts
 */
const SUMMARIZATION_PROMPTS = {
  browser: `Summarize this browser accessibility snapshot concisely. Include:
- Page title/heading (if visible)
- Main interactive elements (buttons, links, forms, inputs)
- Key visible text content
- Any errors, loading states, or modals
- Element counts for major types

Use emojis for visual scanning: 📄 title, 🔗 links, 📝 content, ⚡ interactive, ⚠️ warnings/errors
Keep under {maxLength} characters. Be specific about what's actionable.`,

  exec: `Summarize this command output concisely. Include:
- Success/failure status (exit code if shown)
- Any errors with specific messages
- Any warnings (count + key ones)
- Key numeric results (counts, times, sizes, versions)
- Final outcome or state change

Use emojis: ✓ success, ❌ error, ⚠️ warning, ⏱️ timing, 📦 packages/files
Keep under {maxLength} characters. Prioritize errors and actionable info.`,

  Read: `Summarize this file content concisely. Include:
- File type and apparent purpose
- Main exports, functions, classes, or sections
- Key dependencies or imports
- Notable patterns, todos, or issues
- Approximate size (lines, if relevant)

Use emojis: 📄 file type, 📦 exports, 🔗 imports, ⚙️ config, 📏 metrics
Keep under {maxLength} characters. Focus on structure and key identifiers.`,

  web_fetch: `Summarize this web page content concisely. Include:
- Page type (article, docs, product, forum, etc.)
- Main topic/title
- Key points, sections, or data
- Any code examples or technical details mentioned
- Author/date if present

Use emojis: 📰 article, 📚 docs, 👤 author, 📅 date, 💡 key insight, 🔗 links
Keep under {maxLength} characters. Capture the main takeaways.`,

  process: `Summarize this process log output concisely. Include:
- Process state (running, completed, errored, killed)
- Recent activity or progress
- Any errors or warnings with specifics
- Key metrics (memory, CPU, progress %)
- Time elapsed if shown

Use emojis: 🔄 running, ✓ done, ❌ error, ⚠️ warning, 📊 metrics
Keep under {maxLength} characters. Focus on current state and issues.`,

  default: `Summarize this tool output concisely. Include:
- Main outcome or result
- Any errors or warnings
- Key data points or metrics
- Overall status

Keep under {maxLength} characters. Be specific and actionable.`
};

/**
 * Create summarizer instance
 */
export function createSummarizer(config = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
  const lengthLimits = { ...DEFAULT_LENGTH_LIMITS, ...config.lengthLimits };
  const debug = config.debug || false;
  
  // Gemini configuration
  const geminiConfig = {
    apiKey: config.apiKey || process.env.GEMINI_API_KEY,
    model: config.model || 'gemini-2.0-flash',
    fallbackModel: config.fallbackModel || 'gemini-2.5-flash',
    timeoutMs: config.timeoutMs || 5000,
    maxRetries: config.maxRetries ?? 1
  };
  
  // Truncation fallback settings
  const truncationConfig = {
    previewTokens: config.previewTokens || 400,
    showHeadTail: config.showHeadTail !== false
  };
  
  return {
    /**
     * Check if content should be summarized
     */
    shouldSummarize(toolName, content) {
      try {
        const tokens = estimateTokens(content);
        const threshold = thresholds[toolName] || thresholds.default;
        return tokens > threshold;
      } catch (err) {
        return false;
      }
    },
    
    /**
     * Get threshold for a tool
     */
    getThreshold(toolName) {
      return thresholds[toolName] || thresholds.default;
    },
    
    /**
     * Summarize content using Gemini Flash
     * Falls back to truncation on failure
     */
    async summarize(toolName, content, options = {}) {
      const { resultId, tokenCount = estimateTokens(content), maxLength = lengthLimits.target } = options;

      // Try summarization if enabled and key exists
      if (config.enabled !== false && geminiConfig.apiKey) {
        try {
          const summary = await callGeminiSummarize({
            toolName,
            content,
            maxLength,
            config: geminiConfig,
            debug
          });

          if (summary && summary.length >= lengthLimits.min) {
            // Truncate if too long
            const finalSummary = summary.length > lengthLimits.max
              ? summary.slice(0, lengthLimits.max - 3) + '...'
              : summary;

            return formatSummarizedResult({
              resultId,
              toolName,
              summary: finalSummary,
              tokenCount,
              method: 'summarized'
            });
          }

          // If summary exists but is too short, fall through to truncation
          if (debug && summary) {
            console.log(`[summarizer] Summary too short (${summary.length} < ${lengthLimits.min}), using truncation`);
          }
        } catch (err) {
          if (debug) {
            console.warn(`[summarizer] Gemini summarization failed: ${err.message}`);
          }
        }
      }

      // Fallback to truncation
      if (debug) {
        console.log(`[summarizer] Falling back to truncation for ${toolName}`);
      }

      try {
        const truncated = truncateFallback(toolName, content, {
          resultId,
          tokenCount,
          previewTokens: truncationConfig.previewTokens,
          showHeadTail: truncationConfig.showHeadTail
        });

        // Critical: Ensure we never return undefined
        if (!truncated) {
          return `[STORED: ${resultId}] Result stored. Content: ${content.slice(0, 200)}...`;
        }

        return truncated;
      } catch (err) {
        // Absolute last resort - MUST return something
        if (debug) {
          console.error(`[summarizer] Truncation failed: ${err.message}`);
        }
        return `[STORED: ${resultId}] Result stored. Content too large to display and summarization/truncation failed. Original size: ~${tokenCount} tokens.`;
      }
    }
  };
}

/**
 * Call Gemini API for summarization
 */
async function callGeminiSummarize({ toolName, content, maxLength, config, debug }) {
  if (!config.apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  
  const promptTemplate = SUMMARIZATION_PROMPTS[toolName] || SUMMARIZATION_PROMPTS.default;
  const prompt = promptTemplate.replace('{maxLength}', maxLength.toString());
  
  // Prepare content (truncate input if extremely large to save costs)
  const maxInputChars = 100000; // ~25K tokens max input
  const truncatedContent = content.length > maxInputChars
    ? content.slice(0, Math.floor(maxInputChars * 0.7)) + '\n\n[...middle section omitted...]\n\n' + content.slice(-Math.floor(maxInputChars * 0.3))
    : content;
  
  const requestBody = {
    contents: [{
      parts: [{
        text: `${prompt}\n\n---\n${truncatedContent}\n---`
      }]
    }],
    generationConfig: {
      maxOutputTokens: 200,
      temperature: 0.3, // Lower = more consistent
      topP: 0.8
    }
  };
  
  let lastError = null;
  const models = [config.model, config.fallbackModel].filter(Boolean);
  
  for (const model of models) {
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal
          }
        );
        
        clearTimeout(timeout);
        
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
        }
        
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!text) {
          throw new Error('Empty response from Gemini');
        }
        
        if (debug) {
          console.log(`[summarizer] Gemini ${model} returned ${text.length} chars`);
        }
        
        return text.trim();
        
      } catch (err) {
        lastError = err;
        if (debug) {
          console.warn(`[summarizer] Attempt ${attempt + 1} with ${model} failed: ${err.message}`);
        }
        
        // Don't retry on abort (timeout)
        if (err.name === 'AbortError') {
          break;
        }
      }
    }
  }
  
  throw lastError || new Error('Summarization failed');
}

/**
 * Format summarized result for message history
 */
function formatSummarizedResult({ resultId, toolName, summary, tokenCount, method }) {
  const toolLabels = {
    browser: 'Browser Snapshot',
    exec: 'Command Output',
    Read: 'File Content',
    web_fetch: 'Web Content',
    process: 'Process Log',
    default: 'Tool Output'
  };
  
  const label = toolLabels[toolName] || toolLabels.default;
  const timestamp = new Date().toISOString();
  
  let output = `[STORED: ${resultId}]
📄 ${label} | ~${tokenCount.toLocaleString()} tokens | ${timestamp}

${summary}

💡 Retrieve full: retrieve_tool_result(result_id="${resultId}")
   Options: mode="search", query="..." | mode="lines", start_line=N, end_line=M`;

  return output;
}

/**
 * Fallback truncation when summarization fails
 */
function truncateFallback(toolName, content, options) {
  const { resultId, tokenCount, previewTokens, showHeadTail } = options;
  
  const toolLabels = {
    browser: 'Browser Snapshot',
    exec: 'Command Output', 
    Read: 'File Content',
    web_fetch: 'Web Content',
    process: 'Process Log',
    default: 'Tool Output'
  };
  
  const label = toolLabels[toolName] || toolLabels.default;
  const timestamp = new Date().toISOString();
  const lines = content.split('\n');
  const previewChars = previewTokens * 4;
  
  let preview;
  
  if (showHeadTail && lines.length > 20) {
    // Show head + tail
    const headChars = Math.floor(previewChars * 0.6);
    const tailChars = Math.floor(previewChars * 0.4);
    
    let head = '';
    let headLines = 0;
    for (const line of lines) {
      if (head.length + line.length > headChars) break;
      head += line + '\n';
      headLines++;
    }
    
    let tail = '';
    let tailLines = 0;
    for (let i = lines.length - 1; i >= headLines; i--) {
      if (tail.length + lines[i].length > tailChars) break;
      tail = lines[i] + '\n' + tail;
      tailLines++;
    }
    
    const skipped = lines.length - headLines - tailLines;
    preview = head + `\n... [${skipped} lines omitted] ...\n\n` + tail;
  } else {
    // Just head
    preview = content.slice(0, previewChars);
    if (preview.length < content.length) {
      const lastNL = preview.lastIndexOf('\n');
      if (lastNL > previewChars * 0.8) {
        preview = preview.slice(0, lastNL);
      }
      preview += '\n... [truncated]';
    }
  }
  
  // Quick error detection
  let statusHint = '';
  if (/error|ERR!|failed|exception|fatal/i.test(content)) {
    statusHint = '\n⚠️ Output may contain errors';
  }
  
  return `[STORED: ${resultId}] ⚠️ Summarization unavailable
📄 ${label} | ~${tokenCount.toLocaleString()} tokens | ${timestamp}${statusHint}

--- PREVIEW ---
${preview.trim()}
--- END PREVIEW ---

💡 Retrieve full: retrieve_tool_result(result_id="${resultId}")
   Options: mode="search", query="error" | mode="lines", start_line=N, end_line=M`;
}

// Keep truncator compatibility for gradual migration
export const createTruncator = createSummarizer;

export default { createSummarizer, createTruncator };
