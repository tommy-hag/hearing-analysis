/**
 * CriticMarkup Validator
 * 
 * Validates CriticMarkup syntax and ensures proper formatting.
 * CriticMarkup format: {==highlight==}{>>comment<<}
 */

export class CriticMarkupValidator {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
  }

  /**
   * Validate CriticMarkup syntax in text
   * @param {string} text - Text containing CriticMarkup
   * @returns {Object} Validation result with issues
   */
  validateSyntax(text) {
    if (!text || typeof text !== 'string') {
      return { valid: true, issues: [], blocks: [] };
    }

    const issues = [];
    const blocks = [];

    // Find all CriticMarkup blocks
    const criticMarkupPattern = /\{==([^=]+)==\}\{>>([^<]+)<<\}/g;
    let match;
    let lastEnd = 0;

    while ((match = criticMarkupPattern.exec(text)) !== null) {
      const fullMatch = match[0];
      const highlight = match[1];
      const comment = match[2];
      const start = match.index;
      const end = match.index + fullMatch.length;

      blocks.push({
        start,
        end,
        fullMatch,
        highlight,
        comment
      });

      // Check for proper spacing
      if (start > 0 && text[start - 1] !== ' ' && text[start - 1] !== '\n') {
        issues.push({
          type: 'missing_space_before',
          position: start,
          message: 'CriticMarkup block should be preceded by a space',
          block: fullMatch
        });
      }

      // Check for empty highlight
      if (!highlight.trim()) {
        issues.push({
          type: 'empty_highlight',
          position: start,
          message: 'CriticMarkup highlight is empty',
          block: fullMatch
        });
      }

      // Check for empty comment
      if (!comment.trim()) {
        issues.push({
          type: 'empty_comment',
          position: start,
          message: 'CriticMarkup comment is empty',
          block: fullMatch
        });
      }

      lastEnd = end;
    }

    // Find malformed CriticMarkup patterns
    this.findMalformedPatterns(text, issues);

    // Check for placeholder text
    this.checkForPlaceholders(text, issues);

    // Check for double spaces between blocks
    this.checkSpacingIssues(text, blocks, issues);

    return {
      valid: issues.length === 0,
      issues,
      blocks,
      stats: {
        totalBlocks: blocks.length,
        validBlocks: blocks.length - issues.filter(i => i.type.includes('malformed')).length
      }
    };
  }

  /**
   * Find malformed CriticMarkup patterns
   * @private
   */
  findMalformedPatterns(text, issues) {
    // Check for unclosed highlight blocks
    const unclosedHighlight = /\{==[^=]+((?!==\}).)*$/gm;
    let match;
    while ((match = unclosedHighlight.exec(text)) !== null) {
      issues.push({
        type: 'unclosed_highlight',
        position: match.index,
        message: 'Unclosed CriticMarkup highlight block',
        text: match[0].substring(0, 50) + '...'
      });
    }

    // Check for unclosed comment blocks
    const unclosedComment = /\{>>[^<]+((?!<<\}).)*$/gm;
    while ((match = unclosedComment.exec(text)) !== null) {
      issues.push({
        type: 'unclosed_comment',
        position: match.index,
        message: 'Unclosed CriticMarkup comment block',
        text: match[0].substring(0, 50) + '...'
      });
    }

    // Check for separated highlight and comment blocks
    const separatedBlocks = /\{==[^=]+==\}(?!\s*\{>>)/g;
    while ((match = separatedBlocks.exec(text)) !== null) {
      // Check if this is not followed by a comment block
      const nextChars = text.substring(match.index + match[0].length, match.index + match[0].length + 10);
      if (!nextChars.trimStart().startsWith('{>>')) {
        issues.push({
          type: 'missing_comment_block',
          position: match.index,
          message: 'CriticMarkup highlight without corresponding comment block',
          text: match[0]
        });
      }
    }

    // Check for orphaned comment blocks (comment without preceding highlight)
    const orphanedComments = /(?<!\{==[^=]+==\}\s*)\{>>[^<]+<<\}/g;
    while ((match = orphanedComments.exec(text)) !== null) {
      issues.push({
        type: 'orphaned_comment',
        position: match.index,
        message: 'CriticMarkup comment block without preceding highlight',
        text: match[0]
      });
    }

    // NEW: Check for consecutive comment blocks (multiple comments attached to same highlight)
    // Pattern: {==highlight==}{>>comment1<<}{>>comment2<<}
    // This is invalid - comments should be merged into one
    const consecutiveComments = /\{==[^=]+==\}\{>>[^<]+<<\}\{>>[^<]+<<\}/g;
    while ((match = consecutiveComments.exec(text)) !== null) {
      issues.push({
        type: 'consecutive_comments',
        position: match.index,
        message: 'Multiple CriticMarkup comments attached to same highlight - should be merged',
        text: match[0].substring(0, 100) + (match[0].length > 100 ? '...' : '')
      });
    }
  }

  /**
   * Check for placeholder text that shouldn't be in final output
   * @private
   */
  checkForPlaceholders(text, issues) {
    const placeholderPatterns = [
      { pattern: /__CRITIC_MARKUP_\d+__/g, type: 'critic_markup_placeholder' },
      // NOTE: <<REF_X>> placeholders are VALID in hybrid-position-writing stage
      // They will be converted to CriticMarkup in format-output step
      // { pattern: /<<REF_\d+>>/g, type: 'unprocessed_reference' },
      { pattern: /\[MANGLER[^\]]*\]/g, type: 'missing_quote_placeholder' },
      { pattern: /sourceQuote ikke tilgængelig/g, type: 'missing_source_placeholder' },
      { pattern: /PLACEHOLDER|TODO|FIXME/g, type: 'development_placeholder' }
    ];

    placeholderPatterns.forEach(({ pattern, type }) => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        issues.push({
          type: `placeholder_${type}`,
          position: match.index,
          message: `Found placeholder text: ${match[0]}`,
          placeholder: match[0]
        });
      }
    });
  }

  /**
   * Check for spacing issues between CriticMarkup blocks
   * @private
   */
  checkSpacingIssues(text, blocks, issues) {
    for (let i = 0; i < blocks.length - 1; i++) {
      const currentBlock = blocks[i];
      const nextBlock = blocks[i + 1];
      
      // Check spacing between consecutive blocks
      const textBetween = text.substring(currentBlock.end, nextBlock.start);
      
      if (textBetween === '') {
        issues.push({
          type: 'no_spacing_between_blocks',
          position: currentBlock.end,
          message: 'No spacing between consecutive CriticMarkup blocks',
          blocks: [currentBlock.fullMatch, nextBlock.fullMatch]
        });
      } else if (textBetween.includes('\n\n')) {
        issues.push({
          type: 'double_newline_between_blocks',
          position: currentBlock.end,
          message: 'Double newline between CriticMarkup blocks (should be single space)',
          textBetween
        });
      }
    }
  }

  /**
   * Validate CriticMarkup in a position's summary
   * @param {Object} position - Position object with summary
   * @returns {Object} Validation result
   */
  validatePositionSummary(position) {
    if (!position || !position.summary) {
      return { valid: true, issues: [] };
    }

    const validation = this.validateSyntax(position.summary);
    
    // Always log issues for debugging
    if (!validation.valid) {
      console.log(`[CriticMarkupValidator] Position "${position.title}" has ${validation.issues.length} CriticMarkup issues`);
      validation.issues.forEach((issue, idx) => {
        console.log(`  ${idx + 1}. ${issue.type}: ${issue.message}`);
        if (issue.block) {
          console.log(`     Block: "${issue.block}"`);
        }
        if (issue.text) {
          console.log(`     Text: "${issue.text}"`);
        }
      });
      // Log first 200 chars of summary to see what's wrong
      console.log(`  Summary preview: "${position.summary.substring(0, 200)}..."`);
    }
    
    // Add position context to issues
    validation.issues = validation.issues.map(issue => ({
      ...issue,
      context: {
        positionTitle: position.title,
        responseNumbers: position.responseNumbers
      }
    }));

    return validation;
  }

  /**
   * Validate all positions in themes
   * @param {Array} themes - Array of themes with positions
   * @returns {Object} Aggregated validation result
   */
  validateAllPositions(themes) {
    const allIssues = [];
    let totalPositions = 0;
    let positionsWithIssues = 0;
    let totalBlocks = 0;

    themes.forEach(theme => {
      if (!theme.positions || !Array.isArray(theme.positions)) return;

      theme.positions.forEach(position => {
        totalPositions++;
        const validation = this.validatePositionSummary(position);
        
        if (!validation.valid) {
          positionsWithIssues++;
          allIssues.push(...validation.issues);
        }
        
        totalBlocks += validation.stats?.totalBlocks || 0;
      });
    });

    // Group issues by type
    const issuesByType = {};
    allIssues.forEach(issue => {
      if (!issuesByType[issue.type]) {
        issuesByType[issue.type] = [];
      }
      issuesByType[issue.type].push(issue);
    });

    return {
      valid: allIssues.length === 0,
      issues: allIssues,
      issuesByType,
      stats: {
        totalPositions,
        positionsWithIssues,
        totalBlocks,
        totalIssues: allIssues.length
      }
    };
  }

  /**
   * Create a summary report of CriticMarkup validation
   * @param {Object} validation - Validation result from validateAllPositions
   * @returns {string} Human-readable report
   */
  createReport(validation) {
    const lines = ['CriticMarkup Validation Report', '=' * 30];
    
    if (validation.valid) {
      lines.push('✓ All CriticMarkup syntax is valid');
      lines.push(`  Total positions: ${validation.stats.totalPositions}`);
      lines.push(`  Total CriticMarkup blocks: ${validation.stats.totalBlocks}`);
    } else {
      lines.push(`⚠️  Found ${validation.stats.totalIssues} issues in ${validation.stats.positionsWithIssues} positions`);
      lines.push('');
      lines.push('Issues by type:');
      
      Object.entries(validation.issuesByType).forEach(([type, issues]) => {
        lines.push(`  • ${type}: ${issues.length} occurrence${issues.length === 1 ? '' : 's'}`);
        
        if (this.verbose && issues.length <= 3) {
          issues.forEach(issue => {
            lines.push(`    - Position: ${issue.context?.positionTitle || 'Unknown'}`);
            lines.push(`      ${issue.message}`);
          });
        }
      });
    }
    
    return lines.join('\n');
  }

  /**
   * Fix common CriticMarkup issues (careful - modifies text)
   * @param {string} text - Text with CriticMarkup
   * @returns {Object} Fixed text and changes made
   */
  autoFix(text) {
    let fixedText = text;
    const changes = [];

    // Fix double newlines between blocks
    fixedText = fixedText.replace(/(\{==[^=]+==\}\{>>[^<]+<<\})\n\n(\{==)/g, (match, block1, block2Start) => {
      changes.push({
        type: 'fixed_double_newline',
        original: match,
        fixed: `${block1} ${block2Start}`
      });
      return `${block1} ${block2Start}`;
    });

    // Fix missing spaces before blocks
    fixedText = fixedText.replace(/([^\s\n])(\{==[^=]+==\})/g, (match, prevChar, block) => {
      changes.push({
        type: 'added_space_before_block',
        original: match,
        fixed: `${prevChar} ${block}`
      });
      return `${prevChar} ${block}`;
    });

    // Remove placeholder text (careful with this!)
    const placeholderPattern = /__CRITIC_MARKUP_\d+__/g;
    fixedText = fixedText.replace(placeholderPattern, (match) => {
      changes.push({
        type: 'removed_placeholder',
        original: match,
        fixed: ''
      });
      return '';
    });

    return {
      text: fixedText,
      changes,
      modified: changes.length > 0
    };
  }
}
