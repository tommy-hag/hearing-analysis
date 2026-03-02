/**
 * Micro-Summary Quote Validator
 *
 * Validates that sourceQuotes extracted during micro-summarize actually exist
 * in the original response text. Catches LLM hallucinations early in the pipeline.
 *
 * Should run immediately after citation-registry step to catch issues before
 * expensive downstream processing.
 */

export class MicroSummaryQuoteValidator {
  constructor(options = {}) {
    // Similarity threshold for fuzzy matching (0.0-1.0)
    this.similarityThreshold = options.similarityThreshold || 0.85;
    // Whether to attempt auto-fix by finding closest match in source
    this.suggestFixes = options.suggestFixes !== false;
    this.verbose = options.verbose || false;
  }

  /**
   * Normalize text for comparison
   * Handles whitespace, newlines, and common variations
   */
  normalizeText(text) {
    if (!text) return '';
    return text
      .trim()
      .replace(/\s+/g, ' ')           // Collapse whitespace
      .replace(/[""]/g, '"')          // Normalize quotes
      .replace(/['']/g, "'")          // Normalize apostrophes
      .toLowerCase();
  }

  /**
   * Calculate similarity between two strings using Levenshtein-based approach
   * Returns value between 0.0 (no match) and 1.0 (exact match)
   */
  calculateSimilarity(str1, str2) {
    const s1 = this.normalizeText(str1);
    const s2 = this.normalizeText(str2);

    if (s1 === s2) return 1.0;
    if (!s1 || !s2) return 0.0;

    // For very different lengths, quick rejection
    const lengthRatio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
    if (lengthRatio < 0.5) return lengthRatio * 0.5;

    // Check if one contains the other (common for truncation issues)
    if (s1.includes(s2) || s2.includes(s1)) {
      return 0.9 + (lengthRatio * 0.1);
    }

    // Simple word overlap for longer texts
    const words1 = new Set(s1.split(' ').filter(w => w.length > 2));
    const words2 = new Set(s2.split(' ').filter(w => w.length > 2));
    const intersection = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * Check if a quote exists in the source text
   * Returns { found, exactMatch, similarity, suggestion }
   */
  findQuoteInSource(quote, sourceText) {
    if (!quote || !sourceText) {
      return { found: false, exactMatch: false, similarity: 0, suggestion: null };
    }

    const normalizedQuote = this.normalizeText(quote);
    const normalizedSource = this.normalizeText(sourceText);

    // Check exact match (normalized)
    if (normalizedSource.includes(normalizedQuote)) {
      return { found: true, exactMatch: true, similarity: 1.0, suggestion: null };
    }

    // Check with original (preserving case)
    if (sourceText.includes(quote)) {
      return { found: true, exactMatch: true, similarity: 1.0, suggestion: null };
    }

    // Try fuzzy matching - find best matching substring
    let bestSimilarity = 0;
    let bestMatch = null;

    // Split source into sentences and check each
    const sentences = sourceText.split(/[.!?]+/).filter(s => s.trim().length > 10);

    for (const sentence of sentences) {
      const similarity = this.calculateSimilarity(quote, sentence.trim());
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = sentence.trim();
      }
    }

    // Also check against full paragraphs
    const paragraphs = sourceText.split(/\n\n+/).filter(p => p.trim().length > 10);
    for (const para of paragraphs) {
      const similarity = this.calculateSimilarity(quote, para.trim());
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = para.trim();
      }
    }

    // If good enough similarity, consider it found
    const found = bestSimilarity >= this.similarityThreshold;

