/**
 * Document Chunker
 * 
 * Smart chunking utility for large documents.
 * Splits documents by structural elements (headers, sections) while respecting size limits.
 * Includes relevance scoring to weight chunks by importance.
 * 
 * Used by: SubstanceExtractor, ThemeExtractor, MaterialSummarizer, and other LLM-based analyzers.
 */

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  maxChunkSize: 25000,      // Max chars per chunk
  minChunkSize: 5000,       // Min chars before forcing a split
  overlapSize: 1000,        // Overlap between chunks for context
  preferHeaderBreaks: true, // Prefer breaking at headers
  headerPattern: /^#{1,6}\s+.+$/gm,  // Markdown headers
  enableRelevanceScoring: true  // Score chunks by importance
};

/**
 * Keywords that indicate HIGH relevance (core regulatory content)
 * These are weighted heavily in relevance scoring
 */
const HIGH_RELEVANCE_PATTERNS = {
  lokalplan: [
    /bestemmelser/i,
    /§\s*\d+/,                    // § sections
    /formål/i,
    /anvendelse/i,
    /bebyggelse/i,
    /omfang/i,
    /placering/i,
    /højde/i,
    /parkering/i,
    /veje/i,
    /ubebyggede arealer/i,
    /støj/i,
    /retsvirkninger/i
  ],
  dispensation: [
    /dispensation/i,
    /dispenseres/i,
    /fravigelse/i,
    /vilkår/i,
    /betingelse/i,
    /tilladelse/i,
    /afgørelse/i
  ],
  politik: [
    /mål/i,
    /vision/i,
    /strategi/i,
    /prioritet/i,
    /indsats/i,
    /handling/i
  ],
  default: [
    /bestemmelse/i,
    /§\s*\d+/,
    /krav/i,
    /skal/i,
    /må ikke/i,
    /forpligtet/i
  ]
};

/**
 * Keywords that indicate LOW relevance (procedural/meta content)
 * These patterns help identify REDEGØRELSE sections that should be deprioritized
 * in favor of BESTEMMELSER (the actual regulatory provisions)
 */
const LOW_RELEVANCE_PATTERNS = [
  // Procedural/meta content
  /praktiske oplysninger/i,
  /hvad er en lokalplan/i,
  /høringsperiode/i,
  /offentliggør/i,
  /indholdsfortegnelse/i,
  /tegning\s*\d+/i,
  /bilag/i,

  // REDEGØRELSE section markers (explanatory, not regulatory)
  /redegørelse/i,           // Background, not the actual rules
  /baggrund/i,
  /miljøvurdering/i,
  /kommuneplan(?!\s*ramme)/i, // References, not the plan itself (but allow "kommuneplanramme")

  // REDEGØRELSE content indicators (descriptive sections in lokalplaner)
  /egenart(?:en)?/i,                    // "Egenarten" - area character description
  /eksisterende forhold/i,              // Current state description
  /fremtidige trafikforhold/i,          // Traffic forecast (not regulation)
  /områdets karakter/i,                 // Area description
  /planens indhold/i,                   // Summary, not rules
  /planhistorik/i,                      // Historical context
  /lokalplanens baggrund/i,             // Background explanation
  /planmæssig vurdering/i,              // Assessment, not rules
  /lokalplanområdet er beliggende/i,    // Location description
  /formålet med lokalplanen er/i,       // Purpose statement (not the formal § 1)
];

/**
 * Smart chunk a document by structural elements
 * 
 * Strategy:
 * 1. First, try to split by major headers (## or ###)
 * 2. If sections are still too large, split by paragraphs
 * 3. If paragraphs are still too large, split by sentences
 * 4. Add overlap between chunks for context continuity
 * 
 * @param {string} text - The document text to chunk
 * @param {Object} options - Configuration options
 * @returns {Array<{text: string, metadata: Object}>} Array of chunks with metadata
 */
