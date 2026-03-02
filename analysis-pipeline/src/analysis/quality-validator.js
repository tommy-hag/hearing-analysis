/**
 * Quality Validator
 * 
 * Validates aggregated analysis output for quality issues:
 * - Summary substance (not just title repetition)
 * - Citation length (focused, not entire responses)
 * - highlightContextual uniqueness
 */

export class QualityValidator {
  constructor(options = {}) {
    this.minSummaryLength = options.minSummaryLength || 30;
    this.targetCitationLength = options.targetCitationLength || 300; // Typical 2-5 sentences
    this.maxCitationLength = options.maxCitationLength || 800; // Absolute max (extreme cases only)
    this.warnings = [];
  }

  /**
   * Validate aggregated analysis result
   * @param {Object} analysisResult - Analysis result with topics and positions
   * @returns {Object} Validation result with warnings
   */
  validate(analysisResult) {
    this.warnings = [];

    if (!analysisResult || !analysisResult.topics) {
      this.warnings.push({
        type: 'error',
        message: 'Invalid analysis result: missing topics'
      });
      return this.getValidationResult();
    }

    // Validate each topic and position
    analysisResult.topics.forEach((topic, topicIdx) => {
      if (!topic.positions || !Array.isArray(topic.positions)) {
        this.warnings.push({
          type: 'error',
          theme: topic.name,
          message: 'Invalid topic: missing positions array'
        });
        return;
      }

      topic.positions.forEach((position, posIdx) => {
        this.validatePosition(position, topic.name, posIdx);
      });
    });

    return this.getValidationResult();
  }

  /**
   * Validate a single position
   * @param {Object} position - Position object
   * @param {string} themeName - Theme name for context
   * @param {number} positionIdx - Position index for context
   */
  validatePosition(position, themeName, positionIdx) {
    const context = `${themeName} - Position ${positionIdx + 1}: ${position.title}`;

    // 1. Check summary substance
    this.validateSummary(position, context);

    // 2. Check citations
    this.validateCitations(position, context);

    // 3. Check highlightContextual uniqueness
    this.validateHighlightContextual(position, context);
  }

  /**
   * Validate summary quality
   * @param {Object} position - Position object
   * @param {string} context - Context string for warnings
   */
  validateSummary(position, context) {
    const summary = position.summary || '';
    const title = position.title || '';

    // Check minimum length
    if (summary.length < this.minSummaryLength) {
      this.warnings.push({
        type: 'warning',
        category: 'summary_too_short',
        context: context,
        message: `Summary is too short (${summary.length} chars). Should be at least ${this.minSummaryLength} chars.`,
        value: summary
      });
    }

    // Check if summary just repeats the title
    const summaryLower = summary.toLowerCase().trim();
    const titleLower = title.toLowerCase().replace(/^\(\d+(?:,\s*[LUO]+)?\)\s*/, '').trim();
    
    // Remove common prefix patterns from title for comparison
    const titleCore = titleLower.replace(/^(ønske om|modstand mod|krav om|støtte til|bekymring for|kritik af)\s+/, '');
    
    if (summaryLower.startsWith(titleCore) && summary.length < 50) {
      this.warnings.push({
        type: 'warning',
        category: 'summary_repeats_title',
        context: context,
        message: 'Summary appears to just repeat the title without adding value',
        title: title,
        summary: summary
      });
    }

    // Check for generic/lazy summaries
    const lazyPatterns = [
      /^(en|to|tre|fire|fem|seks|syv|otte|ni|ti|\d+)\s+(borger|borgere|respondent|respondenter)\s+(ønske|ønsker|modstand|krav|kritik|bekymring|støtte)\.?$/i,
      /^(lokaludvalg|myndighed)\s+(ønske|ønsker|modstand|krav|kritik|bekymring|støtte)\.?$/i
    ];

    for (const pattern of lazyPatterns) {
      if (pattern.test(summaryLower)) {
        this.warnings.push({
          type: 'warning',
          category: 'summary_too_generic',
          context: context,
          message: 'Summary is too generic and lacks detail (should explain WHAT, WHY, and HOW)',
          summary: summary
        });
        break;
      }
    }
  }

