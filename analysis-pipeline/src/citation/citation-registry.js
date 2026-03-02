/**
 * Citation Registry for preserving quote integrity throughout the pipeline
 * 
 * This registry stores verified citations from MicroSummarizer and provides
 * unique IDs that can be passed to LLMs instead of full quotes, ensuring
 * citations are never modified by subsequent processing steps.
 */

export class CitationRegistry {
  constructor() {
    this.citations = new Map();
    this.citationsByResponse = new Map(); // responseNumber -> Set of citation IDs
    this.nextId = 1;
  }

  /**
   * Register a new citation and get its unique ID
   * @param {number} responseNumber - The response number this citation belongs to
   * @param {string} quote - The exact quote text
   * @param {Object} metadata - Additional metadata (argument index, themes, etc.)
   * @returns {string} Unique citation ID (e.g., "CITE_001")
   */
  registerCitation(responseNumber, quote, metadata = {}) {
    // Check if this exact quote already exists for this response
    const existingId = this.findExistingCitation(responseNumber, quote);
    if (existingId) {
      return existingId;
    }

    // Generate new ID
    const citationId = `CITE_${String(this.nextId).padStart(3, '0')}`;
    this.nextId++;

    // Store citation
    this.citations.set(citationId, {
      id: citationId,
      responseNumber,
      quote,
      metadata,
      verified: true,
      registeredAt: new Date().toISOString()
    });

    // Update response index
    if (!this.citationsByResponse.has(responseNumber)) {
      this.citationsByResponse.set(responseNumber, new Set());
    }
    this.citationsByResponse.get(responseNumber).add(citationId);

    return citationId;
  }

  /**
   * Find existing citation for a response with exact quote match
   * @param {number} responseNumber 
   * @param {string} quote 
   * @returns {string|null} Citation ID if found, null otherwise
   */
  findExistingCitation(responseNumber, quote) {
    const responseCitations = this.citationsByResponse.get(responseNumber);
    if (!responseCitations) return null;

    for (const citationId of responseCitations) {
      const citation = this.citations.get(citationId);
      if (citation.quote === quote) {
        return citationId;
      }
    }
    return null;
  }

  /**
   * Get citation by ID
   * @param {string} citationId 
   * @returns {Object|null} Citation object or null if not found
   */
  getCitation(citationId) {
    return this.citations.get(citationId) || null;
  }

  /**
   * Alias for getCitation - for compatibility with Map-like interface
   * @param {string} citationId 
   * @returns {Object|null} Citation object or null if not found
   */
  get(citationId) {
    return this.getCitation(citationId);
  }

  /**
   * Get all citations for a response
   * @param {number} responseNumber 
   * @returns {Array} Array of citation objects
   */
  getCitationsForResponse(responseNumber) {
    const citationIds = this.citationsByResponse.get(responseNumber);
    if (!citationIds) return [];

    return Array.from(citationIds)
      .map(id => this.citations.get(id))
      .filter(Boolean);
  }

  /**
   * Transform micro-summaries to replace quotes with citation IDs
   * @param {Array} microSummaries - Original micro-summaries with sourceQuote fields
   * @returns {Array} Transformed summaries with sourceQuoteRef fields
   */
  transformMicroSummaries(microSummaries) {
    return microSummaries.map(summary => {
      if (!summary.arguments) return summary;

      const transformedArguments = summary.arguments.map((arg, index) => {
        if (!arg.sourceQuote || arg.sourceQuote.trim() === '') {
          return arg;
        }

        // Register citation and get ID
        const citationId = this.registerCitation(
          summary.responseNumber,
          arg.sourceQuote,
          {
            argumentIndex: index,
            themes: arg.relevantThemes || [],
            what: arg.what,
            why: arg.why
          }
        );

        // Replace sourceQuote with reference
        const { sourceQuote, ...argWithoutQuote } = arg;
        return {
          ...argWithoutQuote,
          sourceQuoteRef: citationId
        };
      });

      return {
        ...summary,
        arguments: transformedArguments
      };
    });
  }

