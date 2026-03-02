/**
 * Format Validator
 * 
 * Validates the final output format to ensure no escaped characters
 * and proper markdown/CriticMarkup structure.
 */

export class FormatValidator {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
  }

  /**
   * Validate the complete formatted output
   * @param {string} markdown - Formatted markdown output
   * @param {Object} analysisResult - Original analysis result (optional)
   * @returns {Object} Validation report
   */
  validateOutput(markdown, analysisResult = null) {
    const report = {
      valid: true,
      errors: [],
      warnings: [],
      stats: {
        totalCharacters: markdown.length,
        criticMarkupBlocks: 0,
        escapedCharacters: 0,
        malformedBlocks: 0,
        unclosedBlocks: 0,
        doubleHighlights: 0
      }
    };

    // Run all validation checks
    this.validateEscapedCharacters(markdown, report);
    this.validateCriticMarkup(markdown, report);
    this.validateMarkdownStructure(markdown, report);
    this.validateNewlines(markdown, report);
    
    if (analysisResult) {
      this.validateContentIntegrity(markdown, analysisResult, report);
    }

    // Add summary
    report.summary = this.generateSummary(report);
    
    if (this.verbose) {
      this.logReport(report);
    }

    return report;
  }

  /**
   * Check for escaped characters that should have been normalized
   * @private
   */
  validateEscapedCharacters(markdown, report) {
    // Check for escaped newlines
    const escapedNewlines = (markdown.match(/\\n/g) || []).length;
    if (escapedNewlines > 0) {
      report.valid = false;
      report.errors.push(`Found ${escapedNewlines} escaped newlines (\\n) - these should be actual newlines`);
      report.stats.escapedCharacters += escapedNewlines;
    }

    // Check for escaped tabs
    const escapedTabs = (markdown.match(/\\t/g) || []).length;
    if (escapedTabs > 0) {
      report.valid = false;
      report.errors.push(`Found ${escapedTabs} escaped tabs (\\t) - these should be actual tabs`);
      report.stats.escapedCharacters += escapedTabs;
    }

    // Check for escaped quotes (but allow them in code blocks)
    const codeBlockPattern = /(```[\s\S]*?```|`[^`]*`)/g;
    const markdownWithoutCode = markdown.replace(codeBlockPattern, '');
    
    const escapedQuotes = (markdownWithoutCode.match(/\\"/g) || []).length;
    if (escapedQuotes > 0) {
      report.warnings.push(`Found ${escapedQuotes} escaped quotes (\") outside code blocks`);
      report.stats.escapedCharacters += escapedQuotes;
    }

    // Check for double backslashes (common escaping issue)
    const doubleBackslashes = (markdownWithoutCode.match(/\\\\/g) || []).length;
    if (doubleBackslashes > 0) {
      report.warnings.push(`Found ${doubleBackslashes} double backslashes (\\\\)`);
    }
  }

  /**
   * Validate CriticMarkup syntax
   * @private
   */
  validateCriticMarkup(markdown, report) {
    // Pattern for valid CriticMarkup blocks
    const validPattern = /\{==([^=]+?)==\}\s*\{>>([^<]*?)<<\}/g;
    let match;
    
    while ((match = validPattern.exec(markdown)) !== null) {
      report.stats.criticMarkupBlocks++;
      
      const highlight = match[1];
      const comment = match[2];
      
      // Check for empty highlights
      if (!highlight.trim()) {
        report.valid = false;
        report.errors.push('Found CriticMarkup with empty highlight');
      }
      
      // Check for empty comments
      if (!comment.trim()) {
        report.warnings.push(`Empty comment for highlight: "${highlight}"`);
      }
      
      // Check for nested CriticMarkup (not allowed)
      if (highlight.includes('{==') || comment.includes('{==')) {
        report.valid = false;
        report.errors.push(`Nested CriticMarkup detected in: "${highlight}"`);
      }
    }

    // Check for malformed CriticMarkup - missing spaces between blocks
    const malformedPattern = /\{==([^=]+?)==\}\{>>([^<]*?)<<\}/g;
    const malformedMatches = (markdown.match(malformedPattern) || []).length;
    if (malformedMatches > 0) {
      report.valid = false;
      report.errors.push(`Found ${malformedMatches} CriticMarkup blocks missing space between highlight and comment`);
      report.stats.malformedBlocks += malformedMatches;
    }

    // Check for unclosed blocks
    const unclosedHighlight = /\{==([^}]+)$/gm;
    const unclosedComment = /\{>>([^}]+)$/gm;
    
    if (unclosedHighlight.test(markdown)) {
      report.valid = false;
      report.errors.push('Found unclosed CriticMarkup highlight blocks');
      report.stats.unclosedBlocks++;
    }
    
    if (unclosedComment.test(markdown)) {
      report.valid = false;
      report.errors.push('Found unclosed CriticMarkup comment blocks');
      report.stats.unclosedBlocks++;
    }

    // Check for double highlights (common error)
    const doubleHighlightPattern = /\{==([^=]+?)==\}\s*\{==([^=]+?)==\}/g;
    const doubleHighlights = (markdown.match(doubleHighlightPattern) || []).length;
    if (doubleHighlights > 0) {
      report.warnings.push(`Found ${doubleHighlights} consecutive highlights without comments`);
      report.stats.doubleHighlights = doubleHighlights;
    }
  }

  /**
   * Validate markdown structure
   * @private
   */
  validateMarkdownStructure(markdown, report) {
    const lines = markdown.split('\n');
    
    // Check heading structure
    let lastHeadingLevel = 0;
    let headingCount = { h1: 0, h2: 0, h3: 0 };
    
    lines.forEach((line, idx) => {
      // Check for headings
      const headingMatch = line.match(/^(#+)\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2];
        
        if (level === 1) headingCount.h1++;
        else if (level === 2) headingCount.h2++;
        else if (level === 3) headingCount.h3++;
        
        // Check for heading hierarchy issues
        if (level > lastHeadingLevel + 1 && lastHeadingLevel > 0) {
          report.warnings.push(`Skipped heading level at line ${idx + 1}: ${line}`);
        }
        
        lastHeadingLevel = level;
        
        // Check for empty headings
        if (!title.trim() || title === '#') {
          report.errors.push(`Empty heading at line ${idx + 1}`);
          report.valid = false;
        }
      }
      
      // Check for broken list items
      if (line.match(/^\s*[-*]\s*$/)) {
        report.errors.push(`Empty list item at line ${idx + 1}`);
        report.valid = false;
      }
    });
    
    // Report heading statistics
    if (headingCount.h1 === 0) {
      report.warnings.push('No top-level headings (H1) found');
    }
    
    // Check for unbalanced parentheses (common in broken output)
    const openParens = (markdown.match(/\(/g) || []).length;
    const closeParens = (markdown.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      report.warnings.push(`Unbalanced parentheses: ${openParens} opening, ${closeParens} closing`);
    }
  }

  /**
   * Validate newline formatting
   * @private
   */
  validateNewlines(markdown, report) {
    // Check for Windows line endings
    const windowsNewlines = (markdown.match(/\r\n/g) || []).length;
    if (windowsNewlines > 0) {
      report.warnings.push(`Found ${windowsNewlines} Windows-style line endings (\\r\\n)`);
    }

    // Check for Mac line endings
    const macNewlines = (markdown.match(/\r(?!\n)/g) || []).length;
    if (macNewlines > 0) {
      report.warnings.push(`Found ${macNewlines} Mac-style line endings (\\r)`);
    }

    // Check for multiple consecutive blank lines
    const multipleBlankLines = markdown.match(/\n{4,}/g);
    if (multipleBlankLines) {
      report.warnings.push(`Found ${multipleBlankLines.length} instances of excessive blank lines (4+ consecutive)`);
    }

    // Check for missing newlines after headings
    const headingWithoutNewline = /^#+\s+.+[^\n]$/gm;
    const missingNewlines = (markdown.match(headingWithoutNewline) || []).length;
    if (missingNewlines > 0) {
      report.warnings.push(`Found ${missingNewlines} headings without proper newline spacing`);
    }
  }

  /**
   * Validate content integrity between analysis result and markdown
   * @private
   */
  validateContentIntegrity(markdown, analysisResult, report) {
    // Check that all topics are present
    if (analysisResult.topics) {
      for (const topic of analysisResult.topics) {
        if (!markdown.includes(topic.name)) {
          report.errors.push(`Topic "${topic.name}" not found in output`);
          report.valid = false;
        }
        
        // Check positions
        for (const position of (topic.positions || [])) {
          if (!position.title) {
            report.warnings.push(`Position missing title in topic "${topic.name}"`);
            continue;
          }
          // Extract clean title without prefix
          const cleanTitle = position.title.replace(/^\(\d+(?:,\s*(?:LU|O))?\)\s*/, '');
          if (!markdown.includes(cleanTitle)) {
            report.warnings.push(`Position title "${cleanTitle}" not found in output`);
          }
        }
      }
    }

    // Check that considerations are included (if present)
    if (analysisResult.considerations && analysisResult.considerations.trim()) {
      // Considerations should be in a CriticMarkup comment
      const considerationsInOutput = markdown.includes(analysisResult.considerations);
      if (!considerationsInOutput) {
        report.warnings.push('Considerations from analysis not found in output');
      }
    }
  }

  /**
   * Generate summary of validation results
   * @private
   */
  generateSummary(report) {
    const issues = [];
    
    if (report.stats.escapedCharacters > 0) {
      issues.push(`${report.stats.escapedCharacters} escaped characters`);
    }
    
    if (report.stats.malformedBlocks > 0) {
      issues.push(`${report.stats.malformedBlocks} malformed CriticMarkup blocks`);
    }
    
    if (report.stats.unclosedBlocks > 0) {
      issues.push(`${report.stats.unclosedBlocks} unclosed blocks`);
    }
    
    return {
      status: report.valid ? 'VALID' : 'INVALID',
      characterCount: report.stats.totalCharacters,
      criticMarkupBlocks: report.stats.criticMarkupBlocks,
      issues: issues.join(', ') || 'No issues found',
      recommendation: this.getRecommendation(report)
    };
  }

  /**
   * Get recommendation based on validation results
   * @private
   */
  getRecommendation(report) {
    if (report.valid && report.warnings.length === 0) {
      return 'Output is properly formatted and ready for use.';
    }
    
    if (report.stats.escapedCharacters > 0) {
      return 'Escaped characters found. Run markdown normalizer on the output.';
    }
    
    if (report.stats.malformedBlocks > 0) {
      return 'CriticMarkup formatting errors. Review output formatter logic.';
    }
    
    if (!report.valid) {
      return 'Critical formatting issues found. Output needs correction before use.';
    }
    
    return 'Minor formatting issues found. Review warnings for improvements.';
  }

  /**
   * Log validation report
   * @private
   */
  logReport(report) {
    console.log('\n[FormatValidator] Validation Report:');
    console.log(`- Status: ${report.summary.status}`);
    console.log(`- Characters: ${report.summary.characterCount}`);
    console.log(`- CriticMarkup blocks: ${report.summary.criticMarkupBlocks}`);
    
    if (report.errors.length > 0) {
      console.log('\nERRORS:');
      report.errors.forEach(e => console.log(`  ❌ ${e}`));
    }
    
    if (report.warnings.length > 0) {
      console.log('\nWARNINGS:');
      report.warnings.slice(0, 10).forEach(w => console.log(`  ⚠️  ${w}`));
      if (report.warnings.length > 10) {
        console.log(`  ... and ${report.warnings.length - 10} more warnings`);
      }
    }
    
    console.log(`\nRecommendation: ${report.summary.recommendation}\n`);
  }
}
