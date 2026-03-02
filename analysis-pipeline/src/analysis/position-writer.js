import { chunkArray } from '../utils/array-utils.js';
import { HybridPromptRunner } from '../utils/hybrid-prompt-runner.js';
import { PositionWriterValidator } from '../utils/position-writer-validator.js';
import { getComplexityConfig } from '../utils/openai-client.js';
import { DynamicParameterCalculator } from '../utils/dynamic-parameter-calculator.js';
import { CitationIntegrityValidator } from '../validation/citation-integrity-validator.js';
import { CriticMarkupValidator } from '../validation/criticmarkup-validator.js';
import { CriticMarkupCleaner } from '../utils/criticmarkup-cleaner.js';
import { LLMTracer } from '../utils/llm-tracer.js';
import { findFlexibleQuote } from '../utils/text-matcher.js';
import { DanishNumberFormatter } from '../utils/danish-number-formatter.js';
import { LabelCountValidator } from '../utils/label-count-validator.js';
import { OpenAIReranker } from '../retrieval/openai-reranker.js';
import { OutputFormatter } from '../utils/output-formatter.js';

const DEFAULTS = {
  chunk: {
    maxRespondentsPerChunk: 25,
    maxSnippetsPerRespondent: 3, // RESTORED: Keep all 3 snippets for quality
    maxSnippetChars: 600, // RESTORED: Keep original length
    maxExcerptChars: 1200, // RESTORED: Keep full context
    maxArgumentsPerRespondent: 4, // RESTORED: Keep all 4 arguments
    maxArgumentChars: 280 // RESTORED: Keep original length
  },
  prompts: {
    writePromptPath: 'prompts/hybrid-position-writer-prompt.md',
    stitchPromptPath: 'prompts/hybrid-position-stitch-prompt.md'
  }
};

// Get model config from complexity level (HEAVY for position writing)
// Use heavy (gpt-5-mini) as base for all position writing
function getDefaultModelConfig() {
  const complexityConfig = getComplexityConfig('heavy');
  console.log(`[PositionWriter] Heavy config from env: model=${complexityConfig.model}, verbosity=${complexityConfig.verbosity}, reasoning=${complexityConfig.reasoningEffort}`);
  return {
    name: complexityConfig.model,
    verbosity: complexityConfig.verbosity,
    reasoningEffort: complexityConfig.reasoningEffort
    // Note: GPT-5 models control temperature via verbosity/reasoning parameters
  };
}

/**
 * Calculate complexity score for a position based on content volume
 * @param {Object} position - Position to evaluate
 * @param {Array} rawResponses - All raw responses
 * @returns {number} Complexity score
 * @private
 */
function calculateComplexityScore(position, rawResponses) {
  const respondentCount = position.responseNumbers?.length || 0;
  
  // Calculate total character count for all responses in this position
  let totalChars = 0;
  position.responseNumbers?.forEach(responseNumber => {
    const response = rawResponses.find(r => r.id === responseNumber);
    if (response && response.text) {
      totalChars += response.text.length;
    }
  });
  
  // Complexity score: weighted by respondent count and character volume
  // Weight: 2.0 for respondent count, 1.0 for character volume (per 1000 chars)
  const score = (respondentCount * 2.0) + (totalChars / 1000);
  
  return score;
}

/**
 * Calculate target sentence count for a group based on logarithmic scaling.
 * This provides explicit guidance to LLM on expected verbosity.
 * 
 * Formula: sætninger ≈ 2 + 3 × log₂(n/10)
 * 
 * @param {number} respondentCount - Number of respondents in group
 * @returns {Object} { min, max, requiresBranching } - Target sentence range and branching flag
 * @private
 */
function calculateTargetSentences(respondentCount) {
  if (respondentCount <= 15) {
    return { min: 1, max: 2, requiresBranching: false };
  }
  if (respondentCount <= 40) {
    return { min: 2, max: 3, requiresBranching: false };
  }
  if (respondentCount <= 100) {
    return { min: 4, max: 5, requiresBranching: false };
  }
  if (respondentCount <= 300) {
    return { min: 5, max: 7, requiresBranching: false };
  }
  if (respondentCount <= 800) {
    return { min: 7, max: 10, requiresBranching: true };
  }
  // 800+ respondents: mega-group with internal branching
  return { min: 10, max: 16, requiresBranching: true };
}

/**
 * Get model configuration for position writing with CONTENT-AWARE ADAPTIVE LOGIC
 * Optimize performance by adjusting model based on position complexity (content + count)
 * @param {Object} position - Position to evaluate
 * @param {Array} rawResponses - All raw responses (for character count calculation)
 * @returns {Object} Model configuration with dynamic complexity
 */
function getModelForPosition(position, rawResponses = []) {
  const respondentCount = position.responseNumbers?.length || 0;
  
  // Calculate content-aware complexity score
  const complexityScore = calculateComplexityScore(position, rawResponses);
  
  // CONTENT-AWARE THRESHOLDS:
  // Low complexity: < 15 (e.g., 3 respondents x 2 + 3000 chars = 9)
  // Medium complexity: 15-40 (e.g., 8 respondents x 2 + 8000 chars = 24)
  // High complexity: > 40 (e.g., 15 respondents x 2 + 10000 chars = 40)
  
  let verbosity, complexity, reasoningOverride;
  
    if (complexityScore < 15) {
    // Low complexity: short content, few respondents
    // CRITICAL: Still use 'heavy' (gpt-5-mini) for output quality - nano ignores prompt rules
    // OPTIMIZATION: Keep reduced reasoning for simple tasks to save tokens
    verbosity = 'medium';
    complexity = 'heavy';  // MINIMUM for output text - never nano for user-facing summaries
    reasoningOverride = 'medium'; 
  } else if (complexityScore < 40) {
    // Medium complexity: moderate content → Use heavy
    verbosity = 'high';
    complexity = 'heavy';
  } else {
    // High complexity: long content, many respondents → Use ultra
    verbosity = 'high';
    complexity = 'ultra';
  }
  
  // Get appropriate complexity config
  const complexityConfig = getComplexityConfig(complexity);
  
  return {
    name: complexityConfig.model,
    verbosity: verbosity,
    reasoningEffort: reasoningOverride || complexityConfig.reasoningEffort
  };
}

/**
 * Conservative text truncation - QUALITY FIRST
 * Only truncate when absolutely necessary
 */
function truncateText(text = '', maxChars = 400) {
  if (!text || typeof text !== 'string') return '';
  text = text.trim();
  
  if (text.length <= maxChars) return text;
  
  // Conservative truncation: try to break at sentence boundary
  const truncated = text.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastComma = truncated.lastIndexOf(',');
  
  if (lastPeriod > maxChars * 0.7) {
    // Break at sentence if it's not too short
    return truncated.slice(0, lastPeriod + 1);
  } else if (lastComma > maxChars * 0.8) {
    // Break at comma if sentence break is too short
    return truncated.slice(0, lastComma) + '...';
  }
  
  return `${truncated}...`;
}

/**
 * Sanitize LLM-generated summary text to remove malformed REF patterns
 *
 * Handles cases where LLM generates broken CriticMarkup like:
 * - "292 borgere<<én borger anfører..." instead of "292 borgere<<REF_1>>"
 * - "Der<<én borger fremhæver..." instead of "Der<<REF_1>>"
 *
 * @param {string} summary - Raw summary text from LLM
 * @returns {string} Cleaned summary text
 */
