/**
 * Structured Chunker
 *
 * Main chunking coordinator that supports multiple strategies:
 * - "legacy": Original behavior - chunk all text at semantic boundaries
 * - "argument-aligned": Skip short responses, use argument-aligned chunking for long ones
 * - "section-aware": Use section-aware chunking for materials
 *
 * For responses:
 * - Short responses (< shortResponseThreshold): Create single chunk, no splitting
 * - Long responses: Chunk at paragraph/sentence boundaries OR use argument-aligned if available
 *
 * For materials:
 * - Use section-aware chunking respecting markdown structure
 */

import { MaterialChunker } from './material-chunker.js';
import { StepLogger } from '../utils/step-logger.js';

export class StructuredChunker {
  constructor(options = {}) {
    this.log = new StepLogger('StructuredChunker');
    // Strategy configuration
    this.responseStrategy = options.responseStrategy || 'legacy';
    this.shortResponseThreshold = options.shortResponseThreshold || 800;
    
    // Legacy chunking parameters
    this.chunkSize = options.chunkSize || 600;
    this.chunkOverlap = options.chunkOverlap || 120;
    this.respectMarkdown = options.respectMarkdown !== false;
    this.respectSemanticBoundaries = options.respectSemanticBoundaries !== false;

    // Initialize specialized chunkers
    this.materialChunker = new MaterialChunker({
      minChunkSize: options.materialMinChunkSize || 400,
      maxChunkSize: options.materialMaxChunkSize || 1500,
      headerDepthWeight: options.headerDepthWeight !== false,
      includeParentContext: options.includeParentContext !== false,
      chunkOverlap: options.materialOverlap || 100
    });
  }

