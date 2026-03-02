/**
 * Alibaba Cloud Embedding Provider
 *
 * Uses DashScope API (OpenAI-compatible) for text-embedding-v4
 * Endpoint: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * Dimensions: 2048
 * Batch size: max 10 items per request
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../../config/.env') });

// Alibaba Cloud DashScope endpoints
const ALIBABA_ENDPOINTS = {
  international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  china: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
};

export class AlibabaEmbeddingProvider {
  constructor(options = {}) {
    const apiKey = options.apiKey || process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error('ALIBABA_API_KEY or DASHSCOPE_API_KEY is required for Alibaba embedding provider');
    }

    // Use international endpoint by default
    const region = options.region || process.env.ALIBABA_REGION || 'international';
    const baseURL = options.baseURL || ALIBABA_ENDPOINTS[region] || ALIBABA_ENDPOINTS.international;

    // Create OpenAI-compatible client with Alibaba endpoint
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: options.timeout || 180000, // 3 min default
      maxRetries: 0 // We handle retries manually
    });

    // Model configuration
    // Ignore OpenAI model names if passed through (detect by "embedding-3" pattern)
    const passedModel = options.model;
    const isOpenAIModel = passedModel && (passedModel.includes('embedding-3') || passedModel.includes('ada'));
    this.model = (!isOpenAIModel && passedModel) || process.env.ALIBABA_EMBEDDING_MODEL || 'text-embedding-v4';
    this.dimensions = options.dimensions || parseInt(process.env.ALIBABA_EMBEDDING_DIMENSIONS || '2048');

    // Alibaba has a hard limit of 10 items per batch
    this.maxBatchSize = Math.min(options.batchSize || 10, 10);

    // Retry configuration
    this.retryAttempts = options.retryAttempts || 5;
    this.maxRetryDelay = options.maxRetryDelay || 30000;
    this.rateLimitDelay = options.rateLimitDelay || 100;

    // Progressive timeout settings
    this.baseTimeout = options.baseTimeout || 60000; // 1 minute base
    this.timeoutRetryMultiplier = options.timeoutRetryMultiplier || 1.5;
    this.maxTimeout = options.maxTimeout || 300000; // 5 minutes max

    // Usage tracking for cost calculation
    this.usage = {
      totalTokens: 0,
      totalCalls: 0,
      totalTexts: 0,
      model: this.model,
      provider: 'alibaba'
    };

    console.log(`[AlibabaEmbeddingProvider] Initialized with model=${this.model}, dimensions=${this.dimensions}, endpoint=${baseURL}`);
  }

  /**
   * Get the provider name
   * @returns {string}
   */
  getProviderName() {
    return 'alibaba';
  }

  /**
   * Get embedding dimensions for this provider
   * @returns {number}
   */
  getDimensions() {
    return this.dimensions;
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
      provider: 'alibaba'
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

    const embeddings = new Array(texts.length).fill(null);

    // Split into batches of max 10 items (Alibaba limit)
    const batches = [];
    for (let i = 0; i < validTexts.length; i += this.maxBatchSize) {
      batches.push(validTexts.slice(i, i + this.maxBatchSize));
    }

    if (batches.length > 1) {
      console.log(`[AlibabaEmbeddingProvider] Split ${validTexts.length} texts into ${batches.length} batches (max ${this.maxBatchSize} per batch)`);
    }

    // Process batches sequentially to avoid rate limits
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
          const processed = Math.min((batchIdx + 1) * this.maxBatchSize, validTexts.length);
          options.onProgress(processed, validTexts.length);
        }

        // Rate limiting between batches
        if (batchIdx < batches.length - 1) {
          await this.delay(this.rateLimitDelay);
        }
      } catch (error) {
        console.error(`[AlibabaEmbeddingProvider] Batch ${batchIdx + 1}/${batches.length} failed:`, error.message);
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

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      // Progressive timeout
      const attemptTimeout = Math.min(
        this.baseTimeout * Math.pow(this.timeoutRetryMultiplier, attempt - 1),
        this.maxTimeout
      );

      try {
        // Truncate texts to max 8000 chars (model limit is 8192 tokens)
        const truncatedTexts = texts.map(text => String(text).slice(0, 8000));

        if (attempt > 1) {
          console.log(`[AlibabaEmbeddingProvider] Retry ${attempt}/${this.retryAttempts} with ${(attemptTimeout / 1000).toFixed(0)}s timeout`);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);

        try {
          const response = await this.client.embeddings.create(
            {
              model: this.model,
              input: truncatedTexts,
              dimensions: this.dimensions,
              encoding_format: 'float'
            },
            {
              signal: controller.signal
            }
          );

          clearTimeout(timeoutId);

          if (!response || !response.data || !Array.isArray(response.data)) {
            throw new Error('Invalid response from Alibaba API');
          }

          // Track usage
          if (response.usage) {
            this.usage.totalTokens += response.usage.total_tokens || response.usage.prompt_tokens || 0;
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
        const isTimeout = msg.includes('abort') || msg.includes('timeout');
        const isRateLimit = error.status === 429 || msg.includes('rate limit');
        const isConnectionError = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error?.code) ||
          msg.includes('connection') || msg.includes('network');

        const jitter = (ms) => Math.round(ms * (0.5 + Math.random()));

        if ((isTimeout || isConnectionError || isRateLimit) && attempt < this.retryAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), this.maxRetryDelay);
          console.warn(`[AlibabaEmbeddingProvider] ${isRateLimit ? 'Rate limit' : isTimeout ? 'Timeout' : 'Connection error'} on attempt ${attempt}/${this.retryAttempts}, retrying in ${delay}ms`);
          await this.delay(jitter(delay));
          continue;
        }

        if (attempt < this.retryAttempts) {
          const delay = Math.min(1000 * attempt, this.maxRetryDelay);
          console.warn(`[AlibabaEmbeddingProvider] Error on attempt ${attempt}/${this.retryAttempts}, retrying in ${delay}ms:`, error.message);
          await this.delay(jitter(delay));
          continue;
        }
      }
    }

    throw new Error(`Failed to embed batch after ${this.retryAttempts} attempts: ${lastError?.message || 'Unknown error'}`);
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
