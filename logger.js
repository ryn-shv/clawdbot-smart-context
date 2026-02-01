/**
 * Smart Context Enhanced Logger v2.0
 * 
 * Production-grade async logging with:
 * - Structured JSON output for machine parsing
 * - Human-readable console output
 * - File rotation and size management
 * - Operation correlation IDs
 * - Performance metrics tracking
 * - Session-based log aggregation
 * 
 * @module smart-context/logger
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const LOG_LEVELS = {
  TRACE: 5,   // Very detailed tracing
  DEBUG: 10,  // Debug information
  INFO: 20,   // Normal operations
  WARN: 30,   // Potential issues
  ERROR: 40,  // Errors
  FATAL: 50,  // Critical failures
  METRIC: 25  // Performance metrics (between INFO and WARN)
};

const LEVEL_NAMES = Object.fromEntries(
  Object.entries(LOG_LEVELS).map(([k, v]) => [v, k])
);

const COLORS = {
  TRACE: '\x1b[90m',   // Gray
  DEBUG: '\x1b[36m',   // Cyan
  INFO: '\x1b[32m',    // Green
  WARN: '\x1b[33m',    // Yellow
  ERROR: '\x1b[31m',   // Red
  FATAL: '\x1b[35m',   // Magenta
  METRIC: '\x1b[34m',  // Blue
  RESET: '\x1b[0m',
  DIM: '\x1b[2m',
  BOLD: '\x1b[1m'
};

const LOG_DIR = path.join(os.homedir(), '.clawdbot', 'logs');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 5;
const FLUSH_INTERVAL_MS = 100;
const BUFFER_SIZE = 50;

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

let writeBuffer = [];
let flushTimeout = null;
let globalSessionId = null;
let operationCounter = 0;

// Metrics aggregation
const metrics = {
  operations: new Map(),  // opId → {startTime, component, name}
  totals: {
    filterCalls: 0,
    messagesProcessed: 0,
    messagesFiltered: 0,
    tokensSaved: 0,
    cacheHits: 0,
    cacheMisses: 0,
    embeddingTimeMs: 0,
    filterTimeMs: 0,
    errors: 0,
    warnings: 0
  },
  sessionStart: Date.now()
};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    return true;
  } catch (err) {
    console.error(`[smart-context:logger] Failed to create log dir: ${err.message}`);
    return false;
  }
}

function generateId(prefix = 'op') {
  operationCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}-${operationCounter}`;
}

function formatTimestamp() {
  const now = new Date();
  // IST timezone offset
  const offset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + offset);
  return istTime.toISOString().replace('Z', '+05:30');
}

function truncateString(str, maxLen = 200) {
  if (!str || typeof str !== 'string') return str;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function safeStringify(obj, maxLen = 1000) {
  try {
    const str = JSON.stringify(obj);
    return truncateString(str, maxLen);
  } catch {
    return '[circular or unstringifiable]';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG FILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

function checkRotation(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    
    const stats = fs.statSync(filePath);
    if (stats.size < MAX_FILE_SIZE) return;
    
    // Rotate file
    const rotatedName = `${filePath}.${Date.now()}.old`;
    fs.renameSync(filePath, rotatedName);
    
    // Clean up old rotated files
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const oldFiles = fs.readdirSync(dir)
      .filter(f => f.startsWith(base) && f.endsWith('.old'))
      .sort()
      .reverse();
    
    for (const oldFile of oldFiles.slice(MAX_ROTATED_FILES)) {
      try {
        fs.unlinkSync(path.join(dir, oldFile));
      } catch {}
    }
  } catch {}
}

function writeToFile(filePath, entry) {
  writeBuffer.push({ filePath, entry });
  
  if (writeBuffer.length >= BUFFER_SIZE) {
    flushBuffer();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
  }
}

function flushBuffer() {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  
  if (writeBuffer.length === 0) return;
  
  const byFile = {};
  for (const item of writeBuffer) {
    if (!byFile[item.filePath]) byFile[item.filePath] = [];
    byFile[item.filePath].push(item.entry);
  }
  writeBuffer = [];
  
  for (const [filePath, entries] of Object.entries(byFile)) {
    try {
      fs.appendFileSync(filePath, entries.join('\n') + '\n');
    } catch (err) {
      console.error(`[smart-context:logger] Write failed: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create structured JSON log entry
 */
