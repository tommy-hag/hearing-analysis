/**
 * Citation Integrity Validator
 *
 * Ensures citations remain unchanged throughout pipeline processing.
 * Validates that sourceQuotes match original text exactly.
 */

import { StepLogger } from '../utils/step-logger.js';

export class CitationIntegrityValidator {
  constructor(options = {}) {
    this.strictMode = options.strictMode !== false;
    this.verbose = options.verbose || false;
    this.log = new StepLogger('CitationIntegrityValidator');
  }

  /**
   * Validate that sourceQuotes exist and are non-empty
   * @param {Array} microSummaries - Output from MicroSummarizer
   * @returns {Object} Validation result
   */
  validateMicroSummaryQuotes(microSummaries) {
    this.log.start({ microSummaries: microSummaries.length });

    const issues = [];
    let totalQuotes = 0;
    let missingQuotes = 0;
    let emptyQuotes = 0;

    microSummaries.forEach(summary => {
      if (!summary.arguments || !Array.isArray(summary.arguments)) {
        issues.push({
          responseNumber: summary.responseNumber,
          type: 'missing_arguments',
          message: 'No arguments array in micro summary'
        });
        return;
      }

      summary.arguments.forEach((arg, idx) => {
        totalQuotes++;
        
        if (!arg.sourceQuote) {
          missingQuotes++;
          issues.push({
            responseNumber: summary.responseNumber,
            argumentIndex: idx,
            type: 'missing_quote',
            message: 'sourceQuote field is missing'
          });
        } else if (typeof arg.sourceQuote !== 'string' || arg.sourceQuote.trim() === '') {
          emptyQuotes++;
          issues.push({
            responseNumber: summary.responseNumber,
            argumentIndex: idx,
            type: 'empty_quote',
            message: 'sourceQuote is empty or not a string'
          });
        } else if (arg.sourceQuote.length < 10) {
          issues.push({
            responseNumber: summary.responseNumber,
            argumentIndex: idx,
            type: 'too_short',
            message: `sourceQuote suspiciously short: "${arg.sourceQuote}"`
          });
        }
      });
    });

    const validQuotes = totalQuotes - missingQuotes - emptyQuotes;
    this.log.percentage('Valid quotes', validQuotes, totalQuotes);

    if (issues.length > 0) {
      this.log.distribution('Issues', { missing: missingQuotes, empty: emptyQuotes });
    }

    this.log.complete({ totalQuotes, issues: issues.length });

    return {
      valid: issues.length === 0,
      issues,
      stats: {
        totalQuotes,
        missingQuotes,
        emptyQuotes,
        validQuotes
      }
    };
  }

  /**
   * Normalize text for comparison (ignore whitespace differences)
   * @private
   */
  normalizeText(text) {
    if (!text) return '';
    return text.trim().replace(/\s+/g, ' ');
  }

