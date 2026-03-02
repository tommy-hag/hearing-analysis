/**
 * OpenAI Embedding Provider
 *
 * Uses OpenAI API for text-embedding-3-large/small
 * Refactored from embedding-service.js to implement provider interface
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../../config/.env') });

export class OpenAIEmbeddingProvider {
  constructor(options = {}) {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI embedding provider');
    }

    this.client = new OpenAI({
      apiKey,
      timeout: options.timeout || 300000, // 5 min fallback
      maxRetries: 0 // We handle retries manually
    });

    // Model configuration
    this.model = options.model || process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
    this.batchSize = options.batchSize || parseInt(process.env.EMBEDDING_BATCH_SIZE || '20');

    // Retry configuration
    this.retryAttempts = options.retryAttempts || parseInt(process.env.EMBEDDING_RETRY_ATTEMPTS || '5');
    this.maxRetryDelay = options.maxRetryDelay || 30000;
    this.rateLimitDelay = options.rateLimitDelay || parseInt(process.env.EMBEDDING_RATE_LIMIT_DELAY || '100');

    // Progressive timeout settings
    this.baseTimeout = options.baseTimeout || 180000; // 3 minutes base
    this.timeoutRetryMultiplier = options.timeoutRetryMultiplier || 1.5;
    this.maxTimeout = options.maxTimeout || 600000; // 10 minutes max

    // Usage tracking for cost calculation
    this.usage = {
      totalTokens: 0,
      totalCalls: 0,
      totalTexts: 0,
      model: this.model,
      provider: 'openai'
    };

    console.log(`[OpenAIEmbeddingProvider] Initialized with model=${this.model}`);
  }

  /**
   * Get the provider name
   * @returns {string}
   */
  getProviderName() {
    return 'openai';
  }

  /**
   * Get embedding dimensions for this provider/model
   * @returns {number}
   */
  getDimensions() {
    if (this.model.includes('3-large')) {
      return 3072;
    }
    if (this.model.includes('3-small')) {
      return 1536;
    }
    return 1536; // Default
  }

  /**
   * Get usage statistics for cost calculation
   * @returns {Object}
   */
  getUsage() {
    return { ...this.usage };
  }

  /**
   * Reset usage statistics
   */
  resetUsage() {
    this.usage = {
      totalTokens: 0,
      totalCalls: 0,
      totalTexts: 0,
      model: this.model,
      provider: 'openai'
    };
  }

  /**
   * Embed a batch of texts
   * @param {Array<string>} texts - Array of texts to embed
   * @param {Object} options - Options for embedding
   * @returns {Promise<Array>} Array of embedding vectors
   */
  async embedBatch(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    // Filter out empty texts and track original indices
    const validTexts = texts.map((text, idx) => ({
      text: String(text || '').trim(),
      originalIndex: idx
    })).filter(item => item.text.length > 0);

    if (validTexts.length === 0) {
      return texts.map(() => []);
    }

    // Token limit estimation
    const MAX_TOKENS_PER_REQUEST = 250000;
    const CHARS_PER_TOKEN = 4;
    const maxItemsPerRequest = options.batchSize || this.batchSize;

    const embeddings = new Array(texts.length).fill(null);

    // Create batches based on token count
    const batches = [];
    let currentBatch = [];
    let currentTokenCount = 0;

    for (const item of validTexts) {
      const estimatedTokens = Math.ceil(item.text.length / CHARS_PER_TOKEN);

      if (currentBatch.length > 0 &&
        (currentTokenCount + estimatedTokens > MAX_TOKENS_PER_REQUEST ||
          currentBatch.length >= maxItemsPerRequest)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokenCount = 0;
      }

      currentBatch.push(item);
      currentTokenCount += estimatedTokens;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    if (batches.length > 1) {
      console.log(`[OpenAIEmbeddingProvider] Split ${validTexts.length} texts into ${batches.length} batches`);
    }

    // Process batches
    let totalProcessed = 0;
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchTexts = batch.map(item => item.text);

      try {
        const batchEmbeddings = await this.embedBatchWithRetry(batchTexts);

        // Map embeddings back to original indices
        batch.forEach((item, itemIdx) => {
          embeddings[item.originalIndex] = batchEmbeddings[itemIdx] || [];
        });

        // Progress callback
        if (options.onProgress) {
          totalProcessed += batch.length;
          options.onProgress(Math.min(totalProcessed, validTexts.length), validTexts.length);
        }

        // Rate limiting between batches
        if (batchIdx < batches.length - 1) {
          await this.delay(this.rateLimitDelay);
        }
      } catch (error) {
        console.error(`[OpenAIEmbeddingProvider] Batch ${batchIdx + 1}/${batches.length} failed:`, error.message);
        // Fill with empty arrays for failed batch
        batch.forEach(item => {
          embeddings[item.originalIndex] = [];
        });
      }
    }

    return embeddings;
  }

  /**
   * Embed batch with retry logic
   * @param {Array<string>} texts - Texts to embed
   * @returns {Promise<Array>} Embeddings
   */
  async embedBatchWithRetry(texts) {
    let lastError;

    // Dynamic retries based on batch size
    const sizeBonus = texts.length >= 100 ? 4 : texts.length >= 20 ? 2 : 0;
    const maxAttempts = Math.min(this.retryAttempts + sizeBonus, 12);

    // Size-based timeout adjustment
    const batchSizeMultiplier = Math.max(1, 1 + (texts.length - 10) * 0.05);
    const sizeAdjustedBaseTimeout = Math.min(this.baseTimeout * batchSizeMultiplier, this.maxTimeout);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptTimeout = Math.min(
        sizeAdjustedBaseTimeout * Math.pow(this.timeoutRetryMultiplier, attempt - 1),
        this.maxTimeout
      );

      try {
        // Truncate texts to max 8000 chars
        const truncatedTexts = texts.map(text => String(text).slice(0, 8000));

        if (attempt > 1) {
          console.log(`[OpenAIEmbeddingProvider] Retry ${attempt}/${maxAttempts} with ${(attemptTimeout / 1000).toFixed(0)}s timeout`);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);

        try {
          const response = await this.client.embeddings.create(
            {
              model: this.model,
              input: truncatedTexts
            },
            {
              signal: controller.signal
            }
          );

          clearTimeout(timeoutId);

          if (!response || !response.data || !Array.isArray(response.data)) {
            throw new Error('Invalid response from OpenAI API');
          }

          // Track usage
          if (response.usage) {
            this.usage.totalTokens += response.usage.total_tokens || 0;
            this.usage.totalCalls++;
            this.usage.totalTexts += texts.length;
          }

          // Extract embeddings
          const embeddings = response.data.map(item => item.embedding || []);

          if (embeddings.length !== texts.length) {
            throw new Error(`Expected ${texts.length} embeddings, got ${embeddings.length}`);
          }

          return embeddings;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error;

        const msg = String(error?.message || '');
        const code = error?.code;
        const name = String(error?.name || '');

        const isTimeout = name.toLowerCase().includes('abort') ||
          msg.toLowerCase().includes('timeout') ||
          msg.toLowerCase().includes('aborted');

        const isConnectionError = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code) ||
          msg.toLowerCase().includes('connection error') ||
          msg.toLowerCase().includes('socket') ||
          msg.toLowerCase().includes('network');

        const isRateLimit = error.status === 429 ||
          msg.includes('rate limit') ||
          msg.includes('Rate limit');

        const jitter = (ms) => Math.round(ms * (0.5 + Math.random()));

        if ((isTimeout || isConnectionError || isRateLimit) && attempt < maxAttempts) {
          const delay = Math.min(this.rateLimitDelay * Math.pow(2, attempt - 1), this.maxRetryDelay);
          console.warn(`[OpenAIEmbeddingProvider] ${isRateLimit ? 'Rate limit' : isTimeout ? 'Timeout' : 'Connection error'} on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`);
          await this.delay(jitter(delay));
          continue;
        }

        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * attempt, this.maxRetryDelay);
          console.warn(`[OpenAIEmbeddingProvider] Error on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms:`, error.message);
          await this.delay(jitter(delay));
          continue;
        }
      }
    }

    throw new Error(`Failed to embed batch after ${maxAttempts} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Embed a single text
   * @param {string} text - Text to embed
   * @returns {Promise<Array>} Embedding vector
   */
  async embedQuery(text) {
    const embeddings = await this.embedBatch([text]);
    return embeddings[0] || [];
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