function createStructuredEntry(level, component, message, data = null, extra = {}) {
  const entry = {
    timestamp: formatTimestamp(),
    level: LEVEL_NAMES[level] || 'INFO',
    component: `smart-context:${component}`,
    message,
    sessionId: globalSessionId,
    ...extra
  };
  
  if (data !== null && data !== undefined) {
    entry.data = data;
  }
  
  return entry;
}

/**
 * Format entry for console output (human-readable)
 */
function formatConsoleEntry(entry) {
  const color = COLORS[entry.level] || '';
  const reset = COLORS.RESET;
  const dim = COLORS.DIM;
  
  let msg = `${color}[${entry.timestamp}] [${entry.level}] [${entry.component}]${reset} ${entry.message}`;
  
  if (entry.opId) {
    msg += ` ${dim}(${entry.opId})${reset}`;
  }
  
  if (entry.data) {
    const dataStr = typeof entry.data === 'string' 
      ? entry.data 
      : safeStringify(entry.data, 500);
    msg += ` ${dim}${dataStr}${reset}`;
  }
  
  return msg;
}

/**
 * Format entry for file output (JSON)
 */
function formatFileEntry(entry) {
  return JSON.stringify(entry);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER FACTORY
// ═══════════════════════════════════════════════════════════════════════════

const logFiles = {
  plugin: path.join(LOG_DIR, 'smart-context-plugin.log'),
  filter: path.join(LOG_DIR, 'smart-context-filter.log'),
  errors: path.join(LOG_DIR, 'smart-context-errors.log'),
  metrics: path.join(LOG_DIR, 'smart-context-metrics.log'),
  decisions: path.join(LOG_DIR, 'smart-context-decisions.log')
};

/**
 * Create a scoped logger for a specific component
 */
export function createLogger(component, options = {}) {
  const minLevel = LOG_LEVELS[options.level?.toUpperCase()] || LOG_LEVELS.DEBUG;
  const enableConsole = options.console !== false;
  const enableFile = options.file !== false;
  const debug = options.debug || false;
  const trace = options.trace || false;
  
  const dirExists = ensureLogDir();
  
  // Rotate files on logger creation
  if (dirExists && enableFile) {
    Object.values(logFiles).forEach(checkRotation);
  }
  
  /**
   * Internal log function
   */
  function log(level, message, data = null, extra = {}) {
    const levelNum = typeof level === 'number' ? level : LOG_LEVELS[level];
    if (levelNum < minLevel) return null;
    
    const entry = createStructuredEntry(levelNum, component, message, data, extra);
    
    // Track errors/warnings in metrics
    if (levelNum >= LOG_LEVELS.ERROR) metrics.totals.errors++;
    else if (levelNum >= LOG_LEVELS.WARN) metrics.totals.warnings++;
    
    // Console output
    if (enableConsole) {
      console.log(formatConsoleEntry(entry));
    }
    
    // File output
    if (enableFile && dirExists) {
      const fileEntry = formatFileEntry(entry);
      
      // Main plugin log
      writeToFile(logFiles.plugin, fileEntry);
      
      // Component-specific logs
      if (component === 'filter' || component === 'selector') {
        writeToFile(logFiles.filter, fileEntry);
      }
      
      // Error log
      if (levelNum >= LOG_LEVELS.ERROR) {
        writeToFile(logFiles.errors, fileEntry);
      }
      
      // Metrics log
      if (entry.level === 'METRIC' || extra.metric) {
        writeToFile(logFiles.metrics, fileEntry);
      }
      
      // Decision log (for filter decisions)
      if (extra.decision) {
        writeToFile(logFiles.decisions, fileEntry);
      }
    }
    
    return entry;
  }
  
  return {
    // Standard log levels
    trace: (msg, data) => trace && log('TRACE', msg, data),
    debug: (msg, data) => debug && log('DEBUG', msg, data),
    info: (msg, data) => log('INFO', msg, data),
    warn: (msg, data) => log('WARN', msg, data),
    error: (msg, data) => log('ERROR', msg, data),
    fatal: (msg, data) => log('FATAL', msg, data),
    
    /**
     * Log a metric (performance/stats)
     */
    metric: (name, value, unit = '', data = {}) => {
      return log('METRIC', `📊 ${name}: ${value}${unit}`, data, { metric: true, metricName: name, metricValue: value });
    },
    
    /**
     * Log a filtering decision with full context
     */
    decision: (action, details) => {
      return log('INFO', `🎯 Decision: ${action}`, details, { decision: true });
    },
    
    /**
     * Start a timed operation
     */
    startOp: (operationName, details = {}) => {
      const opId = generateId('op');
      const startTime = Date.now();
      
      metrics.operations.set(opId, { 
        startTime, 
        component, 
        name: operationName,
        details 
      });
      
      log('INFO', `▶ START ${operationName}`, details, { opId });
      
      return {
        opId,
        startTime,
        
        // Log a checkpoint within the operation
        checkpoint: (label, data = {}) => {
          const elapsed = Date.now() - startTime;
          log('DEBUG', `  ├─ ${label} (${elapsed}ms)`, data, { opId });
        },
        
        // End the operation with results
        end: (result = {}) => {
          const elapsed = Date.now() - startTime;
          metrics.operations.delete(opId);
          
          log('INFO', `◀ END ${operationName} (${elapsed}ms)`, { 
            ...result, 
            durationMs: elapsed 
          }, { opId });
          
          return elapsed;
        },
        
        // End with error
        error: (err, data = {}) => {
          const elapsed = Date.now() - startTime;
          metrics.operations.delete(opId);
          
          log('ERROR', `✖ FAILED ${operationName} (${elapsed}ms): ${err.message || err}`, {
            ...data,
            error: err.message || String(err),
            stack: err.stack?.split('\n').slice(0, 3).join('\n'),
            durationMs: elapsed
          }, { opId });
          
          return elapsed;
        }
      };
    },
    
    /**
     * Log message filtering details
     */
    filterDecision: (index, msg, decision) => {
      const { score, keep, reason, role } = decision;
      const preview = truncateString(
        typeof msg?.content === 'string' ? msg.content : '[array content]',
        100
      );
      
      const emoji = keep === 'system' ? '🔧' :
                   keep === 'recent' ? '🕐' :
                   keep === 'relevant' ? '✅' :
                   reason === 'tool-only' ? '🔨' :
                   reason === 'empty' ? '📭' :
                   score >= 0.5 ? '🔶' : '❌';
      
      return log('DEBUG', `${emoji} [${index}] ${role}: score=${score?.toFixed(3) || 'N/A'}, keep=${keep || 'no'}, reason=${reason || 'score'}`, {
        index,
        role,
        score,
        keep,
        reason,
        preview
      }, { decision: true });
    },
    
    /**
     * Log token statistics
     */
    tokenStats: (inputTokens, outputTokens, details = {}) => {
      const saved = inputTokens - outputTokens;
      const reduction = inputTokens > 0 ? Math.round((saved / inputTokens) * 100) : 0;
      
      metrics.totals.tokensSaved += Math.max(0, saved);
      
      return log('INFO', `💰 Tokens: ${inputTokens} → ${outputTokens} (saved ${saved}, ${reduction}% reduction)`, {
        inputTokens,
        outputTokens,
        savedTokens: saved,
        reductionPercent: reduction,
        ...details
      }, { metric: true });
    },
    
    /**
     * Log edge case encountered
     */
    edgeCase: (caseType, details) => {
      return log('WARN', `⚠️ Edge case: ${caseType}`, details);
    },
    
    /**
     * Log cache operation
     */
    cache: (operation, hit, details = {}) => {
      if (hit) metrics.totals.cacheHits++;
      else metrics.totals.cacheMisses++;
      
      const emoji = hit ? '🎯' : '💨';
      return debug && log('DEBUG', `${emoji} Cache ${operation}: ${hit ? 'HIT' : 'MISS'}`, details);
    },
    
    /**
     * Contextual logger (adds context prefix)
     */
    ctx: (context) => ({
      trace: (msg, data) => trace && log('TRACE', `[${context}] ${msg}`, data),
      debug: (msg, data) => debug && log('DEBUG', `[${context}] ${msg}`, data),
      info: (msg, data) => log('INFO', `[${context}] ${msg}`, data),
      warn: (msg, data) => log('WARN', `[${context}] ${msg}`, data),
      error: (msg, data) => log('ERROR', `[${context}] ${msg}`, data),
    }),
    
    /**
     * Visual separator/marker
     */
    marker: (text) => {
      const line = '═'.repeat(60);
      log('INFO', `\n${line}\n  ${text}\n${line}`);
    },
    
    /**
     * Get current metrics
     */
    getMetrics: () => ({ ...metrics.totals }),
    
    /**
     * Flush pending writes
     */
    flush: () => flushBuffer(),
    
    /**
     * Get log file paths
     */
    getLogPaths: () => ({ ...logFiles })
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set global session ID for correlation
 */
export function setSessionId(sessionId) {
  globalSessionId = sessionId;
}

/**
 * Get aggregated metrics
 */
export function getGlobalMetrics() {
  const uptime = Date.now() - metrics.sessionStart;
  return {
    ...metrics.totals,
    uptimeMs: uptime,
    activeOperations: metrics.operations.size,
    cacheHitRate: metrics.totals.cacheHits + metrics.totals.cacheMisses > 0
      ? (metrics.totals.cacheHits / (metrics.totals.cacheHits + metrics.totals.cacheMisses) * 100).toFixed(1) + '%'
      : 'N/A'
  };
}

/**
 * Reset metrics (for testing)
 */
export function resetMetrics() {
  for (const key of Object.keys(metrics.totals)) {
    metrics.totals[key] = 0;
  }
  metrics.sessionStart = Date.now();
  metrics.operations.clear();
}

/**
 * Global logger instance
 */
export const globalLogger = createLogger('global', { debug: true, trace: false });

/**
 * Flush all pending writes
 */
export function flushAll() {
  flushBuffer();
}

/**
 * Write summary metrics to log
 */
export function logSummary() {
  const m = getGlobalMetrics();
  const logger = createLogger('summary', { debug: true });
  
  logger.marker('SESSION SUMMARY');
  logger.info('📈 Metrics Summary', {
    filterCalls: m.filterCalls,
    messagesProcessed: m.messagesProcessed,
    messagesFiltered: m.messagesFiltered,
    tokensSaved: m.tokensSaved,
    cacheHitRate: m.cacheHitRate,
    errors: m.errors,
    warnings: m.warnings,
    uptimeSeconds: Math.round(m.uptimeMs / 1000)
  });
  
  flushBuffer();
}

// Log on module load
const bootEntry = createStructuredEntry(LOG_LEVELS.INFO, 'loader', 'Logger module loaded v2.0');
ensureLogDir();
writeToFile(logFiles.plugin, formatFileEntry(bootEntry));
flushBuffer();

export default {
  createLogger,
  globalLogger,
  flushAll,
  setSessionId,
  getGlobalMetrics,
  resetMetrics,
  logSummary,
  LOG_DIR,
  LOG_LEVELS
};
