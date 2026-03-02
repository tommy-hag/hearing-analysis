/**
 * Batch Embedder
 *
 * Handles batch processing of chunks with progress tracking and error handling.
 */

import { EmbeddingService } from './embedding-service.js';
import { getBatchSizeForStep } from '../utils/batch-calculator.js';
import { StepLogger } from '../utils/step-logger.js';

export class BatchEmbedder {
  constructor(options = {}) {
    this.embeddingService = new EmbeddingService(options);
    this.onProgress = options.onProgress || null;
    this.log = new StepLogger('BatchEmbedder');
  }

  /**
   * Embed chunks with progress tracking
   * @param {Array} chunks - Array of chunk objects with content property
   * @param {Object} options - Options for embedding
   * @returns {Promise<Array>} Array of chunks with embeddings added
   */
  async embedChunks(chunks, options = {}) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      this.log.info('No chunks to embed');
      return chunks;
    }

    // Calculate dynamic batch size based on content
    const batchSize = options.batchSize || getBatchSizeForStep('embedding', chunks);
    const totalBatches = Math.ceil(chunks.length / batchSize);

    this.log.start({ chunks: chunks.length });
    this.log.metric('Batch size', batchSize, `${totalBatches} batches`);

    const texts = chunks.map(chunk => chunk.content || '');
    const total = texts.length;
    let processed = 0;

    // Report initial progress
    if (this.onProgress) {
      this.onProgress({
        stage: 'embedding',
        processed: 0,
        total: total,
        percentage: 0
      });
    }

    try {
      // Pass dynamic batch size to service
      const embeddings = await this.embeddingService.embedBatch(texts, {
        ...options,
        batchSize: batchSize,
        onProgress: (current, batchTotal) => {
          processed = current;
          if (this.onProgress) {
            this.onProgress({
              stage: 'embedding',
              processed: processed,
              total: total,
              percentage: Math.round((processed / total) * 100)
            });
          }
        }
      });

      // Add embeddings to chunks
      const embeddedChunks = chunks.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx] || [],
        hasEmbedding: Array.isArray(embeddings[idx]) && embeddings[idx].length > 0
      }));

      // Report completion
      if (this.onProgress) {
        this.onProgress({
          stage: 'embedding',
          processed: total,
          total: total,
          percentage: 100,
          complete: true
        });
      }

      // Count successful embeddings
      const successCount = embeddedChunks.filter(c => c.hasEmbedding).length;
      const dimensions = embeddings[0]?.length || 0;

      this.log.percentage('Embedding success', successCount, chunks.length);
      this.log.complete({ embedded: successCount, dimensions });

      return embeddedChunks;
    } catch (error) {
      this.log.warn('Embedding failed', { error: error.message });

      // Return chunks with empty embeddings on error
      return chunks.map(chunk => ({
        ...chunk,
        embedding: [],
        hasEmbedding: false,
        embeddingError: error.message
      }));
    }
  }

  /**
   * Get usage statistics from the embedding service
   * @returns {Object} Usage stats including tokens and calls
   */
  getUsage() {
    return this.embeddingService.getUsage();
  }

  /**
   * Reset usage statistics
   */
  resetUsage() {
    this.embeddingService.resetUsage();
  }

  /**
   * Validate embeddings
   */
  validateEmbeddings(chunks) {
    const expectedDimensions = this.embeddingService.getDimensions();
    const issues = [];

    chunks.forEach((chunk, idx) => {
      if (!chunk.hasEmbedding) {
        issues.push({
          chunkIndex: idx,
          chunkId: chunk.chunkId,
          issue: 'Missing embedding'
        });
        return;
      }

      const embedding = chunk.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        issues.push({
          chunkIndex: idx,
          chunkId: chunk.chunkId,
          issue: 'Empty embedding array'
        });
        return;
      }

      if (embedding.length !== expectedDimensions) {
        issues.push({
          chunkIndex: idx,
          chunkId: chunk.chunkId,
          issue: `Wrong dimensions: expected ${expectedDimensions}, got ${embedding.length}`
        });
      }
    });

    return {
      valid: issues.length === 0,
      issues: issues,
      totalChunks: chunks.length,
      validChunks: chunks.filter(c => c.hasEmbedding && Array.isArray(c.embedding) && c.embedding.length === expectedDimensions).length
    };
  }
}




