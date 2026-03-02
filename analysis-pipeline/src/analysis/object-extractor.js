/**
 * ObjectExtractor
 * 
 * Extracts primary objects from arguments to enable object-aware grouping.
 * Examples: "Palads", "Bygning A", "Gammel Køge Landevej", "boldbane"
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';

export class ObjectExtractor {
  constructor(options = {}) {
    // Use LIGHT complexity for simple extraction task
    try {
      const complexityConfig = getComplexityConfig(options.complexityLevel || 'light');
      this.client = new OpenAIClientWrapper({
        model: options.model || complexityConfig.model,
        verbosity: options.verbosity || complexityConfig.verbosity,
        reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
        timeout: options.timeout || 30000
      });
    } catch (error) {
      console.warn('[ObjectExtractor] Failed to initialize LLM client:', error.message);
      this.client = null;
    }

    this.cache = new Map(); // Cache to avoid re-extracting same arguments
  }

  /**
   * Extract primary objects from a batch of arguments
   * @param {Array} args - Arguments to extract objects from
   * @returns {Promise<Array>} Array of objects for each argument
   */
  async extractObjects(args) {
    if (!this.client || args.length === 0) {
      return args.map(() => null);
    }

    console.log(`[ObjectExtractor] Extracting objects from ${args.length} arguments...`);

    try {
      // Build prompt for batch extraction
      const argumentsText = args.map((arg, idx) => {
        const key = this.getCacheKey(arg);
        if (this.cache.has(key)) {
          return null; // Skip cached
        }
        
        const parts = [];
        if (arg.coreContent) parts.push(arg.coreContent);
        if (arg.concern) parts.push(arg.concern);
        if (arg.desiredAction) parts.push(arg.desiredAction);
        
        return `[${idx}] ${parts.join(' | ')}`;
      }).filter(Boolean);

      if (argumentsText.length === 0) {
        // All cached
        return args.map(arg => this.cache.get(this.getCacheKey(arg)));
      }

      const prompt = `Du er ekspert i at identificere primære objekter i høringssvar.

**Opgave:** For hvert argument, identificér det PRIMÆRE FYSISKE OBJEKT eller GEOGRAFISKE STED som argumentet handler om.

**Eksempler på objekter:**
- Bygninger: "Palads", "Bygning A", "skole", "daginstitution"
- Infrastruktur: "Gammel Køge Landevej", "Værkstedvej", "stibro", "boldbane"
- Områder: "foyer", "facade", "byrum F"

**Regler:**
- Returnér KONKRET navn hvis nævnt (fx "Palads", "Bygning A")
- Returnér GENERISK type hvis ikke konkret navn (fx "bygning", "vej", "boldbane")
- Returnér null hvis argumentet handler om PROCES/POLITIK snarere end fysisk objekt (fx "beslutningsproces", "høringsproces")

**Argumenter:**
${argumentsText.join('\n\n')}

**Output:** JSON array med object for hver [idx], fx: [{"idx": 0, "object": "Palads"}, {"idx": 1, "object": "Gammel Køge Landevej"}, {"idx": 2, "object": null}]`;

      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du identificerer primære objekter i høringssvar-argumenter.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: getResponseFormat('objectExtraction')
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in LLM response');
      }

      const parsed = JSON.parse(content);
      const extractedObjects = parsed.objects || [];

      // Build result array with cached values
      const results = [];
      let extractedIdx = 0;

      for (const arg of args) {
        const key = this.getCacheKey(arg);
        if (this.cache.has(key)) {
          results.push(this.cache.get(key));
        } else {
          const extracted = extractedObjects.find(e => e.idx === extractedIdx);
          const object = extracted?.object || null;
          
          // Cache result
          this.cache.set(key, object);
          results.push(object);
          extractedIdx++;
        }
      }

      const objectCount = results.filter(Boolean).length;
      console.log(`[ObjectExtractor] Extracted ${objectCount}/${args.length} objects`);

      return results;
    } catch (error) {
      console.warn('[ObjectExtractor] Extraction failed:', error.message);
      return args.map(() => null); // Fallback: no objects
    }
  }

  /**
   * Create cache key for an argument
   * @private
   */
  getCacheKey(arg) {
    const parts = [];
    if (arg.coreContent) parts.push(arg.coreContent.slice(0, 100));
    if (arg.concern) parts.push(arg.concern.slice(0, 50));
    return parts.join('|');
  }

  /**
   * Check if two objects should be considered the same for grouping
   * @param {string} obj1 - First object
   * @param {string} obj2 - Second object
   * @returns {boolean} Should group together?
   */
  shouldGroupTogether(obj1, obj2) {
    // Null objects always allow grouping (no object constraint)
    if (!obj1 || !obj2) return true;

    // Normalize for comparison
    const norm1 = obj1.toLowerCase().trim();
    const norm2 = obj2.toLowerCase().trim();

    // Exact match
    if (norm1 === norm2) return true;

    // Handle generic vs specific (e.g., "bygning" matches "Bygning A")
    if (norm1.includes(norm2) || norm2.includes(norm1)) {
      return true;
    }

    // Different objects - should NOT group
    return false;
  }

  /**
   * Set Job ID for LLM tracing
   * @param {string} jobId - The job ID to set on the LLM client
   */
  setJobId(jobId) {
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
  }
}

