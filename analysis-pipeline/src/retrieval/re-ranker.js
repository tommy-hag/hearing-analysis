/**
 * Re-ranker
 * 
 * Re-ranks retrieved chunks using cross-encoder approach (can use OpenAI for scoring).
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class ReRanker {
  constructor(options = {}) {
    try {
      // Use MEDIUM complexity level for re-ranking (scoring many chunks)
      const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium');
      this.client = new OpenAIClientWrapper({
        model: options.model || complexityConfig.model,
        verbosity: options.verbosity || complexityConfig.verbosity,
        reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
      });
      this.model = this.client.model;
      this.enabled = options.enabled !== false;
    } catch (error) {
      console.warn('[ReRanker] Failed to initialize OpenAI client, re-ranking will be disabled:', error.message);
      this.client = null;
      this.enabled = false;
    }

    this.topK = options.topK || 10;
    
    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/reranker-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[ReRanker] Could not load prompt template');
      this.promptTemplate = null;
    }
  }

  /**
   * Re-rank chunks using relevance scoring
   * @param {string} query - Original query
   * @param {Array} chunks - Retrieved chunks to re-rank
   * @returns {Promise<Array>} Re-ranked chunks
   */
  async reRank(query, chunks) {
    if (!this.enabled || !chunks || chunks.length === 0) {
      return chunks;
    }

    if (chunks.length <= this.topK) {
      // No need to re-rank if we have fewer chunks than topK
      return chunks;
    }

    try {
      // Score chunks in batches
      const scores = await this.scoreChunks(query, chunks);

      // Combine scores with original scores
      const reRanked = chunks.map((chunk, idx) => ({
        ...chunk,
        relevanceScore: scores[idx] || 0,
        combinedScore: (chunk.score || 0) * 0.5 + (scores[idx] || 0) * 0.5
      }));

      // Sort by combined score
      reRanked.sort((a, b) => b.combinedScore - a.combinedScore);

      return reRanked.slice(0, this.topK);
    } catch (error) {
      console.error('[ReRanker] Failed to re-rank:', error);
      // Return original chunks on error
      return chunks.slice(0, this.topK);
    }
  }

  /**
   * Score chunks for relevance to query
   */
  async scoreChunks(query, chunks) {
    // Process in smaller batches to avoid token limits
    const batchSize = 5;
    const scores = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchScores = await this.scoreBatch(query, batch);
      scores.push(...batchScores);
    }

    return scores;
  }

  /**
   * Score a batch of chunks
   */
  async scoreBatch(query, chunks) {
    const chunksList = chunks.map((chunk, idx) => `${idx + 1}. ${(chunk.content || '').slice(0, 500)}`).join('\n\n');
    const prompt = this.promptTemplate
      ? this.promptTemplate
          .replace('{query}', query)
          .replace('{chunks}', chunksList)
      : `Du skal score relevansen af dokument-chunks i forhold til en søgeforespørgsel.

Søgeforespørgsel: "${query}"

Dokument-chunks:
${chunksList}

Score hver chunk på en skala fra 0.0 til 1.0 baseret på hvor relevant den er til søgeforespørgslen.
Returnér JSON array med scores:
[0.9, 0.7, 0.3, ...]`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i at vurdere dokument-relevans. Returnér kun JSON array med scores.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' }
        // Note: GPT-5 models control temperature via verbosity/reasoning parameters
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return chunks.map(() => 0.5); // Default score
      }

      const parsed = JSON.parse(content);
      const scores = parsed.scores || parsed || [];

      // Ensure we have the right number of scores
      while (scores.length < chunks.length) {
        scores.push(0.5);
      }

      return scores.slice(0, chunks.length).map(s => {
        const score = parseFloat(s);
        return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
      });
    } catch (error) {
      console.error('[ReRanker] Failed to score batch:', error);
      return chunks.map(() => 0.5); // Default score on error
    }
  }

  /**
   * Set Job ID for LLM tracing
   * @param {string} jobId - The job ID to set on the LLM client
   */
  setJobId(jobId) {
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
  }
}

