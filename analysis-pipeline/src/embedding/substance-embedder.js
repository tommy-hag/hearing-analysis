/**
 * Substance Embedder
 * 
 * Embeds substance items for RAG-based context selection.
 * Enables efficient retrieval of relevant substance points per response/position.
 */

import { EmbeddingService, getDynamicEmbeddingConfig } from './embedding-service.js';

export class SubstanceEmbedder {
  constructor(options = {}) {
    this.embeddingService = new EmbeddingService(options);
  }

  /**
   * Embed substance items for RAG retrieval
   * @param {Array} substanceItems - Array of substance items from SubstanceExtractor
   * @returns {Promise<Array>} Substance items with embeddings added
   */
  async embedSubstanceItems(substanceItems) {
    if (!Array.isArray(substanceItems) || substanceItems.length === 0) {
      console.log('[SubstanceEmbedder] No substance items to embed');
      return [];
    }

    console.log(`[SubstanceEmbedder] Embedding ${substanceItems.length} substance items`);

    // Build text representation for each substance item
    const texts = substanceItems.map(item => this.buildEmbeddingText(item));

    try {
      // Embed all texts
      const embeddings = await this.embeddingService.embedBatch(texts);

      // Add embeddings to items
      const embeddedItems = substanceItems.map((item, idx) => ({
        ...item,
        embedding: embeddings[idx] || [],
        hasEmbedding: Array.isArray(embeddings[idx]) && embeddings[idx].length > 0,
        // Store the text used for embedding (for debugging)
        _embeddingText: texts[idx]
      }));

      const successCount = embeddedItems.filter(i => i.hasEmbedding).length;
      console.log(`[SubstanceEmbedder] Successfully embedded ${successCount}/${substanceItems.length} items`);

      return embeddedItems;
    } catch (error) {
      console.error('[SubstanceEmbedder] Failed to embed substance items:', error.message);
      // Return items without embeddings as fallback
      return substanceItems.map(item => ({
        ...item,
        embedding: [],
        hasEmbedding: false
      }));
    }
  }

  /**
   * Build text representation for embedding
   * Combines reference, title, content, and keywords for better semantic matching
   * @private
   */
  buildEmbeddingText(item) {
    const parts = [];

    // Add reference (e.g., "§ 3, stk. 1" or "Bestemmelse: Anvendelse")
    if (item.reference) {
      parts.push(`[${item.reference}]`);
    }

    // Add title
    if (item.title) {
      parts.push(item.title);
    }

    // Add content (main text)
    if (item.content) {
      parts.push(item.content);
    }

    // Add keywords for better matching
    if (item.keywords && Array.isArray(item.keywords) && item.keywords.length > 0) {
      parts.push(`Nøgleord: ${item.keywords.join(', ')}`);
    }

    return parts.join(' - ');
  }

