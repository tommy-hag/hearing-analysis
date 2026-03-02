/**
 * Citation Validator
 * 
 * Validates citation quality, formatting, and alignment with summaries.
 * Ensures citations are trustworthy and properly support claims.
 */

export class CitationValidator {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
    this.strictMode = options.strictMode !== false; // Default to strict validation
  }

  /**
   * Validate all citations in analysis results
   * @param {Object} analysisResult - Complete analysis result
   * @param {Array} originalResponses - Original response texts for verification
   * @returns {Object} Validation report
   */
  validateAnalysis(analysisResult, originalResponses = []) {
    const report = {
      valid: true,
      totalPositions: 0,
      totalCitations: 0,
      errors: [],
      warnings: [],
      stats: {
        missingCitations: 0,
        malformedCitations: 0,
        misalignedCitations: 0,
        nonExistentCitations: 0,
        emptyQuotes: 0,
        truncatedQuotes: 0
      }
    };

    // Create response lookup map
    const responseMap = new Map(
      originalResponses.map(r => [r.id || r.responseNumber, r.text || ''])
    );

    // Validate each topic
    for (const topic of (analysisResult.topics || [])) {
      for (const position of (topic.positions || [])) {
        report.totalPositions++;
        
        // Validate position citations
        const positionValidation = this.validatePosition(position, responseMap);
        report.totalCitations += positionValidation.citationCount;
        
        if (!positionValidation.valid) {
          report.valid = false;
          report.errors.push(...positionValidation.errors);
          report.warnings.push(...positionValidation.warnings);
          
          // Update stats
          for (const [key, value] of Object.entries(positionValidation.stats)) {
            report.stats[key] = (report.stats[key] || 0) + value;
          }
        }
      }
    }

    // Add summary
    report.summary = this.generateSummary(report);
    
    if (this.verbose) {
      this.logReport(report);
    }

    return report;
  }

  /**
   * Validate citations for a single position
   * @private
   */
  validatePosition(position, responseMap) {
    const validation = {
      valid: true,
      citationCount: 0,
      errors: [],
      warnings: [],
      stats: {
        missingCitations: 0,
        malformedCitations: 0,
        misalignedCitations: 0,
        nonExistentCitations: 0,
        emptyQuotes: 0,
        truncatedQuotes: 0
      }
    };

    const positionContext = `Position "${position.title}"`;

    // Check if position has required respondent information
    const respondentCount = position.responseNumbers?.length || 0;
    if (respondentCount === 0) {
      validation.valid = false;
      validation.errors.push(`${positionContext}: No response numbers assigned`);
      return validation;
    }

    // Validate hybrid references (new system)
    if (position.hybridReferences && position.hybridReferences.length > 0) {
      validation.citationCount = position.hybridReferences.length;
      
      for (const ref of position.hybridReferences) {
        const refValidation = this.validateHybridReference(ref, position, responseMap);
        if (!refValidation.valid) {
          validation.valid = false;
          validation.errors.push(...refValidation.errors.map(e => `${positionContext}: ${e}`));
          validation.warnings.push(...refValidation.warnings.map(w => `${positionContext}: ${w}`));
          
          // Update stats
          for (const [key, value] of Object.entries(refValidation.stats)) {
            validation.stats[key] = (validation.stats[key] || 0) + value;
          }
        }
      }
    }

    // Validate old-style citations if present
    if (position.citations && position.citations.length > 0) {
      validation.citationCount += position.citations.length;
      
      for (const citation of position.citations) {
        const citValidation = this.validateCitation(citation, position, responseMap);
        if (!citValidation.valid) {
          validation.valid = false;
          validation.errors.push(...citValidation.errors.map(e => `${positionContext}: ${e}`));
          validation.warnings.push(...citValidation.warnings.map(w => `${positionContext}: ${w}`));
          
          // Update stats
          for (const [key, value] of Object.entries(citValidation.stats)) {
            validation.stats[key] = (validation.stats[key] || 0) + value;
          }
        }
      }
    }

    // Check citation coverage
    if (validation.citationCount === 0) {
      validation.valid = false;
      validation.errors.push(`${positionContext}: No citations found for ${respondentCount} respondents`);
      validation.stats.missingCitations = respondentCount;
    } else if (validation.citationCount < respondentCount * 0.5 && this.strictMode) {
      // In strict mode, warn if less than 50% of respondents have citations
      validation.warnings.push(
        `${positionContext}: Only ${validation.citationCount} citations for ${respondentCount} respondents`
      );
    }

    return validation;
  }

  /**
   * Validate hybrid reference
   * @private
   */
  validateHybridReference(ref, position, responseMap) {
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      stats: {}
    };

    // Check basic structure
    if (!ref.id) {
      validation.valid = false;
      validation.errors.push('Hybrid reference missing ID');
      validation.stats.malformedCitations = 1;
    }

    if (!ref.label || !ref.label.trim()) {
      validation.valid = false;
      validation.errors.push(`Reference ${ref.id}: Missing label`);
      validation.stats.malformedCitations = 1;
    }

    // Validate quotes
    if (ref.quotes && Array.isArray(ref.quotes)) {
      for (const quoteObj of ref.quotes) {
        if (!quoteObj.quote || !quoteObj.quote.trim()) {
          validation.valid = false;
          validation.errors.push(`Reference ${ref.id}: Empty quote`);
          validation.stats.emptyQuotes = 1;
        } else if (quoteObj.quote.includes('[MANGLER')) {
          validation.valid = false;
          validation.errors.push(`Reference ${ref.id}: Missing quote placeholder found`);
          validation.stats.missingCitations = 1;
        } else if (quoteObj.quote.length < 10 && this.strictMode) {
          validation.warnings.push(`Reference ${ref.id}: Very short quote (${quoteObj.quote.length} chars)`);
        }

        // Verify quote exists in source
        // Uses fuzzy matching to allow for minor variations (whitespace, punctuation, prefix stripping)
        if (quoteObj.responseNumber && responseMap.has(quoteObj.responseNumber)) {
          const sourceText = responseMap.get(quoteObj.responseNumber);
          if (sourceText) {
            const quoteFound = this.fuzzyQuoteMatch(quoteObj.quote, sourceText);
            if (!quoteFound) {
            validation.valid = false;
            validation.errors.push(
              `Reference ${ref.id}: Quote not found in response ${quoteObj.responseNumber}`
            );
            validation.stats.nonExistentCitations = 1;
            }
          }
        }
      }
    } else if (ref.skipCitationExtraction) {
      // Deliberately skipped by PositionWriter - this is valid (same group/back-reference)
      // No error needed
    } else if (!ref.notes || !ref.notes.trim()) {
      // No quotes and no notes
      validation.valid = false;
      validation.errors.push(`Reference ${ref.id}: No quotes or notes provided`);
      validation.stats.missingCitations = 1;
    }

    // Check alignment with summary
    if (position.summary && ref.label) {
      const summaryLower = position.summary.toLowerCase();
      const labelLower = ref.label.toLowerCase();
      if (!summaryLower.includes(labelLower)) {
        validation.warnings.push(`Reference ${ref.id}: Label "${ref.label}" not found in summary`);
        validation.stats.misalignedCitations = 1;
      }
    }

    return validation;
  }

  /**
   * Validate old-style citation
   * @private
   */
  validateCitation(citation, position, responseMap) {
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      stats: {}
    };

    // Check basic structure
    if (!citation.responseNumber) {
      validation.valid = false;
      validation.errors.push('Citation missing response number');
      validation.stats.malformedCitations = 1;
    }

    if (!citation.comment || !citation.comment.trim()) {
      validation.valid = false;
      validation.errors.push(`Citation for response ${citation.responseNumber}: Empty comment`);
      validation.stats.emptyQuotes = 1;
    }

    // Check if citation text appears to be truncated
    if (citation.comment && citation.comment.endsWith('...')) {
      validation.stats.truncatedQuotes = 1;
      if (this.strictMode) {
        validation.warnings.push(
          `Citation for response ${citation.responseNumber}: Appears to be truncated`
        );
      }
    }

    // Verify highlight exists in summary
    if (citation.highlight && position.summary) {
      if (!position.summary.includes(citation.highlight)) {
        validation.valid = false;
        validation.errors.push(
          `Citation for response ${citation.responseNumber}: Highlight "${citation.highlight}" not found in summary`
        );
        validation.stats.misalignedCitations = 1;
      }
    }

    return validation;
  }

  /**
   * Generate summary of validation results
   * @private
   */
  generateSummary(report) {
    const errorTypes = Object.entries(report.stats)
      .filter(([_, count]) => count > 0)
      .map(([type, count]) => `${type}: ${count}`)
      .join(', ');

    const citationCoverage = report.totalPositions > 0
      ? ((report.totalCitations / report.totalPositions) * 100).toFixed(1)
      : 0;

    return {
      status: report.valid ? 'VALID' : 'INVALID',
      positionsCovered: `${report.totalPositions} positions analyzed`,
      citationCoverage: `${citationCoverage}% average citations per position`,
      errorSummary: errorTypes || 'No errors found',
      recommendation: this.getRecommendation(report)
    };
  }

  /**
   * Get recommendation based on validation results
   * @private
   */
  getRecommendation(report) {
    if (report.valid && report.warnings.length === 0) {
      return 'Citations are well-formatted and properly aligned.';
    }
    
    if (report.stats.missingCitations > 10) {
      return 'Many citations are missing. Re-run citation extraction with lower thresholds.';
    }
    
    if (report.stats.nonExistentCitations > 5) {
      return 'Several citations do not match source text. Check for text preprocessing issues.';
    }
    
    if (report.stats.misalignedCitations > 5) {
      return 'Citations are not well-aligned with summaries. Review position writing logic.';
    }
    
    if (!report.valid) {
      return 'Critical citation issues found. Review and fix before finalizing.';
    }
    
    return 'Minor issues found. Review warnings for quality improvements.';
  }

  /**
   * Log validation report
   * @private
   */
  logReport(report) {
    console.log('\n[CitationValidator] Validation Report:');
    console.log(`- Status: ${report.summary.status}`);
    console.log(`- Positions: ${report.totalPositions}`);
    console.log(`- Citations: ${report.totalCitations}`);
    console.log(`- Coverage: ${report.summary.citationCoverage}`);
    
    if (report.errors.length > 0) {
      console.log('\nERRORS:');
      report.errors.slice(0, 10).forEach(e => console.log(`  ❌ ${e}`));
      if (report.errors.length > 10) {
        console.log(`  ... and ${report.errors.length - 10} more errors`);
      }
    }
    
    if (report.warnings.length > 0) {
      console.log('\nWARNINGS:');
      report.warnings.slice(0, 5).forEach(w => console.log(`  ⚠️  ${w}`));
      if (report.warnings.length > 5) {
        console.log(`  ... and ${report.warnings.length - 5} more warnings`);
      }
    }
    
    console.log(`\nRecommendation: ${report.summary.recommendation}\n`);
  }

  /**
   * Validate citation formatting in markdown
   * @param {string} markdown - Formatted markdown with CriticMarkup
   * @returns {Object} Format validation results
   */
  validateMarkdownFormat(markdown) {
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      stats: {
        criticMarkupBlocks: 0,
        malformedBlocks: 0,
        emptyComments: 0,
        escapedCharacters: 0
      }
    };

    // Check for CriticMarkup blocks
    const criticMarkupPattern = /\{==([^=]+)==\}\s*\{>>([^<]*?)<<\}/g;
    let match;
    
    while ((match = criticMarkupPattern.exec(markdown)) !== null) {
      validation.stats.criticMarkupBlocks++;
      
      const highlight = match[1];
      const comment = match[2];
      
      // Check for empty comments
      if (!comment.trim()) {
        validation.valid = false;
        validation.errors.push(`Empty CriticMarkup comment for highlight: "${highlight}"`);
        validation.stats.emptyComments++;
      }
      
      // Check for escaped characters in comments
      if (comment.includes('\\n') || comment.includes('\\t') || comment.includes('\\"')) {
        validation.valid = false;
        validation.errors.push(`Escaped characters found in comment for: "${highlight}"`);
        validation.stats.escapedCharacters++;
      }
    }

    // Check for malformed CriticMarkup
    const malformedPattern = /\{==([^}]+)$|\{>>([^}]+)$/gm;
    if (malformedPattern.test(markdown)) {
      validation.valid = false;
      validation.errors.push('Malformed CriticMarkup blocks detected');
      validation.stats.malformedBlocks++;
    }

    return validation;
  }

  /**
   * Fuzzy quote matching to allow for minor variations
   * Handles cases where quotes have been slightly modified during processing:
   * - Whitespace normalization
   * - Prefix stripping (e.g., "I bedes" → "Bedes")
   * - Minor punctuation differences
   *
   * IMPORTANT: Primary validation is contiguous substring matching (not word overlap).
   * Word overlap check (secondary) requires 90% match AND preserves word order.
   * This prevents LLM hallucinations from passing validation.
   *
   * @param {string} quote - The quote to find
   * @param {string} sourceText - The original source text
   * @returns {boolean} True if quote substantially matches source
   */
  fuzzyQuoteMatch(quote, sourceText) {
    if (!quote || !sourceText) return false;

    // Exact match - fast path
    if (sourceText.includes(quote)) {
      return true;
    }

    // Normalize both for fuzzy comparison
    const normalizeText = (text) => {
      return text
        .toLowerCase()
        .replace(/\s+/g, ' ')  // Normalize whitespace
        .replace(/[.,;:!?"'„"«»\-–—]/g, '')  // Remove punctuation
        .trim();
    };

    const normalizedQuote = normalizeText(quote);
    const normalizedSource = normalizeText(sourceText);

    // PRIMARY CHECK: Contiguous substring match (normalized)
    // This is the most reliable check - the quote must appear as a continuous string
    if (normalizedSource.includes(normalizedQuote)) {
      return true;
    }

    // Check if first 50 characters of normalized quote match (contiguous)
    // This catches prefix-stripped quotes
    const quoteStart = normalizedQuote.substring(0, 50);
    if (quoteStart.length >= 20 && normalizedSource.includes(quoteStart)) {
      return true;
    }

    // Check if last 50 characters match (contiguous, for leading text stripped)
    const quoteEnd = normalizedQuote.substring(Math.max(0, normalizedQuote.length - 50));
    if (quoteEnd.length >= 20 && normalizedSource.includes(quoteEnd)) {
      return true;
    }

    // SECONDARY CHECK: Word overlap with ORDER preservation
    // This is stricter than before - requires 90% AND preserves order
    const quoteWords = normalizedQuote.split(' ').filter(w => w.length > 2);
    if (quoteWords.length < 3) {
      // Very short quote - require exact normalized match (already failed above)
      return false;
    }

    // Check if 90% of words appear in source IN ORDER (increased from 80%, now with order)
    // Find the longest contiguous sequence of quote words in source
    const sourceWords = normalizedSource.split(' ').filter(w => w.length > 2);
    let maxContiguousMatch = 0;

    for (let i = 0; i < sourceWords.length; i++) {
      let quoteIdx = 0;
      let contiguousCount = 0;

      for (let j = i; j < sourceWords.length && quoteIdx < quoteWords.length; j++) {
        if (sourceWords[j] === quoteWords[quoteIdx]) {
          contiguousCount++;
          quoteIdx++;
        } else if (contiguousCount > 0) {
          // Allow small gaps (1-2 words) for minor variations
          // But don't reset if we're close to a match
          const nextMatch = quoteWords.findIndex((w, idx) => idx > quoteIdx && sourceWords[j] === w);
          if (nextMatch > 0 && nextMatch - quoteIdx <= 2) {
            quoteIdx = nextMatch + 1;
            contiguousCount++;
          }
        }
      }

      maxContiguousMatch = Math.max(maxContiguousMatch, contiguousCount);
    }

    const contiguousMatchRatio = maxContiguousMatch / quoteWords.length;
    if (contiguousMatchRatio >= 0.9) {
      return true;
    }

    return false;
  }
}