  /**
   * Replace citation IDs with actual quotes in output
   * @param {Object} output - Output containing citation IDs
   * @returns {Object} Output with actual quotes restored
   */
  resolveCitations(output) {
    if (!output.references) return output;

    const resolvedReferences = output.references.map(ref => {
      if (!ref.quotes) return ref;

      const resolvedQuotes = ref.quotes.map(quoteItem => {
        // Handle both string IDs and objects with IDs
        if (typeof quoteItem === 'string') {
          const citation = this.getCitation(quoteItem);
          if (!citation) {
            console.warn(`[CitationRegistry] Citation ID not found: ${quoteItem}`);
            return {
              responseNumber: 0,
              quote: `[CITATION NOT FOUND: ${quoteItem}]`
            };
          }
          return {
            responseNumber: citation.responseNumber,
            quote: citation.quote
          };
        }
        
        // If it's already an object with responseNumber and quote, return as-is
        if (quoteItem.responseNumber && quoteItem.quote) {
          return quoteItem;
        }

        // If it's an object with citationId
        if (quoteItem.citationId) {
          const citation = this.getCitation(quoteItem.citationId);
          if (!citation) {
            console.warn(`[CitationRegistry] Citation ID not found: ${quoteItem.citationId}`);
            return {
              responseNumber: quoteItem.responseNumber || 0,
              quote: `[CITATION NOT FOUND: ${quoteItem.citationId}]`
            };
          }
          return {
            responseNumber: citation.responseNumber,
            quote: citation.quote
          };
        }

        console.warn('[CitationRegistry] Unknown quote format:', quoteItem);
        return quoteItem;
      });

      return {
        ...ref,
        quotes: resolvedQuotes
      };
    });

    return {
      ...output,
      references: resolvedReferences
    };
  }

  /**
   * Get statistics about the registry
   * @returns {Object} Registry statistics
   */
  getStats() {
    return {
      totalCitations: this.citations.size,
      totalResponses: this.citationsByResponse.size,
      citationsPerResponse: Array.from(this.citationsByResponse.entries())
        .map(([responseNumber, citations]) => ({
          responseNumber,
          count: citations.size
        }))
    };
  }

  /**
   * Export registry for debugging or persistence
   * @returns {Object} Serializable registry data
   */
  export() {
    // Export as object for easier hydration (key = internal index, value = citation with .id)
    const citationsObject = {};
    this.citations.forEach((citation, key) => {
      citationsObject[key] = citation;
    });
    
    return {
      citations: citationsObject,
      stats: this.getStats(),
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Hydrate the registry from a checkpoint (used for incremental mode)
   * This loads baseline citations so that reused micro-summaries can resolve their CITE_xxx references.
   * New citations will be assigned IDs that don't conflict with the baseline.
   * 
   * @param {Object} checkpoint - The citation-registry checkpoint data
   * @param {Object} options - Options for hydration
   * @param {boolean} options.merge - If true, merge with existing citations (default: false = replace)
   * @returns {Object} Hydration stats
   */
  hydrateFromCheckpoint(checkpoint, options = {}) {
    const { merge = false } = options;
    
    if (!checkpoint?.citations) {
      console.warn('[CitationRegistry] No citations in checkpoint to hydrate');
      return { hydrated: 0, skipped: 0, maxId: 0 };
    }

    // If not merging, clear existing data
    if (!merge) {
      this.citations = new Map();
      this.citationsByResponse = new Map();
    }

    let hydrated = 0;
    let skipped = 0;
    let maxIdNum = 0;

    // Process each citation from checkpoint
    for (const [key, citation] of Object.entries(checkpoint.citations)) {
      // Extract numeric ID from CITE_xxx format
      const idMatch = citation.id?.match(/CITE_(\d+)/);
      if (idMatch) {
        const idNum = parseInt(idMatch[1], 10);
        maxIdNum = Math.max(maxIdNum, idNum);
      }

      // Skip if already exists (when merging)
      if (merge && this.citations.has(citation.id)) {
        skipped++;
        continue;
      }

      // Add citation to registry
      this.citations.set(citation.id, citation);

      // Update citationsByResponse index
      const responseNumber = citation.responseNumber;
      if (!this.citationsByResponse.has(responseNumber)) {
        this.citationsByResponse.set(responseNumber, new Set());
      }
      this.citationsByResponse.get(responseNumber).add(citation.id);

      hydrated++;
    }

    // Update nextId to avoid conflicts with baseline citations
    this.nextId = Math.max(this.nextId, maxIdNum + 1);

    return { hydrated, skipped, maxId: maxIdNum };
  }

  /**
   * Import fixes from a validated/fixed registry export
   * Updates citations in place with corrected quotes
   *
   * @param {Object} fixedRegistry - Registry export with _autoFixed citations
   * @returns {Object} Stats about imported fixes
   */
  importFixes(fixedRegistry) {
    let fixCount = 0;

    if (!fixedRegistry?.citations) {
      return { fixCount: 0 };
    }

    for (const [citeId, citation] of Object.entries(fixedRegistry.citations)) {
      if (citation._autoFixed && this.citations.has(citeId)) {
        const existing = this.citations.get(citeId);
        existing.quote = citation.quote;
        existing._autoFixed = true;
        existing._originalHallucination = citation._originalHallucination;
        existing._fixedAt = citation._fixedAt;
        fixCount++;
      }
    }

    if (fixCount > 0) {
      console.log(`[CitationRegistry] Imported ${fixCount} quote fixes`);
    }

    return { fixCount };
  }
}
