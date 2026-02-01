/**
 * Tool Result Truncator
 * 
 * Implements tool-specific truncation strategies for large tool results.
 * Generates preview content and formatted truncation messages.
 * 
 * @module tool-results/truncator
 */

import { estimateTokens } from './store.js';

/**
 * Default token thresholds per tool
 */
const DEFAULT_THRESHOLDS = {
  browser: 500,       // Browser snapshots are always large
  exec: 2000,         // CLI output can be verbose
  Read: 3000,         // File contents
  web_fetch: 3000,    // Web page content
  web_search: 10000,  // Search results (usually small, high threshold)
  process: 2000,      // Process logs
  default: 2000       // Fallback
};

/**
 * Default preview token counts per tool
 */
const DEFAULT_PREVIEW_TOKENS = {
  browser: 400,       // Show structure + few elements
  exec: 600,          // Head + tail
  Read: 800,          // File beginning
  web_fetch: 600,     // Article beginning
  default: 500
};

/**
 * Create truncator instance
 */
export function createTruncator(config = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
  const previewTokens = config.previewTokens || DEFAULT_PREVIEW_TOKENS;
  
  return {
    /**
     * Check if content should be truncated
     */
    shouldTruncate(toolName, content) {
      const tokens = estimateTokens(content);
      const threshold = thresholds[toolName] || thresholds.default;
      return tokens > threshold;
    },
    
    /**
     * Get threshold for a tool
     */
    getThreshold(toolName) {
      return thresholds[toolName] || thresholds.default;
    },
    
    /**
     * Truncate content based on tool type
     */
    truncate(toolName, content, options = {}) {
      const { resultId, tokenCount } = options;
      const strategy = TRUNCATION_STRATEGIES[toolName] || TRUNCATION_STRATEGIES.default;
      const previewTokenCount = typeof previewTokens === 'number' 
        ? previewTokens 
        : (previewTokens[toolName] || previewTokens.default || 500);
      
      return strategy(content, {
        resultId,
        tokenCount: tokenCount || estimateTokens(content),
        previewTokens: previewTokenCount
      });
    }
  };
}

/**
 * Truncation strategies per tool type
 */