  /**
   * Validate citations quality
   * @param {Object} position - Position object
   * @param {string} context - Context string for warnings
   */
  validateCitations(position, context) {
    const citations = position.citations || [];
    const hybridReferences = position.hybridReferences || [];
    const summary = position.summary || '';
    const responseNumbers = position.responseNumbers || [];

    const citedResponseNumbers = new Set();

    // Check hybridReferences first (new format)
    if (hybridReferences.length > 0) {
      hybridReferences.forEach(ref => {
        if (ref.quotes && Array.isArray(ref.quotes)) {
          ref.quotes.forEach(quote => {
            if (quote.responseNumber) {
              citedResponseNumbers.add(quote.responseNumber);
            }
          });
        }
      });
    }
    // Check old citations format
    else if (citations.length > 0) {
      citations.forEach(citation => {
        const match = (citation.comment || '').match(/\*\*Henvendelse (\d+)\*\*/);
        if (match) {
          citedResponseNumbers.add(parseInt(match[1], 10));
        }
      });
    } 
    // Check summary text as fallback
    else {
      const matches = summary.match(/\*\*Henvendelse (\d+)\*\*/g) || [];
      matches.forEach(match => {
        const numMatch = match.match(/\d+/);
        if (numMatch) {
          citedResponseNumbers.add(parseInt(numMatch[0], 10));
        }
      });

      if (citedResponseNumbers.size === 0) {
        this.warnings.push({
          type: 'info',
          category: 'no_citations',
          context: context,
          message: 'Position has no citations'
        });
      }
    }

    const missingCitations = responseNumbers.filter(num => !citedResponseNumbers.has(num));
    if (missingCitations.length > 0) {
      this.warnings.push({
        type: 'error',
        category: 'missing_citation_coverage',
        context: context,
        message: `CRITICAL: ${missingCitations.length} responseNumbers missing citations: ${missingCitations.join(', ')}. ALL responseNumbers MUST have at least one citation.`,
        missingResponseNumbers: missingCitations,
        totalResponseNumbers: responseNumbers.length,
        citedResponseNumbers: Array.from(citedResponseNumbers).sort((a, b) => a - b)
      });
    }

    citations.forEach((citation, idx) => {
      // Check citation length
      const citationText = citation.comment || '';
      // Remove formatting: **Henvendelse X**\n*"..."*
      const cleanCitation = citationText.replace(/\*\*Henvendelse \d+\*\*\\n\*"(.+)"\*/s, '$1');
      
      // Warn if exceeds absolute max
      if (cleanCitation.length > this.maxCitationLength) {
        this.warnings.push({
          type: 'error',
          category: 'citation_too_long',
          context: `${context} - Citation ${idx + 1}`,
          message: `Citation is too long (${cleanCitation.length} chars). Absolute max is ${this.maxCitationLength} chars. Find the essence!`,
          length: cleanCitation.length,
          citation: cleanCitation.substring(0, 100) + '...'
        });
      } else if (cleanCitation.length > this.targetCitationLength) {
        // Info if exceeds target but under max
        this.warnings.push({
          type: 'info',
          category: 'citation_longer_than_typical',
          context: `${context} - Citation ${idx + 1}`,
          message: `Citation is ${cleanCitation.length} chars (typical: ${this.targetCitationLength} chars for 2-5 sentences). Acceptable if argument is complex.`,
          length: cleanCitation.length
        });
      }

      // Check highlightContextual uniqueness
      const highlightContextual = citation.highlightContextual || '';
      if (highlightContextual) {
        const occurrences = this.countOccurrences(summary, highlightContextual);
        if (occurrences > 1) {
          this.warnings.push({
            type: 'error',
            category: 'highlight_not_unique',
            context: `${context} - Citation ${idx + 1}`,
            message: `highlightContextual appears ${occurrences} times in summary (must be unique)`,
            highlightContextual: highlightContextual,
            summary: summary
          });
        } else if (occurrences === 0) {
          this.warnings.push({
            type: 'error',
            category: 'highlight_not_found',
            context: `${context} - Citation ${idx + 1}`,
            message: 'highlightContextual not found in summary',
            highlightContextual: highlightContextual,
            summary: summary
          });
        }
      }

      // Check highlight is substring of highlightContextual
      const highlight = citation.highlight || '';
      if (highlight && highlightContextual) {
        if (!highlightContextual.toLowerCase().includes(highlight.toLowerCase())) {
          this.warnings.push({
            type: 'error',
            category: 'highlight_mismatch',
            context: `${context} - Citation ${idx + 1}`,
            message: 'highlight is not a substring of highlightContextual',
            highlight: highlight,
            highlightContextual: highlightContextual
          });
        }
      }
    });
  }

