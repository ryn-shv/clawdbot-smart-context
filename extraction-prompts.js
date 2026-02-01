/**
 * Phase 4B: LLM-Based Fact Extraction Prompts
 * 
 * Structured prompts for extracting facts, preferences, and patterns
 * from conversations using Gemini Flash 2.5 (cheap, fast).
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
// EXTRACTION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * System prompt for fact extraction
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are a fact extraction assistant. Extract important, reusable facts from conversations.

CATEGORIES:
- preference: User likes/dislikes, habits, preferences
- decision: Explicit choices or decisions made
- project: Project context, architecture, codebase info
- system: System setup, environment, tools used
- error_pattern: Recurring errors or troubleshooting patterns
- personal: Personal info (name, role, location, etc.)
- workflow: User's typical workflows or processes

RULES:
1. Extract ONLY facts that are:
   - Permanent or long-lasting (not temporary states)
   - Specific and actionable (not vague statements)
   - Relevant for future conversations
   
2. DO NOT extract:
   - Tool calls or system messages
   - Error messages themselves (extract patterns only)
   - Temporary states ("I'm debugging now")
   - Opinions about current task
   
3. Confidence scoring:
   - 0.9-1.0: Explicitly stated by user ("I prefer X", "My name is Y")
   - 0.7-0.9: Strongly implied from context
   - 0.5-0.7: Inferred from behavior patterns
   - <0.5: DO NOT extract (too uncertain)

4. Keep facts concise and clear (max 200 chars)

OUTPUT: JSON array of extracted facts. Return empty array [] if nothing to extract.`;

/**
 * Generate extraction prompt for a conversation batch
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
  if (!fact || typeof fact !== 'object') return false;
  
  if (typeof fact.fact !== 'string' || fact.fact.length === 0) return false;
  if (fact.fact.length > 200) return false;
  
  if (!Object.values(FACT_CATEGORIES).includes(fact.category)) return false;
  
  if (typeof fact.confidence !== 'number') return false;
  if (fact.confidence < 0 || fact.confidence > 1) return false;
  
  if (typeof fact.source_context !== 'string') return false;
  if (fact.source_context.length > 100) return false;
  
  return true;
}

/**
 * Parse and validate LLM extraction response
 * 
 * @param {string} response - LLM response text
 * @returns {Array<Object>} Valid extracted facts
 */
export function parseExtractionResponse(response) {
  try {
    // Try to extract JSON from response (handle markdown code blocks)
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
    
    jsonText = jsonText.trim();
    
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
  CONFLICT_DETECTION_PROMPT,
  generateExtractionPrompt,
  generateConflictPrompt,
  validateExtractedFact,
  parseExtractionResponse,
  parseConflictResponse
};