export function smartChunk(text, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  
  if (!text || text.length === 0) {
    return [];
  }
  
  // Small documents don't need chunking
  if (text.length <= config.maxChunkSize) {
    return [{
      text,
      metadata: {
        chunkIndex: 0,
        totalChunks: 1,
        startChar: 0,
        endChar: text.length,
        isComplete: true
      }
    }];
  }
  
  // Parse document structure
  const sections = parseDocumentStructure(text, config);
  
  // Build chunks from sections
  const chunks = buildChunksFromSections(sections, config);
  
  // Add metadata and relevance scores
  const documentType = config.documentType || 'default';
  
  return chunks.map((chunk, idx) => {
    const relevance = config.enableRelevanceScoring
      ? calculateRelevanceScore(chunk.text, chunk.headers || [], documentType)
      : { score: 1.0, category: 'unknown', matchedPatterns: [] };

    return {
      text: chunk.text,
      metadata: {
        chunkIndex: idx,
        totalChunks: chunks.length,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        headers: chunk.headers || [],
        parentContexts: chunk.parentContexts || [],  // Hierarchical context (e.g., "§ 5" for "Stk. 1")
        isComplete: false,
        relevance: relevance
      }
    };
  });
}

/**
 * Calculate relevance score for a chunk based on content and headers
 * 
 * @param {string} text - Chunk text
 * @param {Array} headers - Headers in this chunk
 * @param {string} documentType - Type of document (lokalplan, dispensation, etc.)
 * @returns {Object} Relevance info with score, category, and matched patterns
 */
function calculateRelevanceScore(text, headers, documentType) {
  const combinedText = [text, ...headers].join(' ').toLowerCase();
  
  // Get high relevance patterns for this document type
  const highPatterns = HIGH_RELEVANCE_PATTERNS[documentType] || HIGH_RELEVANCE_PATTERNS.default;
  
  // Count matches
  let highMatches = 0;
  let lowMatches = 0;
  const matchedHighPatterns = [];
  const matchedLowPatterns = [];
  
  // Check high relevance patterns
  for (const pattern of highPatterns) {
    const matches = combinedText.match(pattern);
    if (matches) {
      highMatches += matches.length;
      matchedHighPatterns.push(pattern.toString());
    }
  }
  
  // Check low relevance patterns
  for (const pattern of LOW_RELEVANCE_PATTERNS) {
    const matches = combinedText.match(pattern);
    if (matches) {
      lowMatches += matches.length;
      matchedLowPatterns.push(pattern.toString());
    }
  }
  
  // Check for § sections (very high relevance for lokalplan)
  const paragraphMatches = (text.match(/§\s*\d+/g) || []).length;
  if (paragraphMatches > 0) {
    highMatches += paragraphMatches * 2; // Weight § sections heavily
  }
  
  // Calculate score (0.0 to 1.0)
  // Base score starts at 0.5
  // High relevance patterns increase it, low relevance patterns decrease it
  let score = 0.5;
  score += Math.min(highMatches * 0.1, 0.4);  // Max +0.4 from high matches
  score -= Math.min(lowMatches * 0.1, 0.3);   // Max -0.3 from low matches
  score = Math.max(0.1, Math.min(1.0, score)); // Clamp to 0.1-1.0
  
  // Determine category
  let category;
  if (score >= 0.7) {
    category = 'high';
  } else if (score >= 0.4) {
    category = 'medium';
  } else {
    category = 'low';
  }
  
  return {
    score,
    category,
    highMatches,
    lowMatches,
    matchedHighPatterns: matchedHighPatterns.slice(0, 5), // Limit for logging
    matchedLowPatterns: matchedLowPatterns.slice(0, 5)
  };
}

/**
 * Parse document into structural sections based on headers
 * Tracks parent context (header hierarchy) for each section
 */