  /**
   * Retrieve relevant substance items using cosine similarity
   * @param {string} query - Query text (e.g., response text or argument)
   * @param {Array} embeddedSubstance - Substance items with embeddings
   * @param {Object} options - Retrieval options
   * @returns {Promise<Array>} Top-K most relevant substance items
   */
  async retrieveRelevant(query, embeddedSubstance, options = {}) {
    const topK = options.topK || 15;
    const minScore = options.minScore || 0.3; // Lower threshold for substance

    if (!query || !embeddedSubstance || embeddedSubstance.length === 0) {
      return [];
    }

    // Filter items that have embeddings
    const validItems = embeddedSubstance.filter(item => item.hasEmbedding);
    if (validItems.length === 0) {
      console.warn('[SubstanceEmbedder] No embedded substance items available');
      return embeddedSubstance.slice(0, topK); // Fallback to first K items
    }

    try {
      // Get query embedding
      const queryEmbeddings = await this.embeddingService.embedBatch([query]);
      const queryEmbedding = queryEmbeddings[0];

      if (!queryEmbedding || queryEmbedding.length === 0) {
        console.warn('[SubstanceEmbedder] Failed to embed query, returning top items by confidence');
        return this.fallbackSelection(embeddedSubstance, topK);
      }

      // Calculate similarity scores with keyword boosting
      const queryLower = query.toLowerCase();
      
      // Extract key physical elements from query for boosting
      const physicalElements = this.extractPhysicalElements(queryLower);
      
      const scoredItems = validItems.map(item => {
        const baseSimilarity = this.cosineSimilarity(queryEmbedding, item.embedding);
        
        // Keyword boost: if query mentions specific physical elements, 
        // boost items that have those elements in keywords
        let keywordBoost = 0;
        if (physicalElements.length > 0 && item.keywords && Array.isArray(item.keywords)) {
          const itemKeywordsLower = item.keywords.map(k => k.toLowerCase());
          for (const element of physicalElements) {
            if (itemKeywordsLower.some(k => k.includes(element))) {
              keywordBoost += 0.15; // Boost per matching element
            }
          }
          // Also check content and title for matches
          const contentLower = (item.content || '').toLowerCase();
          const titleLower = (item.title || '').toLowerCase();
          for (const element of physicalElements) {
            if (contentLower.includes(element) || titleLower.includes(element)) {
              keywordBoost += 0.08;
            }
          }
        }
        
        return {
          ...item,
          similarityScore: Math.min(1.0, baseSimilarity + keywordBoost), // Cap at 1.0
          _baseSimilarity: baseSimilarity,
          _keywordBoost: keywordBoost
        };
      });

      // Sort by similarity and filter by minimum score
      const rankedItems = scoredItems
        .filter(item => item.similarityScore >= minScore)
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, topK);

      // If we got too few results, add some high-confidence items
      if (rankedItems.length < 5) {
        const additionalItems = this.fallbackSelection(
          embeddedSubstance.filter(i => !rankedItems.find(r => r.id === i.id)),
          5 - rankedItems.length
        );
        rankedItems.push(...additionalItems);
      }

      return rankedItems;
    } catch (error) {
      console.error('[SubstanceEmbedder] Retrieval failed:', error.message);
      return this.fallbackSelection(embeddedSubstance, topK);
    }
  }

  /**
   * Fallback selection when RAG fails - select by confidence and category
   * @private
   */
  fallbackSelection(items, count) {
    // Prioritize regulation items with high confidence
    return items
      .sort((a, b) => {
        // Prioritize regulation category
        const catA = a.category === 'regulation' ? 1 : 0;
        const catB = b.category === 'regulation' ? 1 : 0;
        if (catA !== catB) return catB - catA;
        // Then by confidence
        return (b.confidence || 0) - (a.confidence || 0);
      })
      .slice(0, count);
  }

  /**
   * Extract physical elements from query text for keyword boosting
   * These are the things that get REGULATED in the local plan
   * @private
   */
  extractPhysicalElements(queryLower) {
    const physicalElementPatterns = [
      'boldbane', 'boldbur', 'boldspil',
      'legeplads', 'legeområde',
      'parkering', 'parkeringsplads', 'cykelparkering',
      'byrum', 'friareal', 'kantzone',
      'bygning', 'byggeri', 'bebyggelse',
      'vej', 'sti', 'stibro', 'trafikal',
      'støjskærm', 'støjafskærmning',
      'terrasse', 'altan', 'tagterrasse',
      'beplantning', 'træ', 'træer',
      'hegn', 'gitter'
    ];
    
    const found = [];
    for (const pattern of physicalElementPatterns) {
      if (queryLower.includes(pattern)) {
        found.push(pattern);
      }
    }
    return found;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @private
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Format substance items for prompt inclusion
   * @param {Array} items - Substance items to format
   * @returns {string} Formatted text for prompt
   */
  formatForPrompt(items) {
    if (!items || items.length === 0) {
      return 'Ingen relevant substans fundet.';
    }

    return items
      .map(item => {
        const ref = item.reference ? `[${item.reference}]` : '';
        const title = item.title || '';
        const content = item.content || '';
        return `- ${ref} ${title}: ${content}`.trim();
      })
      .join('\n');
  }

  /**
   * Pre-embed multiple query texts with progressive batching
   * This avoids connection saturation by processing in smaller chunks with delays
   * 
   * ROBUST DESIGN for large hearings (1000+ responses):
   * - Chunks queries into batches of max 50
   * - Adds delay between batches to prevent connection saturation
   * - Retries failed batches individually
   * - Continues on partial failure (graceful degradation)
   * 
   * @param {Array<{id: string|number, text: string}>} queryItems - Items with id and text to embed
   * @returns {Promise<Map<string|number, Array>>} Map of id → embedding vector
   */
  async preEmbedQueries(queryItems) {
    if (!Array.isArray(queryItems) || queryItems.length === 0) {
      console.log('[SubstanceEmbedder] No queries to pre-embed');
      return new Map();
    }

    // Filter out empty texts
    const validItems = queryItems.filter(item => item.text && item.text.trim().length > 0);
    
    if (validItems.length === 0) {
      console.log('[SubstanceEmbedder] No valid query texts to embed');
      return new Map();
    }

    // Get dynamic configuration from DynamicParameterCalculator (if available)
    // Falls back to local calculation based on item count
    const dynamicConfig = getDynamicEmbeddingConfig();
    const totalItems = validItems.length;
    
    // Use dynamic config if available, otherwise calculate locally
    const BATCH_SIZE = dynamicConfig.preEmbedBatchSize 
      || (totalItems > 500 ? 30 : totalItems > 200 ? 40 : 50);
    
    const DELAY_BETWEEN_BATCHES = dynamicConfig.preEmbedDelayMs 
      || (totalItems > 500 ? 500 : totalItems > 200 ? 400 : 300);
    
    const MAX_RETRIES_PER_BATCH = dynamicConfig.preEmbedMaxRetries 
      || (totalItems > 500 ? 5 : totalItems > 200 ? 4 : 3);
    
    const RETRY_DELAY = 2000;  // ms delay before retry

    const totalBatches = Math.ceil(validItems.length / BATCH_SIZE);
    const configSource = dynamicConfig.preEmbedBatchSize ? 'DynamicParameterCalculator' : 'local';
    console.log(`[SubstanceEmbedder] Pre-embedding ${validItems.length} queries in ${totalBatches} batches`);
    console.log(`[SubstanceEmbedder] Config (${configSource}): batchSize=${BATCH_SIZE}, delay=${DELAY_BETWEEN_BATCHES}ms, retries=${MAX_RETRIES_PER_BATCH}`);
    const startTime = Date.now();

    const embeddingsMap = new Map();
    let successCount = 0;
    let failedBatches = 0;

    // Process in batches with delay between each
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchStart = batchIdx * BATCH_SIZE;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, validItems.length);
      const batchItems = validItems.slice(batchStart, batchEnd);
      const texts = batchItems.map(item => item.text);

      let batchSuccess = false;
      let lastError = null;

      // Retry logic per batch
      for (let attempt = 1; attempt <= MAX_RETRIES_PER_BATCH && !batchSuccess; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`[SubstanceEmbedder] Retrying batch ${batchIdx + 1}/${totalBatches} (attempt ${attempt}/${MAX_RETRIES_PER_BATCH})...`);
            await this.delay(RETRY_DELAY * attempt);  // Progressive delay
          }

          const embeddings = await this.embeddingService.embedBatch(texts, {
            // Lower concurrency for individual batches to prevent saturation
            maxConcurrency: 2
          });

          // Add successful embeddings to map
          batchItems.forEach((item, idx) => {
            const embedding = embeddings[idx];
            if (Array.isArray(embedding) && embedding.length > 0) {
              embeddingsMap.set(item.id, embedding);
              successCount++;
            }
          });

          batchSuccess = true;
        } catch (error) {
          lastError = error;
          console.warn(`[SubstanceEmbedder] Batch ${batchIdx + 1}/${totalBatches} failed (attempt ${attempt}): ${error.message}`);
        }
      }

      if (!batchSuccess) {
        failedBatches++;
        console.error(`[SubstanceEmbedder] Batch ${batchIdx + 1}/${totalBatches} failed after ${MAX_RETRIES_PER_BATCH} attempts: ${lastError?.message}`);
        // Continue with next batch - graceful degradation
      }

      // Progress logging every 5 batches or on last batch
      if ((batchIdx + 1) % 5 === 0 || batchIdx === totalBatches - 1) {
        const progress = Math.round(((batchIdx + 1) / totalBatches) * 100);
        console.log(`[SubstanceEmbedder] Progress: ${batchIdx + 1}/${totalBatches} batches (${progress}%), ${successCount} embeddings`);
      }

      // Delay between batches (except after last)
      if (batchIdx < totalBatches - 1) {
        await this.delay(DELAY_BETWEEN_BATCHES);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    if (failedBatches > 0) {
      console.warn(`[SubstanceEmbedder] Completed with ${failedBatches} failed batches. Embedded ${successCount}/${validItems.length} queries in ${duration}s`);
    } else {
      console.log(`[SubstanceEmbedder] Pre-embedded ${successCount}/${validItems.length} queries in ${duration}s`);
    }

    return embeddingsMap;
  }

  /**
   * Delay helper
   * @private
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retrieve relevant substance items using a pre-computed query embedding
   * This is the fast path that avoids API calls during RAG lookup
   * 
   * @param {Array} queryEmbedding - Pre-computed embedding vector for the query
   * @param {string} queryText - Original query text (for keyword boosting)
   * @param {Array} embeddedSubstance - Substance items with embeddings
   * @param {Object} options - Retrieval options
   * @returns {Array} Top-K most relevant substance items
   */
  retrieveRelevantWithEmbedding(queryEmbedding, queryText, embeddedSubstance, options = {}) {
    const topK = options.topK || 15;
    const minScore = options.minScore || 0.3;

    if (!queryEmbedding || queryEmbedding.length === 0) {
      console.warn('[SubstanceEmbedder] No query embedding provided, using fallback');
      return this.fallbackSelection(embeddedSubstance, topK);
    }

    if (!embeddedSubstance || embeddedSubstance.length === 0) {
      return [];
    }

    // Filter items that have embeddings
    const validItems = embeddedSubstance.filter(item => item.hasEmbedding);
    if (validItems.length === 0) {
      console.warn('[SubstanceEmbedder] No embedded substance items available');
      return embeddedSubstance.slice(0, topK);
    }

    // Calculate similarity scores with keyword boosting
    const queryLower = (queryText || '').toLowerCase();
    const physicalElements = this.extractPhysicalElements(queryLower);
    
    const scoredItems = validItems.map(item => {
      const baseSimilarity = this.cosineSimilarity(queryEmbedding, item.embedding);
      
      // Keyword boost (same logic as retrieveRelevant)
      let keywordBoost = 0;
      if (physicalElements.length > 0 && item.keywords && Array.isArray(item.keywords)) {
        const itemKeywordsLower = item.keywords.map(k => k.toLowerCase());
        for (const element of physicalElements) {
          if (itemKeywordsLower.some(k => k.includes(element))) {
            keywordBoost += 0.15;
          }
        }
        const contentLower = (item.content || '').toLowerCase();
        const titleLower = (item.title || '').toLowerCase();
        for (const element of physicalElements) {
          if (contentLower.includes(element) || titleLower.includes(element)) {
            keywordBoost += 0.08;
          }
        }
      }
      
      return {
        ...item,
        similarityScore: Math.min(1.0, baseSimilarity + keywordBoost),
        _baseSimilarity: baseSimilarity,
        _keywordBoost: keywordBoost
      };
    });

    // Sort by similarity and filter by minimum score
    const rankedItems = scoredItems
      .filter(item => item.similarityScore >= minScore)
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, topK);

    // If we got too few results, add some high-confidence items
    if (rankedItems.length < 5) {
      const additionalItems = this.fallbackSelection(
        embeddedSubstance.filter(i => !rankedItems.find(r => r.id === i.id)),
        5 - rankedItems.length
      );
      rankedItems.push(...additionalItems);
    }

    return rankedItems;
  }
}