  /**
   * Validate that quotes in output match source quotes exactly
   * @param {Array} positions - Positions with hybridReferences
   * @param {Array} microSummaries - Original micro summaries with sourceQuotes
   * @param {Array} rawResponses - Original response texts
   * @returns {Object} Validation result
   */
  validatePositionWriterQuotes(positions, microSummaries, rawResponses) {
    this.log.start({ positions: positions.length, microSummaries: microSummaries.length });

    const issues = [];
    let totalQuotesChecked = 0;
    let exactMatches = 0;
    let modifiedQuotes = 0;
    let notFoundInSource = 0;

    // Build a map of responseNumber -> response text for validation
    const responseTextMap = new Map();
    rawResponses.forEach(response => {
      responseTextMap.set(response.id, response.text || '');
    });

    // Build a map of responseNumber -> sourceQuotes
    const sourceQuoteMap = new Map();
    microSummaries.forEach(summary => {
      const quotes = [];
      if (summary.arguments && Array.isArray(summary.arguments)) {
        summary.arguments.forEach(arg => {
          if (arg.sourceQuote && arg.sourceQuote.trim()) {
            quotes.push(arg.sourceQuote);
          }
        });
      }
      sourceQuoteMap.set(summary.responseNumber, quotes);
    });

    // Check each position
    positions.forEach(position => {
      if (!position.hybridReferences || !Array.isArray(position.hybridReferences)) {
        return;
      }

      position.hybridReferences.forEach((ref, refIdx) => {
        if (!ref.quotes || !Array.isArray(ref.quotes)) {
          return;
        }

        ref.quotes.forEach((quoteObj, quoteIdx) => {
          if (!quoteObj.quote || typeof quoteObj.quote !== 'string') {
            return;
          }

          totalQuotesChecked++;
          const quote = quoteObj.quote.trim();
          const responseNumber = quoteObj.responseNumber;

          // Check if quote contains placeholder text
          if (quote.includes('[MANGLER') || quote.includes('sourceQuote ikke tilgængelig')) {
            issues.push({
              position: position.title,
              referenceId: ref.id,
              quoteIndex: quoteIdx,
              responseNumber,
              type: 'placeholder_quote',
              message: 'Quote contains placeholder text'
            });
            return;
          }

          // Get original source quotes for this response
          const sourceQuotes = sourceQuoteMap.get(responseNumber) || [];
          
          // Check if quote exactly matches any sourceQuote
          const exactMatch = sourceQuotes.some(sq => sq.trim() === quote);
          if (exactMatch) {
            exactMatches++;
          } else {
            // Check if it's a modified version of a sourceQuote
            const similarQuote = sourceQuotes.find(sq => 
              this.calculateSimilarity(sq, quote) > 0.8
            );
            
            if (similarQuote) {
              modifiedQuotes++;
              issues.push({
                position: position.title,
                referenceId: ref.id,
                quoteIndex: quoteIdx,
                responseNumber,
                type: 'modified_quote',
                message: 'Quote was modified from original',
                original: similarQuote,
                modified: quote
              });
            } else {
          // Check if quote exists in original response text
          const responseText = responseTextMap.get(responseNumber) || '';
          const normalizedResponse = this.normalizeText(responseText);
          const normalizedQuote = this.normalizeText(quote);
          
          if (!responseText.includes(quote) && !normalizedResponse.includes(normalizedQuote)) {
            notFoundInSource++;
            issues.push({
              position: position.title,
              referenceId: ref.id,
              quoteIndex: quoteIdx,
              responseNumber,
              type: 'not_in_source',
              message: 'Quote not found in original response text',
              quote
            });
          }
            }
          }
        });
      });
    });

    const accuracy = totalQuotesChecked > 0 ? exactMatches / totalQuotesChecked : 0;
    this.log.percentage('Exact matches', exactMatches, totalQuotesChecked);

    if (modifiedQuotes > 0 || notFoundInSource > 0) {
      this.log.distribution('Issues', { modified: modifiedQuotes, notFound: notFoundInSource });
    }

    this.log.complete({ checked: totalQuotesChecked, accuracy: `${(accuracy * 100).toFixed(1)}%` });

    return {
      valid: issues.length === 0 && totalQuotesChecked > 0,
      issues,
      stats: {
        totalQuotesChecked,
        exactMatches,
        modifiedQuotes,
        notFoundInSource,
        accuracy
      }
    };
  }