const TRUNCATION_STRATEGIES = {
  /**
   * Browser snapshot truncation
   * Extracts structure summary and shows first elements
   */
  browser(content, options) {
    const { resultId, tokenCount, previewTokens } = options;
    
    // Try to extract structure info
    let structureSummary = '';
    try {
      // Count element types (rough heuristic for ARIA snapshots)
      const elementCounts = {};
      const matches = content.matchAll(/(?:^|\n)\s*-\s*(\w+)/gm);
      for (const m of matches) {
        const type = m[1].toLowerCase();
        elementCounts[type] = (elementCounts[type] || 0) + 1;
      }
      
      if (Object.keys(elementCounts).length > 0) {
        structureSummary = Object.entries(elementCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ');
      }
      
      // Try to extract page title
      const titleMatch = content.match(/(?:title|heading)[:\s]+["']?([^"'\n]+)/i);
      if (titleMatch) {
        structureSummary = `"${titleMatch[1].slice(0, 50)}" | ${structureSummary}`;
      }
    } catch {}
    
    // Get preview (first N chars)
    const previewChars = previewTokens * 4;
    const preview = content.slice(0, previewChars);
    
    return formatTruncatedResult({
      resultId,
      toolName: 'browser',
      toolLabel: 'Browser Snapshot',
      tokenCount,
      structureSummary,
      preview,
      tips: [
        'mode="full" - Get complete snapshot',
        'mode="search", query="text" - Find specific elements',
        'mode="lines", start_line=N, end_line=M - Get line range'
      ]
    });
  },
  
  /**
   * Exec output truncation
   * Shows head and tail (first and last lines)
   */
  exec(content, options) {
    const { resultId, tokenCount, previewTokens } = options;
    
    const lines = content.split('\n');
    const totalLines = lines.length;
    
    // Calculate how many lines for head vs tail
    const previewChars = previewTokens * 4;
    const headChars = Math.floor(previewChars * 0.6);
    const tailChars = Math.floor(previewChars * 0.4);
    
    // Build head
    let headContent = '';
    let headLines = 0;
    for (const line of lines) {
      if (headContent.length + line.length > headChars) break;
      headContent += line + '\n';
      headLines++;
    }
    
    // Build tail (from end)
    let tailContent = '';
    let tailLines = 0;
    for (let i = lines.length - 1; i >= headLines; i--) {
      if (tailContent.length + lines[i].length > tailChars) break;
      tailContent = lines[i] + '\n' + tailContent;
      tailLines++;
    }
    
    const skippedLines = totalLines - headLines - tailLines;
    
    const preview = skippedLines > 0
      ? `${headContent}\n... [${skippedLines} lines omitted] ...\n\n${tailContent}`
      : content.slice(0, previewChars);
    
    // Check for error indicators
    let errorHint = '';
    if (/error|ERR!|failed|exception/i.test(content)) {
      errorHint = '⚠️ Output may contain errors';
    }
    
    return formatTruncatedResult({
      resultId,
      toolName: 'exec',
      toolLabel: 'Command Output',
      tokenCount,
      structureSummary: `${totalLines} lines${errorHint ? ' | ' + errorHint : ''}`,
      preview,
      tips: [
        'mode="search", query="error" - Find error messages',
        'mode="lines", start_line=1, end_line=50 - Get first 50 lines',
        'mode="around", line=100, context_lines=10 - Get context around line 100'
      ]
    });
  },
  
  /**
   * File read truncation
   * Shows beginning of file with metadata
   */
  Read(content, options) {
    const { resultId, tokenCount, previewTokens } = options;
    
    const lines = content.split('\n');
    const totalLines = lines.length;
    const previewChars = previewTokens * 4;
    
    // Detect file type heuristics
    let fileType = 'text';
    if (content.startsWith('{') || content.startsWith('[')) fileType = 'json';
    else if (content.includes('<!DOCTYPE') || content.includes('<html')) fileType = 'html';
    else if (content.includes('import ') || content.includes('export ')) fileType = 'javascript';
    else if (content.includes('def ') || content.includes('import ')) fileType = 'python';
    else if (content.includes('package ') || content.includes('func ')) fileType = 'go';
    
    const preview = content.slice(0, previewChars);
    
    return formatTruncatedResult({
      resultId,
      toolName: 'Read',
      toolLabel: 'File Content',
      tokenCount,
      structureSummary: `${totalLines} lines | ${fileType}`,
      preview,
      tips: [
        'mode="full" - Get complete file',
        'mode="lines", start_line=1, end_line=100 - Get specific line range',
        'mode="search", query="function" - Find specific patterns'
      ]
    });
  },
  
  /**
   * Web fetch truncation
   * Shows beginning of article/content
   */
  web_fetch(content, options) {
    const { resultId, tokenCount, previewTokens } = options;
    
    const previewChars = previewTokens * 4;
    const preview = content.slice(0, previewChars);
    
    // Try to extract title
    let title = '';
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].slice(0, 60);
    }
    
    return formatTruncatedResult({
      resultId,
      toolName: 'web_fetch',
      toolLabel: 'Web Content',
      tokenCount,
      structureSummary: title || 'Article/page content',
      preview,
      tips: [
        'mode="full" - Get complete content',
        'mode="search", query="keyword" - Find specific sections'
      ]
    });
  },
  
  /**
   * Default truncation strategy
   */
  default(content, options) {
    const { resultId, tokenCount, previewTokens } = options;
    
    const previewChars = previewTokens * 4;
    const preview = content.slice(0, previewChars);
    const lines = content.split('\n').length;
    
    return formatTruncatedResult({
      resultId,
      toolName: 'tool',
      toolLabel: 'Tool Output',
      tokenCount,
      structureSummary: `${lines} lines`,
      preview,
      tips: [
        'mode="full" - Get complete output',
        'mode="search", query="text" - Search for text',
        'mode="lines", start_line=N, end_line=M - Get line range'
      ]
    });
  }
};

/**
 * Format the truncated result message
 */
function formatTruncatedResult(params) {
  const {
    resultId,
    toolName,
    toolLabel,
    tokenCount,
    structureSummary,
    preview,
    tips = []
  } = params;
  
  const timestamp = new Date().toISOString();
  
  let output = `[STORED: ${resultId}]

📄 ${toolLabel}
📊 Size: ~${tokenCount.toLocaleString()} tokens
${structureSummary ? `📋 ${structureSummary}` : ''}
🕐 ${timestamp}

--- PREVIEW ---
${preview.trim()}
--- END PREVIEW ---

💡 Retrieve full content with: retrieve_tool_result(result_id="${resultId}")`;

  if (tips.length > 0) {
    output += '\n   Options:';
    for (const tip of tips) {
      output += `\n   • ${tip}`;
    }
  }
  
  return output;
}

export default { createTruncator };