function sanitizeSummary(summary) {
  if (!summary || typeof summary !== 'string') return summary || '';

  let cleaned = summary;
  let malformedCount = 0;

  // Pattern 1: Malformed << not followed by REF_ (e.g., "borgere<<én borger")
  // This catches broken CriticMarkup where LLM started << but didn't follow with REF_X>>
  const malformedPattern = /<<(?!REF_)([^<>]+?)(?:>>|(?=<<)|$)/g;
  const matches = cleaned.match(malformedPattern);
  if (matches) {
    malformedCount += matches.length;
    // Replace with a dash separator or remove entirely
    cleaned = cleaned.replace(malformedPattern, ' ');
  }

  // Pattern 2: Orphan << without closing >> (e.g., "borgere<<én")
  const orphanOpen = /<<(?!REF_)[^>]*$/g;
  if (orphanOpen.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(orphanOpen, '');
  }

  // Pattern 3: Numeric respondent count directly followed by << without REF_
  // e.g., "292 borgere<<én borger anfører"
  const numericPattern = /(\d+\s+borger(?:e)?)\s*<<(?!REF_)/gi;
  if (numericPattern.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(/(\d+\s+borger(?:e)?)\s*<<(?!REF_)([^<>]*?)(?:>>|(?=<<)|$)/gi, '$1 ');
  }

  // Pattern 4: Danish number words followed by << without REF_
  // e.g., "én borger<<én borger anfører"
  const danishPattern = /(\b(?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv)\s+borger(?:e)?)\s*<<(?!REF_)/gi;
  if (danishPattern.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(/(\b(?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv)\s+borger(?:e)?)\s*<<(?!REF_)([^<{]*?)(?=\{==|<<|$)/gi, '$1 ');
  }

  // Pattern 5: "Der<<" followed by text (not REF_)
  const derPattern = /\bDer<<(?!REF_)/gi;
  if (derPattern.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(/\bDer<<(?!REF_)([^<{]*?)(?=\{==|<<|$)/gi, 'Der ');
  }

  // Pattern 6: Label chains ending with <<REF_X>> - keep first label, remove duplicates
  // Handles: "Én borger<<én borger<<REF_5>>" → "Én borger <<REF_5>>"
  // Handles: "To borgere (2)<<én borger<<REF_13>>" → "To borgere <<REF_13>>"
  const labelChainWithRef = /((?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)(?:\s+enkelt)?\s+borger(?:e)?)(?:\s*\(\d+\))?(?:<<(?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)?(?:\s+enkelt)?\s*borger(?:e)?)+<<(REF_\d+>>)/gi;
  const chainMatches = cleaned.match(labelChainWithRef);
  if (chainMatches && chainMatches.length > 0) {
    malformedCount += chainMatches.length;
    cleaned = cleaned.replace(labelChainWithRef, '$1 <<$2');
  }

  // Pattern 6b: "Der<<ENTITY<<REF_X>>" → "Der <<REF_X>>"
  // Handles: "Der<<BYENSdesign København ApS og 349 borgere<<REF_2>>"
  const derEntityChain = /\bDer<<[^<]+<<(REF_\d+>>)/gi;
  const derChainMatches = cleaned.match(derEntityChain);
  if (derChainMatches && derChainMatches.length > 0) {
    malformedCount += derChainMatches.length;
    cleaned = cleaned.replace(derEntityChain, 'Der <<$1');
  }

  // Pattern 6c: Chains without REF (legacy) - remove entirely as safety net
  // e.g., "én borger<<én borger<<" (no REF_X at end)
  cleaned = cleaned.replace(/((?:én|en)\s+borger<<){2,}(?!REF_)/gi, '');

  // Pattern 6d: Repeated "borgere<<borgere<<" chains (any form, no REF)
  // e.g., "292 borgere<<én borger<<én borger<<"
  const borgerChainPattern = /(\b(?:borgere?|Borgere?|Borgeren)\s*<<)+(?!REF_)/gi;
  if (borgerChainPattern.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(/(\b(?:borgere?|Borgere?|Borgeren)\s*<<)+(?!REF_)/gi, '');
  }

  // Pattern 6e: Repeated "Der<<Der<<" chains (no REF)
  const derChainPattern = /(Der\s*<<)+(?!REF_)/gi;
  if (derChainPattern.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(/(Der\s*<<)+(?!REF_)/gi, 'Der ');
  }

  // Pattern 6f: General label<<label<< chains where same word repeats
  // e.g., "Respondenten<<Respondenten<<", "Vedkommende<<Vedkommende<<"
  const labelWords = ['Vedkommende', 'Respondenten', 'Pågældende', 'Gruppen', 'Udvalget', 'Organisationen', 'Foreningen'];
  for (const word of labelWords) {
    const chainRegex = new RegExp(`(${word}\\s*<<)+(?!REF_)`, 'gi');
    if (chainRegex.test(cleaned)) {
      malformedCount++;
      cleaned = cleaned.replace(chainRegex, word + ' ');
    }
  }

  // Pattern 6g: Stray <<label. without REF_ (period-terminated)
  // Handles: "kulturarv<<én borger." → "kulturarv. Én borger."
  const strayLabelPeriod = /<<((?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)\s+borger(?:e)?)\./gi;
  if (strayLabelPeriod.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(strayLabelPeriod, '. $1.');
  }

  // Pattern 6h: Any stray << followed by text without REF_ (catch-all safety net)
  // Handles leftover << that don't start a valid <<REF_X>> or <<GROUP_X>> pattern
  const strayOpenAngle = /<<(?!REF_|GROUP_)([^<]{1,50})(?=\s|$|\.|\,)/g;
  if (strayOpenAngle.test(cleaned)) {
    malformedCount++;
    cleaned = cleaned.replace(strayOpenAngle, '. $1');
  }

  // Pattern 7: Cluster titles with bold and counts (mega-position leakage)
  // e.g., "**Cluster 2: Palads som bygningsværk** (233 høringssvar):"
  cleaned = cleaned.replace(/\*\*Cluster \d+[^*]*\*\*\s*\([^)]*høringssvar\):\s*/gi, '');

  // Pattern 8: Any bold title followed by (X høringssvar): pattern
  // e.g., "**Modstand mod nedrivning** (to høringssvar):"
  cleaned = cleaned.replace(/\*\*[^*]+\*\*\s*\(\s*(?:ét|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)\s*høringssvar\s*\):\s*/gi, '');

  // Clean up double spaces, triple dots, etc.
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  cleaned = cleaned.replace(/\s+([.,;:!?])/g, '$1');
  cleaned = cleaned.replace(/([.,])\s*\1+/g, '$1'); // ".. " -> "."

  if (malformedCount > 0) {
    console.log(`[PositionWriter] 🧹 Sanitized ${malformedCount} malformed REF pattern(s) from summary`);
  }

  return cleaned.trim();
}

/**
 * PositionWriter
 *
 * Generates hybrid summaries (summary + citations) for aggregated positions.
 * Handles large respondent counts by chunking and stitching partial outputs.
 */
export class PositionWriter {
  constructor(options = {}) {
    this.options = {
      ...DEFAULTS,
      ...options,
      chunk: {
        ...DEFAULTS.chunk,
        ...(options.chunk || {})
      },
      model: {
        ...getDefaultModelConfig(), // Use complexity-based config
        ...(options.model || {})
      },
      prompts: {
        ...DEFAULTS.prompts,
        ...(options.prompts || {})
      }
    };

    this.promptRunner = new HybridPromptRunner({
      model: this.options.model,
      writePromptPath: this.options.prompts.writePromptPath,
      stitchPromptPath: this.options.prompts.stitchPromptPath,
      jobId: options.jobId // Pass jobId for tracing
    });

    // Initialize separate tracer for PositionWriter specific logs (like validation failures)
    this.tracer = new LLMTracer({ jobId: options.jobId });

    this.validator = new PositionWriterValidator();
    this.citationValidator = new CitationIntegrityValidator({ verbose: false });
    this.criticMarkupValidator = new CriticMarkupValidator({ verbose: false });
    this.maxRetries = options.maxRetries || 3;
    this.citationRegistry = options.citationRegistry || null;
    this.proseProofreader = options.proseProofreader || null;
    
    // RAG-based substance selection (optional - for enhanced context)
    this.embeddedSubstance = null;
    this.substanceEmbedder = null;
    this.useRAGSubstance = false;
  }

  /**
   * Set embedded substance for RAG-based context selection
   * @param {Array} embeddedItems - Substance items with embeddings
   * @param {SubstanceEmbedder} embedder - Embedder for query embedding
   */
  setEmbeddedSubstance(embeddedItems, embedder) {
    this.embeddedSubstance = embeddedItems;
    this.substanceEmbedder = embedder;
    this.useRAGSubstance = embeddedItems && embeddedItems.length > 0 && embedder;

    if (this.useRAGSubstance) {
      console.log(`[PositionWriter] RAG mode enabled: ${embeddedItems.length} substance items available`);
    }
  }

  /**
   * Set job ID for LLM tracing
   * Propagates to the main promptRunner and stores for dynamic runners
   * @param {string} jobId - Job ID for tracing
   */
  setJobId(jobId) {
    this._jobId = jobId;
    // Update the main tracer
    if (this.tracer) {
      this.tracer.jobId = jobId;
    }
    // Update the main promptRunner's client
    if (this.promptRunner?.client?.setJobId) {
      this.promptRunner.client.setJobId(jobId);
    }
  }

  /**
   * Set run directory for LLM call logging
   * Propagates to the main promptRunner and stores for dynamic runners
   * @param {string} llmCallsDir - Directory for LLM call logs
   */
  setRunDirectory(llmCallsDir) {
    this._llmCallsDir = llmCallsDir;
    // Update the main tracer
    if (this.tracer?.setRunDirectory) {
      this.tracer.setRunDirectory(llmCallsDir);
    }
    // Update the main promptRunner's client tracer
    if (this.promptRunner?.client?.tracer?.setRunDirectory) {
      this.promptRunner.client.tracer.setRunDirectory(llmCallsDir);
    }
  }

  /**
   * Set feedback context for re-analysis runs
   * This context will be injected into position writing to address user corrections
   * @param {Object} feedbackContext - Context from FeedbackOrchestrator
   */
  setFeedbackContext(feedbackContext) {
    this.feedbackContext = feedbackContext;
    const contextNotes = feedbackContext.contextNotes?.length || 0;
    const corrections = feedbackContext.corrections?.length || 0;
    const citationCorrections = feedbackContext.citationCorrections?.length || 0;
    if (contextNotes > 0 || corrections > 0 || citationCorrections > 0) {
      console.log(`[PositionWriter] Feedback context set: ${contextNotes} context notes, ${corrections} corrections, ${citationCorrections} citation corrections`);
    }
  }

  /**
   * Build feedback section for position writing prompt injection
   * @param {Object} position - Position being written
   * @returns {string} Formatted feedback section for prompt
   * @private
   */
  buildFeedbackSection(position) {
    if (!this.feedbackContext) return '';

    const sections = [];
    const positionTitle = position?.title || '';
    const responseNumbers = position?.responseNumbers || [];

    // Add context notes (general + position-specific)
    const contextNotes = this.feedbackContext.contextNotes || [];
    const relevantContextNotes = contextNotes.filter(
      note => !note.positionTitle || note.positionTitle === positionTitle ||
              !note.responseNumber || responseNumbers.includes(note.responseNumber)
    );
    if (relevantContextNotes.length > 0) {
      sections.push(`\n## Vigtig kontekst fra bruger\nFølgende kontekst-noter skal anvendes:\n${
        relevantContextNotes.map(note => `- ${note.text}`).join('\n')
      }`);
    }

    // Add factual corrections for this position
    const corrections = this.feedbackContext.corrections || [];
    const relevantCorrections = corrections.filter(
      c => !c.positionTitle || c.positionTitle === positionTitle
    );
    if (relevantCorrections.length > 0) {
      sections.push(`\n## Korrektioner fra bruger\nFølgende fejl skal rettes:\n${
        relevantCorrections.map(c => `- ${c.text}`).join('\n')
      }`);
    }

    // Add citation corrections
    const citationCorrections = this.feedbackContext.citationCorrections || [];
    const relevantCitationCorrections = citationCorrections.filter(
      c => !c.positionTitle || c.positionTitle === positionTitle ||
           responseNumbers.includes(c.responseNumber)
    );
    if (relevantCitationCorrections.length > 0) {
      sections.push(`\n## Citatproblemer fra bruger\nFølgende citater har problemer:\n${
        relevantCitationCorrections.map(c => `- Svar ${c.responseNumber}: ${c.text}`).join('\n')
      }`);
    }

    return sections.join('\n');
  }

  /**
   * Get relevant substance for a position using RAG
   * @param {Object} position - Position to get context for
   * @param {number} topK - Number of items to return
   * @returns {Promise<string|null>} Formatted substance text or null
   */
  async getRelevantSubstanceForPosition(position, topK = 10) {
    if (!this.useRAGSubstance || !this.substanceEmbedder) {
      return null;
    }

    try {
      // Build query from position title and summary
      const query = [
        position.title || '',
        position.summary || ''
      ].filter(t => t).join(' ');
      
      if (!query.trim()) return null;
      
      const relevantItems = await this.substanceEmbedder.retrieveRelevant(
        query,
        this.embeddedSubstance,
        { topK, minScore: 0.25 }
      );
      
      if (!relevantItems || relevantItems.length === 0) {
        return null;
      }
      
      return this.substanceEmbedder.formatForPrompt(relevantItems);
    } catch (error) {
      console.warn(`[PositionWriter] RAG retrieval failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Generate hybrid outputs for each aggregated position.
   * @param {Array} aggregatedThemes - Output from Aggregator
   * @param {Array} microSummaries - Micro-summaries for each response
   * @param {Array} embeddings - Embedded chunks (for citation snippets)
   * @param {Array} rawResponses - Original responses (enriched)
   */
  async writePositions({
    aggregatedThemes = [],
    microSummaries = [],
    embeddings = [],
    rawResponses = []
  }) {
    // CRITICAL: Store rawResponses for fallback lookup in setLabelsProgrammatically
    // This ensures named entities (Lokaludvalg, organizations) are correctly labeled
    // even if they're not in the diversity-sampled respondents
    this._rawResponsesMap = new Map(rawResponses.map(r => [r.id, r]));
    
    console.log(`[PositionWriter] Processing ${aggregatedThemes.reduce((sum, t) => sum + t.positions.length, 0)} positions across ${aggregatedThemes.length} themes (PARALLEL)`);
    
    // Process all themes in parallel
    const themePromises = aggregatedThemes.map(async (theme) => {
      try {
      const themeResult = {
        name: theme.name,
        positions: []
      };

      // Process all positions in this theme in parallel
      const positionPromises = theme.positions.map(async (position) => {
        // CRITICAL: Wrap entire position processing in try-catch to prevent pipeline crash
        try {
        // Only log start of position processing if verbose
        if (process.env.VERBOSE) {
          console.log(`[PositionWriter] Processing position "${position.title}"`);
        }

        // PRE-SELECT QUOTES: Determine which arguments will be cited BEFORE building LLM input
        // For standard positions (≤15): filter LLM input to only show arguments that will be cited
        // For medium positions (16-100): keep all arguments for context, but limit quotes to 5
        const quoteSelection = this.preSelectQuotesForPosition(position, microSummaries, this.citationRegistry);
        const respondentCount = position.responseNumbers?.length || 0;

        let writerInput = this.buildPositionInput({
          theme,
          position,
          microSummaries,
          embeddings,
          rawResponses,
          // Only filter to pre-selected args for standard positions (≤15)
          // Medium positions need full context for accurate summaries
          selectedArguments: respondentCount <= 15 ? quoteSelection.selectedArguments : null
        });

        // UPSTREAM PREVENTION: Deduplicate citations BEFORE they reach LLM
        // This prevents same respondent appearing multiple times with same quote
        writerInput = this.deduplicateCitationInput(writerInput);

        // PRE-FILTER: Remove irrelevant respondents BEFORE generating output
        // This prevents "ingen bemærkninger" responses from being included in positions
        // where they have no relevant content (e.g. respondents incorrectly assigned upstream)
        const beforeCount = writerInput.respondents.length;
        writerInput = await this.preFilterIrrelevantRespondents(writerInput, position);
        const afterCount = writerInput.respondents.length;
        if (beforeCount !== afterCount) {
          console.log(`[PositionWriter] 📊 Pre-filter: ${beforeCount} → ${afterCount} respondents for "${position.title.substring(0, 40)}..."`);
        }

        // OPTIMIZATION: Select model based on position complexity (content-aware)
        const positionModelConfig = getModelForPosition(position, rawResponses);

        // Create position-specific promptRunner with adaptive model
        // CRITICAL: Pass jobId for LLM tracing - without this, calls won't be logged
        const positionPromptRunner = new HybridPromptRunner({
          model: positionModelConfig,
          writePromptPath: this.options.prompts.writePromptPath,
          stitchPromptPath: this.options.prompts.stitchPromptPath,
          jobId: this._jobId // Propagate jobId for tracing
        });

        // Configure tracer run directory for this dynamic runner
        if (this._llmCallsDir && positionPromptRunner?.client?.tracer?.setRunDirectory) {
          positionPromptRunner.client.tracer.setRunDirectory(this._llmCallsDir);
        }

        // Generate with retry logic for validation failures
        let hybridSummary = null;
        let attempts = 0;
        let validationIssues = [];

        while (attempts < this.maxRetries) {
          attempts++;
          
          hybridSummary = await this.generateHybridOutputWithRunner(writerInput, positionPromptRunner);
          if (process.env.VERBOSE) {
            console.log(`[PositionWriter] Generated hybrid output for "${position.title}" (attempt ${attempts})`);
          }
          
          // Clean any incorrectly generated CriticMarkup from LLM output
          hybridSummary = CriticMarkupCleaner.cleanHybridOutput(hybridSummary);
          
          // Fix forbidden summary starts like "Positionen beskriver..."
          this.fixForbiddenSummaryStarts(hybridSummary);
          
          // SAFETY NET: Remove literal [TILBAGEHENVISNING:] placeholders from LLM output
          this.cleanTilbagehenvisningPlaceholders(hybridSummary);
          
          // Validate and fix Danish number labels (prevents "Fifteen borgere", "1 borgere", etc.)
          hybridSummary = DanishNumberFormatter.validateAndFixHybridOutput(hybridSummary);

          // SAFETY NET: Fix deterministic grammar errors that are cheap to repair.
          // Example: "Én borger<<REF_1>> fremhæves ..." -> "Én borger<<REF_1>> fremhæver ..."
          this.fixActorSubjectPassiveVerbs(hybridSummary);

          // CRITICAL (MEGA-POSITION): Enforce master-holdning invariants programmatically.
          // - summary must start with "Der<<REF_1>>"
          // - REF_1.label must be "Der"
          // - REF_1.respondents must cover ALL respondents
          // This prevents mismatches like title "(1200 respondenter)" but master text saying "116 borgere".
          this.enforceMegaPositionMasterReference(hybridSummary, writerInput);
          
          // CRITICAL: Validate and fix label/respondent count mismatches
          // This prevents "Seks borgere" when only 3 henvendelser are in the respondents array
          const labelValidation = LabelCountValidator.validateHybridSummary(hybridSummary);
          if (!labelValidation.valid) {
            console.log(`[PositionWriter] ⚠️ Found ${labelValidation.issues.length} label/respondent mismatches in "${position.title}"`);
            hybridSummary = LabelCountValidator.validateAndFixHybridSummary(hybridSummary);
          }
          
          // CRITICAL: Set labels PROGRAMMATICALLY from data - LLM output is ignored
          // Labels come from respondentLabel/respondentName in writerInput, NOT from LLM
          this.setLabelsProgrammatically(hybridSummary, writerInput);

          // CRITICAL: Validate and auto-fix label/respondent count mismatches
          // Prevents issues like "tre borgere" when 8 respondents are actually referenced
          this.validateLabelRespondentCounts(hybridSummary);

          // PROSE PROOFREADING: Fix semantic quality issues (first-person, broken fragments, etc.)
          // Runs AFTER labels are finalized but BEFORE quotes are filled in.
          if (this.proseProofreader && hybridSummary.summary) {
            hybridSummary = await this.proseProofreader.proofread(hybridSummary);
          }

          // Clean quote prefixes (Cite:, Citat:, etc.) from LLM output
          this.cleanQuotePrefixes(hybridSummary);
          
          // Fix misattributed quotes (where LLM assigns text from Response A to Response B)
          this.fixQuoteAttributions(hybridSummary, writerInput);
          
          // NEW: Ensure all respondents are cited (auto-fix missing IDs)
          this.ensureAllRespondentsCited(hybridSummary, writerInput, attempts);

          // CRITICAL: Programmatically fill quotes based on strict rules
          // This overrides any LLM-generated quotes to ensure consistency:
          // - <=15 respondents: one quote per respondent
          // - >15 respondents: 5 representative quotes + list
          // FIX: Use pre-selected quoteMap to ensure consistency between what LLM saw and what quotes are displayed
          this.fillQuotesProgrammatically(hybridSummary, writerInput, {
            title: position.title,
            themeName: position.theme || writerInput.theme?.name,
            microSummaries: microSummaries, // Full summaries for complete citation access
            preSelectedQuoteMap: quoteSelection.quoteMap  // Use pre-selected quotes for consistency
          });

          // HALLUCINATION DETECTION: Validate that summary matches quotes
          // Uses reranker to detect when LLM summary doesn't reflect actual respondent content
          await this.validateSummaryQuoteCoherence(hybridSummary, writerInput);

          // Check for and fix duplicate REF_X references in summary
          if (hybridSummary.summary) {
            const duplicateCheck = this.checkDuplicateReferences(hybridSummary.summary);
            if (duplicateCheck.hasDuplicates) {
              console.warn(`[PositionWriter] ⚠️  Found duplicate references in "${position.title}": ${duplicateCheck.duplicates.join(', ')}`);
              hybridSummary.summary = this.removeDuplicateReferences(hybridSummary.summary);
              if (!hybridSummary.warnings) hybridSummary.warnings = [];
              hybridSummary.warnings.push(`Auto-fixed duplicate references: ${duplicateCheck.duplicates.join(', ')}`);
              console.log(`[PositionWriter] ✓ Auto-fixed duplicate references`);
            }
          }
          
          // Resolve citation references if using citation registry
          if (this.citationRegistry && hybridSummary.references) {
            console.log(`[PositionWriter] Resolving ${hybridSummary.references.length} citation references`);
            hybridSummary = this.citationRegistry.resolveCitations(hybridSummary);
          }
          
          // Validate the output
          const structureValidation = this.validator.validateHybridOutput(writerInput, hybridSummary);
          const linguisticValidation = this.validator.validateLinguisticConsistency(writerInput, hybridSummary);
          const criticMarkupValidation = this.criticMarkupValidator.validatePositionSummary({
            ...position,
            summary: hybridSummary.summary || ''
          });
          const referenceValidation = this.citationValidator.validateHybridReferences([{
            ...position,
            hybridReferences: hybridSummary.references || []
          }]);
          
          // Check if all validations pass
          //
          // NOTE: Overlap warnings are treated as retry-worthy (soft-blocking) while attempts remain.
          // This helps reduce master/sub duplication without hard-failing the entire run.
          const overlapWarnings = (linguisticValidation.warnings || []).filter(w =>
            String(w).toLowerCase().includes('overlap')
          );
          const overlapBlocking = overlapWarnings.length > 0 && attempts < this.maxRetries;
          
          const allValid = structureValidation.valid && 
                          linguisticValidation.valid &&
                          criticMarkupValidation.valid && 
                          referenceValidation.valid &&
                          !overlapBlocking;
          
          if (allValid) {
            console.log(`[PositionWriter] ✓ All validations passed for "${position.title}"`);
            validationIssues = []; // Clear any issues from previous attempts
            break;
          }
          
          // Collect validation issues
          validationIssues = [];
          if (!structureValidation.valid) {
            const msgs = [...(structureValidation.errors || []), ...(structureValidation.warnings || [])];
            validationIssues.push(`Structure: ${msgs.join(', ')}`);
          }
          if (!linguisticValidation.valid) {
            const msgs = [...(linguisticValidation.errors || []), ...(linguisticValidation.warnings || [])];
            validationIssues.push(`Linguistic: ${msgs.join(', ')}`);
          } else if (linguisticValidation.warnings?.length) {
            // Non-blocking warnings: preserve for visibility
            if (!hybridSummary.warnings) hybridSummary.warnings = [];
            hybridSummary.warnings.push(...linguisticValidation.warnings);
          }
          if (overlapBlocking) {
            validationIssues.push(`Overlap: ${overlapWarnings.join(', ')}`);
          }
          if (!criticMarkupValidation.valid) {
            validationIssues.push(`CriticMarkup: ${criticMarkupValidation.issues.length} issues`);
          }
          if (!referenceValidation.valid) {
            validationIssues.push(`References: ${referenceValidation.issues.length} issues`);
          }
          
          if (attempts < this.maxRetries) {
            console.log(`[PositionWriter] ⚠️  Validation failed for "${position.title}": ${validationIssues.join('; ')}. Retrying...`);
            
            // Log failure snapshot for debugging
            await this.tracer.logFailure(
              `PositionWriter-Validation-${position.title.substring(0, 30)}`,
              { message: 'Validation Failed', issues: validationIssues },
              {
                position: position.title,
                attempt: attempts,
                input: writerInput,
                output: hybridSummary,
                validationErrors: {
                  structure: structureValidation.errors,
                  linguistic: linguisticValidation.errors,
                  criticMarkup: criticMarkupValidation.issues,
                  references: referenceValidation.issues
                }
              }
            );
          }
        }
        
        if (validationIssues.length > 0) {
          console.warn(`[PositionWriter] ⚠️  Failed to generate valid output for "${position.title}" after ${attempts} attempts: ${validationIssues.join('; ')}`);
          // Add validation issues to warnings
          if (!hybridSummary.warnings) hybridSummary.warnings = [];
          hybridSummary.warnings.push(`Validation issues after ${attempts} attempts: ${validationIssues.join('; ')}`);
        }
        
        const validation = this.validator.validateHybridOutput(writerInput, hybridSummary);

        const chunkCount = Math.max(
          1,
          Math.ceil(writerInput.respondents.length / this.options.chunk.maxRespondentsPerChunk)
        );

        // ALWAYS use original title to preserve specificity - LLM tends to over-simplify
        // which creates duplicate generic titles like "Ønske om bevarelse af Palads"
        let finalTitle = position.title;
        
        // Auto-fix common abbreviations in title
        finalTitle = this.expandAbbreviationsInTitle(finalTitle);
        
        // Validate title quality and log warnings (non-blocking)
        const titleValidation = this.validatePositionTitle(finalTitle);
        if (!titleValidation.valid) {
          console.warn(`[PositionWriter] ⚠️  Title quality issues for "${finalTitle}":`);
          titleValidation.issues.forEach(issue => {
            console.warn(`[PositionWriter]    → ${issue}`);
          });
          // Add to warnings but don't fail
          if (!hybridSummary.warnings) hybridSummary.warnings = [];
          hybridSummary.warnings.push(`Title quality: ${titleValidation.issues.join('; ')}`);
        }

        // CRITICAL: Update responseNumbers to only include respondents that were actually written
        // This removes any pre-filtered "no comment" respondents from the final output
        const actualResponseNumbers = writerInput.respondents.map(r => r.responseNumber);
        const filteredCount = position.responseNumbers.length - actualResponseNumbers.length;
        
        // Log if pre-filtering affected final output
        if (filteredCount > 0 && writerInput._filteredRespondents?.length > 0) {
          console.log(`[PositionWriter] 📤 Pre-filtered respondents excluded from output: [${writerInput._filteredRespondents.join(', ')}] for "${position.title.substring(0, 40)}..."`);
        }

        // CRITICAL: Ensure summary is always a string to prevent downstream crashes
        let finalSummary = hybridSummary.summary;
        if (typeof finalSummary !== 'string' || !finalSummary.trim()) {
          // If summary is missing/invalid, create a minimal fallback
          console.warn(`[PositionWriter] ⚠️  Invalid summary for "${position.title}" - using fallback`);
          const respondentCount = writerInput.respondents.length;
          finalSummary = `${respondentCount} høringssvar har kommenteret dette emne. Se de individuelle høringssvar for detaljer.`;
          if (!hybridSummary.warnings) hybridSummary.warnings = [];
          hybridSummary.warnings.push('Fallback summary used due to generation failure');
        }

        return {
          ...position,
          // Override responseNumbers with only the respondents that were actually processed
          responseNumbers: actualResponseNumbers,
          title: finalTitle,
          summary: finalSummary,
          hybridReferences: hybridSummary.references || [],
          hybridWarnings: hybridSummary.warnings || [],
          citations: [],
          // CRITICAL: Include citationMap from megaposition processing (deterministic labels)
          citationMap: hybridSummary.citationMap || [],
          hybridMeta: {
            respondents: writerInput.respondents.length,
            chunkCount,
            validation,
            model: positionModelConfig.name, // Track which model was used
            retryAttempts: attempts - 1, // Number of retries
            validationIssues: validationIssues.length > 0 ? validationIssues : undefined,
            titleValidation: !titleValidation.valid ? titleValidation.issues : undefined,
            // Track filtered respondents for debugging
            filteredRespondents: writerInput._filteredRespondents || undefined,
            originalResponseCount: filteredCount > 0 ? position.responseNumbers.length : undefined
          }
        };
        } catch (positionError) {
          // CRITICAL: Don't crash the entire pipeline on a single position failure
          console.error(`[PositionWriter] ❌ Failed to process position "${position.title}": ${positionError.message}`);
          console.error(`[PositionWriter]    Stack: ${positionError.stack?.split('\n').slice(0, 3).join(' → ')}`);

          // Return a minimal fallback position so pipeline can continue
          const respondentCount = position.responseNumbers?.length || 0;
          return {
            ...position,
            summary: `${respondentCount} høringssvar har kommenteret dette emne. Opsummeringen kunne ikke genereres på grund af en teknisk fejl.`,
            hybridReferences: [],
            hybridWarnings: [`Position generation failed: ${positionError.message}`],
            citations: [],
            citationMap: [],
            hybridMeta: {
              respondents: respondentCount,
              chunkCount: 0,
              validation: { valid: false },
              _fallback: true,
              _error: positionError.message
            }
          };
        }
      });

      // Wait for all positions in this theme
      themeResult.positions = await Promise.all(positionPromises);
      return themeResult;
      } catch (themeError) {
        // CRITICAL: Don't crash pipeline on theme-level failure
        console.error(`[PositionWriter] ❌ Failed to process theme "${theme.name}": ${themeError.message}`);
        return {
          name: theme.name,
          positions: [],
          _error: themeError.message
        };
      }
    });

    // Wait for all themes
    const results = await Promise.all(themePromises);
    
    console.log(`[PositionWriter] Completed all ${results.reduce((sum, t) => sum + t.positions.length, 0)} positions`);
    
    return results;
  }

  /**
   * Build input object for a position across all respondents.
   * @param {Object} options - Build options
   * @param {Object} options.theme - Theme object with name
   * @param {Object} options.position - Position with responseNumbers, sourceArgumentRefs, etc.
   * @param {Array} options.microSummaries - All micro-summaries
   * @param {Array} options.embeddings - Embedded chunks
   * @param {Array} options.rawResponses - Original responses
   * @param {Set} [options.selectedArguments] - Set of pre-selected sourceQuoteRefs to filter to (from preSelectQuotesForPosition)
   */
  buildPositionInput({
    theme,
    position,
    microSummaries,
    embeddings,
    rawResponses,
    selectedArguments = null
  }) {
    const respondents = position.responseNumbers
      .map(responseNumber => {
        const response = rawResponses.find(r => r.id === responseNumber);
        const summary = microSummaries.find(s => s.responseNumber === responseNumber);

        if (!response || !summary) {
          return null;
        }

        // CRITICAL FIX: Use sourceArgumentRefs from aggregate to filter PRECISELY
        // This ensures we only include arguments that were actually grouped into this position
        // Prevents summary/citation mismatch when a response has multiple unrelated arguments
        const positionArgRefs = position.sourceArgumentRefs || [];
        const thisResponseRefs = positionArgRefs.filter(ref => ref.responseNumber === responseNumber);

        // DEDUPLICATION: Filter out secondary arguments (they're explained elsewhere)
        // Secondary arguments have _deduplicationStatus: 'secondary' set by ArgumentDeduplicator
        // The respondent still counts in master-holdning, but we don't generate separate citations
        const primaryRefs = thisResponseRefs.filter(ref => ref._deduplicationStatus !== 'secondary');
        const secondaryCount = thisResponseRefs.length - primaryRefs.length;
        if (secondaryCount > 0) {
          console.log(`[PositionWriter] 🔄 Dedup: ${secondaryCount}/${thisResponseRefs.length} arguments skipped for response ${responseNumber} (explained elsewhere)`);
        }
        
        let argumentsToUse;

        // Use primaryRefs (excludes secondary/deduplicated arguments) for filtering
        // This ensures we only include arguments that are "owned" by this position
        if (primaryRefs.length > 0) {
          // NEW: Precise filtering using sourceArgumentRefs from aggregate
          argumentsToUse = (summary.arguments || []).filter(arg => {
            // Match by sourceQuoteRef (most precise)
            if (arg.sourceQuoteRef) {
              return primaryRefs.some(ref => ref.sourceQuoteRef === arg.sourceQuoteRef);
            }
            // Fallback: match by what/coreContent (for older data without citation refs)
            const argWhat = (arg.what || arg.coreContent || '').toLowerCase().trim();
            return primaryRefs.some(ref => {
              const refWhat = (ref.what || '').toLowerCase().trim();
              // Require substantial overlap (not just a few words)
              return refWhat && argWhat && (
                argWhat.includes(refWhat) ||
                refWhat.includes(argWhat) ||
                this.calculateTextOverlap(argWhat, refWhat) > 0.6
              );
            });
          });
          
          // Log if precise filtering worked
          if (argumentsToUse.length > 0 && argumentsToUse.length < (summary.arguments || []).length) {
            console.log(`[PositionWriter] 🎯 Precise filter: ${summary.arguments.length} → ${argumentsToUse.length} arguments for response ${responseNumber} in "${position.title?.substring(0, 40)}..."`);
          }
        }
        
        // Fallback: keyword-based filtering (for backward compatibility)
        if (!argumentsToUse || argumentsToUse.length === 0) {
          const positionTitle = position?.title || '';
          const positionKeywords = this.extractKeywordsForMatching(positionTitle);
          
          // Filter out generic/common words that match too broadly
          const genericWords = new Set([
            'arealer', 'område', 'bygning', 'areal', 'forhold', 'krav', 'ønske',
            'støtte', 'modstand', 'bekymring', 'placering', 'højde', 'materiale',
            'acceptabelt', 'skole', 'daginstitution', 'boliger', 'træer', 'friareal'
          ]);
          
          // Find the PRIMARY keyword - the most specific/unique word in the title
          const allKeywords = [...positionKeywords].filter(kw => !genericWords.has(kw) && kw.length > 4);
          const primaryKeyword = allKeywords.sort((a, b) => b.length - a.length)[0] || null;
          
          const relevantArguments = (summary.arguments || []).filter(arg => {
            const argText = [arg.what, arg.consequence, arg.concern]
              .filter(Boolean).join(' ').toLowerCase();
            
            if (primaryKeyword) {
              return argText.includes(primaryKeyword.toLowerCase());
            }
            
            let matchCount = 0;
            for (const kw of allKeywords) {
              if (argText.includes(kw.toLowerCase())) {
                matchCount++;
              }
            }
            return matchCount >= 2 || allKeywords.length === 0;
          });
          
          // SAFETY: Theme-filtered fallback to prevent cross-theme contamination
          // Do NOT fall back to all arguments - that causes content from unrelated themes to leak in
          if (relevantArguments.length > 0) {
            argumentsToUse = relevantArguments;
          } else {
            // Fallback: Filter by relevantThemes instead of including all arguments
            const positionTheme = theme?.name || '';
            const themeFilteredArgs = (summary.arguments || []).filter(arg => {
              const argThemes = arg.relevantThemes || [];
              return argThemes.some(t =>
                t === positionTheme ||
                t.toLowerCase().includes(positionTheme.toLowerCase()) ||
                positionTheme.toLowerCase().includes(t.toLowerCase())
              );
            });

            if (themeFilteredArgs.length > 0) {
              argumentsToUse = themeFilteredArgs;
            } else {
              // CRITICAL: Skip response entirely to prevent theme contamination
              // Using first unrelated argument would leak content from wrong theme into this position
              // The response will still appear in the position (for coverage) but won't contribute content
              argumentsToUse = [];
              console.warn(`[PositionWriter] ⚠️ SKIPPING response ${responseNumber} in "${positionTheme}" - no theme-matched arguments (prevents contamination)`);
            }
          }
        }

        // QUOTE-SUMMARY ALIGNMENT: Filter to only pre-selected arguments (if provided)
        // This ensures LLM only sees arguments that will have visible quotes displayed
        if (selectedArguments && selectedArguments.size > 0) {
          const beforePreSelect = argumentsToUse.length;
          argumentsToUse = argumentsToUse.filter(arg =>
            arg.sourceQuoteRef && selectedArguments.has(arg.sourceQuoteRef)
          );
          if (beforePreSelect > 0 && argumentsToUse.length < beforePreSelect) {
            console.log(`[PositionWriter] 📋 Quote pre-select: ${beforePreSelect} → ${argumentsToUse.length} arguments for response ${responseNumber}`);
          }
        }

        const trimmedArguments = argumentsToUse
          .slice(0, this.options.chunk.maxArgumentsPerRespondent)
          .map(arg => {
            // Check if we're using citation registry
            const useCitationRefs = this.citationRegistry && arg.sourceQuoteRef;
            
            // Fallback: Use excerpt as sourceQuote if missing
            let sourceQuoteValue = arg.sourceQuote || '';
            if (!useCitationRefs && (!sourceQuoteValue || sourceQuoteValue.trim() === '')) {
              // Use first 500 chars of response text as fallback quote source
              const responseExcerpt = (response?.text || '').substring(0, 500).trim();
              if (responseExcerpt) {
                console.warn(`[PositionWriter] WARNING: Missing sourceQuote for response ${responseNumber}, using excerpt fallback`);
                sourceQuoteValue = responseExcerpt;
              } else {
                console.warn(`[PositionWriter] WARNING: Missing sourceQuote for response ${responseNumber}, no excerpt available`);
              }
            }
            
            const baseArg = {
              what: truncateText(arg.what || '', this.options.chunk.maxArgumentChars),
              why: truncateText(arg.why || '', this.options.chunk.maxArgumentChars),
              how: truncateText(arg.how || '', this.options.chunk.maxArgumentChars),
              consequence: truncateText(arg.consequence || '', this.options.chunk.maxArgumentChars),
              concern: truncateText(arg.concern || '', this.options.chunk.maxArgumentChars),
              relevantThemes: arg.relevantThemes || []
            };
            
            // Use citation ref if available, otherwise use full quote (with fallback)
            if (useCitationRefs) {
              baseArg.sourceQuoteRef = arg.sourceQuoteRef;
            } else {
              baseArg.sourceQuote = sourceQuoteValue; // Don't truncate quotes - keep them intact
            }
            
            return baseArg;
          });

        const respondentLabel = this.buildRespondentLabel(response);
        
        // SMART CONTEXT: Dynamic excerpt/snippet logic
        const responseText = response.text || '';
        const responseLength = responseText.length;
        
        // For short responses (< 1000 chars), include full text in excerpt
        // For longer responses, use normal excerpt + snippets
        const useFullText = responseLength < 1000;
        const excerpt = useFullText 
          ? responseText // Full text for short responses
          : truncateText(responseText, this.options.chunk.maxExcerptChars);
        
        // SMART DEDUPLICATION: Only include snippets if response is longer than excerpt
        // (Avoids sending duplicate text for short responses)
        const includeSnippets = responseLength > this.options.chunk.maxExcerptChars;

        return {
          responseNumber,
          respondentLabel,
          respondentType: response.respondentType,
          respondentName: response.respondentName,
          summary: {
            arguments: trimmedArguments
          },
          excerpt: excerpt,
          snippets: includeSnippets ? this.extractCitationSnippets(responseNumber, embeddings) : []
        };
      })
      .filter(Boolean);

    // Include sub-positions as REQUIRED structure for detailed summary writing
    // When sub-positions are available, they MUST be used with inline labels
    const hasSubPositions = position.subPositions && position.subPositions.length > 0;
    const subPositionData = hasSubPositions
      ? position.subPositions.map(sub => {
          const repArgs = sub.representativeArguments || [];
          const subRespondentCount = sub.responseNumbers?.length || 0;
          const targetSentences = calculateTargetSentences(subRespondentCount);
          return {
            title: sub.title,
            what: sub.what,
            why: sub.why,
            how: sub.how,
            responseNumbers: sub.responseNumbers,
            respondentCount: subRespondentCount,
            summary: sub.summary,
            // NEW: Representative arguments sampled via max-diversity for better verbosity
            // These show the VARIETY of viewpoints within this sub-position
            representativeArguments: repArgs,
            // SAFEGUARD: Tell LLM how many diverse arguments are available
            // LLM should NOT describe more distinct angles than this count
            _availableEvidenceCount: repArgs.length,
            // EXPLICIT VERBOSITY TARGET: Logarithmically scaled sentence count
            // This gives LLM a concrete target instead of relying on formula memory
            _targetSentences: targetSentences
          };
        })
      : undefined;

    // NEW: Handle master-only respondents (those without specific sub-position nuance)
    // These respondents express only the general position without detailed arguments
    const hasMasterOnlyRespondents = position.masterOnlyRespondents && position.masterOnlyRespondents.length > 0;
    const masterOnlyRespondentCount = hasMasterOnlyRespondents ? position.masterOnlyRespondents.length : 0;
    const masterOnlyData = hasMasterOnlyRespondents
      ? {
          respondentCount: masterOnlyRespondentCount,
          responseNumbers: position.masterOnlyRespondents,
          // Include representative arguments from master-only respondents for the LLM
          representativeArguments: this.extractMasterOnlyArguments(
            position.masterOnlyRespondents, 
            microSummaries, 
            position
          ),
          // EXPLICIT VERBOSITY TARGET for master-only group
          _targetSentences: calculateTargetSentences(masterOnlyRespondentCount)
        }
      : undefined;

    // Calculate total respondents for title redundancy check
    const totalRespondentCount = position.responseNumbers?.length || 0;
    
    // Calculate target sentences for the overall position (used when no sub-positions)
    const overallTargetSentences = calculateTargetSentences(totalRespondentCount);

    return {
      theme: {
        name: theme.name
      },
      position: {
        title: position.title,
        summary: position.summary,
        materialReferences: position.materialReferences ?? [],
        // Sub-positions are REQUIRED structure when available
        subPositions: subPositionData,
        // Flag to indicate sub-positions MUST be used (not just guidance)
        subPositionsRequired: hasSubPositions,
        // NEW: Master-only respondents (general position holders without specific nuance)
        masterOnly: masterOnlyData,
        // Total respondent count (to avoid redundancy in text)
        totalRespondentCount,
        // EXPLICIT VERBOSITY TARGET: Logarithmically scaled sentence count
        // For positions without sub-positions, this is the overall target
        // For positions WITH sub-positions, use the sub-position _targetSentences instead
        _targetSentences: overallTargetSentences
      },
      respondents,
      respondentBreakdown: position.respondentBreakdown
    };
  }

  /**
   * Extract representative arguments from master-only respondents.
   * These are respondents who only express the general position without specific sub-arguments.
   * 
   * IMPROVED:
   * - Dynamic 15% coverage (min 3, max 15 for master-only)
   * - Includes original quotes from citation-registry
   * - Evenly-spaced sampling for variety
   * 
   * @private
   */
  extractMasterOnlyArguments(masterOnlyRespondents, microSummaries, position) {
    if (!masterOnlyRespondents || masterOnlyRespondents.length === 0) {
      return [];
    }

    // SMART LOGARITHMIC SAMPLING
    // Master-only respondents typically have simpler arguments, so we can use
    // slightly fewer samples than sub-positions, but same logarithmic principle
    //
    // Formula: samples = BASE + MULTIPLIER * log2(n)
    const n = masterOnlyRespondents.length;
    const BASE = 3;
    const MULTIPLIER = 2;
    const MIN_SAMPLES = 3;
    const MAX_SAMPLES = 25;
    
    let maxSamples;
    if (n <= 8) {
      // Very small: use all
      maxSamples = n;
    } else {
      const logSamples = Math.ceil(BASE + MULTIPLIER * Math.log2(n));
      maxSamples = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, logSamples));
    }
    
    // Evenly-spaced sampling for variety (no embedding overhead)
    const step = Math.max(1, Math.floor(masterOnlyRespondents.length / maxSamples));
    const sampled = masterOnlyRespondents.filter((_, i) => i % step === 0).slice(0, maxSamples);
    
    const representativeArgs = [];
    for (const respNum of sampled) {
      const summary = microSummaries.find(ms => ms.responseNumber === respNum);
      if (summary?.arguments && summary.arguments.length > 0) {
        const arg = summary.arguments[0];
        
        // Get original quote from citation-registry if available
        let originalQuote = null;
        if (this.citationRegistry && arg.sourceQuoteRef) {
          const citation = this.citationRegistry.citations?.get(arg.sourceQuoteRef);
          if (citation?.quote) {
            originalQuote = citation.quote;
          }
        }
        
        representativeArgs.push({
          responseNumber: respNum,
          what: arg.what || '',
          why: arg.why || '',
          // Include original quote for verbosity
          quote: originalQuote || arg.sourceQuote || ''
        });
      }
    }
    
    const coverage = (representativeArgs.length / masterOnlyRespondents.length * 100).toFixed(1);
    console.log(`[PositionWriter] Master-only sampling: ${representativeArgs.length}/${masterOnlyRespondents.length} (${coverage}% coverage)`);
    
    return representativeArgs;
  }

  /**
   * Build lightweight respondent list from diversity-sampled representativeArguments.
   * OPTIMIZATION: Dramatically reduces prompt size for mega-position sub-positions
   * by using only the diversity samples instead of all respondents.
   * 
   * @param {Array} representativeArgs - Diversity-sampled arguments from sub-position (centroid first)
   * @param {Map} fullRespondentMap - Map of responseNumber → full respondent data
   * @param {Object} subPosition - Sub-position with metadata
   * @returns {Object} { lightRespondents, fullResponseNumbers, fullRespondentCount }
   * @private
   */
  buildLightRespondentsFromDiversity(representativeArgs, fullRespondentMap, subPosition) {
    const lightRespondents = [];
    const seenResponseNumbers = new Set();
    
    // First, add all diversity-sampled respondents
    for (const arg of representativeArgs) {
      const respNum = arg.responseNumber;
      if (seenResponseNumbers.has(respNum)) continue;
      seenResponseNumbers.add(respNum);
      
      // Skip outOfScope or invalid entries
      if (arg.what === 'outOfScope' || !arg.what) continue;
      
      const fullResp = fullRespondentMap.get(respNum);
      if (!fullResp) continue;
      
      lightRespondents.push({
        responseNumber: respNum,
        respondentLabel: this.buildRespondentLabel(fullResp),
        respondentType: fullResp.respondentType,
        respondentName: fullResp.respondentName,
        // MINIMAL argument data - from diversity sample
        summary: {
          arguments: [{
            what: arg.what || '',
            why: arg.why || '',
            how: arg.how || '',
            // Use quote from diversity sample (already from citation-registry)
            sourceQuote: arg.quote || ''
          }]
        },
        // Compact excerpt from quote - just a hint for context
        excerpt: (arg.quote || '').substring(0, 300)
      });
    }
    
    // CRITICAL: Ensure ALL named entities (Lokaludvalg, organizations, authorities) are included
    // even if they weren't part of the diversity sample. This ensures proper labeling like
    // "342 borgere og Indre By Lokaludvalg" instead of just "343 borgere".
    for (const respNum of (subPosition.responseNumbers || [])) {
      if (seenResponseNumbers.has(respNum)) continue;
      
      const fullResp = fullRespondentMap.get(respNum);
      if (!fullResp) continue;
      
      // Check if this is a named entity (not a regular citizen)
      const isNamedEntity = this.isNamedEntity(fullResp);
      if (!isNamedEntity) continue;
      
      seenResponseNumbers.add(respNum);
      
      // Add named entity with minimal data (enough for labeling)
      lightRespondents.push({
        responseNumber: respNum,
        respondentLabel: this.buildRespondentLabel(fullResp),
        respondentType: fullResp.respondentType,
        respondentName: fullResp.respondentName,
        // Mark as added for labeling purposes only
        _addedForLabeling: true,
        // Minimal argument data
        summary: {
          arguments: [{
            what: fullResp.respondentName || 'Navngiven aktør',
            why: '',
            how: '',
            sourceQuote: ''
          }]
        },
        excerpt: ''
      });
      
      console.log(`[PositionWriter] 🏷️ Added named entity "${fullResp.respondentName}" to ensure proper labeling`);
    }
    
    return {
      lightRespondents,
      fullResponseNumbers: subPosition.responseNumbers || [],
      fullRespondentCount: subPosition.responseNumbers?.length || 0
    };
  }
  
  /**
   * Check if a respondent is a named entity (not a regular citizen)
   * Named entities include: Lokaludvalg, organizations, public authorities
   */
  isNamedEntity(respondent) {
    if (!respondent) return false;
    
    // Has explicit name → named entity
    if (respondent.respondentName && respondent.respondentName.trim().length > 0) {
      return true;
    }
    
    // Check respondent type
    const type = (respondent.respondentType || '').toLowerCase();
    if (type.includes('lokal')) return true;  // Lokaludvalg
    if (type.includes('myndighed')) return true;  // Offentlig myndighed
    if (type.includes('organisation')) return true;  // Organisation
    if (type.includes('virksomhed')) return true;  // Virksomhed
    if (type.includes('forening')) return true;  // Forening
    
    return false;
  }

  /**
   * Extract candidate snippets for citation generation using embeddings.
   */
  extractCitationSnippets(responseNumber, embeddings) {
    const responseChunks = embeddings.filter(
      chunk => chunk.responseNumber === responseNumber && chunk.hasEmbedding
    );

    if (responseChunks.length === 0) {
      return [];
    }

    const sorted = responseChunks
      .filter(chunk => chunk.metadata?.documentType === 'response')
      .sort((a, b) => {
        const aPriority = a.metadata?.priority ?? 0;
        const bPriority = b.metadata?.priority ?? 0;
        return bPriority - aPriority;
      });

    return sorted
      .slice(0, this.options.chunk.maxSnippetsPerRespondent)
      .map(chunk => ({
        text: truncateText(chunk.content, this.options.chunk.maxSnippetChars),
        chunkId: chunk.id
      }));
  }

  /**
   * Deduplicate citation input to prevent same respondent appearing multiple times
   * with identical or near-identical quotes.
   *
   * This is UPSTREAM prevention of duplicate citations - catches issues before
   * they reach the LLM and appear in the final output.
   *
   * Deduplication rules:
   * 1. Same responseNumber should only appear once per position
   * 2. Arguments within a respondent are deduplicated by sourceQuoteRef
   * 3. Near-duplicate quotes (>85% similarity) are merged
   *
   * @param {Object} writerInput - Input from buildPositionInput
   * @returns {Object} Deduplicated writer input
   */
  deduplicateCitationInput(writerInput) {
    if (!writerInput?.respondents?.length) {
      return writerInput;
    }

    const seenResponseNumbers = new Set();
    const originalCount = writerInput.respondents.length;
    let duplicateResponsesRemoved = 0;
    let duplicateArgsRemoved = 0;

    // 1. Deduplicate respondents by responseNumber
    const deduplicatedRespondents = writerInput.respondents.filter(respondent => {
      const responseNum = respondent.responseNumber;
      if (seenResponseNumbers.has(responseNum)) {
        duplicateResponsesRemoved++;
        return false;
      }
      seenResponseNumbers.add(responseNum);
      return true;
    });

    // 2. Deduplicate arguments within each respondent
    for (const respondent of deduplicatedRespondents) {
      if (!respondent.summary?.arguments?.length) continue;

      const seenRefs = new Set();
      const seenQuotes = new Map(); // quote hash -> first seen argument
      const originalArgsCount = respondent.summary.arguments.length;

      respondent.summary.arguments = respondent.summary.arguments.filter(arg => {
        // By sourceQuoteRef (most precise)
        if (arg.sourceQuoteRef) {
          if (seenRefs.has(arg.sourceQuoteRef)) {
            return false;
          }
          seenRefs.add(arg.sourceQuoteRef);
        }

        // By quote similarity (for cases without ref)
        if (arg.sourceQuote) {
          const normalizedQuote = this.normalizeQuote(arg.sourceQuote);
          const quoteKey = normalizedQuote.substring(0, 100); // Use first 100 chars as key

          if (seenQuotes.has(quoteKey)) {
            const existingQuote = seenQuotes.get(quoteKey);
            const similarity = this.calculateQuoteSimilarity(normalizedQuote, existingQuote);
            if (similarity >= 0.85) {
              return false; // Near-duplicate
            }
          }
          seenQuotes.set(quoteKey, normalizedQuote);
        }

        return true;
      });

      const removedArgs = originalArgsCount - respondent.summary.arguments.length;
      if (removedArgs > 0) {
        duplicateArgsRemoved += removedArgs;
      }
    }

    // Log deduplication stats
    if (duplicateResponsesRemoved > 0 || duplicateArgsRemoved > 0) {
      console.log(`[PositionWriter] 🧹 Deduplication: removed ${duplicateResponsesRemoved} duplicate respondents, ${duplicateArgsRemoved} duplicate arguments`);
    }

    return {
      ...writerInput,
      respondents: deduplicatedRespondents
    };
  }

  /**
   * Normalize quote text for comparison
   * @param {string} quote - Raw quote text
   * @returns {string} Normalized quote
   */
  normalizeQuote(quote) {
    if (!quote) return '';
    return quote
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[""''«»„"]/g, '"')
      .replace(/[.,;:!?]/g, '')
      .trim();
  }

  /**
   * Calculate similarity between two quotes using word overlap
   * @param {string} quote1 - First quote (normalized)
   * @param {string} quote2 - Second quote (normalized)
   * @returns {number} Similarity score 0-1
   */
  calculateQuoteSimilarity(quote1, quote2) {
    if (!quote1 || !quote2) return 0;

    const words1 = new Set(quote1.split(' ').filter(w => w.length > 2));
    const words2 = new Set(quote2.split(' ').filter(w => w.length > 2));

    if (words1.size === 0 || words2.size === 0) return 0;

    const intersection = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * Estimate token count for a single respondent
   * OPTIMIZATION: Token-aware chunking to prevent context window overflow
   * @private
   */
  estimateTokensForRespondent(respondent) {
    // Rough estimate: ~4 characters = 1 token (conservative)
    let totalChars = 0;
    
    // Count argument tokens
    if (respondent.summary?.arguments) {
      respondent.summary.arguments.forEach(arg => {
        totalChars += (arg.what || '').length;
        totalChars += (arg.why || '').length;
        totalChars += (arg.how || '').length;
        totalChars += (arg.consequence || '').length;
        totalChars += (arg.concern || '').length;
        // Citation refs are small (just IDs)
        totalChars += (arg.sourceQuoteRef || arg.sourceQuote || '').length;
      });
    }
    
    // Count excerpt tokens
    totalChars += (respondent.excerpt || '').length;
    
    // Count snippet tokens
    if (respondent.snippets) {
      respondent.snippets.forEach(snippet => {
        totalChars += (snippet.text || '').length;
      });
    }
    
    // Add overhead for JSON structure, labels, etc.
    totalChars += 200;
    
    // Convert to tokens (4 chars ≈ 1 token)
    return Math.ceil(totalChars / 4);
  }

  /**
   * Create token-aware chunks that fill to target token budget
   * OPTIMIZATION: Dynamic chunking based on actual content size, not fixed respondent count
   * @private
   */
  createTokenAwareChunks(respondents, targetTokens) {
    if (respondents.length === 0) return [];
    
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;
    
    for (const respondent of respondents) {
      const respondentTokens = this.estimateTokensForRespondent(respondent);
      
      // If adding this respondent would exceed target AND we already have some in chunk
      if (currentTokens + respondentTokens > targetTokens && currentChunk.length > 0) {
        // Save current chunk and start new one
        chunks.push(currentChunk);
        currentChunk = [respondent];
        currentTokens = respondentTokens;
      } else {
        // Add to current chunk
        currentChunk.push(respondent);
        currentTokens += respondentTokens;
      }
    }
    
    // Add final chunk if not empty
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  /**
   * Calculate optimal chunking strategy with TOKEN-AWARE logic
   * OPTIMIZATION: Handles varying response sizes intelligently
   * @private
   */
  calculateChunkingStrategy(positionInput) {
    const respondents = positionInput.respondents;
    const totalRespondents = respondents.length;
    
    // Model context windows (conservative estimates)
    const MODEL_CONTEXT = {
      'gpt-4o-mini': 100000,
      'gpt-5-mini': 100000,
      'gpt-5-nano': 100000,
      'gpt-4o': 100000,
      'default': 100000
    };
    
    const modelName = this.options.model?.name || 'default';
    const contextWindow = MODEL_CONTEXT[modelName] || MODEL_CONTEXT.default;
    
    // Reserve 30% for prompt template, output, and safety margin
    const availableTokens = contextWindow * 0.7;
    
    // Target tokens per chunk: 35k (safe margin for 100k context)
    // This allows room for prompt overhead + generated output
    const targetTokensPerChunk = Math.min(35000, Math.floor(availableTokens * 0.5));
    
    // Estimate total tokens for all respondents
    let totalEstimatedTokens = 0;
    respondents.forEach(r => {
      totalEstimatedTokens += this.estimateTokensForRespondent(r);
    });
    
    const avgTokensPerRespondent = totalEstimatedTokens / totalRespondents;
    
    // Estimate number of chunks needed
    const estimatedChunks = Math.ceil(totalEstimatedTokens / targetTokensPerChunk);
    
    // Max chunks that can be stitched in one call
    const maxChunksForSingleStitch = Math.floor(availableTokens / (targetTokensPerChunk * 1.5));
    
    const useHierarchical = estimatedChunks > maxChunksForSingleStitch;
    
    if (process.env.VERBOSE) {
      console.log(`[PositionWriter] TOKEN-AWARE chunking strategy: ${totalRespondents} respondents, total ~${totalEstimatedTokens} tokens (avg ${avgTokensPerRespondent.toFixed(0)}/respondent)`);
      console.log(`[PositionWriter]   Target: ${targetTokensPerChunk} tokens/chunk → ~${estimatedChunks} chunks, hierarchical: ${useHierarchical}`);
    }
    
    return {
      targetTokens: targetTokensPerChunk,
      estimatedChunks,
      totalEstimatedTokens,
      avgTokensPerRespondent,
      maxChunksPerStitch: Math.max(3, maxChunksForSingleStitch),
      useHierarchical
    };
  }

  /**
   * Hierarchical stitching for very large positions (legacy)
   * @deprecated Use hierarchicalStitchWithRunner for adaptive model selection
   * @private
   */
  async hierarchicalStitch(positionInput, allChunks, strategy) {
    return this.hierarchicalStitchWithRunner(positionInput, allChunks, strategy, this.promptRunner);
  }

  /**
   * Hierarchical stitching for very large positions with custom promptRunner
   * @private
   */
  async hierarchicalStitchWithRunner(positionInput, allChunks, strategy, promptRunner) {
    console.log(`[PositionWriter] Using hierarchical stitching for ${allChunks.length} chunks`);
    
    // Normalize chunks to standard structure
    let currentLevel = allChunks.map(chunk => {
      // If it's already a structured object (from recursive calls or previous steps), keep it
      if (chunk.respondents && Array.isArray(chunk.respondents)) return chunk;
      // If it's a raw array of respondents, wrap it
      if (Array.isArray(chunk)) return { respondents: chunk };
      return chunk;
    });
    
    let levelNum = 1;
    
    while (currentLevel.length > strategy.maxChunksPerStitch) {
      console.log(`[PositionWriter] Hierarchical level ${levelNum}: stitching ${currentLevel.length} partials into ${Math.ceil(currentLevel.length / strategy.maxChunksPerStitch)} groups`);
      
      const nextLevel = [];
      
      // Process in groups of maxChunksPerStitch
      for (let i = 0; i < currentLevel.length; i += strategy.maxChunksPerStitch) {
        const group = currentLevel.slice(i, i + strategy.maxChunksPerStitch);
        
        // Determine if we're in first iteration (chunks are arrays) or later (chunks are objects with .respondents)
        const isFirstIteration = levelNum === 1;
        
        // Create partial summaries for this group
        const partialSummaries = await Promise.all(
          group.map(async item => {
            // Extract respondents
            const respondents = item.respondents || [];
            
            if (!Array.isArray(respondents) || respondents.length === 0) {
              // Log minimal info instead of full object dump
              const itemType = typeof item;
              const keys = item && typeof item === 'object' ? Object.keys(item).join(', ') : 'N/A';
              console.error(`[PositionWriter] Invalid respondents in hierarchical level ${levelNum}: type=${itemType}, keys=[${keys}]`);
              throw new Error(`Invalid respondents structure at level ${levelNum}`);
            }
            
            // If already has summary (level 2+), use it directly
            if (!isFirstIteration && item.summary) {
              return {
                summary: item.summary,
                responseNumbers: respondents.map(r => r?.responseNumber).filter(Boolean)
              };
            }
            
            // Otherwise generate new summary
            return {
              summary: await promptRunner.generatePosition({
                ...positionInput,
                respondents: respondents
              }),
              responseNumbers: respondents.map(r => r?.responseNumber).filter(Boolean)
            };
          })
        );
        
        // Stitch this group
        // Extract all respondents from group
        const groupRespondents = group.flatMap(item => item.respondents || []);
        
        const stitched = await promptRunner.stitchPosition({
          positionInput: {
            ...positionInput,
            respondents: groupRespondents
          },
          partialSummaries
        });
        
        // Store for next level (as if it was a chunk)
        nextLevel.push({
          summary: stitched,
          respondents: groupRespondents,
          level: levelNum
        });
      }
      
      currentLevel = nextLevel;
      levelNum++;
    }
    
    // Final stitch of top-level summaries
    console.log(`[PositionWriter] Final hierarchical stitch of ${currentLevel.length} summaries`);
    
    const finalPartials = currentLevel.map(item => {
      // Safety check for respondents structure
      if (!item.respondents || !Array.isArray(item.respondents)) {
        console.warn(`[PositionWriter] Invalid respondents structure in hierarchical level: (item missing valid respondents array)`);
        return {
          summary: item.summary || item,
          responseNumbers: [],
          respondentCount: 0,
          _targetSentences: calculateTargetSentences(0)
        };
      }
      
      const respondentCount = item.respondents.length;
      return {
        summary: item.summary,
        responseNumbers: item.respondents.map(r => r.responseNumber),
        respondentCount: respondentCount,
        // EXPLICIT VERBOSITY TARGET for hierarchical stitch
        _targetSentences: calculateTargetSentences(respondentCount)
      };
    });
    
    // Reduce positionInput for final stitch to avoid context window issues
    // But keep minimal respondent info so LLM knows the full list for validation
    const reducedRespondents = positionInput.respondents.map(r => ({
      responseNumber: r.responseNumber,
      respondentName: r.respondentName,
      respondentType: r.respondentType
    }));
    
    const reducedPositionInput = {
      ...positionInput,
      respondents: reducedRespondents
    };
    
    const final = await promptRunner.stitchPosition({
      positionInput: reducedPositionInput,
      partialSummaries: finalPartials
    });
    
    final.warnings = final.warnings || [];
    final.warnings.push(`Used ${levelNum}-level hierarchical stitching for ${positionInput.respondents.length} respondents`);
    
    return final;
  }

  /**
   * Generate hybrid output with dynamic chunking/stitching strategy (legacy)
   * @deprecated Use generateHybridOutputWithRunner for adaptive model selection
   */
  async generateHybridOutput(positionInput) {
    return this.generateHybridOutputWithRunner(positionInput, this.promptRunner);
  }

  /**
   * Generate hybrid output with TOKEN-AWARE chunking/stitching strategy
   * OPTIMIZATION: Uses actual token counts instead of fixed respondent count
   * @param {Object} positionInput - Input data for position
   * @param {HybridPromptRunner} promptRunner - Prompt runner with configured model
   */
  async generateHybridOutputWithRunner(positionInput, promptRunner) {
    const respondents = positionInput.respondents;

    if (respondents.length === 0) {
      return '';
    }

    // MEGA-POSITION DETECTION: Use sub-position-aware processing for large positions with sub-positions
    const subPositions = positionInput.position?.subPositions;
    const hasSubPositions = subPositions && subPositions.length > 0;
    const isMegaPosition = hasSubPositions && respondents.length > 100;
    
    if (isMegaPosition) {
      // Note: "MEGA-POSITION detected" is logged inside generateMegaPositionOutput
      // only when actually generating (not on cache hit for retry)
      return await this.generateMegaPositionOutput(positionInput, promptRunner);
    }

    // Calculate optimal strategy based on actual token usage
    const strategy = this.calculateChunkingStrategy(positionInput);

    // Simple case: fits in one call (estimated single chunk)
    if (strategy.estimatedChunks <= 1) {
      const draft = await promptRunner.generatePosition(positionInput);
      return draft;
    }

    // OPTIMIZATION: Create token-aware chunks instead of fixed respondent count
    const respondentChunks = this.createTokenAwareChunks(respondents, strategy.targetTokens);
    
    // Decide on stitching strategy
    if (strategy.useHierarchical) {
      // Use hierarchical stitching for very large positions
      return await this.hierarchicalStitchWithRunner(positionInput, respondentChunks, strategy, promptRunner);
    }

    // Standard single-level stitching
    const partialSummaries = [];

    respondentChunks.forEach(chunk => {
      const partialInput = {
        ...positionInput,
        respondents: chunk
      };

      partialSummaries.push({
        summary: promptRunner.generatePosition(partialInput),
        responseNumbers: chunk.map(r => r.responseNumber)
      });
    });

    const resolvedSummaries = await Promise.all(
      partialSummaries.map(async partial => ({
        summary: await partial.summary,
        responseNumbers: partial.responseNumbers
      }))
    );

    // OPTIMIZATION: Reduce positionInput for stitching to avoid context window overflow
    // But keep minimal respondent info so LLM knows the full list for validation
    const reducedRespondents = positionInput.respondents.map(r => ({
      responseNumber: r.responseNumber,
      respondentName: r.respondentName,
      respondentType: r.respondentType
    }));

    const reducedPositionInput = {
      ...positionInput,
      respondents: reducedRespondents
    };

    const stitched = await promptRunner.stitchPosition({
      positionInput: reducedPositionInput,
      partialSummaries: resolvedSummaries
    });

    return stitched;
  }

  /**
   * Generate output for MEGA-POSITIONS using sub-position-aware processing
   * 
   * STRATEGY: Respect sub-positions as semantic units
   * - Each sub-position is processed separately (never arbitrarily split)
   * - Large sub-positions get internal token-aware chunking
   * - Small sub-positions are processed directly
   * - Final stitch combines sub-position summaries
   * - OPTIMIZATION: Sub-position summaries are CACHED for retry efficiency
   * 
   * @param {Object} positionInput - Full position input with sub-positions
   * @param {HybridPromptRunner} promptRunner - Prompt runner with configured model
   */
  async generateMegaPositionOutput(positionInput, promptRunner) {
    const subPositions = positionInput.position.subPositions;
    const allRespondents = positionInput.respondents;
    const masterOnly = positionInput.position.masterOnly;
    const positionKey = `${positionInput.theme?.name}::${positionInput.position?.title}`;
    
    // Log master-only info if present
    if (masterOnly && masterOnly.respondentCount > 0) {
      console.log(`[PositionWriter]    📋 Master-only respondents: ${masterOnly.respondentCount} (will be separate group in output)`);
    }
    
    // Calculate expected summary count (sub-positions + master-only if present)
    const expectedSummaryCount = subPositions.length + (masterOnly?.respondentCount > 0 ? 1 : 0);
    
    // OPTIMIZATION: Check for cached sub-position summaries from previous retry
    // This prevents re-generating all sub-positions when only final stitch needs retry
    if (!this._megaPositionCache) {
      this._megaPositionCache = new Map();
    }
    
    const cachedSummaries = this._megaPositionCache.get(positionKey);
    if (cachedSummaries && cachedSummaries.length === expectedSummaryCount) {
      // RETRY PATH: Use cached summaries, only redo final stitch
      console.log(`[PositionWriter]    ♻️ RETRY: Using cached sub-position summaries (${cachedSummaries.length} items) - only redoing final stitch`);
      return await this._finalStitchMegaPosition(positionInput, cachedSummaries, promptRunner, { isRetry: true });
    }
    
    // FIRST RUN PATH: Generate all sub-position summaries
    console.log(`[PositionWriter] 🦣 MEGA-POSITION detected: ${allRespondents.length} respondents, ${subPositions.length} sub-positions`);
    console.log(`[PositionWriter]    Using sub-position-aware processing (preserves semantic structure)`);
    
    // TOKEN-BASED threshold (not respondent count!)
    // This adapts to both one-liners and long citations
    const MAX_TOKENS_PER_DIRECT_CALL = 25000; // ~6,250 words - safe for most models
    const CHARS_PER_TOKEN = 4; // Conservative estimate
    
    // Create a map of responseNumber → respondent for quick lookup
    const respondentMap = new Map();
    for (const r of allRespondents) {
      respondentMap.set(r.responseNumber, r);
    }
    
    // PARALLEL PROCESSING: Process sub-positions concurrently for speed
    const PARALLEL_CONCURRENCY = 8;
    
    console.log(`[PositionWriter]    🚀 Processing ${subPositions.length} sub-positions in parallel (concurrency: ${PARALLEL_CONCURRENCY})`);
    
    // Build all tasks first
    const tasks = subPositions.map((subPos, i) => ({
      subPos,
      index: i,
      title: subPos.title?.slice(0, 60) || `Sub-position ${i + 1}`
    }));
    
    // Process in parallel batches
    const subPositionSummaries = await this.processSubPositionsBatched(
      tasks, respondentMap, positionInput, promptRunner, 
      MAX_TOKENS_PER_DIRECT_CALL, CHARS_PER_TOKEN, PARALLEL_CONCURRENCY
    );
    
    // ADD MASTER-ONLY as FIRST "summary" if present
    // Master-only respondents express only the general position without specific nuance
    // They should be mentioned BEFORE sub-positions (per user requirement)
    if (masterOnly && masterOnly.respondentCount > 0) {
      const masterOnlyCount = masterOnly.respondentCount;
      const masterOnlyNumbers = masterOnly.responseNumbers || [];
      
      // Build proper label with named entities (not just "X borgere")
      const masterOnlyLabel = this.buildMasterOnlyLabel(masterOnlyNumbers, respondentMap);
      
      // Create a simple summary for master-only respondents
      // This will be placed FIRST in the final stitch (before sub-positions)
      const masterOnlySummary = {
        title: 'Generel tilslutning (uden specifik nuance)',
        summary: `${masterOnlyLabel} tilslutter sig holdningen i kortere tilkendegivelser uden at anføre specifikke argumenter.`,
        responseNumbers: masterOnlyNumbers,
        respondentCount: masterOnlyCount,
        _isMasterOnly: true // Flag for stitch prompt - place FIRST
      };
      
      // Unshift to START so it appears first in output (before sub-positions)
      subPositionSummaries.unshift(masterOnlySummary);
      console.log(`[PositionWriter]    📋 Added master-only summary (${masterOnlyCount} respondents) as FIRST group: "${masterOnlyLabel}"`);
    }
    
    // CACHE sub-position summaries for potential retry (validation failures)
    // This saves 10+ minutes on retries by not re-generating sub-positions
    this._megaPositionCache.set(positionKey, subPositionSummaries);
    console.log(`[PositionWriter]    💾 Cached ${subPositionSummaries.length} sub-position summaries for retry efficiency`);
    
    return await this._finalStitchMegaPosition(positionInput, subPositionSummaries, promptRunner, { isRetry: false });
  }

  /**
   * Process sub-positions in batched parallel execution.
   * @private
   */
  async processSubPositionsBatched(tasks, respondentMap, positionInput, promptRunner, maxTokensPerCall, charsPerToken, batchSize) {
    const results = [];
    const totalTasks = tasks.length;
    
    for (let batchStart = 0; batchStart < totalTasks; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, totalTasks);
      const batch = tasks.slice(batchStart, batchEnd);
      
      console.log(`[PositionWriter]    📦 Batch ${Math.floor(batchStart/batchSize) + 1}: processing ${batch.length} sub-positions...`);
      
      const batchPromises = batch.map(async (task) => {
        const { subPos, index, title } = task;
        
        // OPTIMIZATION: Check if we should use diversity-sampled light respondents
        // Threshold: >20 respondents AND has representativeArguments with quotes
        const hasRepresentativeArgs = subPos.representativeArguments && 
                                       subPos.representativeArguments.length > 0 &&
                                       subPos.representativeArguments.some(a => a.quote);
        const fullRespondentCount = (subPos.responseNumbers || []).length;
        const useDiversitySampling = hasRepresentativeArgs && fullRespondentCount > 20;
        
        let subPosRespondents;
        let subPosInput;
        let estimatedTokens;
        
        if (useDiversitySampling) {
          // MEGA-SUB-POSITION: Use diversity samples instead of all respondents
          const { lightRespondents, fullResponseNumbers } = 
            this.buildLightRespondentsFromDiversity(
              subPos.representativeArguments, 
              respondentMap, 
              subPos
            );
          
          if (lightRespondents.length === 0) {
            console.log(`[PositionWriter]      ⚠️ "${title}" has no valid diversity samples, skipping`);
            return null;
          }
          
          subPosRespondents = lightRespondents;
          
          // Estimate tokens for light respondents (much smaller)
          estimatedTokens = lightRespondents.reduce((sum, r) => {
            const argTokens = (r.summary?.arguments || []).reduce((argSum, arg) => {
              return argSum + Math.ceil((arg.what?.length || 0) / charsPerToken) +
                             Math.ceil((arg.sourceQuote?.length || 0) / charsPerToken);
            }, 0);
            return sum + argTokens + 100;
          }, 0);
          
          const targetSentences = calculateTargetSentences(fullRespondentCount);
          console.log(`[PositionWriter]      📝 [${index + 1}/${totalTasks}] "${title}" (${fullRespondentCount} resp → ${lightRespondents.length} diversity samples, ~${Math.round(estimatedTokens/1000)}K tokens)`);
          console.log(`[PositionWriter]         🎯 _targetSentences: min=${targetSentences.min}, max=${targetSentences.max}, branching=${targetSentences.requiresBranching}`);
          
          subPosInput = {
            ...positionInput,
            respondents: lightRespondents,
            position: {
              ...positionInput.position,
              title: subPos.title || positionInput.position.title,
              summary: subPos.summary || positionInput.position.summary,
              subPositions: undefined,
              subPositionsRequired: false,
              _subPositionContext: { what: subPos.what, why: subPos.why, how: subPos.how },
              // CRITICAL: Tell LLM the FULL count for correct labels
              _fullRespondentCount: fullRespondentCount,
              _fullResponseNumbers: fullResponseNumbers,
              // Flag that this is diversity-sampled
              _diversitySampled: true,
              // SAFEGUARD: Available evidence count for anti-hallucination
              _availableEvidenceCount: lightRespondents.length,
              // EXPLICIT VERBOSITY TARGET based on FULL respondent count
              _targetSentences: calculateTargetSentences(fullRespondentCount)
            }
          };
        } else {
          // SMALL SUB-POSITION: Use all respondents (original behavior)
          subPosRespondents = (subPos.responseNumbers || [])
            .map(rn => respondentMap.get(rn))
            .filter(Boolean);
          
          if (subPosRespondents.length === 0) {
            console.log(`[PositionWriter]      ⚠️ "${title}" has no respondents, skipping`);
            return null;
          }
          
          estimatedTokens = subPosRespondents.reduce((sum, r) => {
            const argTokens = (r.summary?.arguments || []).reduce((argSum, arg) => {
              return argSum + Math.ceil((arg.what?.length || 0) / charsPerToken) +
                             Math.ceil((arg.consequence?.length || 0) / charsPerToken);
            }, 0);
            return sum + argTokens + 100;
          }, 0);
          
          const targetSentencesSmall = calculateTargetSentences(subPosRespondents.length);
          console.log(`[PositionWriter]      📝 [${index + 1}/${totalTasks}] "${title}" (${subPosRespondents.length} resp, ~${Math.round(estimatedTokens/1000)}K tokens)`);
          console.log(`[PositionWriter]         🎯 _targetSentences: min=${targetSentencesSmall.min}, max=${targetSentencesSmall.max}, branching=${targetSentencesSmall.requiresBranching}`);
          
          const repArgsForSubPos = subPos.representativeArguments || [];
          subPosInput = {
            ...positionInput,
            respondents: subPosRespondents,
            position: {
              ...positionInput.position,
              title: subPos.title || positionInput.position.title,
              summary: subPos.summary || positionInput.position.summary,
              subPositions: undefined,
              subPositionsRequired: false,
              _subPositionContext: { what: subPos.what, why: subPos.why, how: subPos.how },
              representativeArguments: repArgsForSubPos,
              _availableEvidenceCount: repArgsForSubPos.length,
              // EXPLICIT VERBOSITY TARGET for small sub-positions
              _targetSentences: calculateTargetSentences(subPosRespondents.length)
            }
          };
        }
        
        let subPosSummary;
        
        try {
          if (estimatedTokens <= maxTokensPerCall) {
            subPosSummary = await promptRunner.generatePosition(subPosInput);
          } else {
            const chunks = this.createTokenAwareChunks(subPosRespondents, maxTokensPerCall);
            const partials = await Promise.all(chunks.map(chunk => 
              promptRunner.generatePosition({ ...subPosInput, respondents: chunk })
            ));
            const partialSummaries = partials.map((summary, idx) => ({
              summary,
              responseNumbers: chunks[idx].map(r => r.responseNumber)
            }));
            subPosSummary = await promptRunner.stitchPosition({
              positionInput: { ...subPosInput, respondents: subPosRespondents.map(r => ({
                responseNumber: r.responseNumber,
                respondentName: r.respondentName,
                respondentType: r.respondentType
              }))},
              partialSummaries
            });
          }
        } catch (error) {
          console.warn(`[PositionWriter]      ⚠️ Failed "${title}": ${error.message}`);
          // IMPROVED FALLBACK: Include descriptive text instead of generic error
          // This provides context without exposing technical error messages
          const respondentCount = subPos.responseNumbers?.length || 0;
          const fallbackText = respondentCount === 1
            ? `Én borger har indsendt høringssvar om "${title.substring(0, 50)}...".`
            : `${respondentCount} borgere har indsendt høringssvar om "${title.substring(0, 50)}...".`;
          subPosSummary = {
            summary: fallbackText,
            references: [],
            warnings: [`Generation failed: ${error.message}`],
            _fallback: true // Flag for downstream handling
          };
        }
        
        console.log(`[PositionWriter]      ✅ [${index + 1}/${totalTasks}] "${title}" done`);

        // CRITICAL: Always use full responseNumbers from sub-position, not from light respondents
        const actualResponseNumbers = subPos.responseNumbers || [];

        // Extract summary string and references from LLM response object
        // generatePosition() returns {title, summary, references, warnings} - we need the string
        let summaryText = typeof subPosSummary === 'object' ? subPosSummary.summary : subPosSummary;
        // CRITICAL: Sanitize malformed REF patterns from LLM output
        summaryText = sanitizeSummary(summaryText);
        const summaryRefs = subPosSummary?.references || [];
        const summaryWarnings = subPosSummary?.warnings || [];

        return {
          title: subPos.title,
          summary: summaryText,
          references: summaryRefs,
          warnings: summaryWarnings,
          responseNumbers: actualResponseNumbers,
          respondentCount: actualResponseNumbers.length,
          _diversitySampled: useDiversitySampling
        };
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
      console.log(`[PositionWriter]    ✅ Batch complete (${results.length}/${totalTasks} done)`);
    }
    
    return results;
  }

  /**
   * Final stitch for mega-position - combines sub-position summaries
   * Separated out to enable retry without re-generating sub-positions
   * @private
   */
  async _finalStitchMegaPosition(positionInput, subPositionSummaries, promptRunner, options = {}) {
    const { isRetry = false } = options;
    const allRespondents = positionInput.respondents;

    // OPTIMIZATION: Skip LLM stitch for very large mega-positions
    // With >12 sub-positions, the stitch output exceeds token limits and JSON truncates
    // Use structured fallback directly to avoid 3x retry overhead (~13 min saved)
    const MAX_STITCH_SUB_POSITIONS = 12;
    if (subPositionSummaries.length > MAX_STITCH_SUB_POSITIONS) {
      console.log(`[PositionWriter]    ⚡ ${subPositionSummaries.length} sub-positions exceeds stitch limit (${MAX_STITCH_SUB_POSITIONS}) - using direct concatenation`);
      return this._buildFallbackMegaPositionSummary(positionInput, subPositionSummaries);
    }

    // FINAL STITCH: Combine all sub-position summaries into one mega-position text
    // Only log details on first run (not on retry - we already logged "♻️ RETRY")
    if (!isRetry) {
      console.log(`[PositionWriter]    🧵 Final stitch: combining ${subPositionSummaries.length} sub-position summaries`);
    }

    // ============================================================================
    // PHASE 4: SORT SUB-POSITIONS BY HIERARCHY
    // Ensures: Lokaludvalg → Organizations → Myndigheder → Large groups → Small groups
    // ============================================================================
    const respondentMap = new Map(allRespondents.map(r => [r.responseNumber, r]));

    // Sort sub-positions by hierarchy (Lokaludvalg first, then orgs, then by size)
    const sortedSubPositions = this.sortSubPositionsByHierarchy(subPositionSummaries, respondentMap);

    if (!isRetry) {
      const hierarchyOrder = sortedSubPositions.map(sp => {
        const priority = this.getRespondentPriority(sp, respondentMap);
        const priorityNames = ['Lokaludvalg', 'Organisation', 'Myndighed', 'Stor gruppe', 'Mellem gruppe', 'Lille gruppe'];
        return `${sp.title?.substring(0, 30) || 'Ukendt'}... (${priorityNames[priority] || 'Ukendt'}, ${sp.responseNumbers?.length || 0} resp.)`;
      });
      console.log(`[PositionWriter]    📊 Hierarchy-sorted order: ${hierarchyOrder.join(' → ')}`);
    }

    // ============================================================================
    // PHASE 1-3: BUILD DETERMINISTIC GROUP METADATA
    // Pre-compute exact labels - LLM will use GROUP_X placeholders
    // ============================================================================
    const groupMetadata = this.prepareGroupsForLLM(sortedSubPositions, respondentMap);

    if (!isRetry) {
      console.log(`[PositionWriter]    🏷️ Pre-computed ${groupMetadata.length} deterministic labels:`);
      groupMetadata.forEach(g => {
        console.log(`[PositionWriter]      ${g.id}: "${g._exactLabel}" (${g.type}, ${g.respondentCount} resp.)`);
      });
    }

    // Create final stitch input with minimal respondent data
    const finalInput = {
      ...positionInput,
      respondents: allRespondents.map(r => ({
        responseNumber: r.responseNumber,
        respondentName: r.respondentName,
        respondentType: r.respondentType
      }))
    };

    // Calculate ALL respondent numbers for master-holdning (union of all)
    const allRespondentNumbers = [...new Set(
      sortedSubPositions.flatMap(sp => sp.responseNumbers || [])
    )].sort((a, b) => a - b);

    if (!isRetry) {
      console.log(`[PositionWriter]    📊 Master-holdning will cover ALL ${allRespondentNumbers.length} respondents`);
    }

    // Build final partials from SORTED sub-positions with group metadata
    const finalPartials = sortedSubPositions.map((sp, idx) => ({
      summary: sp.summary,
      responseNumbers: sp.responseNumbers,
      respondentCount: sp.respondentCount,
      // Include sub-position title for context in stitching
      _subPositionTitle: sp.title,
      // Flag for master-only group (should be FIRST and kept separate)
      _isMasterOnly: sp._isMasterOnly || false,
      // EXPLICIT VERBOSITY TARGET for stitch prompt
      _targetSentences: calculateTargetSentences(sp.respondentCount),
      // NEW: GROUP placeholder ID for this sub-position (GROUP_1, GROUP_2, etc.)
      // Note: GROUP_1 is for master-holdning, sub-positions start at GROUP_2
      _groupId: `GROUP_${idx + 2}`,
      // Pre-computed exact label for post-processing
      _exactLabel: groupMetadata[idx]?._exactLabel || `${sp.respondentCount} borgere`,
      _groupType: groupMetadata[idx]?.type || 'plural_citizens'
    }));

    // Add metadata for master-holdning (first reference should use ALL respondents)
    finalInput._allRespondentNumbers = allRespondentNumbers;
    finalInput._totalRespondentCount = allRespondentNumbers.length;

    // Add pre-computed group metadata for deterministic label injection
    finalInput._groupMetadata = this.formatGroupsForPrompt(groupMetadata);
    finalInput._useGroupPlaceholders = true; // Signal to prompt to use GROUP_X format

    // CRITICAL: Add sub-position context for master-holdning to EXCLUDE
    // This prevents master-holdning from repeating arguments already covered by sub-positions
    finalInput._subPositionContext = sortedSubPositions
      .filter(sp => !sp._isMasterOnly) // Exclude master-only from this list
      .map(sp => {
        // Handle case where summary might be an object (from LLM response) or string
        let summaryText = sp.summary || '';
        if (typeof summaryText === 'object') {
          summaryText = summaryText.summary || JSON.stringify(summaryText).slice(0, 200);
        }
        return {
          title: sp.title,
          respondentCount: sp.respondentCount,
          // Extract key arguments from summary (first 200 chars as hint)
          summaryHint: String(summaryText).slice(0, 200)
        };
      });

    if (!isRetry) {
      console.log(`[PositionWriter]    📋 Added ${finalInput._subPositionContext.length} sub-position contexts for master-holdning exclusion`);
    }

    try {
      let finalSummary = await promptRunner.stitchPosition({
        positionInput: finalInput,
        partialSummaries: finalPartials
      });

      // ============================================================================
      // PHASE 3: POST-PROCESS - INJECT EXACT LABELS
      // Replace GROUP_X placeholders with deterministic labels
      // ============================================================================
      if (finalSummary && typeof finalSummary === 'object') {
        // Check if summary contains GROUP_X placeholders
        if (finalSummary.summary && finalSummary.summary.includes('<<GROUP_')) {
          console.log(`[PositionWriter]    🔄 Injecting deterministic labels into summary...`);
          finalSummary.summary = this.injectLabelsIntoSummary(finalSummary.summary, groupMetadata);
        }

        // Build/update references from group metadata (deterministic)
        if (!finalSummary.references || finalSummary.references.length === 0) {
          // Create master reference (REF_1) for all respondents
          const masterRef = {
            id: 'REF_1',
            label: 'Der',
            respondents: allRespondentNumbers,
            quotes: [],
            notes: ''
          };
          // Add sub-position references
          const subRefs = this.buildReferencesFromGroups(groupMetadata).map((ref, idx) => ({
            ...ref,
            id: `REF_${idx + 2}` // REF_2, REF_3, etc. (REF_1 is master)
          }));
          finalSummary.references = [masterRef, ...subRefs];
          console.log(`[PositionWriter]    📝 Built ${finalSummary.references.length} deterministic references`);
        }

        // ============================================================================
        // PHASE 6: BUILD CITATION MAP DETERMINISTICALLY
        // Enables tracing from highlighted text to respondents
        // ============================================================================
        finalSummary.citationMap = this.buildCitationMapFromGroups(groupMetadata);
        console.log(`[PositionWriter]    📍 Built citationMap with ${finalSummary.citationMap.length} entries`);
      }

      console.log(`[PositionWriter]    ✅ Mega-position completed: ${allRespondents.length} respondents → ${subPositionSummaries.length} sub-positions → 1 summary`);

      return finalSummary;
    } catch (error) {
      console.error(`[PositionWriter]    ❌ Final stitch failed: ${error.message}`);
      return this._buildFallbackMegaPositionSummary(positionInput, subPositionSummaries, error.message);
    }
  }

  /**
   * Build fallback summary for mega-positions when stitch fails or is skipped
   * @private
   */
  _buildFallbackMegaPositionSummary(positionInput, subPositionSummaries, errorMessage = null) {
    // Return structured combination of sub-position summaries
    // Return proper object structure to avoid downstream crashes
    const allRespondents = positionInput.respondents || [];

    // ============================================================================
    // PHASE 4: SORT SUB-POSITIONS BY HIERARCHY (same as stitch path)
    // ============================================================================
    const respondentMap = new Map(allRespondents.map(r => [r.responseNumber, r]));
    const sortedSubPositions = this.sortSubPositionsByHierarchy(subPositionSummaries, respondentMap);

    console.log(`[PositionWriter]    📊 Fallback: sorted ${sortedSubPositions.length} sub-positions by hierarchy`);

    // ============================================================================
    // PHASE 1-3: BUILD DETERMINISTIC GROUP METADATA
    // ============================================================================
    const groupMetadata = this.prepareGroupsForLLM(sortedSubPositions, respondentMap);

    // Build summary text with deterministic labels
    const summaryParts = [];

    // Add master holdning first
    const allRespondentNumbers = [...new Set(
      sortedSubPositions.flatMap(sp => sp.responseNumbers || [])
    )].sort((a, b) => a - b);

    summaryParts.push(`Der<<REF_1>> fremhæves overordnet følgende holdninger.`);

    // Add each sorted sub-position with exact labels
    sortedSubPositions.forEach((sp, idx) => {
      const label = groupMetadata[idx]?._exactLabel || `${sp.respondentCount || sp.responseNumbers?.length || 0} borgere`;
      const refNum = idx + 2; // REF_1 is master, sub-positions start at REF_2
      const cleanSummary = sanitizeSummary(sp.summary || '').trim();

      if (cleanSummary) {
        // Replace any existing refs/labels with our deterministic ones
        let subText = cleanSummary;
        // Remove any existing REF placeholders from sub-position summary
        subText = subText.replace(/<<REF_\d+>>/g, '');

        // CRITICAL: Remove leading subjects from sub-position text since we're prepending our own label
        // This prevents "X borgere Der opfordrer..." or "X borgere Flere borgere mener..."
        subText = subText
          .replace(/^Der\s+/i, '')  // Remove leading "Der "
          .replace(/^\d+\s+borgere?\s+/i, '')  // Remove leading "X borgere "
          .replace(/^[A-ZÆØÅ][a-zæøå]+\s+borgere?\s+/i, '')  // Remove "Otte borgere " etc.
          .replace(/^Borgere?\s+/i, '')  // Remove leading "Borger " or "Borgere "
          .replace(/^Flere\s+/i, '')  // Remove leading "Flere "
          .replace(/^En\s+borger\s+/i, '')  // Remove leading "En borger "
          .replace(/^Én\s+borger\s+/i, '')  // Remove leading "Én borger "
          .trim();

        // Ensure first letter is lowercase if we removed a subject (will follow our label)
        // But keep uppercase if it starts a proper noun or sentence-like content
        if (subText && /^[A-ZÆØÅ]/.test(subText.charAt(0))) {
          // CRITICAL: Detect orphaned verbs - these indicate the label might be missing
          // Common Danish verbs that indicate a missing subject when at start
          const commonVerbs = /^(anfører|fremhæver|peger|mener|ønsker|kritiserer|foreslår|anbefaler|udtrykker|tilslutter|argumenterer|påpeger|efterlyser|understreger)\b/i;
          if (commonVerbs.test(subText)) {
            // This is an orphaned verb - subText shouldn't start with verb without subject
            console.log(`[PositionWriter] ⚠️ Orphaned verb detected (will have label prepended): "${subText.substring(0, 40)}..."`);
          }

          // Check if it's likely a proper noun (followed by more uppercase or specific patterns)
          const startsWithProperNoun = /^[A-ZÆØÅ][a-zæøå]+\s+[A-ZÆØÅ]/.test(subText) ||  // "Name Lastname"
                                       /^[A-ZÆØÅ]{2,}/.test(subText) ||                   // Acronym like "APS", "BYENSdesign"
                                       /^[A-ZÆØÅ][a-zæøå]+\./.test(subText) ||            // Abbreviation like "H.H."
                                       /^[A-ZÆØÅ][a-zæøå]+valg/.test(subText) ||
                                       /^[A-ZÆØÅ][a-zæøå]+udvalg/.test(subText);
          if (!startsWithProperNoun && subText.length > 0) {
            subText = subText.charAt(0).toLowerCase() + subText.slice(1);
          }
        }

        // Add our deterministic label
        summaryParts.push(`${label}<<REF_${refNum}>> ${subText}`);
      }
    });

    const fallbackSummaryText = summaryParts.join(' ');

    // Build references deterministically
    const masterRef = {
      id: 'REF_1',
      label: 'Der',
      respondents: allRespondentNumbers,
      quotes: [],
      notes: ''
    };

    const subRefs = groupMetadata.map((group, idx) => ({
      id: `REF_${idx + 2}`,
      label: group._exactLabel,
      respondents: group._responseNumbers,
      quotes: [],
      notes: ''
    }));

    const allReferences = [masterRef, ...subRefs];

    // ============================================================================
    // PHASE 6: BUILD CITATION MAP DETERMINISTICALLY
    // ============================================================================
    const citationMap = this.buildCitationMapFromGroups(groupMetadata);

    const warnings = errorMessage
      ? ['Fallback summary used - final stitch failed: ' + errorMessage]
      : [`Direct concatenation used - ${subPositionSummaries.length} sub-positions exceeded stitch limit`];

    console.log(`[PositionWriter]    📝 Fallback: built ${allReferences.length} deterministic references`);
    console.log(`[PositionWriter]    📍 Fallback: built citationMap with ${citationMap.length} entries`);

    return {
      title: positionInput.position?.title || 'Ukendt position',
      summary: fallbackSummaryText,
      references: allReferences,
      citationMap,
      warnings
    };
  }

  buildRespondentLabel(response = {}) {
    if (response.respondentName && response.respondentName.trim().length > 0) {
      return response.respondentName.trim();
    }

    const type = (response.respondentType || '').toLowerCase();
    if (type.includes('lokal')) return 'Lokaludvalg';
    if (type.includes('myndighed')) return 'Offentlig myndighed';
    if (type.includes('organisation')) return 'Organisation';
    return 'Borger';
  }

  /**
   * Build a label for master-only respondents that includes named entities
   * E.g., "1150 borgere og Indre By Lokaludvalg" instead of just "1150 borgere"
   * @param {Array<number>} responseNumbers - Response numbers in master-only
   * @param {Map} respondentMap - Map of responseNumber -> respondent data
   * @returns {string} Label like "X borgere" or "X borgere og [named entities]"
   */
  buildMasterOnlyLabel(responseNumbers, respondentMap) {
    const namedEntities = [];
    let citizenCount = 0;
    
    for (const respNum of responseNumbers) {
      let respondent = respondentMap.get(respNum);
      
      // Fallback to rawResponses if not in respondentMap
      if (!respondent && this._rawResponsesMap) {
        const rawResp = this._rawResponsesMap.get(respNum);
        if (rawResp) {
          respondent = {
            respondentName: rawResp.respondentName,
            respondentType: rawResp.respondentType,
            respondentLabel: this.buildRespondentLabel(rawResp)
          };
        }
      }

      if (!respondent) {
        citizenCount++;
        continue;
      }

      const label = respondent.respondentLabel?.trim() || respondent.respondentName?.trim();
      const isCitizen = !label || label.toLowerCase() === 'borger';

      if (isCitizen) {
        citizenCount++;
      } else {
        // Avoid duplicates
        if (!namedEntities.includes(label)) {
          namedEntities.push(label);
        }
      }
    }

    // Build final label using DanishNumberFormatter for correct grammar
    if (namedEntities.length === 0) {
      return DanishNumberFormatter.formatWithNoun(citizenCount, 'borger');
    } else if (citizenCount === 0) {
      return namedEntities.join(', ');
    } else {
      // Use DanishNumberFormatter for correct number/noun agreement
      const citizenLabel = DanishNumberFormatter.formatWithNoun(citizenCount, 'borger');
      return `${namedEntities.join(', ')} og ${citizenLabel}`;
    }
  }

  /**
   * Check for duplicate REF_X references in summary text
   * @param {string} summary - Summary text to check
   * @returns {Object} { hasDuplicates: boolean, duplicates: string[] }
   */
  checkDuplicateReferences(summary) {
    if (!summary || typeof summary !== 'string') {
      return { hasDuplicates: false, duplicates: [] };
    }

    const refMatches = summary.match(/<<REF_\d+>>/g);
    if (!refMatches || refMatches.length === 0) {
      return { hasDuplicates: false, duplicates: [] };
    }

    const uniqueRefs = new Set(refMatches);
    const hasDuplicates = refMatches.length !== uniqueRefs.size;

    if (!hasDuplicates) {
      return { hasDuplicates: false, duplicates: [] };
    }

    // Find which refs are duplicated
    const refCounts = {};
    refMatches.forEach(ref => {
      refCounts[ref] = (refCounts[ref] || 0) + 1;
    });

    const duplicates = Object.keys(refCounts).filter(ref => refCounts[ref] > 1);

    return { hasDuplicates: true, duplicates };
  }

  /**
   * Clean prefixes from quotes in hybrid summary
   * Removes "Cite:", "Citat:", "Quote:", etc.
   * @private
   */
  cleanQuotePrefixes(hybridSummary) {
    if (!hybridSummary || !hybridSummary.references || !Array.isArray(hybridSummary.references)) return;
    
    hybridSummary.references.forEach(ref => {
      if (ref.quotes && Array.isArray(ref.quotes)) {
        ref.quotes.forEach(quoteObj => {
          if (quoteObj.quote && typeof quoteObj.quote === 'string') {
            // Remove common prefixes added by LLMs
            // Also remove "Cite" if it appears inside the string like "Cite: ..."
            quoteObj.quote = quoteObj.quote
              .replace(/^(Cite|Citat|Quote|Citation|Reference):\s*/i, '')
              .replace(/^"|"$|^'|'$/g, '') // Remove wrapping quotes
              .trim();
          }
        });
      }
    });
  }

  /**
   * Fix misattributed quotes by searching for the text in other respondents
   * Solves the "Off-by-one" or "Group confusion" hallucinations
   * @private
   */
  fixQuoteAttributions(hybridSummary, writerInput) {
    if (!hybridSummary || !hybridSummary.references || !Array.isArray(hybridSummary.references)) return;
    if (!writerInput || !writerInput.respondents || !Array.isArray(writerInput.respondents)) return;

    // Create map of responseNumber -> text for fast lookup
    const responseMap = new Map();
    writerInput.respondents.forEach(r => {
      // Use excerpt or look up full text if needed (writerInput usually has excerpt or full text)
      // Here we use excerpt because that's what the LLM saw
      if (r.excerpt) {
        responseMap.set(r.responseNumber, this.normalizeText(r.excerpt));
      }
    });

    hybridSummary.references.forEach(ref => {
      if (ref.quotes && Array.isArray(ref.quotes)) {
        ref.quotes.forEach(quoteObj => {
          if (!quoteObj.quote || !quoteObj.responseNumber) return;
          
          const normalizedQuote = this.normalizeText(quoteObj.quote);
          if (normalizedQuote.length < 20) return; // Skip short quotes to avoid false positives

          const originalResponseText = responseMap.get(quoteObj.responseNumber);
          
          // If quote is NOT found in the assigned response
          if (!originalResponseText || !originalResponseText.includes(normalizedQuote)) {
            // Search all other respondents
            for (const [respNum, text] of responseMap.entries()) {
              if (respNum === quoteObj.responseNumber) continue;
              
              if (text.includes(normalizedQuote)) {
                console.log(`[PositionWriter] 🔧 Fixed attribution: Quote assigned to ${quoteObj.responseNumber} actually found in ${respNum}`);
                quoteObj.responseNumber = respNum;
                
                // Also ensure the new respondent is in the references list
                if (ref.respondents && !ref.respondents.includes(respNum)) {
                  ref.respondents.push(respNum);
                  ref.respondents.sort((a, b) => a - b);
                }
                break; // Stop after finding first match
              }
            }
          }
        });
      }
    });
  }

  /**
   * Ensure all respondents in input are cited in the summary references.
   * Attempts to auto-assign missing respondents to relevant groups.
   * @private
   */
  ensureAllRespondentsCited(hybridSummary, writerInput, attempt) {
    if (!hybridSummary || !hybridSummary.references || !Array.isArray(hybridSummary.references)) return;
    if (!writerInput || !writerInput.respondents || !Array.isArray(writerInput.respondents)) return;

    const expectedIds = new Set(writerInput.respondents.map(r => r.responseNumber));
    const citedIds = new Set();

    // Collect currently cited IDs
    hybridSummary.references.forEach(ref => {
      if (Array.isArray(ref.respondents)) {
        ref.respondents.forEach(id => citedIds.add(id));
      } else {
        ref.respondents = []; // Initialize if missing
      }
    });

    const missingIds = [...expectedIds].filter(id => !citedIds.has(id));

    if (missingIds.length === 0) return;

    console.log(`[PositionWriter] ⚠️ Found ${missingIds.length} missing citations. Attempting auto-fix...`);

    // Map of ID -> Respondent Data
    const respondentMap = new Map(writerInput.respondents.map(r => [r.responseNumber, r]));

    missingIds.forEach(id => {
      const respondent = respondentMap.get(id);
      if (!respondent) return;

      const text = this.normalizeText(respondent.excerpt || '');
      let assigned = false;

      // Strategy 1: Content Match (Quote)
      // Check if respondent's text appears in any reference's quotes
      for (const ref of hybridSummary.references) {
        if (ref.quotes && Array.isArray(ref.quotes)) {
          for (const quoteObj of ref.quotes) {
            if (quoteObj.quote) {
              const quoteText = this.normalizeText(quoteObj.quote);
              // Check if quote is part of respondent text (or vice versa)
              if (text.includes(quoteText) || quoteText.includes(text)) {
                ref.respondents.push(id);
                ref.respondents.sort((a, b) => a - b);
                assigned = true;
                console.log(`[PositionWriter] 🔧 Auto-assigned missing ${id} to REF ${ref.id} (Quote Match)`);
                break;
              }
              // Use flexible matcher
              const match = findFlexibleQuote(text, quoteObj.quote);
              if (match.found) {
                ref.respondents.push(id);
                ref.respondents.sort((a, b) => a - b);
                assigned = true;
                console.log(`[PositionWriter] 🔧 Auto-assigned missing ${id} to REF ${ref.id} (Flexible Match)`);
                break;
              }
            }
          }
        }
        if (assigned) break;
      }

      // Strategy 2: Label Count Heuristic
      if (!assigned) {
        for (const ref of hybridSummary.references) {
          const labelCount = this.parseLabelCount(ref.label);
          if (labelCount > 0 && ref.respondents.length < labelCount) {
            ref.respondents.push(id);
            ref.respondents.sort((a, b) => a - b);
            
            // ONLY add a quote if the group size is small (<= 15)
            if (ref.respondents.length <= 15) {
              // CRITICAL FIX: Add a quote for this respondent to prevent "Samme holdning..." fallback
              if (!ref.quotes) ref.quotes = [];
              
              // Try to find a relevant snippet from writerInput
              const respondentInput = writerInput.respondents.find(r => r.responseNumber === id);
              if (respondentInput) {
                // Use first snippet or excerpt
                let quoteText = '';
                if (respondentInput.snippets && respondentInput.snippets.length > 0) {
                  quoteText = respondentInput.snippets[0].text;
                } else if (respondentInput.excerpt) {
                   // Use first sentence of excerpt
                   const match = respondentInput.excerpt.match(/[^.!?]+[.!?]+/);
                   quoteText = match ? match[0] : respondentInput.excerpt.substring(0, 100) + '...';
                }
                
                if (quoteText) {
                  // Include respondentName for proper formatting (use actual name, not "Henvendelse X")
                  const respondentName = respondentInput?.respondentName?.trim() || null;
                  
                  ref.quotes.push({
                    responseNumber: id,
                    quote: quoteText,
                    respondentName: respondentName // CRITICAL: Include name for output formatting
                  });
                  console.log(`[PositionWriter] 🔧 Added missing quote for auto-assigned ${id}`);
                }
              }
            } else {
               console.log(`[PositionWriter] 🔧 Auto-assigned ${id} to large group (size ${ref.respondents.length}), skipping quote generation.`);
            }

            assigned = true;
            console.log(`[PositionWriter] 🔧 Auto-assigned missing ${id} to REF ${ref.id} (Label Capacity: ${ref.respondents.length}/${labelCount})`);
            break;
          }
        }
      }

      // Strategy 3: Last Resort - Assign to the largest group
      // OPTIMIZATION: Now activated on FIRST attempt to avoid unnecessary retries
      // (Previously only activated on attempt > 1, causing 234s+ retries)
      if (!assigned) {
        let largestRef = null;
        let maxSize = -1;

        hybridSummary.references.forEach(ref => {
          if (ref.respondents.length > maxSize) {
            maxSize = ref.respondents.length;
            largestRef = ref;
          }
        });

        if (largestRef) {
          largestRef.respondents.push(id);
          largestRef.respondents.sort((a, b) => a - b);

          // Only add quote if group is small
          if (largestRef.respondents.length <= 15) {
              // CRITICAL FIX: Add a quote for this respondent too
              if (!largestRef.quotes) largestRef.quotes = [];
              
              const respondentInput = writerInput.respondents.find(r => r.responseNumber === id);
              if (respondentInput) {
                 let quoteText = '';
                  if (respondentInput.snippets && respondentInput.snippets.length > 0) {
                    quoteText = respondentInput.snippets[0].text;
                  } else if (respondentInput.excerpt) {
                     const match = respondentInput.excerpt.match(/[^.!?]+[.!?]+/);
                     quoteText = match ? match[0] : respondentInput.excerpt.substring(0, 100) + '...';
                  }
                  
                  if (quoteText) {
                    // Include respondentName for proper formatting (use actual name, not "Henvendelse X")
                    const respondentName = respondentInput?.respondentName?.trim() || null;
                    
                    largestRef.quotes.push({
                      responseNumber: id,
                      quote: quoteText,
                      respondentName: respondentName // CRITICAL: Include name for output formatting
                    });
                  }
              }
          } else {
             console.log(`[PositionWriter] 🔧 Auto-assigned ${id} to large group (fallback), skipping quote generation.`);
          }

          assigned = true;
          console.log(`[PositionWriter] 🔧 Auto-assigned missing ${id} to REF ${largestRef.id} (Fallback: Largest Group)`);
          
          if (!hybridSummary.warnings) hybridSummary.warnings = [];
          hybridSummary.warnings.push(`Auto-assigned missing respondent ${id} to ${largestRef.id} for completeness.`);
        }
      }
    });
  }

  /**
   * Parse number from label string (e.g. "syv borgere" -> 7, "12 borgere" -> 12)
   * @private
   */
  parseLabelCount(label) {
    if (!label || typeof label !== 'string') return 0;
    
    // Digits
    const digitMatch = label.match(/(\d+)/);
    if (digitMatch) return parseInt(digitMatch[1], 10);

    // Common Danish number words
    const words = {
      'en': 1, 'et': 1,
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
    
    const lowerLabel = label.toLowerCase();
    for (const [word, num] of Object.entries(words)) {
      if (lowerLabel.includes(word)) return num;
    }
    
    return 0;
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
   * Auto-expand common abbreviations in title
   * @param {string} title - Title to process
   * @returns {string} Title with abbreviations expanded
   * @private
   */
  expandAbbreviationsInTitle(title) {
    if (!title || typeof title !== 'string') return title;
    
    const expansions = [
      { pattern: /\bGl\.\s*/gi, replacement: 'Gammel ' },
      { pattern: /\bvedr\.\s*/gi, replacement: 'vedrørende ' },
      { pattern: /\bpga\.\s*/gi, replacement: 'på grund af ' },
      { pattern: /\bift\.\s*/gi, replacement: 'i forhold til ' },
      { pattern: /\bbl\.a\.\s*/gi, replacement: 'blandt andet ' },
      { pattern: /\bmht\.\s*/gi, replacement: 'med hensyn til ' },
      { pattern: /\biht\.\s*/gi, replacement: 'i henhold til ' },
      { pattern: /\bevt\.\s*/gi, replacement: 'eventuelt ' },
      { pattern: /\bfx\.\s*/gi, replacement: 'for eksempel ' }
    ];
    
    let result = title;
    let wasExpanded = false;
    
    for (const { pattern, replacement } of expansions) {
      if (pattern.test(result)) {
        wasExpanded = true;
        result = result.replace(pattern, replacement);
      }
    }
    
    if (wasExpanded) {
      console.log(`[PositionWriter] 🔧 Auto-expanded abbreviations: "${title}" → "${result}"`);
    }
    
    return result;
  }


  /**
   * Validate position title for quality issues
   * Logs warnings but does not block - these are quality hints
   * @param {string} title - Position title to validate
   * @returns {Object} { valid: boolean, issues: string[] }
   * @private
   */
  validatePositionTitle(title) {
    if (!title || typeof title !== 'string') {
      return { valid: false, issues: ['Title is missing or invalid'] };
    }

    const issues = [];

    // 0. Check for vague meta-titles that don't describe concrete content
    const metaTitlePatterns = [
      { pattern: /vægtning\s+af.*bemærkninger/i, reason: 'For abstrakt - handler om proces, ikke indhold' },
      { pattern: /høringsproces/i, reason: 'Meta-titel om proces, ikke konkret holdning' },
      { pattern: /generel.*holdning/i, reason: 'For vag - specificer konkret emne' },
      { pattern: /^diverse\s+/i, reason: 'For vag - specificer konkret emne' },
      { pattern: /^forhold\s+vedrørende/i, reason: 'For vag - specificer konkret holdning' },
      { pattern: /^bemærkninger\s+om/i, reason: 'For vag - brug holdnings-præfiks' },
      { pattern: /^kommentarer\s+til/i, reason: 'For vag - brug holdnings-præfiks' },
      { pattern: /tydelig.*vægtning/i, reason: 'Meta-titel om proces, ikke konkret holdning' },
      // CRITICAL: "Holdninger til X" is ALWAYS bad - it doesn't express any actual stance
      // Good: "Ønske om bevaring af X", "Modstand mod X", "Bekymring for X"
      // Bad: "Holdninger til X" - doesn't tell if they're for or against
      { pattern: /^holdninger?\s+til\s+/i, reason: 'Udtrykker ikke konkret holdning - brug ønske/modstand/bekymring/støtte' }
    ];

    for (const { pattern, reason } of metaTitlePatterns) {
      if (pattern.test(title)) {
        issues.push(`Meta-titel detekteret: "${reason}". Titlen bør beskrive den konkrete holdning.`);
        break; // Only report first meta-title issue
      }
    }

    // 0.5 Check for combination titles ("X og Y" where Y is another stance)
    // These indicate the title combines multiple positions - the secondary part 
    // should likely be a sub-position rather than in the main title.
    const combinationPatterns = [
      { 
        pattern: /\bog\s+(ønske|bekymring|modstand|forslag|støtte|opfordring|anmodning|indsigelse)\s+/i, 
        reason: 'Kombinerer flere holdninger med "og"'
      },
      { 
        pattern: /\bsamt\s+(ønske|bekymring|modstand|forslag|støtte)\s+/i, 
        reason: 'Kombinerer flere holdninger med "samt"'
      }
    ];
    
    for (const { pattern, reason } of combinationPatterns) {
      if (pattern.test(title)) {
        issues.push(`Kombinations-titel: ${reason}. Den sekundære holdning bør evt. være en sub-position.`);
        break; // Only report first combination issue
      }
    }

    // 1. Check for forbidden made-up compound words
    const forbiddenCompounds = [
      { pattern: /privatlivsbekymring/i, suggestion: 'Bekymring for indbliksgener' },
      { pattern: /trafikbekymring/i, suggestion: 'Bekymring for trafiksikkerhed' },
      { pattern: /støjbekymring/i, suggestion: 'Bekymring for støjgener' },
      { pattern: /skyggebekymring/i, suggestion: 'Bekymring for skyggegener' },
      { pattern: /højdebekymring/i, suggestion: 'Bekymring for bygningshøjde' },
      { pattern: /parkeringsbekymring/i, suggestion: 'Bekymring for parkeringsforhold' },
      { pattern: /miljøbekymring/i, suggestion: 'Bekymring for miljøpåvirkning' }
    ];

    for (const { pattern, suggestion } of forbiddenCompounds) {
      if (pattern.test(title)) {
        issues.push(`Påfundet sammensætning "${title.match(pattern)[0]}" → brug "${suggestion}"`);
      }
    }

    // 2. Check for abbreviations
    const abbreviations = [
      { pattern: /\bGl\.\s/i, full: 'Gammel ' },
      { pattern: /\bvedr\.\s/i, full: 'vedrørende ' },
      { pattern: /\bpga\.\s/i, full: 'på grund af ' },
      { pattern: /\bift\.\s/i, full: 'i forhold til ' },
      { pattern: /\bbl\.a\.\s/i, full: 'blandt andet ' },
      { pattern: /\bmht\.\s/i, full: 'med hensyn til ' }
    ];

    for (const { pattern, full } of abbreviations) {
      if (pattern.test(title)) {
        issues.push(`Forkortelse fundet - brug "${full.trim()}" i stedet`);
      }
    }

    // 3. Check for missing explicit stance prefix
    const validPrefixes = [
      /^Ønske om\b/i,
      /^Forslag om\b/i,
      /^Bekymring for\b/i,
      /^Modstand mod\b/i,
      /^Støtte til\b/i,
      /^Opfordring til\b/i,
      /^Indsigelse mod\b/i,
      /^Anmodning om\b/i
    ];

    const hasValidPrefix = validPrefixes.some(prefix => prefix.test(title));
    if (!hasValidPrefix) {
      // Check if it's an implicit stance (action without prefix)
      const implicitActions = [
        /^Flytning af\b/i,
        /^Reduktion af\b/i,
        /^Etablering af\b/i,
        /^Ændring af\b/i,
        /^Fjernelse af\b/i,
        /^Bevarelse af\b/i
      ];
      
      const isImplicit = implicitActions.some(action => action.test(title));
      if (isImplicit) {
        issues.push(`Implicit holdning - titlen bør starte med "Ønske om" eller lignende`);
      } else {
        issues.push(`Mangler holdnings-præfiks (Ønske om, Bekymring for, Modstand mod, etc.)`);
      }
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * Remove duplicate REF_X references from summary text
   * Keeps only the first occurrence of each REF_X
   * @param {string} summary - Summary text with duplicate references
   * @returns {string} Cleaned summary with duplicates removed
   */
  removeDuplicateReferences(summary) {
    if (!summary || typeof summary !== 'string') {
      return summary;
    }

    const seen = new Set();
    
    // Replace all REF_X placeholders
    // Keep first occurrence, remove subsequent ones
    return summary.replace(/<<REF_\d+>>/g, (match) => {
      if (seen.has(match)) {
        // Duplicate - remove it
        return '';
      }
      seen.add(match);
      // First occurrence - keep it
      return match;
    });
  }

  /**
   * Check if a string has balanced parentheses.
   * @param {string} text - Text to check
   * @returns {boolean} True if balanced
   * @private
   */
  hasBalancedParens(text) {
    if (!text) return true;
    let count = 0;
    for (const char of text) {
      if (char === '(') count++;
      else if (char === ')') count--;
      if (count < 0) return false; // More closing than opening
    }
    return count === 0;
  }

  /**
   * Extract complete sentences from text, ensuring they don't end mid-parenthesis.
   * Returns 1-2 complete sentences suitable for quoting.
   * 
   * @param {string} text - Text to extract sentences from
   * @param {number} maxChars - Maximum total characters
   * @returns {string} Complete sentence(s)
   * @private
   */
  extractCompleteSentences(text, maxChars = 350) {
    if (!text) return '';
    
    // FIRST: Check if input text has unbalanced parentheses - if so, try to complete them
    const inputParenBalance = this.countParentheses(text);
    if (inputParenBalance.open > inputParenBalance.close) {
      // Text ends with unclosed parenthesis - this is problematic
      // Try to find the closing parenthesis in the original text if we can extend
      console.warn(`[PositionWriter] Quote has unclosed parenthesis: "${text.substring(0, 60)}..."`);
    }
    
    // First, try to get complete sentences
    // This pattern attempts to match sentences that may contain parentheses
    const sentences = [];
    let remaining = text;
    let parenDepth = 0;
    let currentSentence = '';
    
    for (let i = 0; i < remaining.length && sentences.length < 3; i++) {
      const char = remaining[i];
      currentSentence += char;
      
      if (char === '(') parenDepth++;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      
      // End of sentence only if we're not inside parentheses
      if ((char === '.' || char === '!' || char === '?') && parenDepth === 0) {
        // Check if it's actually end of sentence (not abbreviation like "ca.")
        const nextChar = remaining[i + 1];
        
        // Common abbreviations that don't end sentences
        const abbreviations = ['ca.', 'fx.', 'bl.', 'mv.', 'nr.', 'kr.', 'gl.', 'st.', 'kl.', 'pkt.', 'stk.', 'evt.'];
        const lastWord = currentSentence.slice(-10).toLowerCase();
        const isAbbreviation = abbreviations.some(abbr => lastWord.includes(abbr));
        
        // If next char is uppercase or whitespace+uppercase, it's likely end of sentence
        if (!isAbbreviation && (!nextChar || nextChar === ' ' || nextChar === '\n')) {
          sentences.push(currentSentence.trim());
          currentSentence = '';
        }
      }
    }
    
    // If we have complete sentences, use first 1-2 that fit within maxChars
    if (sentences.length > 0) {
      let result = sentences[0];
      if (sentences.length > 1 && (result.length + sentences[1].length + 1) <= maxChars) {
        result += ' ' + sentences[1];
      }
      
      // Verify result has balanced parentheses
      if (this.hasBalancedParens(result)) {
        // If result is still too long, truncate at last complete sentence
        if (result.length > maxChars) {
          result = sentences[0];
          if (result.length > maxChars) {
            // Even first sentence is too long - find safe truncation point
            result = this.truncateSafely(result, maxChars);
          }
        }
        return result;
      }
      
      // If result has unbalanced parens, try to fix by including more text
      if (sentences.length > 1 && !this.hasBalancedParens(result)) {
        result = sentences[0] + ' ' + sentences[1];
        if (this.hasBalancedParens(result) && result.length <= maxChars * 1.2) {
          return result;
        }
      }
    }
    
    // Fallback: no proper sentences found or parenthesis issues
    // Try to find a safe truncation point that doesn't break parentheses
    return this.truncateSafely(text, maxChars);
  }
  
  /**
   * Count open and close parentheses in text.
   * @param {string} text - Text to analyze
   * @returns {Object} { open: number, close: number }
   * @private
   */
  countParentheses(text) {
    if (!text) return { open: 0, close: 0 };
    let open = 0, close = 0;
    for (const char of text) {
      if (char === '(') open++;
      else if (char === ')') close++;
    }
    return { open, close };
  }
  
  /**
   * Truncate text safely without breaking mid-parenthesis or mid-word.
   * @param {string} text - Text to truncate
   * @param {number} maxChars - Maximum characters
   * @returns {string} Safely truncated text
   * @private
   */
  truncateSafely(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    
    // Find a safe truncation point before maxChars
    let truncateAt = maxChars;
    let parenDepth = 0;
    let lastSafePoint = -1;
    
    for (let i = 0; i < Math.min(text.length, maxChars + 50); i++) {
      const char = text[i];
      
      if (char === '(') parenDepth++;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      
      // A safe point is where we're not inside parentheses and at a word boundary
      if (parenDepth === 0 && (char === ' ' || char === '.' || char === ',' || char === ';')) {
        if (i <= maxChars) {
          lastSafePoint = i;
        } else if (i <= maxChars + 50) {
          // Allow slight overflow to close parenthesis
          lastSafePoint = i;
          break;
        }
      }
    }
    
    // Use the safe point if found, otherwise just word boundary
    if (lastSafePoint > maxChars / 2) {
      const result = text.substring(0, lastSafePoint).trim();
      // Add ellipsis if we didn't end on punctuation
      if (!/[.!?]$/.test(result)) {
        return result + '...';
      }
      return result;
    }
    
    // Last resort: simple word boundary truncation
    const breakPoint = text.lastIndexOf(' ', maxChars - 3);
    if (breakPoint > maxChars / 2) {
      return text.substring(0, breakPoint) + '...';
    }
    return text.substring(0, maxChars - 3) + '...';
  }

  /**
   * Clean quote content by removing irrelevant prefixes like salutations and subject headers.
   * These add no value to the citation and can be confusing.
   * 
   * @param {string} quote - Raw quote text
   * @returns {string} Cleaned quote text
   * @private
   */
  cleanQuoteContent(quote) {
    if (!quote || typeof quote !== 'string') return quote;
    
    let cleaned = quote;
    
    // Fjern hilsener og emne-headers i starten (kan være på flere linjer)
    const irrelevantPrefixes = [
      // Hilsener
      /^(Til rette vedkommende|Kære\s+[^\n,]+|Hej\s+[^\n,]+)[,.\s\n]*/i,
      // Emne-headers
      /^(Vedr\.?|Vedrørende|Angående)\s+[^.\n]+[.\n]+\s*/i,
      /^(Høringssvar|Bemærkninger|Indsigelse)\s*(vedr\.?|vedrørende|til|om)[^.\n]+[.\n]+\s*/i,
      // Generiske høringssvar-starters
      /^Høringssvar\s*:\s*/i,
    ];
    
    // Fjern "rough cut" prefixes - tegnsætning, listenumre og whitespace i starten
    const roughCutPrefixes = [
      // Tegnsætning i starten (punktum, komma, kolon, semikolon, udråbstegn, spørgsmålstegn)
      /^[.,:;!?\s]+/,
      // Listenumre: "1)", "2.", "1.", "a)", "b.", "•", "-", "–", "—", "●", "○"
      /^(\d+[\)\.\s][\t\s]*)/,
      /^([a-zæøå][\)\.\s][\t\s]*)/i,
      /^([-•●○–—]\s*)/,
      // Tabs og multiple mellemrum i starten (efter andre rensninger)
      /^[\t]+/,
    ];
    
    // Apply each pattern (may need multiple passes)
    let previousLength;
    do {
      previousLength = cleaned.length;
      
      // First: remove irrelevant prefixes (headers, greetings)
      for (const pattern of irrelevantPrefixes) {
        cleaned = cleaned.replace(pattern, '');
      }
      
      // Then: remove rough cut prefixes (punctuation, list numbers)
      for (const pattern of roughCutPrefixes) {
        cleaned = cleaned.replace(pattern, '');
      }
      
      cleaned = cleaned.trim();
    } while (cleaned.length < previousLength && cleaned.length > 0);
    
    // Capitalize first letter if we removed a prefix
    if (cleaned.length > 0 && cleaned !== quote.trim()) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
    
    return cleaned;
  }

  /**
   * Extract keywords from text for relevance matching.
   * Normalizes and filters to meaningful words.
   * @param {...string} texts - Text strings to extract keywords from
   * @returns {Set<string>} Set of lowercase keywords
   * @private
   */
  extractKeywordsForMatching(...texts) {
    const keywords = new Set();
    const stopWords = new Set([
      'og', 'i', 'til', 'på', 'af', 'for', 'med', 'en', 'et', 'den', 'det',
      'som', 'er', 'at', 'om', 'fra', 'der', 'har', 'være', 'kan', 'vil',
      'skal', 'bør', 'må', 'ikke', 'sig', 'sin', 'sit', 'sine', 'deres',
      'ved', 'mod', 'over', 'under', 'mellem', 'efter', 'før', 'omkring',
      'ønske', 'forslag', 'bekymring', 'modstand', 'støtte', 'krav'
    ]);
    
    for (const text of texts) {
      if (!text) continue;
      const words = text.toLowerCase()
        .replace(/[^\wæøåÆØÅ\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
      
      words.forEach(w => keywords.add(w));
    }
    
    return keywords;
  }

  /**
   * Calculate keyword overlap score between two keyword sets.
   * Higher score means more relevance.
   * @param {Set<string>} set1 - First keyword set
   * @param {Set<string>} set2 - Second keyword set
   * @returns {number} Overlap score (0-1)
   * @private
   */
  calculateKeywordOverlap(set1, set2) {
    if (!set1.size || !set2.size) return 0;
    
    let overlapCount = 0;
    for (const word of set1) {
      if (set2.has(word)) {
        overlapCount++;
      } else {
        // Partial match: check if any word in set2 contains this word or vice versa
        for (const word2 of set2) {
          if (word.includes(word2) || word2.includes(word)) {
            overlapCount += 0.5;
            break;
          }
        }
      }
    }
    
    // Normalize by the smaller set size
    const minSize = Math.min(set1.size, set2.size);
    return overlapCount / minSize;
  }

  /**
   * Extract keywords from position title with synonyms for semantic matching.
   * Critical for mega-positions that span multiple themes.
   * @param {string} title - Position title
   * @returns {Object} Keywords and synonyms for matching
   * @private
   */
  extractPositionTitleKeywords(title) {
    if (!title) return { keywords: new Set(), synonyms: {} };
    
    // Define semantic synonyms for common position concepts
    // NOTE: "bevaring" and "nedrivning" are two sides of the same coin -
    // opposition to demolition = support for preservation
    // IMPORTANT: Include Danish spelling variations (æ/ø/å characters)
    const synonymMappings = {
      'bevaring': ['bevar', 'fred', 'beskyt', 'fasthold', 'oprethold', 'værn', 'nedrivning', 'nedrive', 'riv', 'ødelag', 'ødelæg', 'ødelægge', 'ødelæggende'],
      'bevar': ['bevaring', 'fred', 'beskyt', 'fasthold', 'oprethold', 'værn', 'nedrivning', 'nedrive', 'riv', 'ødelag', 'ødelæg', 'ødelægge', 'ødelæggende'],
      'nedrivning': ['riv', 'ødelag', 'ødelæg', 'ødelægge', 'ødelæggende', 'fjern', 'destruer', 'skamfer', 'bevaring', 'bevar', 'fred', 'beskyt'],
      'nedrive': ['nedrivning', 'ødelag', 'ødelæg', 'ødelægge', 'ødelæggende', 'fjern', 'destruer', 'skamfer', 'bevaring', 'bevar', 'fred', 'beskyt'],
      'modstand': ['imod', 'mod', 'stop', 'afvis', 'protest', 'drop', 'kritik', 'kritisere', 'kritiserer'],
      'kritik': ['modstand', 'imod', 'mod', 'stop', 'afvis', 'protest', 'drop', 'kritisere', 'kritiserer'],
      'ønske': ['vil', 'krav', 'foreslå', 'forslag', 'ønsker', 'foretrække'],
      'bygning': ['bygn', 'ejendom', 'facade', 'foyer', 'interiør', 'palads', 'hus', 'struktur'],
      'palads': ['bygning', 'bygn', 'ejendom', 'facade', 'foyer', 'interiør', 'hus', 'struktur', 'biograf'],
      'kulturarv': ['kultur', 'historisk', 'ikonisk', 'bevaringsværdig', 'arkitektur', 'identitet']
    };
    
    const keywords = new Set();
    const titleWords = title.toLowerCase()
      .replace(/[^\wæøåÆØÅ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
    
    titleWords.forEach(w => keywords.add(w));
    
    // Add synonyms for each title word
    const activeSynonyms = {};
    for (const word of titleWords) {
      // Check if word matches any synonym key
      for (const [key, synonyms] of Object.entries(synonymMappings)) {
        if (word.includes(key) || key.includes(word)) {
          activeSynonyms[word] = synonyms;
          synonyms.forEach(s => keywords.add(s));
        }
      }
    }
    
    return { keywords, synonyms: activeSynonyms };
  }

  /**
   * Check if argument content semantically matches position title.
   * Uses keyword and synonym matching for semantic similarity.
   * @param {string} argContent - Argument content (what + coreContent + consequence)
   * @param {Object} titleKeywordsObj - Object from extractPositionTitleKeywords
   * @param {string} positionTitle - Original position title for direct matching
   * @returns {boolean} True if semantic match detected
   * @private
   */
  checkPositionTitleMatch(argContent, titleKeywordsObj, positionTitle) {
    if (!argContent || !titleKeywordsObj?.keywords?.size) return false;
    
    const contentLower = argContent.toLowerCase();
    const { keywords, synonyms } = titleKeywordsObj;
    
    // Check for direct keyword matches
    let matchCount = 0;
    const requiredMatches = Math.min(2, Math.ceil(keywords.size / 3)); // Need at least 2 or 1/3 of keywords
    
    for (const keyword of keywords) {
      if (contentLower.includes(keyword)) {
        matchCount++;
        if (matchCount >= requiredMatches) return true;
      }
    }
    
    // Check for preservation-specific patterns (common in mega-positions)
    const preservationPatterns = [
      /bevar|fred|beskyt/i,
      /nedri|ødelag|skamfer/i,
      /kulturarv|historisk|ikonisk/i,
      /facade|foyer|bygning/i
    ];
    
    // If position is about preservation/demolition, check for these patterns
    if (positionTitle.includes('bevar') || positionTitle.includes('nedri')) {
      for (const pattern of preservationPatterns) {
        if (pattern.test(contentLower)) {
          matchCount++;
          if (matchCount >= requiredMatches) return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Calculate text overlap ratio between two strings.
   * Uses word-level comparison for semantic similarity.
   * @param {string} text1 - First text
   * @param {string} text2 - Second text
   * @returns {number} Overlap score (0-1)
   * @private
   */
  calculateTextOverlap(text1, text2) {
    if (!text1 || !text2) return 0;
    
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    
    if (words1.size === 0 || words2.size === 0) return 0;
    
    let matches = 0;
    for (const word of words1) {
      if (words2.has(word)) {
        matches++;
      }
    }
    
    // Return ratio of matching words to smaller set
    return matches / Math.min(words1.size, words2.size);
  }

  /**
   * Pre-select which respondents/arguments will have visible quotes.
   * Call BEFORE buildPositionInput() to filter LLM input to only citeable content.
   *
   * This fixes the quote/summary mismatch issue where LLM sees more arguments
   * than will eventually be cited, leading to summaries with claims that aren't
   * supported by the displayed quotes.
   *
   * STRATEGY:
   * - ≤15 respondents: All get 1 quote each - select best argument per respondent
   * - 16-100 respondents: Only 5 representative respondents get quotes
   * - Mega-positions (100+): Handled via diversity sampling in sub-positions
   *
   * @param {Object} position - Position with responseNumbers and sourceArgumentRefs
   * @param {Array} microSummaries - All micro-summaries with arguments and citations
   * @param {Object} citationRegistry - Citation registry for quote lookup
   * @returns {Object} { selectedArguments: Set<sourceQuoteRef>, selectedRespondents: Set<responseNumber>, quoteMap: Map<responseNumber, quote> }
   */
  preSelectQuotesForPosition(position, microSummaries, citationRegistry) {
    const respondentCount = position.responseNumbers?.length || 0;
    const selectedArguments = new Set();
    const selectedRespondents = new Set();
    const quoteMap = new Map();

    if (respondentCount === 0) {
      return { selectedArguments, selectedRespondents, quoteMap };
    }

    // Build position keywords for relevance scoring
    const positionKeywords = this.extractKeywordsForMatching(position.title || '');
    const positionTitle = (position.title || '').toLowerCase();
    const positionTitleKeywords = this.extractPositionTitleKeywords(positionTitle);

    // Get sourceArgumentRefs for this position (precise filtering)
    const positionArgRefs = position.sourceArgumentRefs || [];

    // Collect all candidate arguments from respondents in this position
    const candidatesByRespondent = new Map();

    for (const respNum of position.responseNumbers) {
      const summary = microSummaries.find(s => s.responseNumber === respNum);
      if (!summary?.arguments) continue;

      // Filter to arguments that belong to this position
      const thisResponseRefs = positionArgRefs.filter(ref => ref.responseNumber === respNum);
      let relevantArgs = summary.arguments;

      if (thisResponseRefs.length > 0) {
        relevantArgs = summary.arguments.filter(arg => {
          if (arg.sourceQuoteRef) {
            return thisResponseRefs.some(ref => ref.sourceQuoteRef === arg.sourceQuoteRef);
          }
          return false;
        });
      }

      // Score and collect arguments with citable quotes
      const scoredArgs = [];
      for (const arg of relevantArgs) {
        if (!arg.sourceQuoteRef) continue;

        const citation = citationRegistry?.getCitation?.(arg.sourceQuoteRef);
        if (!citation?.quote || citation.quote.length < 20) continue;

        // Score by relevance to position
        const argKeywords = this.extractKeywordsForMatching(arg.what || '', arg.consequence || '');
        let score = this.calculateKeywordOverlap(positionKeywords, argKeywords);

        // Boost for position title match
        const argContent = (arg.what || '') + ' ' + (arg.coreContent || '') + ' ' + (arg.consequence || '');
        const titleMatch = this.checkPositionTitleMatch(argContent, positionTitleKeywords, positionTitle);
        if (titleMatch.matches) {
          score += 0.5;
        }

        // Boost for theme match
        const argThemes = arg.relevantThemes || [];
        const positionTheme = position.theme?.toLowerCase() || '';
        if (positionTheme && argThemes.some(t => t?.toLowerCase().includes(positionTheme))) {
          score += 0.3;
        }

        scoredArgs.push({
          arg,
          quote: citation.quote,
          score,
          sourceQuoteRef: arg.sourceQuoteRef
        });
      }

      if (scoredArgs.length > 0) {
        // Sort by score descending
        scoredArgs.sort((a, b) => b.score - a.score);
        candidatesByRespondent.set(respNum, scoredArgs);
      }
    }

    if (respondentCount <= 15) {
      // ALL respondents get 1 quote each - select best argument per respondent
      for (const [respNum, scoredArgs] of candidatesByRespondent) {
        const best = scoredArgs[0];
        selectedArguments.add(best.sourceQuoteRef);
        selectedRespondents.add(respNum);
        quoteMap.set(respNum, best.quote);
      }

      console.log(`[PositionWriter] 🎯 Pre-selected quotes: ${selectedRespondents.size}/${respondentCount} respondents (standard mode)`);
    } else {
      // 16-100 respondents: Only 5 representative respondents get quotes
      // Select respondents with highest-scoring arguments, spread across the group
      const allScored = [];
      for (const [respNum, scoredArgs] of candidatesByRespondent) {
        allScored.push({ respNum, ...scoredArgs[0] });
      }

      // Sort by score and take top 5
      allScored.sort((a, b) => b.score - a.score);

      // But also ensure diversity - spread selection across response numbers
      const selected = [];
      const MAX_REPRESENTATIVE = 5;

      if (allScored.length <= MAX_REPRESENTATIVE) {
        // Take all available
        selected.push(...allScored);
      } else {
        // Take top scorer, then spread others across the list for diversity
        selected.push(allScored[0]);
        const step = Math.floor(allScored.length / MAX_REPRESENTATIVE);
        for (let i = step; selected.length < MAX_REPRESENTATIVE && i < allScored.length; i += step) {
          selected.push(allScored[i]);
        }
        // Fill remaining slots from top scorers
        for (const item of allScored) {
          if (selected.length >= MAX_REPRESENTATIVE) break;
          if (!selected.includes(item)) {
            selected.push(item);
          }
        }
      }

      for (const item of selected) {
        selectedArguments.add(item.sourceQuoteRef);
        selectedRespondents.add(item.respNum);
        quoteMap.set(item.respNum, item.quote);
      }

      console.log(`[PositionWriter] 🎯 Pre-selected quotes: ${selectedRespondents.size}/${respondentCount} respondents (medium mode, ${candidatesByRespondent.size} had citable args)`);
    }

    return { selectedArguments, selectedRespondents, quoteMap };
  }

  /**
   * Build a map of responseNumber -> best quote for programmatic quote filling.
   * Uses priority: citation registry (sourceQuoteRef) > sourceQuote > snippets > excerpt
   *
   * FIX: Now accepts positionContext to select the MOST RELEVANT citation for the position,
   * not just the first citation found. This prevents quote/position mismatches.
   *
   * @param {Array} respondents - Array of respondent objects from writerInput
   * @param {Object} positionContext - Optional context about the current position
   * @param {string} positionContext.title - Position title (for relevance matching)
   * @param {string} positionContext.themeName - Theme name (for relevance matching)
   * @returns {Map<number, string>} Map of response numbers to their best quote
   * @private
   */
  buildQuoteMap(respondents, positionContext = null) {
    const map = new Map();
    const lowRelevanceWarnings = []; // Collect warnings for summarization

    if (!respondents || !Array.isArray(respondents)) {
      return map;
    }
    
    // Build position keywords for relevance matching (exclude theme name to avoid "andre emner" pollution)
    const positionKeywords = this.extractKeywordsForMatching(
      positionContext?.title || ''
      // NOTE: Removed themeName - it was polluting keywords with "andre", "emner" etc.
    );
    
    // Get full microSummaries if available (for complete citation access)
    const fullMicroSummaries = positionContext?.microSummaries || null;
    
    respondents.forEach(r => {
      if (!r.responseNumber) return;
      
      let quote = '';
      let quoteSource = '';
      
      // CRITICAL FIX: Use FULL arguments from microSummaries, not truncated writerInput
      // This ensures citation selection has access to ALL arguments, not just maxArgumentsPerRespondent
      let fullArguments = r.summary?.arguments || [];
      if (fullMicroSummaries) {
        const fullSummary = fullMicroSummaries.find(s => s.responseNumber === r.responseNumber);
        if (fullSummary?.arguments && fullSummary.arguments.length > fullArguments.length) {
          fullArguments = fullSummary.arguments;
        }
      }

      // Priority 0 (HIGHEST): Citation registry via sourceQuoteRef
      // FIX: Select the MOST RELEVANT citation for this position using FULL arguments
      if (this.citationRegistry && fullArguments.length > 0) {
        
        // Get position theme for fallback matching
        const positionTheme = positionContext?.themeName?.toLowerCase() || '';
        
        // NEW: Extract position title keywords for semantic matching
        // This is crucial for mega-positions that span multiple themes
        const positionTitle = positionContext?.title?.toLowerCase() || '';
        const positionTitleKeywords = this.extractPositionTitleKeywords(positionTitle);
        
        // Score each argument by relevance to the position
        const scoredArgs = fullArguments
          .filter(arg => arg.sourceQuoteRef)
          .map(arg => {
            const citation = this.citationRegistry.getCitation(arg.sourceQuoteRef);
            if (!citation?.quote) return null;
            
            // Calculate relevance score based on keyword overlap
            const argKeywords = this.extractKeywordsForMatching(arg.what || '', arg.consequence || '');
            let relevanceScore = this.calculateKeywordOverlap(positionKeywords, argKeywords);
            
            // NEW: POSITION TITLE MATCH - Critical for mega-positions!
            // Check if argument's content semantically matches position title
            const argContent = (arg.what || '') + ' ' + (arg.coreContent || '') + ' ' + (arg.consequence || '');
            const titleMatch = this.checkPositionTitleMatch(argContent, positionTitleKeywords, positionTitle);
            
            // THEME BOOST: If keyword overlap is low but argument's theme matches position theme,
            // give a significant boost. This prevents wrong citations when all keyword overlaps are 0.
            const argThemes = arg.relevantThemes || [];
            
            // Define semantically related theme groups
            // Themes in the same group are considered "matching" for citation selection
            const themeRelationships = {
              'bebyggelsens omfang og placering': ['bevaring', 'facade', 'bygning', 'nedrivning', 'arkitektur'],
              'bebyggelsens ydre fremtræden': ['bevaring', 'facade', 'arkitektur', 'udseende'],
              'bevaring': ['bebyggelsens omfang', 'bebyggelsens ydre', 'facade', 'bygning', 'kulturarv', 'nedrivning']
            };
            
            const themeMatch = argThemes.some(theme => {
              const themeLower = theme?.toLowerCase() || '';
              // Check if themes contain similar terms (e.g., "ubebyggede arealer" matches "ubebyggede arealer")
              if (themeLower === positionTheme || 
                  themeLower.includes(positionTheme) || 
                  positionTheme.includes(themeLower)) {
                return true;
              }
              
              // Check semantic theme relationships
              for (const [themeKey, relatedThemes] of Object.entries(themeRelationships)) {
                if (positionTheme.includes(themeKey) || themeKey.includes(positionTheme)) {
                  // Position matches a theme group - check if argument theme is related
                  if (relatedThemes.some(related => themeLower.includes(related) || related.includes(themeLower))) {
                    return true;
                  }
                }
              }
              
              // Handle common theme name variations
              return (themeLower.includes('ubebyg') && positionTheme.includes('ubebyg')) ||
                     (themeLower.includes('parkering') && positionTheme.includes('parkering')) ||
                     (themeLower.includes('trafik') && positionTheme.includes('trafik'));
            });
            
            // If no keyword overlap but theme matches, give minimum base score
            // This ensures theme-relevant citations beat theme-irrelevant ones when all have 0 keyword match
            if (relevanceScore < 0.1 && themeMatch) {
              relevanceScore = Math.max(relevanceScore, 0.15); // Theme-matching base score
            }
            
            // NEW: If title matches, boost relevance significantly
            // This is especially important for mega-positions with respondents from different themes
            if (relevanceScore < 0.1 && titleMatch) {
              relevanceScore = Math.max(relevanceScore, 0.20); // Title-matching base score (higher than theme)
            }
            
            return {
              arg,
              citation,
              relevanceScore,
              themeMatch,
              titleMatch
            };
          })
          .filter(Boolean);
        
        if (scoredArgs.length > 0) {
          // Sort by relevance score (highest first) and pick the best match
          scoredArgs.sort((a, b) => b.relevanceScore - a.relevanceScore);
          const bestMatch = scoredArgs[0];
          
          // CRITICAL CHECK: If best match has very low score AND no theme/title match,
          // this respondent might not belong in this position at all.
          // Collect warning for summary instead of logging each individually.
          if (bestMatch.relevanceScore < 0.1 && !bestMatch.themeMatch && !bestMatch.titleMatch) {
            lowRelevanceWarnings.push({
              responseNumber: r.responseNumber,
              score: bestMatch.relevanceScore,
              positionTitle: positionContext?.title?.substring(0, 50) || 'unknown'
            });
          }
          
          quote = bestMatch.citation.quote;
          quoteSource = `citation-registry:${bestMatch.arg.sourceQuoteRef}`;
        }
      }
      
      // Priority 1: sourceQuote from micro-summary arguments (legacy/fallback)
      // Check ALL arguments (using fullArguments for complete access)
      if (!quote && fullArguments.length > 0) {
        for (const arg of fullArguments) {
          if (arg.sourceQuote) {
            quote = arg.sourceQuote;
            quoteSource = 'sourceQuote';
            break;
          }
        }
      }
      
      // Priority 2: First snippet text
      if (!quote && r.snippets?.[0]?.text) {
        quote = r.snippets[0].text;
        quoteSource = 'snippet';
      }
      
      // Priority 3: First sentence(s) from excerpt - using improved sentence detection
      if (!quote && r.excerpt) {
        // Use extractCompleteSentences to avoid mid-sentence breaks and unbalanced parentheses
        quote = this.extractCompleteSentences(r.excerpt, 350);
        quoteSource = 'excerpt';
      }
      
      if (quote) {
        // Clean irrelevant prefixes before storing
        const cleanedQuote = this.cleanQuoteContent(quote.trim());
        if (cleanedQuote) {
          map.set(r.responseNumber, cleanedQuote);
          // Debug: log quote source if not from citation registry
          if (quoteSource !== 'citation-registry' && quoteSource) {
            console.log(`[PositionWriter] Quote for respondent ${r.responseNumber} from ${quoteSource}`);
          }
        }
      }
    });

    // Log summarized warning instead of individual warnings
    if (lowRelevanceWarnings.length > 0) {
      const positionTitle = positionContext?.title?.substring(0, 50) || 'unknown';
      console.warn(`[PositionWriter] ⚠️ LOW RELEVANCE: ${lowRelevanceWarnings.length} respondents have no theme/title-matching citations for position "${positionTitle}"`);
      // Log respondent IDs (truncated if too many)
      const respondentIds = lowRelevanceWarnings.map(w => w.responseNumber);
      if (respondentIds.length <= 5) {
        console.warn(`  Respondents: ${respondentIds.join(', ')}`);
      } else {
        console.warn(`  Respondents: ${respondentIds.slice(0, 5).join(', ')} (+${respondentIds.length - 5} more)`);
      }
    }

    return map;
  }

  /**
   * Detect if a reference is a back-reference to a previous group.
   * Patterns like "De samme X borgere", "Disse X borgere", "Af disse" indicate
   * we're referring to a previously mentioned group and should NOT repeat quotes.
   * 
   * @param {string} summary - Full summary text
   * @param {string} refId - Reference ID (e.g., "REF_2")
   * @returns {boolean} True if this is a back-reference
   * @private
   */
  isBackReference(summary, refId) {
    if (!summary || !refId) return false;
    
    const placeholder = `<<${refId}>>`;
    const refIndex = summary.indexOf(placeholder);
    if (refIndex === -1) return false;
    
    // Look at the 80 characters before this reference
    const precedingText = summary.substring(Math.max(0, refIndex - 80), refIndex).toLowerCase();
    
    // Patterns that indicate back-reference (referring to previously mentioned group)
    // Note: \w+ matches ONE word, so "fem borgere" needs separate matching
    const backRefPatterns = [
      /de samme\s+[\wæøå]+\s+[\wæøå]+\s*$/,  // "De samme fem borgere"
      /de samme\s+[\wæøå]+\s*$/,              // "De samme borgere" (without number)
      /disse\s+[\wæøå]+\s+[\wæøå]+\s*$/,      // "Disse fem borgere"
      /disse\s+[\wæøå]+\s*$/,                 // "Disse borgere"
      /af disse\s*$/,                         // "Af disse"
      /samme\s+[\wæøå]+\s+borgere\s*$/,       // "samme tre borgere"
      /[\wæøå]+\s+af\s+disse\s*$/,            // "Tre af disse"
      /de\s+[\wæøå]+\s+borgere\s*$/           // "De tre borgere" (implicit back-ref if same count)
    ];
    
    for (const pattern of backRefPatterns) {
      if (pattern.test(precedingText)) {
        console.log(`[PositionWriter] 🔗 Detected back-reference for ${refId}: "${precedingText.slice(-40)}"`);
        return true;
      }
    }
    
    return false;
  }

  /**
   * PROGRAMMATIC QUOTE FILLING
   * Fills quotes programmatically based on strict rules:
   * - Groups with <=15 respondents: Each respondent gets exactly one quote
   * - Groups with >15 respondents: 5 representative quotes + respondent list
   * - Back-references ("De samme X borgere") do NOT get quotes (already shown)
   * - Single-respondent positions: Show quote only at first reference, skip silently for subsequent
   *
   * This replaces LLM quote generation to ensure consistent, rule-based output.
   *
   * @param {Object} hybridSummary - The hybrid output from LLM
   * @param {Object} writerInput - The input containing respondent data
   * @param {Object} positionContext - Optional context about the position being written
   * @param {string} positionContext.title - Position title (for relevance matching)
   * @param {string} positionContext.themeName - Theme name (for relevance matching)
   * @param {Array} positionContext.microSummaries - Full micro-summaries (for complete citation access)
   * @param {Map} positionContext.preSelectedQuoteMap - Pre-selected quotes from preSelectQuotesForPosition() (ensures LLM input matches output)
   */
  fillQuotesProgrammatically(hybridSummary, writerInput, positionContext = null) {
    if (!hybridSummary?.references || !Array.isArray(hybridSummary.references)) {
      return;
    }

    // Use pre-selected quote map if available (ensures LLM input matches displayed quotes)
    // Otherwise fall back to building quote map from writerInput (for sub-positions and mega-positions)
    const quoteMap = positionContext?.preSelectedQuoteMap && positionContext.preSelectedQuoteMap.size > 0
      ? positionContext.preSelectedQuoteMap
      : this.buildQuoteMap(writerInput.respondents, positionContext);
    
    // TRACK: Keep track of already-quoted respondents to avoid duplicates
    const quotedRespondents = new Set();
    
    // TRACK: Track which respondent groups have been fully quoted
    // Key: sorted respondents string, Value: reference ID that quoted them
    const quotedGroups = new Map();
    
    // DETECT: Is this a single-respondent position (entire position has only 1 unique respondent)?
    const allRespondentsInPosition = new Set();
    hybridSummary.references.forEach(ref => {
      (ref.respondents || []).forEach(r => allRespondentsInPosition.add(r));
    });
    const isSingleRespondentPosition = allRespondentsInPosition.size === 1;
    
    if (isSingleRespondentPosition) {
      console.log(`[PositionWriter] 👤 Single-respondent position detected - will show quote only at first reference`);
    }
    
    hybridSummary.references.forEach(ref => {
      const groupSize = ref.respondents?.length || 0;
      
      if (groupSize === 0) {
        // No respondents in this reference
        ref.quotes = [];
        return;
      }
      
      // CHECK: Is this a back-reference ("De samme X borgere")?
      // If so, skip quotes entirely - they were already shown in the previous reference
      const isBackRef = this.isBackReference(hybridSummary.summary, ref.id);
      if (isBackRef) {
        ref.quotes = []; // No quotes for back-references
        ref.skipCitationExtraction = true; // Prevent extract-citations from trying to fill
        ref.notes = ref.notes || 'Samme gruppe som ovenfor';
        console.log(`[PositionWriter] ⏩ Skipping quotes for ${ref.id} (back-reference to previous group)`);
        return;
      }
      
      // CHECK: Is this the same group of respondents as a previously quoted reference?
      const groupKey = [...ref.respondents].sort((a, b) => a - b).join(',');
      if (quotedGroups.has(groupKey)) {
        // Mark this reference for removal - the LLM should have used a pronoun instead
        // We'll remove it in post-processing so the text flows naturally
        ref.quotes = [];
        ref.skipCitationExtraction = true;
        ref.removeFromOutput = true; // Flag for output-formatter to remove this reference entirely
        // Don't add any notes - the reference will be removed
        console.log(`[PositionWriter] 🗑️ Marking ${ref.id} for removal (duplicate of ${quotedGroups.get(groupKey)})`);
        return;
      }
      
      if (groupSize <= 15) {
        // RULE: Each respondent gets a quote
        const newQuotes = [];
        
        ref.respondents.forEach(respNum => {
          const quote = quoteMap.get(respNum);
          
          if (quote) {
            // Always add quote even if respondent was quoted elsewhere - duplicates are acceptable
            // Include respondentName for proper formatting (use actual name, not "Henvendelse X")
            const respondent = writerInput.respondents?.find(r => r.responseNumber === respNum);
            const respondentName = respondent?.respondentName?.trim() || null;
            
            newQuotes.push({
              responseNumber: respNum,
              quote: quote,
              respondentName: respondentName // CRITICAL: Include name for output formatting
            });
            quotedRespondents.add(respNum);
          } else {
            // CRITICAL: Find a quote from writerInput as fallback - NEVER use placeholder
            const respondent = writerInput.respondents?.find(r => r.responseNumber === respNum);
            let fallbackQuote = null;
            
            if (respondent) {
              // Try citation registry first (most reliable source)
              if (this.citationRegistry && respondent.summary?.arguments?.[0]?.sourceQuoteRef) {
                const citationRef = respondent.summary.arguments[0].sourceQuoteRef;
                const citation = this.citationRegistry.getCitation(citationRef);
                if (citation?.quote) {
                  fallbackQuote = citation.quote;
                }
              }
              
              // Try other sources if citation registry didn't have it
              if (!fallbackQuote && respondent.excerpt && respondent.excerpt.trim()) {
                fallbackQuote = this.extractCompleteSentences(respondent.excerpt, 350);
              } 
              if (!fallbackQuote && respondent.snippets?.[0]?.text) {
                fallbackQuote = respondent.snippets[0].text;
              } 
              if (!fallbackQuote && respondent.summary?.arguments?.[0]?.sourceQuote) {
                fallbackQuote = respondent.summary.arguments[0].sourceQuote;
              }
              
              // Clean the fallback quote
              if (fallbackQuote) {
                fallbackQuote = this.cleanQuoteContent(fallbackQuote.trim());
              }
            }
            
            if (fallbackQuote && fallbackQuote.length > 10) {
              // Include respondentName for proper formatting (use actual name, not "Henvendelse X")
              const respondentName = respondent?.respondentName?.trim() || null;
              
              newQuotes.push({
                responseNumber: respNum,
                quote: fallbackQuote,
                respondentName: respondentName // CRITICAL: Include name for output formatting
              });
              quotedRespondents.add(respNum);
              console.log(`[PositionWriter] 🔧 Used fallback quote for respondent ${respNum}`);
            } else {
              // ABSOLUTE LAST RESORT: Log error but DON'T add placeholder
              console.error(`[PositionWriter] ❌ CRITICAL: No quote found for respondent ${respNum} - SKIPPING (no placeholder)`);
              // Don't add to quotes array - better to have no quote than a placeholder
            }
          }
        });
        
        ref.quotes = newQuotes;
        
        // Track this group as quoted
        if (newQuotes.length > 0) {
          quotedGroups.set(groupKey, ref.id);
        }
      } else {
        // RULE: >15 respondents = Include 5 representative quotes + respondent list
        // This ensures citation coverage for mega-positions while keeping output manageable
        const representativeQuotes = [];
        const MAX_REPRESENTATIVE_QUOTES = 5;

        // Select up to 5 respondents with quotes (evenly distributed across the group)
        const respondentsSorted = [...ref.respondents].sort((a, b) => a - b);
        const step = Math.max(1, Math.floor(respondentsSorted.length / MAX_REPRESENTATIVE_QUOTES));

        for (let i = 0; i < respondentsSorted.length && representativeQuotes.length < MAX_REPRESENTATIVE_QUOTES; i += step) {
          const respNum = respondentsSorted[i];
          const quote = quoteMap.get(respNum);

          if (quote) {
            const respondent = writerInput.respondents?.find(r => r.responseNumber === respNum);
            const respondentName = respondent?.respondentName?.trim() || null;

            representativeQuotes.push({
              responseNumber: respNum,
              quote: quote,
              respondentName: respondentName
            });
            quotedRespondents.add(respNum);
          }
        }

        ref.quotes = representativeQuotes;

        // Ensure notes field has the full respondent list (compressed format)
        if (!ref.notes) {
          ref.notes = `Alle ${groupSize} svarnumre: ${OutputFormatter.compressNumberRange(ref.respondents)}`;
        }

        console.log(`[PositionWriter] Large group (${groupSize} respondents) in REF ${ref.id}: included ${representativeQuotes.length} representative quotes + full list`);
      }
    });
    
    console.log(`[PositionWriter] ✓ Programmatically filled quotes for ${hybridSummary.references.length} references (${quotedRespondents.size} unique respondents)`);
  }

  /**
   * Validate coherence between summary text and quotes using reranker.
   * Detects potential hallucinations where summary content doesn't match quotes.
   * Now also FILTERS incoherent quotes to prevent mismatched citations.
   * 
   * IMPORTANT: Also removes incoherent respondents from writerInput to prevent
   * validation failures and unnecessary retries. This is an optimization to avoid
   * wasting LLM calls on respondents that can never be validly cited.
   * 
   * @param {Object} hybridSummary - The hybrid output with summary and references
   * @param {Object} writerInput - The input containing respondent data (MUTATED to remove incoherent respondents)
   * @returns {Promise<void>} Filters incoherent quotes and adds warnings
   */
  async validateSummaryQuoteCoherence(hybridSummary, writerInput) {
    if (!hybridSummary?.summary || !hybridSummary?.references?.length) {
      return;
    }
    
    const reranker = this._getReranker();
    if (!reranker) {
      console.warn('[PositionWriter] Reranker not available for coherence validation');
      return;
    }
    
    const incoherenceWarnings = [];
    const allIncoherentRespondents = []; // Track ALL incoherent respondents across refs
    const COHERENCE_THRESHOLD = 0.12; // Below this score, quote doesn't support summary
    
    for (const ref of hybridSummary.references) {
      if (!ref.quotes?.length) continue;
      
      // Extract the summary segment that precedes this reference
      let summarySegment = this.extractSummarySegmentForRef(hybridSummary.summary, ref.id);
      
      // FIX: Use position title as fallback when segment is just a respondent name or too short
      // This prevents false "incoherent" detection when summary format is "RespondentName <<REF_1>>"
      const posTitle = writerInput?.position?.title || '';
      const segmentIsJustName = summarySegment && 
        (summarySegment.length < 50 || !summarySegment.includes(' ') || 
         /^[A-ZÆØÅ][a-zæøå\-\s]+$/.test(summarySegment.trim()));
      
      if (segmentIsJustName && posTitle) {
        // Use position title for coherence check - it's more semantically meaningful
        summarySegment = posTitle;
      }
      
      
      if (!summarySegment || summarySegment.length < 20) continue;
      
      // Check coherence for each quote and filter incoherent ones
      const coherentQuotes = [];
      const incoherentRespondents = [];
      
      for (const quoteObj of ref.quotes) {
        if (!quoteObj.quote || quoteObj.quote.includes('[Citat ikke tilgængeligt]')) {
          coherentQuotes.push(quoteObj); // Keep quotes we can't validate
          continue;
        }
        
        try {
          // Use reranker to score how well the quote matches the summary segment
          const chunks = [{ content: quoteObj.quote }];
          const results = await reranker.rerank(summarySegment, chunks);
          
          if (results.length > 0) {
            // CRITICAL FIX: Only filter if rerankScore is explicitly set and valid
            // If rerankScore is undefined/0 (reranker timeout/failure), keep the quote
            // This prevents false filtering when reranker times out under load
            const rerankScore = results[0].rerankScore;
            const hasValidScore = typeof rerankScore === 'number' && !isNaN(rerankScore) && rerankScore > 0;
            
            if (!hasValidScore) {
              // Reranker failed/timed out - keep the quote (trust keyword-based selection)
              coherentQuotes.push(quoteObj);
              continue;
            }
            
            // If score is very low, the quote doesn't support the summary claim
            if (rerankScore < COHERENCE_THRESHOLD) {
              const warning = `Filtreret: Citat fra henvendelse ${quoteObj.responseNumber} støtter ikke påstanden (score: ${rerankScore.toFixed(3)})`;
              incoherenceWarnings.push(warning);
              incoherentRespondents.push(quoteObj.responseNumber);
              allIncoherentRespondents.push(quoteObj.responseNumber);
              console.warn(`[PositionWriter] ⚠️ INCOHERENT (FILTERED): ${warning}`);
              console.warn(`[PositionWriter]   Summary: "${summarySegment.substring(0, 80)}..."`);
              console.warn(`[PositionWriter]   Quote: "${quoteObj.quote.substring(0, 80)}..."`);
              // Don't add to coherentQuotes - this quote will be filtered out
            } else {
              coherentQuotes.push(quoteObj);
            }
          } else {
            coherentQuotes.push(quoteObj); // Keep if reranker returned no results
          }
        } catch (error) {
          console.warn(`[PositionWriter] Coherence check failed for response ${quoteObj.responseNumber}: ${error.message}`);
          coherentQuotes.push(quoteObj); // Keep on error
        }
      }
      
      // Update reference with only coherent quotes
      if (incoherentRespondents.length > 0) {
        console.log(`[PositionWriter] 🔧 Filtered ${incoherentRespondents.length} incoherent quotes from ${ref.id}: [${incoherentRespondents.join(', ')}]`);
        ref.quotes = coherentQuotes;
        
        // Also remove incoherent respondents from the respondents array
        // This ensures the count matches the actual cited respondents
        ref.respondents = ref.respondents.filter(r => !incoherentRespondents.includes(r));
        
        // Update label to reflect new count
        const newCount = ref.respondents.length;
        if (newCount !== parseInt(ref.label?.match(/\d+/)?.[0])) {
          const oldLabel = ref.label;
          ref.label = this.formatDanishCount(newCount);
          console.log(`[PositionWriter] 🔧 Updated label: "${oldLabel}" → "${ref.label}"`);
        }
      }
    }
    
    // NOTE: We no longer remove "incoherent" respondents from writerInput.respondents
    // This was causing valid respondents to be incorrectly removed when the reranker
    // gave low scores. Instead, we only filter quotes but keep the respondents.
    // The pre-filter in writePositions handles removal of genuinely irrelevant respondents
    // (those with "ingen bemærkninger" patterns).
    
    // Add all incoherence warnings to the output
    if (incoherenceWarnings.length > 0) {
      if (!hybridSummary.warnings) hybridSummary.warnings = [];
      hybridSummary.warnings.push(...incoherenceWarnings);
    }
  }
  
  /**
   * Format a count as Danish text (én, to, tre, etc.)
   * @param {number} count - The count to format
   * @returns {string} Danish formatted count with "borger"/"borgere"
   * @private
   */
  formatDanishCount(count) {
    const danishNumbers = ['', 'én borger', 'to borgere', 'tre borgere', 'fire borgere', 
      'fem borgere', 'seks borgere', 'syv borgere', 'otte borgere', 'ni borgere', 
      'ti borgere', 'elleve borgere', 'tolv borgere'];
    
    if (count >= 1 && count <= 12) {
      return danishNumbers[count];
    }
    return `${count} borgere`;
  }

  /**
   * Extract the summary segment that corresponds to a specific reference.
   * Finds the text preceding the <<REF_X>> placeholder.
   * 
   * @param {string} summary - Full summary text
   * @param {string} refId - Reference ID (e.g., "REF_1")
   * @returns {string} The relevant summary segment
   * @private
   */
  extractSummarySegmentForRef(summary, refId) {
    if (!summary || !refId) return '';
    
    const placeholder = `<<${refId}>>`;
    const refIndex = summary.indexOf(placeholder);
    
    if (refIndex === -1) return '';
    
    // Find the sentence(s) preceding this reference
    // Look back from the reference to find sentence boundaries
    let startIndex = 0;
    
    // Find the previous reference or start of text
    const prevRefMatch = summary.substring(0, refIndex).match(/<<REF_\d+>>/g);
    if (prevRefMatch && prevRefMatch.length > 0) {
      const lastPrevRef = prevRefMatch[prevRefMatch.length - 1];
      const lastPrevRefIndex = summary.lastIndexOf(lastPrevRef, refIndex - 1);
      if (lastPrevRefIndex !== -1) {
        startIndex = lastPrevRefIndex + lastPrevRef.length;
      }
    }
    
    // Also try to find the start of the current sentence
    const sentenceStart = summary.substring(0, refIndex).lastIndexOf('. ');
    if (sentenceStart > startIndex) {
      startIndex = sentenceStart + 2;
    }
    
    return summary.substring(startIndex, refIndex).trim();
  }

  /**
   * Get or create the OpenAIReranker instance for semantic quote selection.
   * Uses OpenAI embeddings + cosine similarity for excellent Danish support.
   * Lazy-initialized to avoid overhead when reranking isn't needed.
   * @private
   */
  _getReranker() {
    if (!this._reranker) {
      this._reranker = new OpenAIReranker({ enabled: true });
    }
    return this._reranker;
  }

  /**
   * PRE-FILTER: Remove irrelevant respondents BEFORE generating output.
   * Uses pattern matching to detect "ingen bemærkninger" type responses.
   * Only filters based on text patterns, NOT reranker scores (to avoid timeout issues).
   * 
   * This prevents situations where respondents are incorrectly assigned to positions
   * in upstream steps (aggregate/consolidate) from polluting the final output.
   * 
   * @param {Object} writerInput - The input containing respondents
   * @param {Object} position - The position being written
   * @returns {Promise<Object>} Updated writerInput with irrelevant respondents removed
   */
  async preFilterIrrelevantRespondents(writerInput, position) {
    if (!writerInput?.respondents?.length || writerInput.respondents.length <= 1) {
      return writerInput; // Don't filter if only one respondent
    }

    const positionTitle = position?.title || '';
    if (!positionTitle) {
      return writerInput;
    }

    const relevantRespondents = [];
    const filteredRespondents = [];

    for (const respondent of writerInput.respondents) {
      // Get content to check - use excerpt or first snippet
      const content = respondent.excerpt || respondent.snippets?.[0]?.text || '';
      
      if (!content || content.length < 20) {
        // Keep respondents we can't evaluate
        relevantRespondents.push(respondent);
        continue;
      }

      // Pattern-based filtering: Only filter obvious "no comment" responses
      const lowerContent = content.toLowerCase();
      const isNoComment = (
        // Explicit "no comment" patterns
        lowerContent.includes('ingen bemærkninger') ||
        lowerContent.includes('ingen kommentarer') ||
        lowerContent.includes('har ikke bemærkninger') ||
        lowerContent.includes('ikke anledning til bemærkninger') ||
        lowerContent.includes('ikke anledning til kommentarer') ||
        // Formal "no objection" patterns (including longer formal responses)
        lowerContent.includes('ikke, at der er anledning til kommentarer') ||
        lowerContent.includes('ikke at der er anledning til kommentarer') ||
        // Short formal acknowledgments
        (lowerContent.includes('ikke anledning til') && content.length < 800) ||
        // Check for responses that are just acknowledgments
        (content.length < 300 && (
          lowerContent.includes('tager til efterretning') ||
          lowerContent.includes('har noteret')
        ))
      );
      
      if (isNoComment) {
        filteredRespondents.push({
          responseNumber: respondent.responseNumber,
          reason: 'no-comment-pattern',
          contentPreview: content.substring(0, 100)
        });
        continue; // Skip this respondent
      }
      
      relevantRespondents.push(respondent);
    }

    // Log and apply filtering
    if (filteredRespondents.length > 0) {
      const filteredIds = filteredRespondents.map(f => f.responseNumber);
      console.log(`[PositionWriter] 🔍 Pre-filter removed ${filteredRespondents.length} "no comment" respondent(s) for "${positionTitle.substring(0, 50)}..."`);
      filteredRespondents.forEach(f => {
        console.log(`[PositionWriter]    → Removed respondent ${f.responseNumber} (${f.reason}): "${f.contentPreview.substring(0, 60)}..."`);
      });
      
      // Update writerInput with only relevant respondents
      return {
        ...writerInput,
        respondents: relevantRespondents,
        _filteredRespondents: filteredIds // Track for debugging
      };
    }

    return writerInput;
  }

  /**
   * Find the best quote for a respondent using BGE reranker.
   * Uses cross-encoder to score candidate quotes against the position title
   * and returns the most relevant one.
   * 
   * @param {Object} respondent - Respondent object with snippets/excerpt
   * @param {string} positionTitle - The position title to match against
   * @returns {Promise<string|null>} Best quote or null if none found
   */
  async findBestQuoteForRespondent(respondent, positionTitle) {
    if (!positionTitle || !respondent) {
      return null;
    }

    // Collect candidate quotes from various sources
    const candidates = [];
    
    // Source 1: Snippet texts
    if (respondent.snippets && Array.isArray(respondent.snippets)) {
      respondent.snippets.forEach(s => {
        if (s.text && s.text.trim()) {
          candidates.push(s.text.trim());
        }
      });
    }
    
    // Source 2: sourceQuote from micro-summary arguments
    if (respondent.summary?.arguments) {
      respondent.summary.arguments.forEach(arg => {
        if (arg.sourceQuote && arg.sourceQuote.trim()) {
          candidates.push(arg.sourceQuote.trim());
        }
      });
    }
    
    // Source 3: Sentences from excerpt
    if (respondent.excerpt) {
      const sentences = respondent.excerpt.match(/[^.!?]+[.!?]+/g) || [];
      // Take first 5 sentences as candidates
      sentences.slice(0, 5).forEach(s => {
        const trimmed = s.trim();
        if (trimmed.length > 20) { // Skip very short sentences
          candidates.push(trimmed);
        }
      });
    }
    
    // Deduplicate candidates
    const uniqueCandidates = [...new Set(candidates)];
    
    if (uniqueCandidates.length === 0) {
      return null;
    }
    
    // If only one candidate, return it directly
    if (uniqueCandidates.length === 1) {
      return uniqueCandidates[0];
    }
    
    // Use reranker to find best match
    try {
      const reranker = this._getReranker();
      const chunks = uniqueCandidates.map(content => ({ content }));
      const ranked = await reranker.rerank(positionTitle, chunks);
      
      // Sort by rerank score (descending)
      ranked.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));
      
      // Return the highest-scoring candidate
      const best = ranked[0];
      if (best && best.chunk?.content) {
        return best.chunk.content;
      }
      
      // Fallback to first candidate if reranking didn't produce valid results
      return uniqueCandidates[0];
      
    } catch (error) {
      // If reranker fails, fall back to priority-based selection
      console.warn(`[PositionWriter] Reranker failed for respondent ${respondent.responseNumber}, using fallback: ${error.message}`);
      return uniqueCandidates[0];
    }
  }

  /**
   * Build quote map with reranker-enhanced quote selection.
   * For each respondent, uses the reranker to find the most relevant quote
   * based on a given position title.
   * 
   * @param {Array} respondents - Array of respondent objects
   * @param {string} positionTitle - Position title to match quotes against
   * @returns {Promise<Map<number, string>>} Map of response numbers to best quotes
   */
  async buildQuoteMapWithReranker(respondents, positionTitle) {
    const map = new Map();
    
    if (!respondents || !Array.isArray(respondents) || !positionTitle) {
      return map;
    }
    
    // Process respondents in parallel with concurrency limit
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < respondents.length; i += BATCH_SIZE) {
      const batch = respondents.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (r) => {
        if (!r.responseNumber) return;
        
        const bestQuote = await this.findBestQuoteForRespondent(r, positionTitle);
        if (bestQuote) {
          map.set(r.responseNumber, bestQuote);
        }
      }));
    }
    
    return map;
  }

  /**
   * Fix forbidden summary starts like "Positionen beskriver...", "Dette synspunkt...".
   * These abstract labels are unacceptable - summaries should use human subjects.
   * 
   * @param {Object} hybridSummary - The hybrid output with summary field
   */
  fixForbiddenSummaryStarts(hybridSummary) {
    if (!hybridSummary?.summary || typeof hybridSummary.summary !== 'string') {
      return;
    }

    const originalSummary = hybridSummary.summary;

    // Patterns for forbidden abstract starts
    const forbiddenPatterns = [
      // "Positionen beskriver/indeholder/omhandler/omfatter..."
      /^Positionen\s+(beskriver|indeholder|omhandler|omfatter|handler\s+om|drejer\s+sig\s+om)[^.]*\.\s*/i,
      // "Dette synspunkt/holdning/emne..."
      /^Dette\s+(synspunkt|holdning|emne|punkt)[^.]*\.\s*/i,
      // "Holdningen beskriver/handler..."
      /^Holdningen\s+(beskriver|handler|omhandler|indeholder)[^.]*\.\s*/i,
      // "Denne position..."
      /^Denne\s+position[^.]*\.\s*/i,
      // "I denne holdning..."
      /^I\s+denne\s+(holdning|position)[^.]*\.\s*/i,
    ];

    let modified = false;

    forbiddenPatterns.forEach(pattern => {
      if (pattern.test(hybridSummary.summary)) {
        hybridSummary.summary = hybridSummary.summary.replace(pattern, '').trim();
        modified = true;
      }
    });

    // If we modified the summary, ensure it starts with capital letter
    if (modified && hybridSummary.summary) {
      // Capitalize first letter if it's lowercase Danish letter
      if (/^[a-zæøå]/.test(hybridSummary.summary)) {
        hybridSummary.summary = hybridSummary.summary.charAt(0).toUpperCase() + hybridSummary.summary.slice(1);
      }

      // Add warning for audit trail
      if (!hybridSummary.warnings) hybridSummary.warnings = [];
      hybridSummary.warnings.push('Auto-removed forbidden summary start ("Positionen beskriver..." or similar)');

      console.log(`[PositionWriter] ✓ Fixed forbidden summary start: "${originalSummary.substring(0, 50)}..." → "${hybridSummary.summary.substring(0, 50)}..."`);
    }
  }

  /**
   * Safety-net: Remove literal [TILBAGEHENVISNING:] placeholders from LLM output.
   * These are example annotations in the prompt that shouldn't appear in output.
   * 
   * @param {Object} hybridSummary - The hybrid output with summary field
   */
  cleanTilbagehenvisningPlaceholders(hybridSummary) {
    if (!hybridSummary?.summary || typeof hybridSummary.summary !== 'string') {
      return;
    }

    // Pattern matches [TILBAGEHENVISNING:] with any spacing/case variations
    const pattern = /\[TILBAGEHENVISNING:\]\s*/gi;
    
    if (pattern.test(hybridSummary.summary)) {
      const originalSummary = hybridSummary.summary;
      hybridSummary.summary = hybridSummary.summary.replace(pattern, '').trim();
      
      // Clean up any double spaces that might result
      hybridSummary.summary = hybridSummary.summary.replace(/\s{2,}/g, ' ');
      
      // Add warning for audit trail
      if (!hybridSummary.warnings) hybridSummary.warnings = [];
      hybridSummary.warnings.push('Auto-removed literal [TILBAGEHENVISNING:] placeholders');
      
      console.log(`[PositionWriter] ⚠️ Cleaned [TILBAGEHENVISNING:] placeholders from summary`);
    }
  }

  /**
   * Deterministic grammar safety-net:
   * Fixes patterns where an actor-subject is incorrectly combined with passive (-s) verb.
   *
   * Examples (FORBUDT):
   * - "Én borger<<REF_1>> fremhæves ..."
   * - "to borgere<<REF_2>> udtrykkes ..."
   *
   * Rewrites to active form:
   * - "Én borger<<REF_1>> fremhæver ..."
   * - "to borgere<<REF_2>> udtrykker ..."
   *
   * @param {Object} hybridSummary
   */
  fixActorSubjectPassiveVerbs(hybridSummary) {
    if (!hybridSummary?.summary || typeof hybridSummary.summary !== 'string') {
      return;
    }

    const map = {
      udtrykkes: 'udtrykker',
      fremhæves: 'fremhæver',
      anføres: 'anfører',
      påpeges: 'påpeger',
      vurderes: 'vurderer',
      kritiseres: 'kritiserer',
      foreslås: 'foreslår',
      bemærkes: 'bemærker',
      gøres: 'gør',
      skønnes: 'skønner',
      peges: 'peger'
    };

    // IMPORTANT: Do NOT use \b for Danish letters like "én" (é is not \w in JS),
    // otherwise we miss exactly the patterns we want to fix.
    const pattern = /(^|[^\p{L}\p{N}_])((?:én|Én|to|To|tre|Tre|fire|Fire|fem|Fem|seks|Seks|syv|Syv|otte|Otte|ni|Ni|ti|Ti|elleve|Elleve|tolv|Tolv|\d+)\s+borgere?\s*<<REF_\d+>>\s+)(udtrykkes|fremhæves|anføres|påpeges|vurderes|kritiseres|foreslås|bemærkes|gøres|skønnes|peges)\b/gu;

    const before = hybridSummary.summary;
    const after = before.replace(pattern, (match, boundary, prefix, verb) => {
      const replacement = map[String(verb).toLowerCase()] || verb;
      const cased = (verb[0] && verb[0] === verb[0].toUpperCase())
        ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
        : replacement;
      return `${boundary}${prefix}${cased}`;
    });

    if (after !== before) {
      hybridSummary.summary = after;
      if (!hybridSummary.warnings) hybridSummary.warnings = [];
      hybridSummary.warnings.push('Auto-fixed grammar: actor-subject + passive (-s) verb');
      console.log('[PositionWriter] ✓ Auto-fixed actor-subject passive (-s) verb in summary');
    }
  }

  /**
   * MEGA-POSITION SAFETY NET:
   * When sub-positions are present, enforce a consistent master-holdning:
   * - summary starts with "Der<<REF_1>>"
   * - REF_1.label === "Der"
   * - REF_1.respondents covers ALL respondents in the position
   *
   * This is applied deterministically to avoid confusing mismatches like:
   * title says "(1200 respondenter)" but the first sentence says "116 borgere".
   *
   * @param {Object} hybridSummary
   * @param {Object} writerInput
   */
  enforceMegaPositionMasterReference(hybridSummary, writerInput) {
    if (!hybridSummary || typeof hybridSummary !== 'object') return;
    if (typeof hybridSummary.summary !== 'string' || !hybridSummary.summary.trim()) return;

    const hasSubPositions =
      !!(writerInput?.position?.subPositionsRequired) ||
      (Array.isArray(writerInput?.position?.subPositions) && writerInput.position.subPositions.length > 0);
    if (!hasSubPositions) return;

    // Build expected respondent list (post pre-filtering)
    const expected = (writerInput?.respondents || [])
      .map(r => r?.responseNumber)
      .filter(Boolean)
      .map(n => parseInt(n, 10))
      .filter(n => Number.isFinite(n))
      .sort((a, b) => a - b);

    if (expected.length === 0) return;

    // Ensure references array exists
    if (!Array.isArray(hybridSummary.references)) {
      hybridSummary.references = [];
    }

    // Ensure REF_1 exists
    let ref1 = hybridSummary.references.find(r => r && r.id === 'REF_1');
    if (!ref1) {
      ref1 = { id: 'REF_1', label: 'Der', respondents: [], quotes: [], notes: '' };
      hybridSummary.references.unshift(ref1);
      if (!hybridSummary.warnings) hybridSummary.warnings = [];
      hybridSummary.warnings.push('Auto-fixed mega-position: created missing REF_1 master reference');
    }

    // Enforce label and respondent coverage
    ref1.label = 'Der';
    ref1.respondents = expected;

    // Ensure summary starts with Der<<REF_1>>
    if (!/^\s*Der<<REF_1>>(?:\s|$)/.test(hybridSummary.summary)) {
      // Common failure mode: "116 borgere<<REF_1>> ..." or "der <<REF_1>> ..."
      // Replace any leading label before the first <<REF_1>> with "Der".
      const before = hybridSummary.summary;

      // ENHANCED: Specific detection for number-start patterns (e.g., "116 borgere<<REF_1>>")
      const numberStartPattern = /^\s*\d+\s+borgere?<<REF_1>>/i;
      if (numberStartPattern.test(before)) {
        console.warn('[PositionWriter] ⚠️ Master-holdning started with number - converting to "Der"');
        hybridSummary.summary = before.replace(/^\s*\d+\s+borgere?<<(REF_1>>)/i, 'Der<<$1');
        if (!hybridSummary.warnings) hybridSummary.warnings = [];
        hybridSummary.warnings.push('Auto-fixed mega-position: converted number-start to "Der<<REF_1>>"');
      } else {
        // General case: replace any leading label before <<REF_1>> with "Der"
        const rewritten = before.replace(/^(\s*)(?:[^\n<]{0,80}?)(<<REF_1>>)/, '$1Der$2');

        if (rewritten !== before && /^\s*Der<<REF_1>>/.test(rewritten)) {
          hybridSummary.summary = rewritten;
          if (!hybridSummary.warnings) hybridSummary.warnings = [];
          hybridSummary.warnings.push('Auto-fixed mega-position: enforced master start "Der<<REF_1>>"');
        } else {
          // If we can't safely rewrite, let validation+retry handle it.
          if (!hybridSummary.warnings) hybridSummary.warnings = [];
          hybridSummary.warnings.push('Mega-position: could not deterministically enforce "Der<<REF_1>>" start (will rely on retry/validation)');
        }
      }
    }
  }

  /**
   * Set labels PROGRAMMATICALLY from data. LLM-generated labels are IGNORED.
   * 
   * Labels are built from respondentLabel/respondentName in writerInput:
   * - Named entities use their actual name: "Børne- og Ungdomsforvaltningen"
   * - Citizens are counted: "tre borgere"
   * - Mixed groups combine both: "Brug Folkeskolen og to borgere"
   * 
   * @param {Object} hybridSummary - The hybrid output with references array
   * @param {Object} writerInput - The input containing respondent data with names/types
   */
  setLabelsProgrammatically(hybridSummary, writerInput) {
    if (!hybridSummary?.references || !Array.isArray(hybridSummary.references)) {
      return;
    }
    if (!writerInput?.respondents || !Array.isArray(writerInput.respondents)) {
      return;
    }

    // Build a map of responseNumber -> respondent data for quick lookup
    const respondentMap = new Map();
    writerInput.respondents.forEach(r => {
      if (r.responseNumber) {
        respondentMap.set(r.responseNumber, r);
      }
    });

    hybridSummary.references.forEach(ref => {
      if (!ref.respondents || ref.respondents.length === 0) {
        return;
      }

      const llmLabel = ref.label; // Save for logging

      // CRITICAL: Preserve "Der" for master-holdning when sub-positions are present.
      // The stitch-prompt requires REF_1.label === "Der" and summary to start with "Der<<REF_1>>".
      // We must NOT override that with a computed label like "1198 borgere".
      const hasSubPositions =
        !!(writerInput?.position?.subPositionsRequired) ||
        (Array.isArray(writerInput?.position?.subPositions) && writerInput.position.subPositions.length > 0);
      const isMasterRef = hasSubPositions && ref.id === 'REF_1';
      const summaryStartsWithDerRef1 = typeof hybridSummary.summary === 'string' && /^\s*Der<<REF_1>>(?:\s|$)/.test(hybridSummary.summary);
      const labelIsDer = (String(ref.label || '').trim().toLowerCase() === 'der') || (String(llmLabel || '').trim().toLowerCase() === 'der');

      if (isMasterRef && (labelIsDer || summaryStartsWithDerRef1)) {
        ref.label = 'Der';
        return; // Skip programmatic label rewriting for REF_1 master reference
      }
      
      // Categorize respondents into named entities and citizens
      const namedEntities = [];
      const citizens = [];

      ref.respondents.forEach(responseNumber => {
        let respondent = respondentMap.get(responseNumber);
        
        // CRITICAL FALLBACK: If respondent not in writerInput.respondents (e.g., not in diversity sample),
        // look up from rawResponses to ensure named entities are correctly identified
        if (!respondent && this._rawResponsesMap) {
          const rawResp = this._rawResponsesMap.get(responseNumber);
          if (rawResp) {
            respondent = {
              responseNumber,
              respondentName: rawResp.respondentName,
              respondentType: rawResp.respondentType,
              respondentLabel: this.buildRespondentLabel(rawResp)
            };
          }
        }
        
        if (!respondent) {
          citizens.push(responseNumber); // Unknown = assume citizen
          return;
        }

        // Use respondentLabel first (already processed), fallback to respondentName
        const label = respondent.respondentLabel?.trim() || respondent.respondentName?.trim();
        
        // If label is "Borger" or empty, it's a citizen
        // Otherwise it's a named entity (organization, authority, etc.)
        const isCitizen = !label || label.toLowerCase() === 'borger';

        if (isCitizen) {
          citizens.push(responseNumber);
        } else {
          namedEntities.push({
            responseNumber,
            name: label
          });
        }
      });

      // Build the programmatic label
      const newLabel = this.buildLabelFromData(namedEntities, citizens.length);
      
      // Always set the label from data
      ref.label = newLabel;

      // Also update the summary text to replace LLM-generated label with correct one
      if (hybridSummary.summary && llmLabel && llmLabel !== newLabel) {
        const refPlaceholder = `<<${ref.id}>>`;
        const escapedPlaceholder = this.escapeRegex(refPlaceholder);
        
        // Replace ANY text before the placeholder that looks like a label
        // This catches: "BUF, en myndighed<<REF_1>>", "tre borgere<<REF_2>>", etc.
        const labelBeforeRefPattern = new RegExp(
          `[^.!?;\\n]*?(${escapedPlaceholder})`,
          'g'
        );
        
        // Find all occurrences and replace the label part
        hybridSummary.summary = hybridSummary.summary.replace(
          new RegExp(`([A-ZÆØÅ][^<]*|(?:en|én|to|tre|fire|fem|seks|syv|otte|ni|ti|\\d+)\\s+(?:borger|borgere|myndighed|myndigheder|organisation|organisationer|lokaludvalg)[^<]*)(${escapedPlaceholder})`, 'gi'),
          (match, labelPart, placeholder) => {
            // Only replace if the label part ends right before the placeholder
            // and looks like it's the subject introducing the reference
            const trimmed = labelPart.trim();
            if (trimmed.length < 100) { // Reasonable label length
              return `${newLabel}${placeholder}`;
            }
            return match; // Don't replace if it's part of a longer sentence
          }
        );
        
        console.log(`[PositionWriter] 🏷️ Label from data: "${newLabel}" (LLM had: "${llmLabel}")`);
      }
      
      // CLEANUP: Remove duplicate parenthetical references AFTER <<REF_X>>
      // LLM sometimes generates: "Brug Folkeskolen<<REF_1>> (Brug Folkeskolen) kræver..."
      // The parenthetical duplicate should be removed
      if (hybridSummary.summary) {
        const refPlaceholder = `<<${ref.id}>>`;
        const escapedPlaceholder = this.escapeRegex(refPlaceholder);
        
        // Pattern: <<REF_X>> followed by space and (same-label-text)
        // Match: <<REF_1>> (Brug Folkeskolen) -> <<REF_1>>
        const escapedLabel = this.escapeRegex(newLabel);
        const duplicatePattern = new RegExp(
          `(${escapedPlaceholder})\\s*\\(${escapedLabel}\\)`,
          'gi'
        );
        
        const beforeCleanup = hybridSummary.summary;
        hybridSummary.summary = hybridSummary.summary.replace(duplicatePattern, '$1');
        
        if (beforeCleanup !== hybridSummary.summary) {
          console.log(`[PositionWriter] 🧹 Removed duplicate parenthetical: "(${newLabel})" after ${ref.id}`);
        }
      }
    });

    // SECOND PASS: Deduplicate identical labels within the same position.
    // After the first pass, two refs with 462 citizens both get "462 borgere".
    // This pass varies duplicates: "462 borgere", "Andre 462 borgere", "Yderligere 462 borgere".
    this.deduplicateLabels(hybridSummary);
  }

  /**
   * Deduplicate identical labels within a hybridSummary.
   * Groups refs by normalized label, then varies 2nd+ occurrences using
   * DanishNumberFormatter.getSequentialLabel().
   * Also updates the summary text to match the new labels.
   *
   * @param {Object} hybridSummary - The hybrid output with references and summary
   */
  deduplicateLabels(hybridSummary) {
    if (!hybridSummary?.references || !hybridSummary.summary) return;

    // Build map: normalizedLabel → [{ref, summaryPosition}]
    const labelGroups = new Map();
    for (const ref of hybridSummary.references) {
      // Skip "Der" master-refs
      if (String(ref.label || '').trim().toLowerCase() === 'der') continue;

      const normalized = DanishNumberFormatter.normalizeLabel(ref.label);
      if (!labelGroups.has(normalized)) {
        labelGroups.set(normalized, []);
      }
      // Record position in summary for ordering
      const refPlaceholder = `<<${ref.id}>>`;
      const pos = hybridSummary.summary.indexOf(refPlaceholder);
      labelGroups.get(normalized).push({ ref, summaryPosition: pos >= 0 ? pos : Infinity });
    }

    // For each group with duplicates, vary the labels
    for (const [, group] of labelGroups) {
      if (group.length <= 1) continue;

      // Sort by position in summary text (first appearance stays unchanged)
      group.sort((a, b) => a.summaryPosition - b.summaryPosition);

      for (let i = 1; i < group.length; i++) {
        const { ref } = group[i];
        const oldLabel = ref.label;
        const newLabel = DanishNumberFormatter.getSequentialLabel(oldLabel, i + 1);

        if (newLabel === oldLabel) continue;

        // Update the reference label
        ref.label = newLabel;

        // Update the summary text: replace label immediately before this ref's placeholder
        const refPlaceholder = `<<${ref.id}>>`;
        const escapedPlaceholder = this.escapeRegex(refPlaceholder);
        const escapedOldLabel = this.escapeRegex(oldLabel);

        // Match the old label directly before this specific ref placeholder
        const pattern = new RegExp(`${escapedOldLabel}(\\s*${escapedPlaceholder})`, 'g');
        const before = hybridSummary.summary;
        hybridSummary.summary = hybridSummary.summary.replace(pattern, `${newLabel}$1`);

        if (before !== hybridSummary.summary) {
          console.log(`[PositionWriter] 🔄 Label dedup: "${oldLabel}" → "${newLabel}" for ${ref.id}`);
        }
      }
    }
  }

  /**
   * Validate and auto-fix label/respondent count mismatches.
   *
   * This is a safety net that catches cases where setLabelsProgrammatically() failed
   * to properly update a label, or where the label count doesn't match the actual
   * number of respondents.
   *
   * Example: Label says "tre borgere" but ref.respondents has 8 items → fix to "otte borgere"
   *
   * @param {Object} hybridSummary - The hybrid output with references array
   */
  validateLabelRespondentCounts(hybridSummary) {
    if (!hybridSummary?.references || !Array.isArray(hybridSummary.references)) {
      return;
    }

    const numberWords = {
      'en': 1, 'én': 1, 'et': 1,
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

    for (const ref of hybridSummary.references) {
      // Skip refs without respondents or with "Der" label (master-position)
      if (!ref.respondents || ref.respondents.length === 0) continue;
      if (ref.label && ref.label.toLowerCase() === 'der') continue;

      const actualCount = ref.respondents.length;
      const label = ref.label || '';

      // Check if label starts with a number word or digit
      const labelMatch = label.match(/^(én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)\s+(borger|borgere)/i);

      if (labelMatch) {
        // Parse the count from the label
        const labelNumberStr = labelMatch[1].toLowerCase();
        const labelCount = numberWords[labelNumberStr] || parseInt(labelNumberStr, 10) || 0;

        if (labelCount > 0 && labelCount !== actualCount) {
          // Mismatch detected! Auto-fix the label
          const oldLabel = ref.label;
          ref.label = DanishNumberFormatter.formatWithNoun(actualCount, 'borger');
          console.warn(`[PositionWriter] ⚠️ Label/respondent mismatch AUTO-FIXED: "${oldLabel}" → "${ref.label}" (had ${labelCount}, actual ${actualCount})`);
        }
      }
    }
  }

  /**
   * Build label from categorized respondent data.
   *
   * Examples:
   * - 1 named, 0 citizens: "Børne- og Ungdomsforvaltningen"
   * - 2 named, 0 citizens: "Københavns Museum og Metroselskabet"
   * - 0 named, 3 citizens: "tre borgere"
   * - 1 named, 2 citizens: "Brug Folkeskolen og to borgere"
   * - 2 named, 1 citizen: "Valby Lokaludvalg, Børne- og Ungdomsforvaltningen og én borger"
   * - 3 named, 0 citizens: "A, B og C"
   * 
   * @param {Array} namedEntities - Array of {name, responseNumber}
   * @param {number} citizenCount - Number of regular citizens
   * @returns {string} Combined label
   * @private
   */
  buildLabelFromData(namedEntities, citizenCount) {
    const names = namedEntities.map(e => e.name);
    const citizenLabel = citizenCount > 0
      ? DanishNumberFormatter.formatWithNoun(citizenCount, 'borger')
      : null;

    // Combine all parts into one list for proper Danish formatting
    const allParts = [...names];
    if (citizenLabel) {
      allParts.push(citizenLabel);
    }

    // Format as Danish list: "A", "A og B", "A, B og C"
    if (allParts.length === 0) {
      return 'ukendt';
    } else if (allParts.length === 1) {
      return allParts[0];
    } else if (allParts.length === 2) {
      return `${allParts[0]} og ${allParts[1]}`;
    } else {
      // "A, B, C og D" format
      const allButLast = allParts.slice(0, -1);
      const last = allParts[allParts.length - 1];
      return `${allButLast.join(', ')} og ${last}`;
    }
  }

  /**
   * Escape special regex characters in a string
   * @private
   */
  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ============================================================================
  // DETERMINISTIC LABEL AND GROUP MANAGEMENT (Phase 1-6 Implementation)
  // ============================================================================

  /**
   * Build a deterministic label for a group of respondents.
   * CRITICAL: LLM should NEVER count - this method provides 100% correct labels.
   *
   * @param {Array<number>} responseNumbers - Response IDs in this group
   * @param {Map} respondentMap - Map of responseNumber → respondent data
   * @returns {Object} { label, groupType, namedEntities, citizenCount, responseNumbers }
   */
  buildLabelForGroup(responseNumbers, respondentMap) {
    const namedEntities = [];
    let citizenCount = 0;

    for (const respNum of responseNumbers) {
      let respondent = respondentMap.get(respNum);

      // Fallback to rawResponses if not in respondentMap
      if (!respondent && this._rawResponsesMap) {
        const rawResp = this._rawResponsesMap.get(respNum);
        if (rawResp) {
          respondent = {
            responseNumber: respNum,
            respondentName: rawResp.respondentName,
            respondentType: rawResp.respondentType,
            respondentLabel: this.buildRespondentLabel(rawResp)
          };
        }
      }

      if (!respondent) {
        citizenCount++;
        continue;
      }

      const label = respondent.respondentLabel?.trim() || respondent.respondentName?.trim();
      const isCitizen = !label || label.toLowerCase() === 'borger';

      if (isCitizen) {
        citizenCount++;
      } else {
        // Avoid duplicates
        if (!namedEntities.some(e => e.name === label)) {
          namedEntities.push({ name: label, responseNumber: respNum });
        }
      }
    }

    // Determine groupType for verb agreement
    let groupType;
    if (namedEntities.length > 0 && citizenCount === 0) {
      groupType = namedEntities.length === 1 ? 'named_singular' : 'named_plural';
    } else if (citizenCount === 1 && namedEntities.length === 0) {
      groupType = 'singular_citizen';
    } else {
      groupType = 'plural_citizens';
    }

    // Build the exact label
    const label = this.buildLabelFromData(namedEntities, citizenCount);

    return {
      label,
      groupType,
      namedEntities,
      citizenCount,
      responseNumbers: [...responseNumbers]
    };
  }

  /**
   * Get priority for sorting sub-positions by hierarchy.
   * Lower number = higher priority (shown first).
   *
   * Priority order:
   * 0. Lokaludvalg (most important)
   * 1. Organizations/Foreninger
   * 2. Myndigheder (public authorities)
   * 3. Large citizen groups (>50)
   * 4. Medium citizen groups (15-50)
   * 5. Small citizen groups (<15)
   *
   * @param {Object} subPosition - Sub-position with responseNumbers
   * @param {Map} respondentMap - Map of responseNumber → respondent data
   * @returns {number} Priority (0 = highest)
   */
  getRespondentPriority(subPosition, respondentMap) {
    const responseNumbers = subPosition.responseNumbers || [];

    // Check for Lokaludvalg
    const hasLokalUdvalg = responseNumbers.some(id => {
      const r = respondentMap.get(id);
      if (!r && this._rawResponsesMap) {
        const rawR = this._rawResponsesMap.get(id);
        if (rawR) {
          return (rawR.respondentType || '').toLowerCase().includes('lokaludvalg') ||
                 (rawR.respondentName || '').toLowerCase().includes('lokaludvalg');
        }
      }
      return r && (
        (r.respondentType || '').toLowerCase().includes('lokaludvalg') ||
        (r.respondentName || '').toLowerCase().includes('lokaludvalg') ||
        (r.respondentLabel || '').toLowerCase().includes('lokaludvalg')
      );
    });
    if (hasLokalUdvalg) return 0;

    // Check for organizations/foreninger
    const hasOrganization = responseNumbers.some(id => {
      const r = respondentMap.get(id);
      if (!r && this._rawResponsesMap) {
        const rawR = this._rawResponsesMap.get(id);
        if (rawR) {
          const type = (rawR.respondentType || '').toLowerCase();
          const name = (rawR.respondentName || '').toLowerCase();
          return type.includes('organisation') || type.includes('forening') ||
                 name.includes('forening') || name.includes('organisation');
        }
      }
      const type = (r?.respondentType || '').toLowerCase();
      const name = (r?.respondentName || r?.respondentLabel || '').toLowerCase();
      return type.includes('organisation') || type.includes('forening') ||
             name.includes('forening') || name.includes('organisation');
    });
    if (hasOrganization) return 1;

    // Check for myndigheder (public authorities)
    const hasMyndighed = responseNumbers.some(id => {
      const r = respondentMap.get(id);
      if (!r && this._rawResponsesMap) {
        const rawR = this._rawResponsesMap.get(id);
        if (rawR) {
          const type = (rawR.respondentType || '').toLowerCase();
          return type.includes('myndighed') || type.includes('forvaltning');
        }
      }
      const type = (r?.respondentType || '').toLowerCase();
      return type.includes('myndighed') || type.includes('forvaltning');
    });
    if (hasMyndighed) return 2;

    // Sort by group size for citizens
    const count = responseNumbers.length;
    if (count > 50) return 3;  // Large groups
    if (count >= 15) return 4;  // Medium groups
    return 5;  // Small groups
  }

  /**
   * Sort sub-positions by hierarchy before processing.
   * Ensures: Lokaludvalg → Organizations → Myndigheder → Large groups → Small groups
   *
   * @param {Array} subPositions - Array of sub-positions with responseNumbers
   * @param {Map} respondentMap - Map of responseNumber → respondent data
   * @returns {Array} Sorted sub-positions (new array, original unchanged)
   */
  sortSubPositionsByHierarchy(subPositions, respondentMap) {
    return [...subPositions].sort((a, b) => {
      const aPriority = this.getRespondentPriority(a, respondentMap);
      const bPriority = this.getRespondentPriority(b, respondentMap);

      // Primary sort: by priority (ascending = higher priority first)
      if (aPriority !== bPriority) return aPriority - bPriority;

      // Secondary sort: by count (descending = larger groups first)
      const aCount = a.responseNumbers?.length || 0;
      const bCount = b.responseNumbers?.length || 0;
      return bCount - aCount;
    });
  }

  /**
   * Prepare group metadata for LLM call.
   * Creates GROUP_X placeholders with type information for correct verb agreement.
   *
   * @param {Array} subPositions - Sub-positions with responseNumbers
   * @param {Map} respondentMap - Map of responseNumber → respondent data
   * @returns {Array} Group metadata array with deterministic labels
   */
  prepareGroupsForLLM(subPositions, respondentMap) {
    return subPositions.map((sub, idx) => {
      const labelData = this.buildLabelForGroup(
        sub.responseNumbers || [],
        respondentMap
      );

      // Generate description based on groupType for LLM verb agreement hints
      let typeDescription;
      switch (labelData.groupType) {
        case 'named_singular':
          typeDescription = `navngiven aktør (${labelData.label}) - brug ENTAL verb`;
          break;
        case 'named_plural':
          typeDescription = `navngivne aktører (${labelData.label}) - brug FLERTAL verb`;
          break;
        case 'singular_citizen':
          typeDescription = `én borger - brug ENTAL verb`;
          break;
        case 'plural_citizens':
        default:
          typeDescription = `${labelData.responseNumbers.length} respondenter - brug FLERTAL verb`;
          break;
      }

      return {
        id: `GROUP_${idx + 1}`,
        type: labelData.groupType,
        description: typeDescription,
        respondentCount: labelData.responseNumbers.length,
        // Store for post-processing (prefixed with _ to indicate internal use)
        _exactLabel: labelData.label,
        _responseNumbers: labelData.responseNumbers,
        _namedEntities: labelData.namedEntities,
        _citizenCount: labelData.citizenCount,
        // Pass through sub-position metadata
        _subPositionTitle: sub.title || sub._subPositionTitle,
        _isMasterOnly: sub._isMasterOnly || false,
        _summary: sub.summary // Original sub-position summary for context
      };
    });
  }

  /**
   * Inject exact labels into LLM-generated summary text.
   * Replaces <<GROUP_X>> placeholders with exact labels and <<REF_X>> placeholders.
   *
   * @param {string} summary - Summary text with <<GROUP_X>> placeholders
   * @param {Array} groupMetadata - Array from prepareGroupsForLLM
   * @returns {string} Summary with exact labels and REF placeholders
   */
  injectLabelsIntoSummary(summary, groupMetadata) {
    if (!summary || typeof summary !== 'string') return summary;

    let result = summary;

    groupMetadata.forEach((group, idx) => {
      const groupPlaceholder = `<<GROUP_${idx + 1}>>`;
      const refPlaceholder = `<<REF_${idx + 1}>>`;
      const replacement = `${group._exactLabel}${refPlaceholder}`;

      // Replace all occurrences of this GROUP placeholder
      result = result.split(groupPlaceholder).join(replacement);

      // After injection, detect and remove immediate duplicates
      // Pattern: "Name og X borgere Name og X borgere" → "Name og X borgere"
      // This can happen when LLM outputs the organization name AND the <<GROUP_X>> placeholder
      if (group._exactLabel && group._exactLabel.length > 5) {
        const labelPattern = group._exactLabel.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        // Match label followed by same label (case-insensitive for second occurrence)
        const dupRegex = new RegExp(`(${labelPattern})\\s*(${labelPattern})`, 'gi');
        if (dupRegex.test(result)) {
          console.log(`[PositionWriter] 🧹 Removing duplicate label: ${group._exactLabel}`);
          result = result.replace(dupRegex, '$1');
        }
      }
    });

    // Also handle REF_1 for master-holdning special case (starts with "Der<<REF_1>>")
    // This is handled separately since master uses "Der" label

    console.log(`[PositionWriter] 🏷️ Injected ${groupMetadata.length} deterministic labels into summary`);
    return result;
  }

  /**
   * Build references array deterministically from group metadata.
   * This ensures references match exact respondent counts.
   *
   * @param {Array} groupMetadata - Array from prepareGroupsForLLM
   * @returns {Array} References array for hybrid summary
   */
  buildReferencesFromGroups(groupMetadata) {
    return groupMetadata.map((group, idx) => ({
      id: `REF_${idx + 1}`,
      label: group._exactLabel,
      respondents: group._responseNumbers,
      quotes: [], // Quotes are filled programmatically later
      notes: ''
    }));
  }

  /**
   * Build citationMap deterministically from group metadata.
   * Enables tracing from highlighted text to respondents.
   *
   * @param {Array} groupMetadata - Array from prepareGroupsForLLM
   * @returns {Array} CitationMap array
   */
  buildCitationMapFromGroups(groupMetadata) {
    return groupMetadata.map(group => ({
      highlight: group._exactLabel,
      responseNumbers: group._responseNumbers,
      groupType: group.type,
      namedEntities: group._namedEntities?.map(e => e.name) || []
    }));
  }

  /**
   * Format groups for LLM prompt input.
   * Strips internal fields and formats for prompt consumption.
   *
   * @param {Array} groupMetadata - Array from prepareGroupsForLLM
   * @returns {Array} Cleaned array for LLM prompt
   */
  formatGroupsForPrompt(groupMetadata) {
    return groupMetadata.map(group => ({
      id: group.id,
      type: group.type,
      description: group.description,
      respondentCount: group.respondentCount,
      subPositionTitle: group._subPositionTitle || null,
      isMasterOnly: group._isMasterOnly
    }));
  }
}