function parseDocumentStructure(text, config) {
  const sections = [];
  const headerRegex = /^(#{1,6})\s+(.+)$/gm;

  let lastIndex = 0;
  let match;

  // Find all headers and their positions
  const headers = [];
  while ((match = headerRegex.exec(text)) !== null) {
    headers.push({
      level: match[1].length,
      title: match[2].trim(),
      index: match.index,
      fullMatch: match[0]
    });
  }

  // If no headers found, treat entire text as one section
  if (headers.length === 0) {
    return [{
      title: null,
      level: 0,
      content: text,
      startChar: 0,
      endChar: text.length,
      parentContext: null
    }];
  }

  // Track header hierarchy for parent context
  // headerStack[level] = title at that level
  const headerStack = {};

  /**
   * Build parent context string from header stack
   * For a section at level 6 with parents at level 4 and 5:
   * Returns "§ 5. Bil- og cykelparkering > Stk. 1. Bilparkering"
   */
  function buildParentContext(currentLevel) {
    const parents = [];
    // Collect all parent headers (lower level numbers = higher in hierarchy)
    for (let lvl = 1; lvl < currentLevel; lvl++) {
      if (headerStack[lvl]) {
        parents.push(headerStack[lvl]);
      }
    }
    return parents.length > 0 ? parents.join(' > ') : null;
  }

  // Create sections between headers
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const nextHeader = headers[i + 1];

    // Content before first header
    if (i === 0 && header.index > 0) {
      const preContent = text.slice(0, header.index).trim();
      if (preContent.length > 0) {
        sections.push({
          title: null,
          level: 0,
          content: preContent,
          startChar: 0,
          endChar: header.index,
          parentContext: null
        });
      }
    }

    // Update header stack: clear all levels >= current, then set current
    for (let lvl = header.level; lvl <= 6; lvl++) {
      delete headerStack[lvl];
    }

    // Build parent context BEFORE adding current header to stack
    const parentContext = buildParentContext(header.level);

    // Now add current header to stack
    headerStack[header.level] = header.title;

    // Section content (from this header to next header or end)
    const sectionStart = header.index;
    const sectionEnd = nextHeader ? nextHeader.index : text.length;
    const sectionContent = text.slice(sectionStart, sectionEnd).trim();

    sections.push({
      title: header.title,
      level: header.level,
      content: sectionContent,
      startChar: sectionStart,
      endChar: sectionEnd,
      headerLine: header.fullMatch,
      parentContext: parentContext
    });
  }

  return sections;
}

/**
 * Build chunks from sections, respecting size limits
 * Tracks parentContext for hierarchy (e.g., "§ 5" for "Stk. 1")
 */
function buildChunksFromSections(sections, config) {
  const chunks = [];
  let currentChunk = {
    text: '',
    startChar: 0,
    endChar: 0,
    headers: [],
    parentContexts: []  // Track parent contexts from all sections in this chunk
  };

  for (const section of sections) {
    const sectionSize = section.content.length;
    const currentSize = currentChunk.text.length;

    // If section fits in current chunk
    if (currentSize + sectionSize <= config.maxChunkSize) {
      if (currentChunk.text.length === 0) {
        currentChunk.startChar = section.startChar;
      }
      currentChunk.text += (currentChunk.text ? '\n\n' : '') + section.content;
      currentChunk.endChar = section.endChar;
      if (section.title) {
        currentChunk.headers.push(section.title);
      }
      if (section.parentContext && !currentChunk.parentContexts.includes(section.parentContext)) {
        currentChunk.parentContexts.push(section.parentContext);
      }
    }
    // If section is too large on its own, split it
    else if (sectionSize > config.maxChunkSize) {
      // Save current chunk if it has content
      if (currentChunk.text.length >= config.minChunkSize) {
        chunks.push({ ...currentChunk });
        currentChunk = { text: '', startChar: section.startChar, endChar: 0, headers: [], parentContexts: [] };
      }

      // Split large section by paragraphs (inherit parentContext)
      const subChunks = splitLargeSection(section, config);
      for (const subChunk of subChunks) {
        // Inherit parentContext from the parent section
        subChunk.parentContexts = section.parentContext ? [section.parentContext] : [];

        if (currentChunk.text.length + subChunk.text.length <= config.maxChunkSize) {
          if (currentChunk.text.length === 0) {
            currentChunk.startChar = subChunk.startChar;
          }
          currentChunk.text += (currentChunk.text ? '\n\n' : '') + subChunk.text;
          currentChunk.endChar = subChunk.endChar;
          if (subChunk.headers) {
            currentChunk.headers.push(...subChunk.headers);
          }
          if (subChunk.parentContexts) {
            for (const pc of subChunk.parentContexts) {
              if (!currentChunk.parentContexts.includes(pc)) {
                currentChunk.parentContexts.push(pc);
              }
            }
          }
        } else {
          if (currentChunk.text.length > 0) {
            chunks.push({ ...currentChunk });
          }
          currentChunk = { ...subChunk };
        }
      }
    }
    // Start new chunk
    else {
      if (currentChunk.text.length > 0) {
        chunks.push({ ...currentChunk });
      }
      currentChunk = {
        text: section.content,
        startChar: section.startChar,
        endChar: section.endChar,
        headers: section.title ? [section.title] : [],
        parentContexts: section.parentContext ? [section.parentContext] : []
      };
    }
  }

  // Don't forget last chunk
  if (currentChunk.text.length > 0) {
    chunks.push(currentChunk);
  }

  // Add overlap between chunks
  return addOverlap(chunks, config);
}

