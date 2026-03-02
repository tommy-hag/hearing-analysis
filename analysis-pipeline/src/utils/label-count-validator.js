/**
 * LabelCountValidator
 * 
 * Validates and auto-fixes mismatches between reference labels and respondent counts.
 * 
 * CRITICAL: Prevents outputs where "Seks borgere" is claimed but only 3 henvendelser are cited.
 * This is a root-cause fix for the label/respondent mismatch bug.
 */

import { DanishNumberFormatter } from './danish-number-formatter.js';

export class LabelCountValidator {
  /**
   * Danish number words (lowercase) for parsing labels
   */
  static DANISH_NUMBERS_TO_INT = {
    'én': 1, 'en': 1, 'et': 1,
    'to': 2,
    'tre': 3,
    'fire': 4,
    'fem': 5,
    'seks': 6,
    'syv': 7,
    'otte': 8,
    'ni': 9,
    'ti': 10,
    'elleve': 11,
    'tolv': 12
  };

  /**
   * Parse the count from a label string
   * @param {string} label - Label like "tre borgere", "12 borgere", "Valby Lokaludvalg"
   * @returns {number|null} Parsed count or null if not a count-based label
   */
  static parseCountFromLabel(label) {
    if (!label || typeof label !== 'string') return null;

    const lowerLabel = label.toLowerCase().trim();

    // 1. Check for digit-based count: "12 borgere", "107 respondenter"
    const digitMatch = lowerLabel.match(/^(\d+)\s+/);
    if (digitMatch) {
      return parseInt(digitMatch[1], 10);
    }

    // 2. Check for Danish word-based count: "tre borgere", "Seks respondenter"
    for (const [word, num] of Object.entries(this.DANISH_NUMBERS_TO_INT)) {
      if (lowerLabel.startsWith(word + ' ')) {
        return num;
      }
    }

    // 3. Special case: "én borger" (singular)
    if (lowerLabel.includes('én borger') || lowerLabel.includes('en borger')) {
      return 1;
    }

    // 4. Not a count-based label (e.g., "Valby Lokaludvalg", "grundejerforeningen")
    return null;
  }

  /**
   * Check if a label is count-based (borgere/respondenter) vs. named entity
   * @param {string} label - Label to check
   * @returns {boolean} True if count-based, false if named entity
   */
  static isCountBasedLabel(label) {
    if (!label) return false;
    const lowerLabel = label.toLowerCase();
    
    // Count-based keywords
    const countKeywords = ['borger', 'borgere', 'respondent', 'respondenter', 'henvendelse', 'henvendelser'];
    
    return countKeywords.some(kw => lowerLabel.includes(kw));
  }

  /**
   * Validate a single reference object
   * @param {Object} ref - Reference object from hybridReferences
   * @returns {Object} { valid: boolean, expected: number, actual: number, issue: string|null }
   */
  static validateReference(ref) {
    if (!ref || !ref.label || !ref.respondents) {
      return { valid: true, expected: null, actual: null, issue: null };
    }

    const labelCount = this.parseCountFromLabel(ref.label);
    const actualCount = ref.respondents.length;

    // If not a count-based label (e.g., "Valby Lokaludvalg"), skip validation
    if (labelCount === null || !this.isCountBasedLabel(ref.label)) {
      return { valid: true, expected: null, actual: actualCount, issue: null };
    }

    // Check for mismatch
    if (labelCount !== actualCount) {
      return {
        valid: false,
        expected: labelCount,
        actual: actualCount,
        issue: `Label claims "${ref.label}" (${labelCount}) but respondents array has ${actualCount} IDs`
      };
    }

    return { valid: true, expected: labelCount, actual: actualCount, issue: null };
  }