  /**
   * Chunk text based on configured strategy
   * @param {string} text - Text to chunk
   * @param {Object} metadata - Metadata about the source (responseNumber, documentType, etc.)
   * @returns {Array} Array of chunk objects with content and metadata
   */
  chunk(text, metadata = {}) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      return [];
    }

    // Detect document type
    const documentType = metadata.documentType || 
      (this.hasMarkdownStructure(trimmedText) ? 'material' : 'response');

    // Route to appropriate chunking method
    if (documentType === 'material') {
      return this.chunkMaterial(trimmedText, metadata);
    } else {
      return this.chunkResponse(trimmedText, metadata);
    }
  }

  /**
   * Chunk a response based on strategy
   * @param {string} text - Response text
   * @param {Object} metadata - Response metadata
   * @returns {Array} Chunks
   */
  chunkResponse(text, metadata) {
    const textLength = text.length;

    // For argument-aligned strategy, check if we should skip chunking
    if (this.responseStrategy === 'argument-aligned') {
      // Short responses: create single chunk (no splitting)
      if (textLength < this.shortResponseThreshold) {
        return [this.createSimpleChunk(text, metadata)];
      }
      
      // Long responses without argument data: use legacy chunking
      // (Argument-aligned chunking happens in orchestrator after MicroSummarizer)
      return this.chunkFreeText(text, metadata);
    }

    // Legacy strategy: always chunk at semantic boundaries
    return this.chunkFreeText(text, metadata);
  }

  /**
   * Chunk material using section-aware chunker
   * @param {string} text - Material text (markdown)
   * @param {Object} metadata - Material metadata
   * @returns {Array} Chunks
   */
  chunkMaterial(text, metadata) {
    // Use the specialized material chunker
    return this.materialChunker.chunk(text, metadata);
  }

  /**
   * Create a simple single chunk (for short responses)
   * @param {string} text - Full text
   * @param {Object} metadata - Metadata
   * @returns {Object} Single chunk
   */
  createSimpleChunk(text, metadata) {
    const source = metadata.source || `response:${metadata.responseNumber || 'unknown'}`;
    
    return {
      chunkId: `${source}:chunk:0`,
      content: text,
      chunkIndex: 0,
      source: source,
      responseNumber: metadata.responseNumber || null,
      documentType: 'response',
      chunkType: 'short-response',
      charOffset: 0,
      parentSection: null,
      tokenCount: this.estimateTokens(text),
      metadata: {
        ...metadata,
        source: source,
        chunkType: 'short-response',
        skippedChunking: true
      }
    };
  }

  /**
   * Check if text has markdown structure (headers, lists, etc.)
   */
  hasMarkdownStructure(text) {
    // Check for markdown headers (# ## ###)
    if (/^#{1,6}\s+.+/m.test(text)) return true;
    // Check for markdown lists (- * 1.)
    if (/^[\s]*[-*+]\s+/m.test(text) || /^[\s]*\d+\.\s+/m.test(text)) return true;
    // Check for markdown tables
    if (/\|.+\|/m.test(text)) return true;
    return false;
  }

  /**
   * Chunk free text (hearing responses) - legacy method
   */
  chunkFreeText(text, metadata) {
    const chunks = [];
    
    // Split by double line breaks (paragraphs)
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    
    let currentChunk = '';
    let currentChunkTokens = 0;
    let charOffset = 0;
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      if (!trimmedPara) continue;

      const paraTokens = this.estimateTokens(trimmedPara);
      
      // If paragraph alone exceeds chunk size, split by sentences
      if (paraTokens > this.chunkSize) {
        // Save current chunk if exists
        if (currentChunk.trim()) {
          chunks.push(this.createChunk(
            currentChunk.trim(),
            chunkIndex++,
            metadata,
            charOffset - currentChunk.length,
            null
          ));
          currentChunk = '';
          currentChunkTokens = 0;
        }
        
        // Split large paragraph by sentences
        const sentenceChunks = this.chunkBySentences(trimmedPara, metadata, chunkIndex, charOffset);
        chunks.push(...sentenceChunks);
        chunkIndex += sentenceChunks.length;
        charOffset += trimmedPara.length + 2; // +2 for double line break
        continue;
      }

      // Check if adding paragraph would exceed chunk size
      if (currentChunkTokens + paraTokens > this.chunkSize && currentChunk.trim()) {
        // Save current chunk
        chunks.push(this.createChunk(
          currentChunk.trim(),
          chunkIndex++,
          metadata,
          charOffset - currentChunk.length,
          null
        ));
        
        // Start new chunk with overlap (only for legacy strategy)
        const overlapText = this.responseStrategy === 'legacy' 
          ? this.getOverlapText(currentChunk, this.chunkOverlap)
          : '';
        currentChunk = overlapText + (overlapText ? '\n\n' : '') + trimmedPara;
        currentChunkTokens = this.estimateTokens(overlapText) + paraTokens;
        charOffset += trimmedPara.length + 2;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + trimmedPara;
        currentChunkTokens += paraTokens;
        charOffset += trimmedPara.length + 2;
      }
    }

    // Add final chunk
    if (currentChunk.trim()) {
      chunks.push(this.createChunk(
        currentChunk.trim(),
        chunkIndex,
        metadata,
        charOffset - currentChunk.length,
        null
      ));
    }

    return chunks;
  }

  /**
   * Chunk large text by sentences
   */
  chunkBySentences(text, metadata, startChunkIndex, startCharOffset) {
    const chunks = [];
    // Split by sentence endings (. ! ? followed by space or newline)
    const sentences = text.split(/([.!?]\s+)/).filter(s => s.trim());
    
    let currentChunk = '';
    let currentChunkTokens = 0;
    let charOffset = startCharOffset;
    let chunkIndex = startChunkIndex;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim();
      if (!sentence) continue;

      const sentenceTokens = this.estimateTokens(sentence);
      
      if (currentChunkTokens + sentenceTokens > this.chunkSize && currentChunk.trim()) {
        chunks.push(this.createChunk(
          currentChunk.trim(),
          chunkIndex++,
          metadata,
          charOffset - currentChunk.length,
          null
        ));
        
        const overlapText = this.responseStrategy === 'legacy'
          ? this.getOverlapText(currentChunk, this.chunkOverlap)
          : '';
        currentChunk = overlapText + (overlapText ? ' ' : '') + sentence;
        currentChunkTokens = this.estimateTokens(overlapText) + sentenceTokens;
        charOffset += sentence.length + 1;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
        currentChunkTokens += sentenceTokens;
        charOffset += sentence.length + 1;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(this.createChunk(
        currentChunk.trim(),
        chunkIndex,
        metadata,
        charOffset - currentChunk.length,
        null
      ));
    }

    return chunks;
  }

  /**
   * Get overlap text from end of chunk
   */
  getOverlapText(chunk, overlapTokens) {
    if (!chunk || overlapTokens <= 0) return '';
    
    // Try to get overlap at sentence/word boundaries
    const words = chunk.split(/\s+/);
    let overlapWords = [];
    let tokenCount = 0;
    
    // Start from end and work backwards
    for (let i = words.length - 1; i >= 0 && tokenCount < overlapTokens; i--) {
      const wordTokens = this.estimateTokens(words[i]);
      if (tokenCount + wordTokens <= overlapTokens) {
        overlapWords.unshift(words[i]);
        tokenCount += wordTokens;
      } else {
        break;
      }
    }
    
    return overlapWords.join(' ');
  }

  /**
   * Estimate token count (rough approximation: ~4 chars per token)
   */
  estimateTokens(text) {
    if (!text) return 0;
    // Rough approximation: average 4 characters per token for Danish/English
    return Math.ceil(text.length / 4);
  }

  /**
   * Create chunk object with metadata
   */
  createChunk(content, chunkIndex, metadata, charOffset, parentSection) {
    const source = metadata.source || 'unknown';
    const responseNumber = metadata.responseNumber || null;
    
    return {
      chunkId: `${source}:chunk:${chunkIndex}`,
      content: content,
      chunkIndex: chunkIndex,
      source: source,
      responseNumber: responseNumber,
      documentType: metadata.documentType || 'response',
      charOffset: charOffset,
      parentSection: parentSection,
      tokenCount: this.estimateTokens(content),
      metadata: {
        ...metadata,
        parentSection
      }
    };
  }

  /**
   * Chunk multiple items with logging
   * @param {Array} items - Array of items to chunk (responses or materials)
   * @param {Object} options - Chunking options
   * @returns {Array} All chunks from all items
   */
  chunkAll(items, options = {}) {
    if (!items || items.length === 0) {
      this.log.info('No items to chunk');
      return [];
    }

    this.log.start({ items: items.length, strategy: this.responseStrategy });

    const allChunks = [];
    let shortResponses = 0;
    let longResponses = 0;
    let materials = 0;

    for (const item of items) {
      const text = item.text || item.contentMd || item.content || '';
      const metadata = {
        responseNumber: item.id || item.responseNumber,
        documentType: item.documentType || (this.hasMarkdownStructure(text) ? 'material' : 'response'),
        source: item.source || `item:${item.id || 'unknown'}`,
        ...options.metadata
      };

      const chunks = this.chunk(text, metadata);
      allChunks.push(...chunks);

      // Track statistics
      if (metadata.documentType === 'material') {
        materials++;
      } else if (text.length < this.shortResponseThreshold) {
        shortResponses++;
      } else {
        longResponses++;
      }
    }

    const stats = StructuredChunker.getChunkingStats(allChunks);
    this.log.distribution('Input types', { short: shortResponses, long: longResponses, materials });
    this.log.distribution('Chunk types', stats.byType);
    this.log.metric('Avg tokens', stats.avgTokens, `${stats.totalTokens} total`);
    this.log.complete({ chunks: allChunks.length });

    return allChunks;
  }

  /**
   * Get chunking statistics for a set of chunks
   * @param {Array} chunks - Array of chunks
   * @returns {Object} Statistics
   */
  static getChunkingStats(chunks) {
    if (!chunks || chunks.length === 0) {
      return { total: 0, byType: {}, avgTokens: 0, totalTokens: 0 };
    }

    const byType = {};
    let totalTokens = 0;

    for (const chunk of chunks) {
      const type = chunk.chunkType || chunk.documentType || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
      totalTokens += chunk.tokenCount || 0;
    }

    return {
      total: chunks.length,
      byType,
      avgTokens: Math.round(totalTokens / chunks.length),
      totalTokens
    };
  }
}
