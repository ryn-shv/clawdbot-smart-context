/**
 * Phase 4B: LLM-Based Fact Extraction Prompts
 * 
 * Structured prompts for extracting facts, preferences, and patterns
 * from conversations using Gemini Flash 2.5 (cheap, fast).
 * 
 * v2.1.0: Added hybrid extraction (facts + summaries) with generous prompts
 * v2.1.1: Bulletproof parser - handles truncated JSON, literal \n, partial responses
 * 
 * @module extraction-prompts
 */

// ═══════════════════════════════════════════════════════════════════════════
// FACT CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

export const FACT_CATEGORIES = {
  PREFERENCE: 'preference',       // User likes/dislikes, habits
  DECISION: 'decision',           // Explicit choices made
  PROJECT: 'project',             // Project context, architecture
  SYSTEM: 'system',               // System setup, environment
  ERROR_PATTERN: 'error_pattern', // Recurring error patterns
  PERSONAL: 'personal',           // Personal info (name, role, etc.)
  WORKFLOW: 'workflow'            // User's typical workflows
};

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACTION PROMPT SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * JSON schema for extracted facts
 */
export const EXTRACTION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      fact: {
        type: 'string',
        description: 'Concise fact statement (max 200 chars)'
      },
      category: {
        type: 'string',
        enum: Object.values(FACT_CATEGORIES),
        description: 'Fact category'
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence score (0-1)'
      },
      source_context: {
        type: 'string',
        description: 'Brief context from conversation (max 100 chars)'
      }
    },
    required: ['fact', 'category', 'confidence', 'source_context']
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ORIGINAL EXTRACTION PROMPTS (v2.0.x — kept for backward compat)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * System prompt for fact extraction (legacy, facts-only mode)
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are a fact extraction assistant. Extract important facts from conversations that would help future interactions.

CATEGORIES:
- preference: User likes/dislikes, habits, preferences
- decision: Explicit choices or decisions made
- project: Project context, architecture, codebase info
- system: System setup, environment, tools used
- error_pattern: Recurring errors or troubleshooting patterns
- personal: Personal info (name, role, location, work schedule, etc.)
- workflow: User's typical workflows or processes

RULES:
1. Extract facts that are:
   - Useful for future conversations
   - Personal attributes, preferences, or context
   - Work patterns, schedule, responsibilities
   - Project info, tools, technical preferences
   
2. DO NOT extract:
   - Tool calls or system messages
   - Temporary debugging states
   - Generic conversation filler
   
3. Confidence scoring:
   - 0.9-1.0: Explicitly stated by user ("I prefer X", "My name is Y", "I work at Z")
   - 0.7-0.9: Strongly implied from context
   - 0.5-0.7: Reasonable inference from stated facts
   - <0.5: DO NOT extract (too uncertain)

4. Keep facts concise (max 200 chars)

OUTPUT: JSON array of extracted facts. Extract ANY relevant personal/professional info, not just "permanent" facts. Return [] if truly nothing to extract.`;

/**
 * Generate extraction prompt for a conversation batch (legacy, facts-only)
 * 
 * @param {Array<Object>} messages - Conversation messages
 * @returns {string} Formatted prompt
 */
export function generateExtractionPrompt(messages) {
  // Format messages for extraction
  const formattedMessages = messages
    .map((msg, idx) => {
      const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content);
      
      // Truncate very long messages
      const truncated = content.length > 500 
        ? content.slice(0, 500) + '...' 
        : content;
      
      return `[${idx + 1}] ${role}: ${truncated}`;
    })
    .join('\n\n');
  
  return `Extract permanent, reusable facts from this conversation:

${formattedMessages}

