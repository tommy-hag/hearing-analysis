/**
 * DanishNumberFormatter
 * 
 * Utility for formatting numbers according to Danish language rules.
 * Ensures proper number words (1-12 as words, 13+ as digits) and correct
 * grammatical agreement (ental/flertal for "borger/borgere").
 * 
 * CRITICAL: This prevents LLM outputs like "Fifteen borgere" or "1 borgere"
 */

export class DanishNumberFormatter {
  /**
   * Danish number words for 1-12
   * Note: "én" is used for common gender (not "en" which is an article)
   */
  static DANISH_NUMBERS = {
    1: 'én',
    2: 'to',
    3: 'tre',
    4: 'fire',
    5: 'fem',
    6: 'seks',
    7: 'syv',
    8: 'otte',
    9: 'ni',
    10: 'ti',
    11: 'elleve',
    12: 'tolv'
  };

  /**
   * English number words that might appear in LLM output (for detection/fix)
   */
  static ENGLISH_NUMBER_WORDS = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14,
    'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18,
    'nineteen': 19, 'twenty': 20, 'thirty': 30, 'forty': 40,
    'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80,
    'ninety': 90, 'hundred': 100
  };

  /**
   * Common Danish nouns that need singular/plural agreement
   */
  static NOUN_FORMS = {
    'borger': { singular: 'borger', plural: 'borgere' },
    'respondent': { singular: 'respondent', plural: 'respondenter' },
    'person': { singular: 'person', plural: 'personer' },
    'høringssvar': { singular: 'høringssvar', plural: 'høringssvar' }, // Same form
    'forening': { singular: 'forening', plural: 'foreninger' },
    'organisation': { singular: 'organisation', plural: 'organisationer' },
    'myndighed': { singular: 'myndighed', plural: 'myndigheder' },
    'lokaludvalg': { singular: 'lokaludvalg', plural: 'lokaludvalg' } // Same form
  };

  /**
   * Convert a number to Danish number word (1-12) or digit string (13+)
   * @param {number} num - The number to format
   * @returns {string} Danish representation
   */
  static toWord(num) {
    if (typeof num !== 'number' || isNaN(num) || num < 1) {
      return String(num);
    }
    
    const intNum = Math.floor(num);
    
    if (intNum >= 1 && intNum <= 12) {
      return this.DANISH_NUMBERS[intNum];
    }
    
    // 13+ uses digits
    return String(intNum);
  }

  /**
   * Format number + noun with correct Danish grammar
   * @param {number} count - The count
   * @param {string} noun - Base noun (e.g., 'borger')
   * @returns {string} Formatted string (e.g., "én borger", "to borgere", "15 borgere")
   */
  static formatWithNoun(count, noun = 'borger') {
    const normalizedNoun = noun.toLowerCase().trim();
    const forms = this.NOUN_FORMS[normalizedNoun] || { singular: noun, plural: noun + (noun.endsWith('e') ? 'r' : 'e') };
    
    const numberWord = this.toWord(count);
    const nounForm = count === 1 ? forms.singular : forms.plural;
    
    return `${numberWord} ${nounForm}`;
  }

  /**
   * Validate and fix Danish number labels in text
   * Fixes issues like:
   * - "Fifteen borgere" → "15 borgere"
   * - "1 borgere" → "én borger"
   * - "en borger" → "én borger" (correct gender)
   * - "Twenty-three borgere" → "23 borgere"
   * 
   * @param {string} text - Text to validate and fix
   * @returns {string} Fixed text
   */
  static validateAndFix(text) {
    if (!text || typeof text !== 'string') return text;

    let result = text;

    // 1. Fix English number words followed by Danish nouns
    // Pattern: English number word + borgere/borger/respondent(er)/etc.
    const nounPatterns = Object.keys(this.NOUN_FORMS).join('|');
    const englishWordPattern = new RegExp(
      `\\b(${Object.keys(this.ENGLISH_NUMBER_WORDS).join('|')})(?:[-\\s]+(${Object.keys(this.ENGLISH_NUMBER_WORDS).join('|')}))?\\s+(${nounPatterns}(?:e|er|ne|erne)?)\\b`,
      'gi'
    );
    
    result = result.replace(englishWordPattern, (match, word1, word2, noun) => {
      let num = this.ENGLISH_NUMBER_WORDS[word1.toLowerCase()] || 0;
      if (word2) {
        // Handle compound numbers like "twenty-three"
        num += this.ENGLISH_NUMBER_WORDS[word2.toLowerCase()] || 0;
      }
      if (num > 0) {
        // Find base noun and format correctly
        const baseNoun = this.findBaseNoun(noun);
        return this.formatWithNoun(num, baseNoun);
      }
      return match;
    });

    // 2. Fix incorrect singular/plural agreement (e.g., "1 borgere" → "én borger")
    const digitNounPattern = new RegExp(
      `\\b(\\d+)\\s+(${nounPatterns}(?:e|er|ne|erne)?)\\b`,
      'gi'
    );
    
    result = result.replace(digitNounPattern, (match, numStr, noun) => {
      const num = parseInt(numStr, 10);
      if (isNaN(num) || num < 1) return match;
      
      const baseNoun = this.findBaseNoun(noun);
      return this.formatWithNoun(num, baseNoun);
    });

    // 3. Fix "en borger" → "én borger" (common gender article issue)
    result = result.replace(/\b(en|et)\s+(borger|respondent|person)\b/gi, (match, article, noun) => {
      return `én ${noun.toLowerCase()}`;
    });

    // 4. Fix standalone Danish number words with incorrect noun forms
    // e.g., "tre borger" → "tre borgere", "én borgere" → "én borger"
    const danishWordPattern = new RegExp(
      `\\b(${Object.values(this.DANISH_NUMBERS).join('|')})\\s+(${nounPatterns}(?:e|er|ne|erne)?)\\b`,
      'gi'
    );
    
    result = result.replace(danishWordPattern, (match, numWord, noun) => {
      const num = this.danishWordToNumber(numWord.toLowerCase());
      if (num > 0) {
        const baseNoun = this.findBaseNoun(noun);
        return this.formatWithNoun(num, baseNoun);
      }
      return match;
    });

    return result;
  }

  /**
   * Validate and fix a hybrid summary object from position-writer
   * @param {Object} hybridSummary - Object with summary and references
   * @returns {Object} Fixed hybrid summary
   */
  static validateAndFixHybridOutput(hybridSummary) {
    if (!hybridSummary || typeof hybridSummary !== 'object') {
      return hybridSummary;
    }

    const result = { ...hybridSummary };

    // Fix summary text
    if (result.summary) {
      result.summary = this.validateAndFix(result.summary);
    }

    // Fix title
    if (result.title) {
      result.title = this.validateAndFix(result.title);
    }

    // Fix reference labels
    if (result.references && Array.isArray(result.references)) {
      result.references = result.references.map(ref => {
        if (ref.label) {
          return {
            ...ref,
            label: this.validateAndFix(ref.label)
          };
        }
        return ref;
      });
    }

    return result;
  }

  /**
   * Convert Danish number word back to number
   * @private
   */
  static danishWordToNumber(word) {
    for (const [num, danishWord] of Object.entries(this.DANISH_NUMBERS)) {
      if (danishWord === word) {
        return parseInt(num, 10);
      }
    }
    return 0;
  }

  /**
   * Find base noun from potentially inflected form
   * @private
   */
  static findBaseNoun(noun) {
    const lowerNoun = noun.toLowerCase();
    
    for (const [base, forms] of Object.entries(this.NOUN_FORMS)) {
      if (lowerNoun === base || 
          lowerNoun === forms.singular || 
          lowerNoun === forms.plural ||
          lowerNoun === forms.plural + 'ne' || // definite plural
          lowerNoun === forms.singular + 'en') { // definite singular
        return base;
      }
    }
    
    // Try to detect base from common patterns
    if (lowerNoun.endsWith('erne')) return lowerNoun.slice(0, -4);
    if (lowerNoun.endsWith('ere')) return lowerNoun.slice(0, -2) + 'er';
    if (lowerNoun.endsWith('er')) return lowerNoun.slice(0, -1);
    if (lowerNoun.endsWith('e')) return lowerNoun.slice(0, -1);
    if (lowerNoun.endsWith('ne')) return lowerNoun.slice(0, -2);
    
    return lowerNoun;
  }

  /**
   * Check if text contains English number words (for quality validation)
   * @param {string} text - Text to check
   * @returns {boolean} True if English numbers found
   */
  static containsEnglishNumbers(text) {
    if (!text) return false;
    
    const englishPattern = new RegExp(
      `\\b(${Object.keys(this.ENGLISH_NUMBER_WORDS).join('|')})\\b`,
      'i'
    );
    
    return englishPattern.test(text);
  }

  /**
   * Danish ordinal words for sequential references
   * Used for "En anden borger", "En tredje borger", etc.
   */
  static DANISH_ORDINALS = {
    2: 'anden',
    3: 'tredje',
    4: 'fjerde',
    5: 'femte',
    6: 'sjette',
    7: 'syvende',
    8: 'ottende',
    9: 'niende',
    10: 'tiende'
  };

  /**
   * Transform consecutive identical labels to use sequential variations.
   * 
   * When the same label appears multiple times consecutively (e.g., "Én borger"),
   * this method transforms them to:
   * - 1st: "Én borger" (unchanged)
   * - 2nd: "En anden borger"
   * - 3rd: "En tredje borger"
   * - etc.
   * 
   * For plural labels (e.g., "To borgere"):
   * - 1st: "To borgere" (unchanged)
   * - 2nd: "Andre to borgere"
   * - 3rd: "Yderligere to borgere"
   * 
   * The counter resets when:
   * - A different label appears
   * - A new position heading (## ) is encountered
   * 
   * @param {string} text - Text containing labels with CriticMarkup
   * @returns {string} Text with varied consecutive labels
   */
  static transformConsecutiveLabels(text) {
    if (!text || typeof text !== 'string') return text;

    // Split text by position headings (## ) to process each position separately
    // This ensures the counter resets for each new position/holdning
    const positionPattern = /^(## .+)$/gm;
    
    // Find all position heading positions
    const headings = [];
    let match;
    while ((match = positionPattern.exec(text)) !== null) {
      headings.push({ index: match.index, length: match[0].length });
    }

    // If no headings, process entire text as one section
    if (headings.length === 0) {
      return this.transformLabelsInSection(text);
    }

    // Process each section between headings
    let result = '';
    let lastEnd = 0;

    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];
      const nextHeading = headings[i + 1];
      
      // Add text before this heading (if any)
      if (heading.index > lastEnd) {
        result += text.substring(lastEnd, heading.index);
      }
      
      // Determine section end (next heading or end of text)
      const sectionEnd = nextHeading ? nextHeading.index : text.length;
      
      // Extract and transform this section (heading + content)
      const section = text.substring(heading.index, sectionEnd);
      result += this.transformLabelsInSection(section);
      
      lastEnd = sectionEnd;
    }

    // Add any remaining text after last heading (shouldn't happen but safety)
    if (lastEnd < text.length) {
      result += text.substring(lastEnd);
    }

    return result;
  }

  /**
   * Transform consecutive identical labels within a single section.
   * @param {string} sectionText - Text of a single position section
   * @returns {string} Section with varied consecutive labels
   * @private
   */
  static transformLabelsInSection(sectionText) {
    if (!sectionText || typeof sectionText !== 'string') return sectionText;

    // Pattern to match labels inside CriticMarkup: {==Label==}
    const labelPattern = /\{==([^=]+)==\}/g;
    
    // First pass: collect all labels with their positions
    const labels = [];
    let match;
    while ((match = labelPattern.exec(sectionText)) !== null) {
      labels.push({
        fullMatch: match[0],
        label: match[1],
        index: match.index,
        length: match[0].length
      });
    }

    if (labels.length === 0) return sectionText;

    // Second pass: identify consecutive identical labels and compute replacements
    const replacements = [];
    let consecutiveCount = 0;
    let lastNormalizedLabel = null;

    for (let i = 0; i < labels.length; i++) {
      const current = labels[i];
      const normalizedLabel = this.normalizeLabel(current.label);

      if (normalizedLabel === lastNormalizedLabel) {
        consecutiveCount++;
        // This is a consecutive duplicate - needs transformation
        const newLabel = this.getSequentialLabel(current.label, consecutiveCount);
        if (newLabel !== current.label) {
          replacements.push({
            index: current.index,
            length: current.length,
            oldLabel: current.label,
            newLabel: newLabel,
            newFullMatch: `{==${newLabel}==}`
          });
        }
      } else {
        // Different label - reset counter
        consecutiveCount = 1;
        lastNormalizedLabel = normalizedLabel;
      }
    }

    // Apply replacements from end to start to preserve indices
    let result = sectionText;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i];
      result = result.substring(0, r.index) + r.newFullMatch + result.substring(r.index + r.length);
      console.log(`[DanishNumberFormatter] Transformed consecutive label: "${r.oldLabel}" → "${r.newLabel}"`);
    }

    return result;
  }

  /**
   * Normalize a label for comparison (lowercase, trim, remove accents from "én")
   * @private
   */
  static normalizeLabel(label) {
    if (!label) return '';
    return label.toLowerCase()
      .trim()
      .replace(/^én\b/, 'en') // Treat "én" and "en" as same
      .replace(/\s+/g, ' ');  // Normalize whitespace
  }

  /**
   * Generate sequential variant of a label
   * @param {string} label - Original label (e.g., "Én borger")
   * @param {number} occurrence - Which occurrence this is (2 = second, 3 = third, etc.)
   * @returns {string} Sequential variant (e.g., "En anden borger")
   * @private
   */
  static getSequentialLabel(label, occurrence) {
    if (occurrence <= 1) return label;

    // Check if this is a singular citizen label (én/en borger)
    const singularMatch = label.match(/^(én|en)\s+(borger|respondent|person)$/i);
    if (singularMatch) {
      const noun = singularMatch[2].toLowerCase();
      const ordinal = this.DANISH_ORDINALS[occurrence];
      if (ordinal) {
        // "Én borger" → "En anden borger" (note: "En" not "Én" for ordinal phrases)
        return `En ${ordinal} ${noun}`;
      } else {
        // Fallback for > 10: "Endnu en borger"
        return `Endnu en ${noun}`;
      }
    }

    // Check if this is a plural citizen label (to/tre/etc. borgere)
    const pluralMatch = label.match(/^(\d+|én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv)\s+(borgere|respondenter|personer)$/i);
    if (pluralMatch) {
      const numPart = pluralMatch[1];
      const noun = pluralMatch[2].toLowerCase();
      
      if (occurrence === 2) {
        // "To borgere" → "Andre to borgere"
        return `Andre ${numPart.toLowerCase()} ${noun}`;
      } else if (occurrence === 3) {
        // "To borgere" → "Yderligere to borgere"
        return `Yderligere ${numPart.toLowerCase()} ${noun}`;
      } else {
        // Fallback: "Endnu to borgere"
        return `Endnu ${numPart.toLowerCase()} ${noun}`;
      }
    }

    // For other labels (organizations, etc.), use generic prefix
    if (occurrence === 2) {
      // Check if starts with capital
      const startsWithCapital = /^[A-ZÆØÅ]/.test(label);
      return startsWithCapital ? `Også ${label.charAt(0).toLowerCase()}${label.slice(1)}` : `også ${label}`;
    } else {
      return `Yderligere ${label.toLowerCase()}`;
    }
  }

  /**
   * Check if text has grammatical errors in number-noun agreement
   * @param {string} text - Text to check
   * @returns {Array} Array of issues found
   */
  static findGrammarIssues(text) {
    if (!text) return [];
    
    const issues = [];
    const nounPatterns = Object.keys(this.NOUN_FORMS).join('|');
    
    // Check for "1 borgere" (singular number with plural noun)
    const singularPluralPattern = new RegExp(
      `\\b1\\s+(${nounPatterns})(e|er|ne|erne)\\b`,
      'gi'
    );
    let match;
    while ((match = singularPluralPattern.exec(text)) !== null) {
      issues.push({
        type: 'singular_plural_mismatch',
        found: match[0],
        position: match.index,
        suggestion: `én ${match[1]}`
      });
    }

    // Check for English numbers
    if (this.containsEnglishNumbers(text)) {
      const englishPattern = new RegExp(
        `\\b(${Object.keys(this.ENGLISH_NUMBER_WORDS).join('|')})\\b`,
        'gi'
      );
      while ((match = englishPattern.exec(text)) !== null) {
        const num = this.ENGLISH_NUMBER_WORDS[match[1].toLowerCase()];
        issues.push({
          type: 'english_number',
          found: match[0],
          position: match.index,
          suggestion: this.toWord(num)
        });
      }
    }

    return issues;
  }
}
