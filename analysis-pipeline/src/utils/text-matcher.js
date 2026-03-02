/**
 * Text Matcher Utilities
 * 
 * Helper functions for finding quotes in text with flexible matching
 * (whitespace insensitive, case insensitive, punctuation insensitive, partial recovery)
 */

/**
 * Finds a quote in a source text with flexible matching.
 * Priority:
 * 1. Exact match
 * 2. Flexible whitespace (regex)
 * 3. Case insensitive flexible whitespace
 * 4. Normalized match (alphanumeric only)
 * 5. Best Partial Match (Longest Common Substring of words) - handles missing words or disjoint sentences
 * 
 * @param {string} sourceText - The full source text
 * @param {string} quote - The quote to find
 * @returns {Object} Result object { found: boolean, exactQuote: string, index: number, confidence: number }
 */
export function findFlexibleQuote(sourceText, quote) {
  if (!sourceText || !quote) return { found: false, exactQuote: null, index: -1, confidence: 0 };

  const trimmedQuote = quote.trim();
  if (!trimmedQuote) return { found: false, exactQuote: null, index: -1, confidence: 0 };

  // 1. Exact match (fastest)
  if (sourceText.includes(quote)) {
    return { 
      found: true, 
      exactQuote: quote, 
      index: sourceText.indexOf(quote),
      confidence: 1.0
    };
  }

  // 2 & 3. Flexible whitespace match (case sensitive & insensitive)
  const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = trimmedQuote.split(/\s+/).map(escapeRegExp);
  const regexPattern = parts.join('\\s+');
  
  try {
    const regex = new RegExp(regexPattern);
    const match = sourceText.match(regex);
    if (match) {
      return { 
        found: true, 
        exactQuote: match[0], 
        index: match.index,
        confidence: 0.95
      };
    }
    
    const regexCI = new RegExp(regexPattern, 'i');
    const matchCI = sourceText.match(regexCI);
    if (matchCI) {
      return { 
        found: true, 
        exactQuote: matchCI[0], 
        index: matchCI.index,
        confidence: 0.9
      };
    }
  } catch (e) {
    // Ignore regex errors
  }

  // 4. Normalized match (ignoring punctuation, casing, symbols)
  const normResult = findNormalizedMatch(sourceText, trimmedQuote);
  if (normResult.found) {
    return normResult;
  }

  // 5. Best Partial Match (Recovery)
  // This handles cases like missing words at end/start, or disjoint sentences (returns the longest part)
  const partialResult = findBestPartialMatch(sourceText, trimmedQuote);
  if (partialResult.found) {
    return partialResult;
  }

  return { found: false, exactQuote: null, index: -1, confidence: 0 };
}

/**
 * Finds a match by normalizing both texts (removing non-alphanumeric chars)
 * and mapping back to original positions.
 */
function findNormalizedMatch(sourceText, quote) {
  // Create normalized versions and keep track of index mapping
  const normalize = (text) => {
    let normalized = '';
    const indices = [];
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      // Keep only alphanumeric chars (including Danish chars)
      if (/[a-zA-Z0-9æøåÆØÅ]/.test(char)) {
        normalized += char.toLowerCase();
        indices.push(i);
      }
    }
    return { str: normalized, indices };
  };

  const normSource = normalize(sourceText);
  const normQuote = normalize(quote);

  if (normQuote.str.length < 10) {
    // Don't try normalized match for very short quotes
    return { found: false, exactQuote: null, index: -1, confidence: 0 };
  }

  const matchIndex = normSource.str.indexOf(normQuote.str);

  if (matchIndex !== -1) {
    const startOrigIndex = normSource.indices[matchIndex];
    const endOrigIndex = normSource.indices[matchIndex + normQuote.str.length - 1] + 1;
    
    return {
      found: true,
      exactQuote: sourceText.substring(startOrigIndex, endOrigIndex),
      index: startOrigIndex,
      confidence: 0.85
    };
  }

  return { found: false, exactQuote: null, index: -1, confidence: 0 };
}

/**
 * Finds the longest continuous substring of words from the quote that exists in the source.
 * If the match covers a significant portion of the quote (>60%), returns it as a valid match.
 */
function findBestPartialMatch(sourceText, quote) {
  // Tokenize by words (basic split)
  const tokenize = (text) => {
    const tokens = [];
    const regex = /([a-zA-Z0-9æøåÆØÅ]+|[^\s\w]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      tokens.push({ text: match[0], index: match.index });
    }
    return tokens;
  };

  const sourceTokens = tokenize(sourceText);
  const quoteTokens = tokenize(quote);

  if (quoteTokens.length < 3) {
    return { found: false, exactQuote: null, index: -1, confidence: 0 };
  }

  // Longest Common Substring (of tokens)
  let maxLen = 0;
  let endSourceIndex = 0; // index in sourceTokens
  
  // DP table for LCS (optimized for space if needed, but full table is fine for paragraph size)
  // Using flat array or Map for sparse matrix might be better for huge texts,
  // but usually responses are < 10k chars.
  // Let's use a simplified approach: sliding window match since we want *contiguous*
  
  // Iterate through quote tokens and find longest sequence in source
  // This is O(N*M) which is fine for N,M < 1000
  
  for (let i = 0; i < sourceTokens.length; i++) {
    for (let j = 0; j < quoteTokens.length; j++) {
      let k = 0;
      while (
        i + k < sourceTokens.length && 
        j + k < quoteTokens.length && 
        sourceTokens[i + k].text.toLowerCase() === quoteTokens[j + k].text.toLowerCase()
      ) {
        k++;
      }
      
      if (k > maxLen) {
        maxLen = k;
        endSourceIndex = i + k - 1;
      }
    }
  }

  // Check if the match is "good enough"
  // Use a softer threshold for short quotes (< 8 tokens / ~50 chars)
  // Short quotes are often incomplete but legitimate extracts
  const isShortQuote = quoteTokens.length < 8;
  const minMatchRatio = isShortQuote ? 0.55 : 0.75;

  const matchRatio = maxLen / quoteTokens.length;

  if (maxLen >= 3 && (matchRatio > minMatchRatio || maxLen > 20)) {
    // Reconstruct the matched text from source
    const startToken = sourceTokens[endSourceIndex - maxLen + 1];
    const endToken = sourceTokens[endSourceIndex];

    const startIndex = startToken.index;
    const endIndex = endToken.index + endToken.text.length;

    const matchedText = sourceText.substring(startIndex, endIndex);

    return {
      found: true,
      exactQuote: matchedText,
      index: startIndex,
      confidence: 0.5 * matchRatio // Reduced confidence for partial matches
    };
  }

  return { found: false, exactQuote: null, index: -1, confidence: 0 };
}