Return a JSON array of extracted facts following the schema. If nothing to extract, return [].`;
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.1.0: HYBRID EXTRACTION PROMPTS (facts + summaries)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * System prompt for hybrid extraction (facts + summary)
 */
export const HYBRID_EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant for a developer's AI coding companion. 
Extract TWO types of information from conversations:

## OUTPUT FORMAT
Return a JSON object with two keys:

{
  "facts": [
    {
      "fact": "concise statement (max 200 chars)",
      "category": "preference|decision|project|system|error_pattern|personal|workflow",
      "confidence": 0.0-1.0,
      "source_context": "brief context (max 100 chars)",
      "entity": "primary entity this relates to (optional)",
      "project": "project slug if applicable (optional)"
    }
  ],
  "summary": {
    "topic": "short topic label (max 100 chars)",
    "content": "paragraph summarizing the conversation's key points, decisions, and context (max 500 chars)",
    "entities": ["list", "of", "mentioned", "entities"],
    "projects": ["project-slugs"]
  }
}

## WHAT TO EXTRACT

### Facts (structured, for quick lookup)
- User preferences: "prefers shadcn for UI components"
- Decisions: "chose Llama 4 Scout for Voais voice model"
- Project details: "Bond Analysis uses Next.js frontend + FastAPI backend"
- System info: "runs macOS on M-series, uses Supabase + pgvector"
- Working patterns: "prefers architecture-first approach, then UI"
- Personal context: "building 3 projects: Voais, Bond Analysis, AdaptIQ"

### Summary (semantic, for context recall)
- What was discussed and why
- Key decisions with reasoning
- Current state/progress
- What's planned next (if mentioned)

## CONFIDENCE SCORING
- 0.9-1.0: Explicitly stated ("I want X", "we're using Y")
- 0.7-0.9: Strongly implied from context
- 0.5-0.7: Reasonable inference
- <0.5: Don't include

## CRITICAL RULES
1. Extract from BOTH user and assistant messages
2. The user is a developer building real projects — capture project decisions
3. Even if the assistant is explaining code, extract what the USER asked for and decided
4. Capture tech stack choices, architecture decisions, tool preferences
5. If the conversation is purely about debugging a transient issue with no lasting decisions, return {"facts": [], "summary": null}
6. Be generous with extraction — err on capturing too much rather than too little`;

/**
 * Generate hybrid extraction prompt for a conversation batch
 * 
 * @param {Array<Object>} messages - Conversation messages (user + assistant)
 * @param {Object} [context] - Optional context about user's projects
 * @returns {string} Formatted prompt
 */
export function generateHybridExtractionPrompt(messages, context = {}) {
  // Format messages for extraction
  const formattedMessages = messages
    .map((msg, idx) => {
      const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content);
      
      // Truncate very long messages (more generous than original)
      const truncated = content.length > 1000 
        ? content.slice(0, 1000) + '...' 
        : content;
      
      return `[${idx + 1}] ${role}: ${truncated}`;
    })
    .join('\n\n');
  
  // Build optional project context hint
  let contextHint = '';
  if (context.projects && context.projects.length > 0) {
    contextHint = `\nContext: The developer is working on projects including ${context.projects.join(', ')}.`;
  }
  if (context.techStack) {
    contextHint += ` They use ${context.techStack}.`;
  }
  
  return `Extract memory from this conversation between a developer (USER) and their AI assistant (ASSISTANT):

${formattedMessages}
${contextHint}

Return JSON with "facts" array and "summary" object. If nothing worth remembering, return {"facts": [], "summary": null}.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFLICT DETECTION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * System prompt for conflict detection
 */
export const CONFLICT_DETECTION_PROMPT = `You are a fact conflict detector. Compare two facts and determine if they contradict.

Return JSON with:
{
  "conflicts": boolean,
  "reason": "Brief explanation if conflicts=true",
  "resolution": "keep_latest" | "keep_highest_confidence" | "merge" | "ask_user"
}

CONFLICT RULES:
- Direct contradiction: "prefers X" vs "prefers Y" (where X≠Y for same attribute)
- Outdated info: "uses version 1.0" vs "uses version 2.0"
- Changed preferences: "dislikes testing" vs "loves TDD"

NOT CONFLICTS:
- Different categories (preference vs project)
- Complementary info ("uses Python" + "uses Node.js" is OK)
- Different contexts (work vs personal)

RESOLUTION STRATEGIES:
- keep_latest: Clear update/change (version upgrades, changed preference)
- keep_highest_confidence: One is explicit, other inferred
- merge: Both valid, combine them
- ask_user: Ambiguous, needs clarification`;

/**
 * Generate conflict detection prompt
 * 
 * @param {Object} existingFact - Existing fact from memory
 * @param {Object} newFact - Newly extracted fact
 * @returns {string} Formatted prompt
 */
export function generateConflictPrompt(existingFact, newFact) {
  return `Compare these two facts:

EXISTING FACT:
- Value: ${existingFact.value}
- Category: ${existingFact.category}
- Confidence: ${existingFact.confidence || 'unknown'}
- Created: ${existingFact.createdAt ? new Date(existingFact.createdAt).toISOString() : 'unknown'}

NEW FACT:
- Value: ${newFact.fact}
- Category: ${newFact.category}
- Confidence: ${newFact.confidence}
- Context: ${newFact.source_context}

Do these facts conflict? Return JSON with conflicts, reason, and resolution.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate extracted fact against schema
 * 
 * @param {Object} fact - Extracted fact object
 * @returns {boolean} True if valid
 */