/**
 * Split a large section by paragraphs, then by sentences if needed
 */
function splitLargeSection(section, config) {
  const chunks = [];
  const paragraphs = section.content.split(/\n\n+/);
  
  let currentChunk = {
    text: '',
    startChar: section.startChar,
    endChar: section.startChar,
    headers: section.title ? [section.title] : []
  };
  
  for (const paragraph of paragraphs) {
    // If paragraph itself is too large, split by sentences
    if (paragraph.length > config.maxChunkSize) {
      if (currentChunk.text.length > 0) {
        chunks.push({ ...currentChunk });
        currentChunk = { text: '', startChar: currentChunk.endChar, endChar: currentChunk.endChar, headers: [] };
      }
      
      const sentenceChunks = splitBySentences(paragraph, config);
      chunks.push(...sentenceChunks);
    }
    // If adding paragraph would exceed limit
    else if (currentChunk.text.length + paragraph.length > config.maxChunkSize) {
      if (currentChunk.text.length > 0) {
        chunks.push({ ...currentChunk });
      }
      currentChunk = {
        text: paragraph,
        startChar: currentChunk.endChar,
        endChar: currentChunk.endChar + paragraph.length,
        headers: []
      };
    }
    // Add paragraph to current chunk
    else {
      currentChunk.text += (currentChunk.text ? '\n\n' : '') + paragraph;
      currentChunk.endChar = currentChunk.startChar + currentChunk.text.length;
    }
  }
  
  if (currentChunk.text.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Split text by sentences (last resort for very long paragraphs)
 */
function splitBySentences(text, config) {
  const chunks = [];
  // Split by sentence endings (. ! ? followed by space or end)
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  let currentChunk = { text: '', startChar: 0, endChar: 0, headers: [] };
  
  for (const sentence of sentences) {
    if (currentChunk.text.length + sentence.length > config.maxChunkSize) {
      if (currentChunk.text.length > 0) {
        chunks.push({ ...currentChunk });
      }
      currentChunk = { text: sentence, startChar: currentChunk.endChar, endChar: currentChunk.endChar + sentence.length, headers: [] };
    } else {
      currentChunk.text += (currentChunk.text ? ' ' : '') + sentence;
      currentChunk.endChar = currentChunk.startChar + currentChunk.text.length;
    }
  }
  
  if (currentChunk.text.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Add overlap between chunks for context continuity
 */
function addOverlap(chunks, config) {
  if (chunks.length <= 1 || config.overlapSize === 0) {
    return chunks;
  }
  
  const result = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = { ...chunks[i] };
    
    // Add context from previous chunk (end of previous)
    if (i > 0 && config.overlapSize > 0) {
      const prevChunk = chunks[i - 1];
      const overlapText = getOverlapFromEnd(prevChunk.text, config.overlapSize);
      if (overlapText) {
        chunk.text = `[...fortsat fra forrige del...]\n${overlapText}\n\n---\n\n${chunk.text}`;
        chunk.hasOverlapPrefix = true;
      }
    }
    
    result.push(chunk);
  }
  
  return result;
}

/**
 * Get overlap text from the end of a chunk
 */
function getOverlapFromEnd(text, overlapSize) {
  if (text.length <= overlapSize) {
    return text;
  }
  
  // Try to break at a paragraph
  const endPortion = text.slice(-overlapSize * 1.5);
  const paragraphBreak = endPortion.indexOf('\n\n');
  if (paragraphBreak !== -1 && paragraphBreak < overlapSize) {
    return endPortion.slice(paragraphBreak + 2);
  }
  
  // Try to break at a sentence
  const sentenceBreak = endPortion.search(/[.!?]\s/);
  if (sentenceBreak !== -1) {
    return endPortion.slice(sentenceBreak + 2);
  }
  
  // Just take the last N characters
  return text.slice(-overlapSize);
}

/**
 * Merge results from chunked processing with relevance weighting
 * 
 * Items from high-relevance chunks get boosted confidence.
 * Items from low-relevance chunks get reduced confidence.
 * 
 * @param {Array} results - Array of results from each chunk (with chunkRelevance)
 * @param {Object} options - Merge options
 * @returns {Object} Merged result with weighted items
 */
export function mergeChunkResults(results, options = {}) {
  const {
    itemsKey = 'items',
    deduplicateBy = ['reference', 'title'],
    averageConfidence = true,
    applyRelevanceWeighting = true  // Weight items by chunk relevance
  } = options;
  
  const allItems = [];
  const seenKeys = new Set();
  let totalConfidence = 0;
  let validResults = 0;
  let highRelevanceChunks = 0;
  let lowRelevanceChunks = 0;
  
  for (const result of results) {
    if (!result) continue;
    
    // Get chunk relevance (default to 1.0 if not provided)
    const chunkRelevance = result.chunkRelevance || { score: 1.0, category: 'unknown' };
    
    // Track relevance distribution
    if (chunkRelevance.category === 'high') highRelevanceChunks++;
    else if (chunkRelevance.category === 'low') lowRelevanceChunks++;
    
    const items = result[itemsKey] || [];
    for (const item of items) {
      // Create deduplication key
      const keyParts = deduplicateBy.map(field => item[field] || '').filter(Boolean);
      const key = keyParts.join('|') || JSON.stringify(item);
      
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        
        // Apply relevance weighting to item
        const weightedItem = { ...item };
        
        if (applyRelevanceWeighting && chunkRelevance.score) {
          // Boost/reduce item confidence based on chunk relevance
          const baseConfidence = item.confidence || 0.7;
          const relevanceMultiplier = 0.5 + (chunkRelevance.score * 0.5); // 0.55 to 1.0
          weightedItem.confidence = Math.min(1.0, baseConfidence * relevanceMultiplier);
          weightedItem.sourceChunkRelevance = chunkRelevance.category;
        }
        
        allItems.push(weightedItem);
      }
    }
    
    if (typeof result.confidence === 'number') {
      // Weight confidence by chunk relevance
      const weight = applyRelevanceWeighting ? (chunkRelevance.score || 1.0) : 1.0;
      totalConfidence += result.confidence * weight;
      validResults += weight;
    }
  }
  
  // Sort items: high-relevance items first, then by original order
  if (applyRelevanceWeighting) {
    allItems.sort((a, b) => {
      const aRel = a.sourceChunkRelevance === 'high' ? 2 : a.sourceChunkRelevance === 'medium' ? 1 : 0;
      const bRel = b.sourceChunkRelevance === 'high' ? 2 : b.sourceChunkRelevance === 'medium' ? 1 : 0;
      return bRel - aRel; // High relevance first
    });
  }
  
  return {
    [itemsKey]: allItems,
    confidence: averageConfidence && validResults > 0 ? totalConfidence / validResults : 0.5,
    chunksProcessed: results.length,
    totalItemsBeforeDedup: results.reduce((sum, r) => sum + (r?.[itemsKey]?.length || 0), 0),
    totalItemsAfterDedup: allItems.length,
    relevanceDistribution: {
      high: highRelevanceChunks,
      medium: results.length - highRelevanceChunks - lowRelevanceChunks,
      low: lowRelevanceChunks
    }
  };
}

/**
 * Estimate token count for a text (rough approximation)
 * Useful for staying within model context limits
 */
export function estimateTokens(text) {
  // Rough approximation: ~4 chars per token for English/Danish
  return Math.ceil(text.length / 4);
}

/**
 * Get recommended chunk size based on model context window
 */
export function getRecommendedChunkSize(modelContextWindow = 128000, reserveForOutput = 8000) {
  // Leave room for system prompt, output, and some buffer
  const availableTokens = modelContextWindow - reserveForOutput - 2000;
  // Convert to chars (rough: 4 chars per token)
  return Math.floor(availableTokens * 4 * 0.8); // 80% to be safe
}

export default {
  smartChunk,
  mergeChunkResults,
  estimateTokens,
  getRecommendedChunkSize
};
