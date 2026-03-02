/**
 * CriticMarkup Cleaner
 * 
 * Removes incorrectly generated CriticMarkup from LLM output
 * The LLM should NOT generate {== ==} syntax - only the formatter should add it
 */

export class CriticMarkupCleaner {
  /**
   * Clean incorrectly generated CriticMarkup from summary text
   * @param {string} summary - Summary text potentially containing {== ==} syntax
   * @returns {string} Cleaned summary without CriticMarkup
   */
  static cleanSummary(summary) {
    if (!summary || typeof summary !== 'string') {
      return summary;
    }

    const original = summary;
    
    // Remove CriticMarkup highlight syntax {== ==}
    // Pattern: {==anything==} -> anything
    let cleaned = summary.replace(/\{==([^=]+)==\}/g, '$1');
    
    // Also remove comment syntax {>><<} if present
    // Pattern: {>>anything<<} -> remove completely
    cleaned = cleaned.replace(/\{>>([^<]+)<<\}/g, '');
    
    // Remove CriticMarkup addition syntax {++ ++}
    // Pattern: {++anything++} -> anything (keep the content, remove markup)
    // Use non-greedy match with lookahead to handle content with + characters
    cleaned = cleaned.replace(/\{\+\+([\s\S]*?)\+\+\}/g, '$1');
    
    // Remove CriticMarkup deletion syntax {-- --}
    // Pattern: {--anything--} -> remove completely
    // Use non-greedy match with lookahead to handle content with - characters
    cleaned = cleaned.replace(/\{--([\s\S]*?)--\}/g, '');
    
    // Remove any stray brackets that might be left (handle optional spaces)
    cleaned = cleaned.replace(/\{==/g, '');
    cleaned = cleaned.replace(/==\}/g, '');
    cleaned = cleaned.replace(/\{>>/g, '');
    cleaned = cleaned.replace(/<<\}/g, '');
    cleaned = cleaned.replace(/\{\+\+/g, '');
    cleaned = cleaned.replace(/\+\+\}/g, '');
    cleaned = cleaned.replace(/\{--/g, '');
    cleaned = cleaned.replace(/--\}/g, '');
    
    // Robust cleanup for malformed brackets and JSON artifacts
    cleaned = cleaned.replace(/<<\s*\}/g, '');
    cleaned = cleaned.replace(/\{\s*>>/g, '');
    cleaned = cleaned.replace(/\*<<\}/g, '');
    cleaned = cleaned.replace(/\"\*<<\}/g, '');
    cleaned = cleaned.replace(/\}\s*>>/g, '');
    
    if (cleaned !== original) {
      console.log('[CriticMarkupCleaner] Cleaned CriticMarkup from summary');
    }
    