export function validateExtractedFact(fact) {
  if (!fact || typeof fact !== 'object') {
    return false;
  }
  
  if (typeof fact.fact !== 'string' || fact.fact.length === 0) {
    return false;
  }
  if (fact.fact.length > 200) {
    // Truncate instead of rejecting
    fact.fact = fact.fact.slice(0, 197) + '...';
  }
  
  if (!Object.values(FACT_CATEGORIES).includes(fact.category)) {
    // Try to map common variants
    const categoryMap = {
      'tech_stack': 'project',
      'technology': 'project',
      'architecture': 'project',
      'tool': 'system',
      'tools': 'system',
      'environment': 'system',
      'bug': 'error_pattern',
      'error': 'error_pattern',
      'habit': 'workflow',
      'process': 'workflow',
      'choice': 'decision',
      'goal': 'personal',
      'context': 'personal'
    };
    
    const mapped = categoryMap[fact.category?.toLowerCase()];
    if (mapped) {
      fact.category = mapped;
    } else {
      // Default to 'project' as most common
      fact.category = 'project';
    }
  }
  
  if (typeof fact.confidence !== 'number') {
    // Try to parse
    const parsed = parseFloat(fact.confidence);
    if (!isNaN(parsed)) {
      fact.confidence = parsed;
    } else {
      fact.confidence = 0.7; // Default confidence
    }
  }
  if (fact.confidence < 0 || fact.confidence > 1) {
    fact.confidence = Math.max(0, Math.min(1, fact.confidence));
  }
  
  // source_context is optional - add default if missing
  if (!fact.source_context) {
    fact.source_context = 'Extracted from conversation';
  }
  if (typeof fact.source_context !== 'string') {
    fact.source_context = String(fact.source_context);
  }
  if (fact.source_context.length > 100) {
    fact.source_context = fact.source_context.slice(0, 97) + '...';
  }
  
  return true;
}

/**
 * Validate a summary object
 * 
 * @param {Object} summary - Summary object to validate
 * @returns {boolean} True if valid
 */
export function validateSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return false;
  }
  
  // Topic is required
  if (typeof summary.topic !== 'string' || summary.topic.length === 0) {
    return false;
  }
  if (summary.topic.length > 100) {
    summary.topic = summary.topic.slice(0, 97) + '...';
  }
  
  // Content is required
  if (typeof summary.content !== 'string' || summary.content.length === 0) {
    return false;
  }
  if (summary.content.length > 500) {
    summary.content = summary.content.slice(0, 497) + '...';
  }
  
  // Entities should be an array (optional)
  if (summary.entities && !Array.isArray(summary.entities)) {
    if (typeof summary.entities === 'string') {
      summary.entities = [summary.entities];
    } else {
      summary.entities = [];
    }
  }
  if (!summary.entities) {
    summary.entities = [];
  }
  
  // Projects should be an array (optional)
  if (summary.projects && !Array.isArray(summary.projects)) {
    if (typeof summary.projects === 'string') {
      summary.projects = [summary.projects];
    } else {
      summary.projects = [];
    }
  }
  if (!summary.projects) {
    summary.projects = [];
  }
  
  return true;
}

/**
 * Parse and validate LLM extraction response (legacy, facts-only)
 * 
 * @param {string} response - LLM response text
 * @returns {Array<Object>} Valid extracted facts
 */