  /**
   * Validate hybrid references structure and notes
   * @param {Array} positions - Positions with hybridReferences
   * @returns {Object} Validation result
   */
  validateHybridReferences(positions) {
    const issues = [];
    const forbiddenPhrases = [
      'deludkast',
      'oprindelige deludkast',
      'ikke indsat',
      'individuelle kildecitater var ikke',
      'Se respondenternes individuelle',
      'Citatuddrag er ikke indsat',
      'liste over svarnumre',
      'Gruppen omfatter',
      'individuelle citater ikke udskrevet'
    ];

    positions.forEach(position => {
      if (!position.hybridReferences) return;

      // Check for double references in summary
      const doubleRefPattern = /<<REF_\d+>><<REF_\d+>>/g;
      const doubleRefs = position.summary?.match(doubleRefPattern) || [];
      if (doubleRefs.length > 0) {
        issues.push({
          position: position.title,
          type: 'double_reference',
          message: `Found double references: ${doubleRefs.join(', ')}`
        });
      }

      position.hybridReferences.forEach(ref => {
        // Check for forbidden phrases in notes
        if (ref.notes && typeof ref.notes === 'string') {
          forbiddenPhrases.forEach(phrase => {
            if (ref.notes.toLowerCase().includes(phrase)) {
              issues.push({
                position: position.title,
                referenceId: ref.id,
                type: 'forbidden_notes',
                message: `Notes contain forbidden phrase: "${phrase}"`,
                notes: ref.notes
              });
            }
          });
        }

        // Validate quotes array structure
        if (ref.quotes && Array.isArray(ref.quotes)) {
          ref.quotes.forEach((quoteObj, idx) => {
            if (!quoteObj.responseNumber || !quoteObj.quote) {
              issues.push({
                position: position.title,
                referenceId: ref.id,
                quoteIndex: idx,
                type: 'malformed_quote',
                message: 'Quote object missing responseNumber or quote field'
              });
            }
          });
        }

        // Check for >15 respondents rule
        if (ref.respondents && ref.respondents.length > 15) {
          if (ref.quotes && ref.quotes.length > 5) {
            issues.push({
              position: position.title,
              referenceId: ref.id,
              type: 'too_many_quotes',
              message: `Reference has ${ref.respondents.length} respondents but ${ref.quotes.length} quotes (should be 3-5)`
            });
          }
        }
      });
    });

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * Validate that sub-positions are properly used in output when required
   * When a position has subPositions, the summary should contain multiple references
   * corresponding to the different sub-groups
   * 
   * @param {Array} positions - Positions with potential subPositions
   * @returns {Object} Validation result with warnings (not failures)
   */
  validateSubPositionUsage(positions) {
    const warnings = [];
    let positionsWithSubPositions = 0;
    let positionsWithMultipleRefs = 0;

    positions.forEach(position => {
      // Check if this position has sub-positions
      if (!position.subPositions || position.subPositions.length === 0) {
        return; // No sub-positions, nothing to validate
      }

      positionsWithSubPositions++;

      // Count references in summary
      const refPattern = /<<REF_\d+>>/g;
      const refs = position.summary?.match(refPattern) || [];
      const uniqueRefs = new Set(refs).size;

      // We expect roughly as many references as sub-positions (or at least 2+)
      if (uniqueRefs >= 2) {
        positionsWithMultipleRefs++;
      } else {
        // Only 1 or 0 references for a position with sub-positions - not ideal
        warnings.push({
          position: position.title,
          type: 'missing_sub_position_refs',
          subPositionCount: position.subPositions.length,
          referenceCount: uniqueRefs,
          message: `Position har ${position.subPositions.length} sub-positioner men kun ${uniqueRefs} reference(r) i summary. Nuancer kan mangle.`,
          severity: 'WARNING'
        });
      }

      // Check if respondents are distributed across references
      if (position.hybridReferences) {
        const allRefRespondents = position.hybridReferences.reduce((sum, ref) => {
          return sum + (ref.respondents?.length || 0);
        }, 0);
        
        const totalRespondents = position.responseNumbers?.length || 0;
        
        // If all respondents are in a single reference, nuances may be lost
        const largestRef = Math.max(...position.hybridReferences.map(r => r.respondents?.length || 0), 0);
        if (largestRef > totalRespondents * 0.8 && position.subPositions.length >= 2) {
          warnings.push({
            position: position.title,
            type: 'concentrated_references',
            message: `${largestRef}/${totalRespondents} respondenter er i samme reference. Sub-positioner bør fordele respondenter mere jævnt.`,
            severity: 'WARNING'
          });
        }
      }
    });

    return {
      valid: warnings.length === 0,
      warnings,
      stats: {
        positionsWithSubPositions,
        positionsWithMultipleRefs,
        subPositionUtilization: positionsWithSubPositions > 0 
          ? (positionsWithMultipleRefs / positionsWithSubPositions * 100).toFixed(1) + '%'
          : 'N/A'
      }
    };
  }

  /**
   * Calculate similarity between two strings (simple implementation)
   * @private
   */
  calculateSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;
    
    // Simple character overlap ratio
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) matches++;
    }
    
    return matches / longer.length;
  }

  /**
   * Create a summary report of all validations
   * @param {Object} microSummaryValidation - Result from validateMicroSummaryQuotes
   * @param {Object} positionWriterValidation - Result from validatePositionWriterQuotes
   * @param {Object} hybridRefValidation - Result from validateHybridReferences
   * @returns {Object} Summary report
   */
  createValidationReport(microSummaryValidation, positionWriterValidation, hybridRefValidation) {
    const allValid = 
      microSummaryValidation.valid && 
      positionWriterValidation.valid && 
      hybridRefValidation.valid;

    const report = {
      valid: allValid,
      summary: {
        microSummaries: {
          valid: microSummaryValidation.valid,
          stats: microSummaryValidation.stats,
          issueCount: microSummaryValidation.issues.length
        },
        positionWriter: {
          valid: positionWriterValidation.valid,
          stats: positionWriterValidation.stats,
          issueCount: positionWriterValidation.issues.length
        },
        hybridReferences: {
          valid: hybridRefValidation.valid,
          issueCount: hybridRefValidation.issues.length
        }
      }
    };

    if (this.verbose) {
      report.details = {
        microSummaryIssues: microSummaryValidation.issues,
        positionWriterIssues: positionWriterValidation.issues,
        hybridRefIssues: hybridRefValidation.issues
      };
    }

    return report;
  }
}