  /**
   * Validate highlightContextual uniqueness
   * @param {Object} position - Position object
   * @param {string} context - Context string for warnings
   */
  validateHighlightContextual(position, context) {
    const citations = position.citations || [];
    const summary = position.summary || '';

    if (citations.length === 0) {
      return;
    }

    // Check all highlightContextual values are unique
    const highlightContextuals = citations.map(c => c.highlightContextual).filter(Boolean);
    const uniqueSet = new Set(highlightContextuals.map(h => h.toLowerCase()));
    
    if (highlightContextuals.length !== uniqueSet.size) {
      this.warnings.push({
        type: 'error',
        category: 'duplicate_highlight_contextuals',
        context: context,
        message: 'Multiple citations have the same highlightContextual value',
        highlightContextuals: highlightContextuals
      });
    }
  }

  /**
   * Count occurrences of substring in string (case-insensitive)
   * @param {string} text - Text to search in
   * @param {string} substring - Substring to find
   * @returns {number} Number of occurrences
   */
  countOccurrences(text, substring) {
    if (!text || !substring) return 0;
    const textLower = text.toLowerCase();
    const substringLower = substring.toLowerCase();
    let count = 0;
    let pos = 0;
    while ((pos = textLower.indexOf(substringLower, pos)) !== -1) {
      count++;
      pos += substringLower.length;
    }
    return count;
  }

  /**
   * Get validation result
   * @returns {Object} Validation result with stats and warnings
   */
  getValidationResult() {
    const errors = this.warnings.filter(w => w.type === 'error');
    const warnings = this.warnings.filter(w => w.type === 'warning');
    const info = this.warnings.filter(w => w.type === 'info');

    return {
      valid: errors.length === 0,
      errorCount: errors.length,
      warningCount: warnings.length,
      infoCount: info.length,
      warnings: this.warnings
    };
  }

  /**
   * Format validation warnings for logging
   * @param {Object} validationResult - Result from validate()
   * @returns {string} Formatted warning text
   */
  formatWarnings(validationResult) {
    if (validationResult.warnings.length === 0) {
      return 'No quality issues found.';
    }

    let output = `Quality Validation Summary:\n`;
    output += `  Errors: ${validationResult.errorCount}\n`;
    output += `  Warnings: ${validationResult.warningCount}\n`;
    output += `  Info: ${validationResult.infoCount}\n\n`;

    const groupedWarnings = {};
    validationResult.warnings.forEach(w => {
      const category = w.category || w.type;
      if (!groupedWarnings[category]) {
        groupedWarnings[category] = [];
      }
      groupedWarnings[category].push(w);
    });

    Object.keys(groupedWarnings).forEach(category => {
      const categoryWarnings = groupedWarnings[category];
      output += `${category.toUpperCase()} (${categoryWarnings.length}):\n`;
      categoryWarnings.forEach(w => {
        output += `  - ${w.context || 'Unknown context'}: ${w.message}\n`;
      });
      output += '\n';
    });

    return output;
  }
}