export function parseExtractionResponse(response) {
  try {
    // Extract JSON from markdown code blocks or plain text
    let jsonText = response.trim();
    
    // Try to extract JSON from code block (handles ```json ... ``` or ``` ... ```)
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    } else {
      // No code block - try to find JSON array directly
      const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        jsonText = arrayMatch[0];
      }
    }
    
    const parsed = JSON.parse(jsonText);
    
    if (!Array.isArray(parsed)) {
      return [];
    }
    
    // Validate and filter facts
    return parsed.filter(validateExtractedFact);
  } catch (err) {
    // Invalid JSON, return empty array
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.1.1: BULLETPROOF RESPONSE NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize LLM response text before JSON parsing.
 * Handles various quirks from different LLM providers:
 * - Literal \n (backslash + n) instead of real newlines
 * - Markdown code blocks (```json ... ```)
 * - Unclosed code blocks (truncated responses)
 * - Extra text before/after JSON
 * 
 * @param {string} text - Raw LLM response text
 * @returns {string} Cleaned text ready for JSON parsing
 */
function normalizeResponseText(text) {
  if (!text || typeof text !== 'string') return '';
  
  let cleaned = text.trim();
  
  // Step 1: Replace literal \n (two-char sequence backslash+n) with real newlines
  // But only if the string doesn't already contain real newlines in JSON context
  // Check: if there are no real newlines but there are literal \n sequences
  if (!cleaned.includes('\n') && cleaned.includes('\\n')) {
    cleaned = cleaned.replace(/\\n/g, '\n');
  }
  
  // Step 2: Replace literal \t with real tabs
  if (cleaned.includes('\\t')) {
    cleaned = cleaned.replace(/\\t/g, '\t');
  }
  
  // Step 3: Strip markdown code blocks
  // Handle COMPLETE code blocks: ```json ... ```
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  } else {
    // Handle UNCLOSED code blocks (truncated response): ```json ...  (no closing ```)
    const openCodeBlock = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*)$/);
    if (openCodeBlock) {
      cleaned = openCodeBlock[1].trim();
    }
  }
  
  // Step 4: Remove any leading/trailing non-JSON text
  // Find where JSON actually starts
  const jsonStart = cleaned.search(/[\[{]/);
  if (jsonStart > 0) {
    cleaned = cleaned.slice(jsonStart);
  }
  
  return cleaned;
}

/**
 * Attempt to repair truncated JSON by extracting complete objects from partial input.
 * 
 * When Gemini hits maxTokens, it cuts off mid-JSON. This function:
 * 1. Tries to find all complete fact objects in the truncated JSON
 * 2. Reconstructs a valid JSON structure from them
 * 3. Attempts to recover the summary if it's complete
 * 
 * @param {string} truncatedJson - Incomplete JSON string
 * @returns {{facts: Array, summary: Object|null}|null} Recovered data or null
 */
function repairTruncatedJson(truncatedJson) {
  if (!truncatedJson || typeof truncatedJson !== 'string') return null;
  
  const facts = [];
  
  // Strategy 1: Extract COMPLETE fact objects using regex
  // Match individual complete JSON objects that look like facts
  const factPattern = /\{\s*"fact"\s*:\s*"[^"]*"\s*,\s*"category"\s*:\s*"[^"]*"\s*,\s*"confidence"\s*:\s*[\d.]+\s*(?:,\s*"[^"]*"\s*:\s*(?:"[^"]*"|[\d.]+|null|\[[^\]]*\])\s*)*\}/g;
  
  const factMatches = truncatedJson.match(factPattern);
  const seenFacts = new Set();
  
  if (factMatches) {
    for (const match of factMatches) {
      try {
        const fact = JSON.parse(match);
        if (fact && fact.fact && fact.category && !seenFacts.has(fact.fact)) {
          seenFacts.add(fact.fact);
          facts.push(fact);
        }
      } catch (e) {
        // Individual fact parse failed, skip it
      }
    }
  }
  
  // Strategy 2: Extract facts from INCOMPLETE objects (truncated mid-object)
  // Look for fact+category+confidence even if the object isn't closed
  const partialFactPattern = /"fact"\s*:\s*"([^"]+)"\s*,\s*"category"\s*:\s*"([^"]+)"\s*,\s*"confidence"\s*:\s*([\d.]+)/g;
  let partialMatch;
  while ((partialMatch = partialFactPattern.exec(truncatedJson)) !== null) {
    const factText = partialMatch[1];
    if (!seenFacts.has(factText)) {
      seenFacts.add(factText);
      // Extract source_context if available (might be truncated)
      const afterConfidence = truncatedJson.slice(partialMatch.index + partialMatch[0].length);
      const sourceMatch = afterConfidence.match(/^\s*,\s*"source_context"\s*:\s*"([^"]*)"/);
      
      facts.push({
        fact: factText,
        category: partialMatch[2],
        confidence: parseFloat(partialMatch[3]),
        source_context: sourceMatch ? sourceMatch[1] : 'Extracted from conversation'
      });
    }
  }
  
  // Strategy 3: Try to extract the summary object if it exists and is complete
  let summary = null;
  const summaryPattern = /"summary"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/;
  const summaryMatch = truncatedJson.match(summaryPattern);
  
  if (summaryMatch) {
    try {
      summary = JSON.parse(summaryMatch[1]);
      if (!summary.topic || !summary.content) {
        summary = null;
      }
    } catch (e) {
      summary = null;
    }
  }
  
  if (facts.length > 0 || summary) {
    return { facts, summary };
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.1.1: HYBRID RESPONSE PARSER (bulletproof)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse and validate hybrid LLM extraction response
 * 
 * v2.1.1 REWRITE - Bulletproof multi-strategy parser:
 * 
 * 1. Normalize text (literal \n, code blocks, etc.)
 * 2. Try JSON.parse on full cleaned text
 * 3. Try extracting JSON object { ... }
 * 4. Try extracting JSON array [ ... ]
 * 5. Attempt truncated JSON repair (recover partial facts)
 * 6. Never throws — always returns valid structure
 * 
 * @param {string} response - LLM response text
 * @returns {{facts: Array<Object>, summary: Object|null}} Parsed hybrid result
 */
export function parseHybridExtractionResponse(response) {
  if (!response || typeof response !== 'string') {
    return { facts: [], summary: null };
  }
  
  // ═══ Step 1: Normalize the response text ═══
  const jsonText = normalizeResponseText(response);
  
  if (!jsonText) {
    return { facts: [], summary: null };
  }
  
  // ═══ Step 2: Try direct JSON.parse ═══
  let parsed = tryParseJSON(jsonText);
  
  // ═══ Step 3: Try extracting JSON object from text ═══
  if (!parsed) {
    const objectMatch = jsonText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      parsed = tryParseJSON(objectMatch[0]);
    }
  }
  
  // ═══ Step 4: Try extracting JSON array from text ═══
  if (!parsed) {
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      parsed = tryParseJSON(arrayMatch[0]);
    }
  }
  
  // ═══ Step 5: Successful parse — validate and return ═══
  if (parsed) {
    return normalizeHybridResult(parsed);
  }
  
  // ═══ Step 6: All parsing failed — try truncated JSON repair ═══
  const repaired = repairTruncatedJson(jsonText);
  if (repaired) {
    const validFacts = repaired.facts.filter(validateExtractedFact);
    const validSummary = (repaired.summary && validateSummary(repaired.summary))
      ? repaired.summary
      : null;
    
    return { facts: validFacts, summary: validSummary };
  }
  
  // ═══ Step 7: Also try repair on the original response (before normalization) ═══
  // In case normalization mangled something
  const repairedOriginal = repairTruncatedJson(response);
  if (repairedOriginal) {
    const validFacts = repairedOriginal.facts.filter(validateExtractedFact);
    const validSummary = (repairedOriginal.summary && validateSummary(repairedOriginal.summary))
      ? repairedOriginal.summary
      : null;
    
    if (validFacts.length > 0 || validSummary) {
      return { facts: validFacts, summary: validSummary };
    }
  }
  
  // Ultimate fallback — nothing recoverable
  return { facts: [], summary: null };
}