    return cleaned;
  }
  
  /**
   * Strip all CriticMarkup to produce clean prose for LLM evaluation.
   *
   * - Keeps highlighted text (labels): {==text==} → text
   * - Removes all comments entirely: {>>...<<} → (nothing)
   *
   * Use this for LLM-as-judge evaluation where clean, natural prose
   * is required without inline references or markup.
   *
   * @param {string} text - Text with CriticMarkup
   * @returns {string} Clean prose for evaluation
   */
  static toCleanProse(text) {
    if (!text || typeof text !== 'string') return text;

    let clean = text;

    // Keep highlighted text (labels), remove highlight markers
    // {==text==} → text
    clean = clean.replace(/\{==([^=]+)==\}/g, '$1');

    // Remove all comments entirely (multiline safe)
    // {>>anything<<} → nothing
    clean = clean.replace(/\{>>[^]*?<<\}/g, '');

    // Clean up any orphaned markers
    clean = clean.replace(/\{==/g, '');
    clean = clean.replace(/==\}/g, '');
    clean = clean.replace(/\{>>/g, '');
    clean = clean.replace(/<<\}/g, '');

    // Fix multiple spaces that may result
    clean = clean.replace(/  +/g, ' ');

    // Fix multiple newlines (max 2)
    clean = clean.replace(/\n{3,}/g, '\n\n');

    // Ensure markdown headers have proper preceding blank lines (double newline)
    // This fixes cases where removing {>>...<<} leaves headers on adjacent lines
    // Process ## headers: ensure blank line before (requires \n\n before ##)
    clean = clean.replace(/([^\n])\n(##\s+)/g, '$1\n\n$2');  // single \n → \n\n
    clean = clean.replace(/([^\n])(##\s+)/g, '$1\n\n$2');    // no \n → \n\n
    // Process single # headers (not followed by another #)
    clean = clean.replace(/([^\n])\n(#(?!#)\s*\S)/g, '$1\n\n$2');  // single \n → \n\n
    clean = clean.replace(/([^\n#])(#(?!#)\s*\S)/g, '$1\n\n$2');   // no \n → \n\n

    // SAFETY NET: Fix label concatenation patterns that slipped through
    // Handles cases like "bygningén borger" → "bygning. Én borger"
    // Pattern: lowercase letter followed by "én/Én" + space + "borger"
    clean = clean.replace(/([a-zæøå])(Én|én)\s+borger/g, (match, lastChar, enWord) => {
      return `${lastChar}. ${enWord.charAt(0).toUpperCase() + enWord.slice(1)} borger`;
    });

    // Pattern: lowercase letter followed by number + space + "borger"
    clean = clean.replace(/([a-zæøå])(\d+)\s+(borger)/gi, (match, lastChar, num, borger) => {
      return `${lastChar}. ${num} ${borger}`;
    });

    // Pattern: lowercase letter followed by written numbers + space + "borger/borgere"
    const numberWords = 'to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv';
    const borgerePattern = new RegExp(`([a-zæøå])(${numberWords})\\s+(borger[e]?)`, 'gi');
    clean = clean.replace(borgerePattern, (match, lastChar, num, borgere) => {
      return `${lastChar}. ${num.charAt(0).toUpperCase() + num.slice(1)} ${borgere}`;
    });

    // Pattern: Stray "borger" before label (e.g., ", borger. Én borger" → ". Én borger")
    clean = clean.replace(/,\s*borger\.\s*(Én|én|En|en)\s+borger/gi, (match, enWord) => {
      return `. ${enWord.charAt(0).toUpperCase() + enWord.slice(1)} borger`;
    });

    // Pattern: Stray "borgeren" before label (e.g., "mens borgeren. En anden borger" → "mens En anden borger")
    clean = clean.replace(/\bborger(?:en|ne)?\.\s*(En\s+anden\s+borger|En\s+tredje\s+borger|En\s+fjerde\s+borger)/gi, (match, nextLabel) => {
      return `. ${nextLabel.charAt(0).toUpperCase() + nextLabel.slice(1)}`;
    });

    // Pattern: Concatenated labels without space (e.g., "Én borgerEn anden borger" → "Én borger. En anden borger")
    clean = clean.replace(/borger(En\s+anden\s+borger|En\s+tredje\s+borger|En\s+fjerde\s+borger|En\s+femte\s+borger|En\s+sjette\s+borger|En\s+syvende\s+borger)/gi, (match, nextLabel) => {
      return `borger. ${nextLabel}`;
    });

    // Remove stray << not part of CriticMarkup (final safety net)
    // These are leftover from malformed LLM output that weren't caught earlier
    clean = clean.replace(/<<(?!REF_|GROUP_)/g, '. ');

    // Fix "Enkelt borger" → "Én borger" (missing article)
    clean = clean.replace(/\bEnkelt borger\b/g, 'Én borger');
    clean = clean.replace(/\benkelt borger\b/g, 'én borger');

    // Fix orphaned verbs after periods (LLM missed a label before the verb)
    // Pattern: ". verb" where verb is a common Danish verb that needs a subject
    // E.g., ". afviser højhusudvidelser" should become ". Gruppen afviser højhusudvidelser"
    // Allow punctuation (comma, "at", "og") after verb, not just space
    const orphanedVerbPattern = /\.\s+(afviser|anfører|argumenterer|fremhæver|kritiserer|foreslår|anbefaler|udtrykker|tilslutter|peger|mener|ønsker|påpeger|efterspørger|efterlyser|understreger|kræver|henstiller|advarer|vurderer|finder|beskriver)(\s+|,\s*|\s+at\s+|\s+og\s+)/gi;
    clean = clean.replace(orphanedVerbPattern, (match, verb, suffix) => {
      // Capitalize the verb and prepend "Gruppen" as a generic subject
      return `. Gruppen ${verb.toLowerCase()}${suffix}`;
    });

    // Fix orphaned verbs after comma (same issue, different context)
    // Pattern: ", verb ..." where verb is a common Danish verb that needs "og der"
    // E.g., ", efterspørger en åben proces" → ", og der efterspørges en åben proces"
    const orphanedVerbAfterComma = /,\s+(afviser|anfører|argumenterer|fremhæver|kritiserer|foreslår|anbefaler|udtrykker|tilslutter|peger|mener|ønsker|påpeger|efterspørger|efterlyser|understreger|kræver|henstiller|advarer|vurderer|finder|beskriver)(\s+|,\s*|\s+at\s+|\s+og\s+)/gi;
    clean = clean.replace(orphanedVerbAfterComma, (match, verb, suffix) => {
      // Convert to passive form with "og der"
      const passiveForm = verb.toLowerCase().replace(/er$/, 'es');
      return `, og der ${passiveForm}${suffix}`;
    });

    // Fix organization name duplication
    // Pattern: "Name og X borgere Name og X borgere" or "Name og X borgere name og X borgere"
    // Use word-boundary aware approach
    const orgDupPattern = /([A-ZÆØÅ][^.!?]{5,50}\s+og\s+\d+\s+borgere)\s+\1/gi;
    clean = clean.replace(orgDupPattern, '$1');

    // Also handle case-insensitive duplicate with different casing (lowercased second occurrence)
    // e.g., "BYENSdesign København ApS og 354 borgere bYENSdesign København ApS og 354 borgere"
    const caseInsensitiveDup = /([A-ZÆØÅ][^.!?]{5,50}\s+og\s+\d+\s+borgere)\s+([a-zæøå][^.!?]{5,50}\s+og\s+\d+\s+borgere)/gi;
    clean = clean.replace(caseInsensitiveDup, (match, first, second) => {
      if (first.toLowerCase() === second.toLowerCase()) return first;
      return match;
    });

    // Clean up orphaned periods or double punctuation that may result from cleanup
    clean = clean.replace(/\.\s*\./g, '.');
    // Collapse multiple spaces (but not newlines) into single space
    clean = clean.replace(/ {2,}/g, ' ');

    // Generate and prepend TOC
    const toc = this.generateTOC(clean);
    return toc + clean.trim();
  }

  /**
   * Generate Table of Contents from clean prose markdown.
   * @param {string} cleanMarkdown - Clean markdown without CriticMarkup
   * @returns {string} TOC string to prepend to document
   */
  static generateTOC(cleanMarkdown) {
    if (!cleanMarkdown || typeof cleanMarkdown !== 'string') return '';

    const lines = cleanMarkdown.split('\n');
    const tocEntries = [];

    for (const line of lines) {
      // Match theme headers: # Theme Name
      const themeMatch = line.match(/^#\s+(.+?)(?:\s*$)/);
      if (themeMatch && !line.startsWith('##')) {
        tocEntries.push({ level: 1, title: themeMatch[1].trim() });
        continue;
      }

      // Match position headers: ## (N, LU, O) Title
      const positionMatch = line.match(/^##\s+\(([^)]+)\)\s+(.+?)(?:\s*$)/);
      if (positionMatch) {
        tocEntries.push({
          level: 2,
          meta: positionMatch[1],
          title: positionMatch[2].trim()
        });
      }
    }

    if (tocEntries.length === 0) return '';

    let toc = '## Indholdsfortegnelse\n\n';
    for (const entry of tocEntries) {
      if (entry.level === 1) {
        toc += `**${entry.title}**\n`;
      } else {
        toc += `  - (${entry.meta}) ${entry.title}\n`;
      }
    }

    return toc + '\n---\n\n';
  }

  /**
   * Clean hybrid output from PositionWriter
   * @param {Object} hybridOutput - Output from LLM
   * @returns {Object} Cleaned output
   */
  static cleanHybridOutput(hybridOutput) {
    if (!hybridOutput) {
      return hybridOutput;
    }
    
    const cleaned = { ...hybridOutput };
    
    // Clean the summary
    if (cleaned.summary) {
      cleaned.summary = this.cleanSummary(cleaned.summary);
    }
    
    // Clean any quotes in references
    if (cleaned.references && Array.isArray(cleaned.references)) {
      cleaned.references = cleaned.references.map(ref => {
        const cleanRef = { ...ref };
        
        // Clean label
        if (cleanRef.label) {
          cleanRef.label = this.cleanSummary(cleanRef.label);
        }
        
        // Clean quotes
        if (cleanRef.quotes && Array.isArray(cleanRef.quotes)) {
          cleanRef.quotes = cleanRef.quotes.map(quote => ({
            ...quote,
            quote: this.cleanSummary(quote.quote)
          }));
        }
        
        return cleanRef;
      });
    }
    
    return cleaned;
  }
}

export default CriticMarkupCleaner;