    return {
      found,
      exactMatch: false,
      similarity: bestSimilarity,
      suggestion: this.suggestFixes && bestMatch ? bestMatch : null
    };
  }

  /**
   * Extract a reasonable quote from source text
   * Used as fallback when LLM hallucinated a quote
   */
  extractFallbackQuote(sourceText, maxLength = 300) {
    if (!sourceText) return null;

    // Try to get first meaningful paragraph
    const paragraphs = sourceText.split(/\n\n+/).filter(p => p.trim().length > 20);
    if (paragraphs.length > 0) {
      const firstPara = paragraphs[0].trim();
      if (firstPara.length <= maxLength) {
        return firstPara;
      }
      // Truncate at sentence boundary
      const sentences = firstPara.match(/[^.!?]+[.!?]+/g) || [firstPara];
      let result = '';
      for (const sentence of sentences) {
        if ((result + sentence).length <= maxLength) {
          result += sentence;
        } else {
          break;
        }
      }
      return result.trim() || firstPara.substring(0, maxLength) + '...';
    }

    // Fallback: just use start of text
    return sourceText.substring(0, maxLength).trim() + (sourceText.length > maxLength ? '...' : '');
  }

  /**
   * Validate all citations in a citation registry against original responses
   *
   * @param {Object} citationRegistry - The citation registry export (with .citations)
   * @param {Array} responses - Original responses with {id, text}
   * @returns {Object} Validation result with issues and stats
   */
  validateCitationRegistry(citationRegistry, responses) {
    const issues = [];
    const stats = {
      totalCitations: 0,
      validCitations: 0,
      exactMatches: 0,
      fuzzyMatches: 0,
      hallucinations: 0,
      missingSourceText: 0
    };

    // Build response text map
    const responseTextMap = new Map();
    responses.forEach(r => {
      const id = r.id || r.responseNumber;
      const text = r.text || r.responseText || r.text_md || '';
      responseTextMap.set(id, text);
    });

    // Get citations object
    const citations = citationRegistry.citations || citationRegistry;

    for (const [citeId, citation] of Object.entries(citations)) {
      stats.totalCitations++;

      const responseNumber = citation.responseNumber;
      const quote = citation.quote;
      const sourceText = responseTextMap.get(responseNumber);

      if (!sourceText) {
        stats.missingSourceText++;
        issues.push({
          citeId,
          responseNumber,
          type: 'missing_source',
          message: `No source text found for response ${responseNumber}`,
          quote: quote?.substring(0, 100)
        });
        continue;
      }

      if (!quote) {
        issues.push({
          citeId,
          responseNumber,
          type: 'empty_quote',
          message: 'Citation has no quote'
        });
        continue;
      }

      const result = this.findQuoteInSource(quote, sourceText);

      if (result.found) {
        stats.validCitations++;
        if (result.exactMatch) {
          stats.exactMatches++;
        } else {
          stats.fuzzyMatches++;
          if (this.verbose) {
            console.log(`[QuoteValidator] Fuzzy match for ${citeId} (${(result.similarity * 100).toFixed(1)}%)`);
          }
        }
      } else {
        stats.hallucinations++;

        // Generate a suggested fix from actual source text
        const fallbackQuote = this.extractFallbackQuote(sourceText);

        issues.push({
          citeId,
          responseNumber,
          type: 'hallucination',
          message: `Quote not found in source text (best similarity: ${(result.similarity * 100).toFixed(1)}%)`,
          hallucinated: quote,
          suggestion: result.suggestion,
          fallbackQuote,
          similarity: result.similarity
        });
      }
    }

    return {
      valid: stats.hallucinations === 0,
      issues,
      stats,
      summary: this.generateSummary(stats)
    };
  }

  /**
   * Generate human-readable summary
   */
  generateSummary(stats) {
    const parts = [];
    parts.push(`${stats.validCitations}/${stats.totalCitations} citations valid`);

    if (stats.exactMatches > 0) {
      parts.push(`${stats.exactMatches} exact matches`);
    }
    if (stats.fuzzyMatches > 0) {
      parts.push(`${stats.fuzzyMatches} fuzzy matches`);
    }
    if (stats.hallucinations > 0) {
      parts.push(`⚠️ ${stats.hallucinations} HALLUCINATIONS detected`);
    }
    if (stats.missingSourceText > 0) {
      parts.push(`${stats.missingSourceText} missing source`);
    }

    return parts.join(', ');
  }

  /**
   * Apply fixes to citation registry based on validation results
   * Returns a new registry with hallucinated quotes replaced by fallbacks
   */
  applyFixes(citationRegistry, validationResult) {
    if (validationResult.valid) {
      return { registry: citationRegistry, fixCount: 0 };
    }

    // Deep clone the registry
    const fixedRegistry = JSON.parse(JSON.stringify(citationRegistry));
    let fixCount = 0;

    for (const issue of validationResult.issues) {
      if (issue.type === 'hallucination' && issue.fallbackQuote) {
        const citeId = issue.citeId;
        if (fixedRegistry.citations?.[citeId]) {
          fixedRegistry.citations[citeId].quote = issue.fallbackQuote;
          fixedRegistry.citations[citeId]._autoFixed = true;
          fixedRegistry.citations[citeId]._originalHallucination = issue.hallucinated;
          fixedRegistry.citations[citeId]._fixedAt = new Date().toISOString();
          fixCount++;

          console.log(`[QuoteValidator] Auto-fixed ${citeId} (response ${issue.responseNumber})`);
        }
      }
    }

    return { registry: fixedRegistry, fixCount };
  }
}

export default MicroSummaryQuoteValidator;
