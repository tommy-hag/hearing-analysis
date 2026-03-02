/**
 * Argument Chunker
 * 
 * Creates chunks aligned with extracted arguments from MicroSummarizer.
 * Each chunk corresponds to one argument (what/why/how), preserving semantic coherence.
 * 
 * This is used for LONG responses where arguments have already been extracted.
 * Short responses skip chunking entirely.
 */

export class ArgumentChunker {
  constructor(options = {}) {
    this.maxChunkSize = options.argumentChunkSize || 1200;
    this.includeSourceQuote = options.includeSourceQuote !== false;
  }

  /**
   * Create chunks from extracted arguments
   * @param {Object} microSummary - MicroSummarizer output for a single response
   * @param {Object} originalResponse - The original response object
   * @returns {Array} Array of argument-aligned chunks
   */
  chunkFromArguments(microSummary, originalResponse) {
    const chunks = [];
    const responseNumber = microSummary.responseNumber || originalResponse?.id;
    const source = `response:${responseNumber}`;

    if (!microSummary.arguments || microSummary.arguments.length === 0) {
      // No arguments extracted - return whole response as single chunk
      return this.createSingleChunk(originalResponse, responseNumber);
    }

    // Create one chunk per argument
    microSummary.arguments.forEach((arg, idx) => {
      const chunk = this.createArgumentChunk(arg, idx, responseNumber, source, originalResponse);
      if (chunk) {
        chunks.push(chunk);
      }
    });

    return chunks;
  }

  /**
   * Create a chunk from a single argument
   * @private
   */
  createArgumentChunk(arg, argIndex, responseNumber, source, originalResponse) {
    // Combine what/why/how for rich semantic content
    const parts = [];
    
    if (arg.what) {
      parts.push(`Holdning: ${arg.what}`);
    }
    if (arg.why && arg.why !== 'Ikke specificeret') {
      parts.push(`Begrundelse: ${arg.why}`);
    }
    if (arg.how && arg.how !== 'Ikke specificeret') {
      parts.push(`Forslag: ${arg.how}`);
    }

    // Optionally include source quote for better retrieval
    if (this.includeSourceQuote && arg.sourceQuote) {
      // Truncate very long quotes
      const quote = arg.sourceQuote.length > 300 
        ? arg.sourceQuote.substring(0, 300) + '...'
        : arg.sourceQuote;
      parts.push(`Citat: "${quote}"`);
    }

    const content = parts.join('\n');

    if (!content.trim()) {
      return null;
    }

    // Truncate if exceeds max size
    const finalContent = content.length > this.maxChunkSize
      ? content.substring(0, this.maxChunkSize) + '...'
      : content;

    return {
      chunkId: `${source}:arg:${argIndex}`,
      content: finalContent,
      chunkIndex: argIndex,
      source: source,
      responseNumber: responseNumber,
      documentType: 'response',
      chunkType: 'argument',
      argumentIndex: argIndex,
      charOffset: 0,
      parentSection: null,
      tokenCount: this.estimateTokens(finalContent),
      metadata: {
        source: source,
        responseNumber: responseNumber,
        documentType: 'response',
        chunkType: 'argument',
        argumentIndex: argIndex,
        themes: arg.relevantThemes || [],
        hasSourceQuote: !!arg.sourceQuote,
        originalWhat: arg.what,
        originalWhy: arg.why,
        originalHow: arg.how
      }
    };
  }

  /**
   * Create a single chunk from the whole response (fallback)
   * @private
   */
  createSingleChunk(response, responseNumber) {
    const text = response?.text || response?.textMd || '';
    if (!text.trim()) {
      return [];
    }

    const source = `response:${responseNumber}`;
    
    // Truncate if necessary
    const finalContent = text.length > this.maxChunkSize
      ? text.substring(0, this.maxChunkSize) + '...'
      : text;

    return [{
      chunkId: `${source}:chunk:0`,
      content: finalContent,
      chunkIndex: 0,
      source: source,
      responseNumber: responseNumber,
      documentType: 'response',
      chunkType: 'full-response',
      charOffset: 0,
      parentSection: null,
      tokenCount: this.estimateTokens(finalContent),
      metadata: {
        source: source,
        responseNumber: responseNumber,
        documentType: 'response',
        chunkType: 'full-response'
      }
    }];
  }

  /**
   * Batch process multiple micro summaries
   * @param {Array} microSummaries - Array of MicroSummarizer outputs
   * @param {Array} responses - Original responses array
   * @returns {Array} All argument-aligned chunks
   */
  chunkBatch(microSummaries, responses) {
    const allChunks = [];
    const responseMap = new Map(responses.map(r => [r.id, r]));

    for (const summary of microSummaries) {
      const response = responseMap.get(summary.responseNumber);
      const chunks = this.chunkFromArguments(summary, response);
      allChunks.push(...chunks);
    }

    return allChunks;
  }

  /**
   * Estimate token count (rough approximation)
   * @private
   */
  estimateTokens(text) {
    if (!text) return 0;
    // Danish/English average: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}
