/**
 * Reranker Provider Factory
 *
 * Creates reranker providers based on configuration.
 * Supports OpenAI (embedding-based), Alibaba Cloud (qwen3-rerank), and BGE (model-reranker).
 *
 * Configuration via environment variables:
 * - RERANKER_PROVIDER: 'openai' (default) | 'alibaba' | 'bge'
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../config/.env') });

// Lazy-loaded providers to avoid circular imports
let OpenAIReranker = null;
let AlibabaReranker = null;
let ModelReranker = null;

/**
 * Get the configured reranker provider name
 * @returns {string} Provider name ('openai', 'alibaba', or 'bge')
 */
export function getRerankerProviderName() {
  return (process.env.RERANKER_PROVIDER || 'openai').toLowerCase();
}

/**
 * Create a reranker provider based on configuration
 * @param {Object} options - Provider options
 * @param {string} options.provider - Override provider selection
 * @returns {Promise<Object>} Reranker provider instance
 */
export async function getRerankerProvider(options = {}) {
  const providerName = (options.provider || getRerankerProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen':
    case 'qwen3': {
      if (!AlibabaReranker) {
        const module = await import('./alibaba-reranker.js');
        AlibabaReranker = module.AlibabaReranker;
      }
      return new AlibabaReranker(options);
    }

    case 'bge':
    case 'model':
    case 'cross-encoder': {
      if (!ModelReranker) {
        const module = await import('./model-reranker.js');
        ModelReranker = module.ModelReranker;
      }
      return new ModelReranker(options);
    }

    case 'openai':
    case 'embedding':
    default: {
      if (!OpenAIReranker) {
        const module = await import('./openai-reranker.js');
        OpenAIReranker = module.OpenAIReranker;
      }
      return new OpenAIReranker(options);
    }
  }
}

/**
 * Get model name for a provider
 * @param {string} provider - Provider name (optional)
 * @returns {string} Model name
 */
export function getRerankerModelName(provider) {
  const providerName = (provider || getRerankerProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen':
    case 'qwen3':
      return process.env.ALIBABA_RERANK_MODEL || 'gte-rerank';

    case 'bge':
    case 'model':
    case 'cross-encoder':
      return 'BAAI/bge-reranker-v2-m3';

    case 'openai':
    case 'embedding':
    default:
      return 'text-embedding-3-small';
  }
}

/**
 * Check if a provider is available (has required API key/dependencies)
 * @param {string} provider - Provider name
 * @returns {boolean} Whether provider is available
 */
export function isRerankerProviderAvailable(provider) {
  const providerName = (provider || getRerankerProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen':
    case 'qwen3':
      return !!(process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY);

    case 'bge':
    case 'model':
    case 'cross-encoder':
      // ModelReranker requires Python backend - availability is checked at runtime
      return true;

    case 'openai':
    case 'embedding':
    default:
      return !!process.env.OPENAI_API_KEY;
  }
}

/**
 * Get reranker type description
 * @param {string} provider - Provider name
 * @returns {string} Description of reranker type
 */
export function getRerankerType(provider) {
  const providerName = (provider || getRerankerProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen':
    case 'qwen3':
      return 'cross-encoder'; // True reranking model

    case 'bge':
    case 'model':
    case 'cross-encoder':
      return 'cross-encoder'; // True reranking model

    case 'openai':
    case 'embedding':
    default:
      return 'bi-encoder'; // Embedding-based similarity
  }
}

/**
 * Get all available reranker providers
 * @returns {Array<{name: string, available: boolean, model: string, type: string}>}
 */
export function listRerankerProviders() {
  return [
    {
      name: 'openai',
      available: isRerankerProviderAvailable('openai'),
      model: getRerankerModelName('openai'),
      type: getRerankerType('openai')
    },
    {
      name: 'alibaba',
      available: isRerankerProviderAvailable('alibaba'),
      model: getRerankerModelName('alibaba'),
      type: getRerankerType('alibaba')
    },
    {
      name: 'bge',
      available: isRerankerProviderAvailable('bge'),
      model: getRerankerModelName('bge'),
      type: getRerankerType('bge')
    }
  ];
}