  /**
   * Validate all references in a hybrid summary
   * @param {Object} hybridSummary - Object with references array
   * @returns {Object} { valid: boolean, issues: Array<{ refId, issue, expected, actual }> }
   */
  static validateHybridSummary(hybridSummary) {
    if (!hybridSummary || !hybridSummary.references) {
      return { valid: true, issues: [] };
    }

    const issues = [];

    for (const ref of hybridSummary.references) {
      const validation = this.validateReference(ref);
      if (!validation.valid) {
        issues.push({
          refId: ref.id,
          label: ref.label,
          expected: validation.expected,
          actual: validation.actual,
          issue: validation.issue
        });
      }
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * Fix a single reference by recalculating its label based on respondents.length
   * @param {Object} ref - Reference object to fix
   * @returns {Object} Fixed reference object
   */
  static fixReference(ref) {
    if (!ref || !ref.respondents || ref.respondents.length === 0) {
      return ref;
    }

    const actualCount = ref.respondents.length;
    
    // If not count-based, don't modify
    if (!this.isCountBasedLabel(ref.label)) {
      return ref;
    }

    // Determine the noun to use (borger/borgere, respondent/respondenter)
    const lowerLabel = (ref.label || '').toLowerCase();
    let noun = 'borger'; // default
    if (lowerLabel.includes('respondent')) {
      noun = 'respondent';
    } else if (lowerLabel.includes('henvendelse')) {
      noun = 'henvendelse';
    }

    // Generate correct label
    const correctLabel = DanishNumberFormatter.formatWithNoun(actualCount, noun);

    return {
      ...ref,
      label: correctLabel,
      _labelFixed: ref.label !== correctLabel,
      _originalLabel: ref.label !== correctLabel ? ref.label : undefined
    };
  }

  /**
   * Validate and auto-fix all references in a hybrid summary
   * @param {Object} hybridSummary - Object with summary and references
   * @returns {Object} Fixed hybrid summary
   */
  static validateAndFixHybridSummary(hybridSummary) {
    if (!hybridSummary || !hybridSummary.references) {
      return hybridSummary;
    }

    const result = { ...hybridSummary };
    const fixedRefs = [];
    const fixLog = [];

    for (const ref of hybridSummary.references) {
      const validation = this.validateReference(ref);
      
      if (!validation.valid) {
        const fixedRef = this.fixReference(ref);
        fixedRefs.push(fixedRef);
        
        fixLog.push({
          refId: ref.id,
          originalLabel: ref.label,
          fixedLabel: fixedRef.label,
          respondentCount: ref.respondents.length,
          issue: validation.issue
        });
        
        console.log(`[LabelCountValidator] 🔧 Fixed ${ref.id}: "${ref.label}" → "${fixedRef.label}" (${ref.respondents.length} respondents)`);
      } else {
        fixedRefs.push(ref);
      }
    }

    result.references = fixedRefs;

    // Also fix the summary text if labels were changed
    if (fixLog.length > 0 && result.summary) {
      result.summary = this.fixSummaryLabels(result.summary, fixLog);
      
      // Add to warnings
      if (!result.warnings) result.warnings = [];
      result.warnings.push(`Auto-fixed ${fixLog.length} label/respondent mismatches`);
    }

    return result;
  }

  /**
   * Fix label text in summary to match corrected references
   * @param {string} summary - Summary text with REF placeholders
   * @param {Array} fixLog - Array of { refId, originalLabel, fixedLabel }
   * @returns {string} Fixed summary text
   */
  static fixSummaryLabels(summary, fixLog) {
    if (!summary || !fixLog || fixLog.length === 0) {
      return summary;
    }

    let result = summary;

    for (const fix of fixLog) {
      // Find the pattern: "{originalLabel}<<{refId}>>" and replace with "{fixedLabel}<<{refId}>>"
      // Also handle variations like "{originalLabel} <<{refId}>>"
      
      const refPlaceholder = `<<${fix.refId}>>`;
      const refIndex = result.indexOf(refPlaceholder);
      
      if (refIndex === -1) continue;
      
      // Look backwards from the placeholder to find the original label
      const beforeRef = result.substring(0, refIndex);
      const originalLabelLower = fix.originalLabel.toLowerCase();
      
      // Find the last occurrence of the original label before the placeholder
      const labelIndex = beforeRef.toLowerCase().lastIndexOf(originalLabelLower);
      
      if (labelIndex !== -1 && refIndex - labelIndex <= fix.originalLabel.length + 5) {
        // Close enough - this is likely the label for this reference
        const before = result.substring(0, labelIndex);
        const after = result.substring(labelIndex + fix.originalLabel.length);
        result = before + fix.fixedLabel + after;
      }
    }

    return result;
  }

  /**
   * Get statistics about label/respondent mismatches in a result
   * @param {Object} hybridSummary - Hybrid summary to analyze
   * @returns {Object} Statistics
   */
  static getStats(hybridSummary) {
    if (!hybridSummary || !hybridSummary.references) {
      return { total: 0, mismatches: 0, valid: 0 };
    }

    let mismatches = 0;
    let valid = 0;

    for (const ref of hybridSummary.references) {
      const validation = this.validateReference(ref);
      if (validation.valid) {
        valid++;
      } else {
        mismatches++;
      }
    }

    return {
      total: hybridSummary.references.length,
      mismatches,
      valid,
      mismatchRate: hybridSummary.references.length > 0 
        ? (mismatches / hybridSummary.references.length * 100).toFixed(1) + '%'
        : '0%'
    };
  }
}