/**
 * Safe JSON parse that never throws
 * @param {string} text 
 * @returns {any|null}
 */
function tryParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * Normalize a successfully parsed result into the standard {facts, summary} format
 * @param {any} parsed - Parsed JSON value
 * @returns {{facts: Array<Object>, summary: Object|null}}
 */
function normalizeHybridResult(parsed) {
  // Case A: Hybrid format {facts: [...], summary: {...}}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const facts = Array.isArray(parsed.facts) 
      ? parsed.facts.filter(validateExtractedFact) 
      : [];
    
    const summary = (parsed.summary && typeof parsed.summary === 'object' && validateSummary(parsed.summary))
      ? parsed.summary 
      : null;
    
    return { facts, summary };
  }
  
  // Case B: Old array format [...] (backward compat)
  if (Array.isArray(parsed)) {
    return { facts: parsed.filter(validateExtractedFact), summary: null };
  }
  
  return { facts: [], summary: null };
}

/**
 * Parse conflict detection response
 * 
 * @param {string} response - LLM response text
 * @returns {Object|null} Parsed conflict info or null if invalid
 */
export function parseConflictResponse(response) {
  try {
    let jsonText = response.trim();
    
    // Remove markdown code blocks
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.slice(7);
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.slice(3);
    }
    
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.slice(0, -3);
    }
    
    const parsed = JSON.parse(jsonText.trim());
    
    // Validate structure
    if (typeof parsed.conflicts !== 'boolean') return null;
    if (parsed.conflicts && typeof parsed.reason !== 'string') return null;
    
    const validResolutions = ['keep_latest', 'keep_highest_confidence', 'merge', 'ask_user'];
    if (parsed.resolution && !validResolutions.includes(parsed.resolution)) return null;
    
    return parsed;
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  FACT_CATEGORIES,
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  HYBRID_EXTRACTION_SYSTEM_PROMPT,
  CONFLICT_DETECTION_PROMPT,
  generateExtractionPrompt,
  generateHybridExtractionPrompt,
  generateConflictPrompt,
  validateExtractedFact,
  validateSummary,
  parseExtractionResponse,
  parseHybridExtractionResponse,
  parseConflictResponse
};
