/**
 * Embedding Provider Factory
 *
 * Creates embedding providers based on configuration.
 * Supports OpenAI and Alibaba Cloud (DashScope) providers.
 *
 * Configuration via environment variables:
 * - EMBEDDING_PROVIDER: 'openai' (default) | 'alibaba'
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../config/.env') });

// Lazy-loaded providers to avoid circular imports
let OpenAIEmbeddingProvider = null;
let AlibabaEmbeddingProvider = null;

/**
 * Get the configured embedding provider name
 * @returns {string} Provider name ('openai' or 'alibaba')
 */
export function getEmbeddingProviderName() {
  return (process.env.EMBEDDING_PROVIDER || 'openai').toLowerCase();
}

/**
 * Create an embedding provider based on configuration
 * @param {Object} options - Provider options
 * @param {string} options.provider - Override provider selection
 * @returns {Promise<Object>} Embedding provider instance
 */
export async function getEmbeddingProvider(options = {}) {
  const providerName = (options.provider || getEmbeddingProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen': {
      if (!AlibabaEmbeddingProvider) {
        const module = await import('./providers/alibaba-embedding-provider.js');
        AlibabaEmbeddingProvider = module.AlibabaEmbeddingProvider;
      }
      return new AlibabaEmbeddingProvider(options);
    }

    case 'openai':
    default: {
      if (!OpenAIEmbeddingProvider) {
        const module = await import('./providers/openai-embedding-provider.js');
        OpenAIEmbeddingProvider = module.OpenAIEmbeddingProvider;
      }
      return new OpenAIEmbeddingProvider(options);
    }
  }
}

/**
 * Get expected embedding dimensions for a provider
 * @param {string} provider - Provider name (optional, uses configured if not provided)
 * @returns {number} Expected embedding dimensions
 */
export function getEmbeddingDimensions(provider) {
  const providerName = (provider || getEmbeddingProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen':
      // Alibaba text-embedding-v4 with dimension 2048 (user preference)
      return parseInt(process.env.ALIBABA_EMBEDDING_DIMENSIONS || '2048');

    case 'openai':
    default: {
      // OpenAI dimensions depend on model
      const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
      if (model.includes('3-large')) {
        return 3072;
      }
      if (model.includes('3-small')) {
        return 1536;
      }
      return 1536;
    }
  }
}

/**
 * Get model name for a provider
 * @param {string} provider - Provider name (optional)
 * @returns {string} Model name
 */
export function getEmbeddingModelName(provider) {
  const providerName = (provider || getEmbeddingProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen':
      return process.env.ALIBABA_EMBEDDING_MODEL || 'text-embedding-v4';

    case 'openai':
    default:
      return process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
  }
}

/**
 * Check if a provider is available (has required API key)
 * @param {string} provider - Provider name
 * @returns {boolean} Whether provider is available
 */
export function isProviderAvailable(provider) {
  const providerName = (provider || getEmbeddingProviderName()).toLowerCase();

  switch (providerName) {
    case 'alibaba':
    case 'dashscope':
    case 'qwen':
      return !!(process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY);

    case 'openai':
    default:
      return !!process.env.OPENAI_API_KEY;
  }
}

/**
 * Get all available providers
 * @returns {Array<{name: string, available: boolean, model: string, dimensions: number}>}
 */
export function listProviders() {
  return [
    {
      name: 'openai',
      available: isProviderAvailable('openai'),
      model: getEmbeddingModelName('openai'),
      dimensions: getEmbeddingDimensions('openai')
    },
    {
      name: 'alibaba',
      available: isProviderAvailable('alibaba'),
      model: getEmbeddingModelName('alibaba'),
      dimensions: getEmbeddingDimensions('alibaba')
    }
  ];
}
