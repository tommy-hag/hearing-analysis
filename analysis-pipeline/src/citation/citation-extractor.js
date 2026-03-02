/**
 * Citation Extractor
 * 
 * Extracts exact citations from responses using vector search and validation.
 */

import { HybridRetriever } from '../retrieval/hybrid-retriever.js';
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { findFlexibleQuote } from '../utils/text-matcher.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class CitationExtractor {
  constructor(options = {}) {
    // OPTIMIZATION: Check for specific citation model override (gpt-5-nano for cost savings)
    // Falls back to medium-plus complexity if not set
    const citationModel = process.env.LLM_CITATION_MODEL;
    const citationVerbosity = process.env.LLM_CITATION_VERBOSITY;
    const citationReasoning = process.env.LLM_CITATION_REASONING_LEVEL;
    
    let config;
    if (citationModel && citationVerbosity && citationReasoning) {
      // Use specific citation overrides (optimized for cost)
      config = {
        model: citationModel,
        verbosity: citationVerbosity,
        reasoningEffort: citationReasoning
      };
      console.log('[CitationExtractor] Using optimized citation model:', citationModel);
    } else {
      // Fall back to medium-plus complexity
      config = getComplexityConfig(options.complexityLevel || 'medium-plus');
    }
    
    this.client = new OpenAIClientWrapper({
      model: options.model || config.model,
      verbosity: options.verbosity || config.verbosity,
      reasoningEffort: options.reasoningEffort || config.reasoningEffort,
      timeout: options.timeout || 180000 // 180 second (3 min) timeout for high-quality citation extraction
    });
    this.model = this.client.model;
    this.retriever = new HybridRetriever(options);
    
    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/citation-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[CitationExtractor] Could not load prompt template');
      this.promptTemplate = null;
    }
  }

  /**
   * Extract citation for a specific response number and query
   * @param {number} responseNumber - Response number
   * @param {string} query - Query context for citation
   * @param {string} fullResponseText - Full response text
   * @param {string} highlightContextual - Contextual highlight text
   * @param {Array} allChunks - All chunks (for vector search fallback)
   * @returns {Promise<Object>} Citation object
   */
  async extractCitation(responseNumber, query, fullResponseText, highlightContextual, allChunks = []) {
    // First try: Use LLM to find exact citation
    try {
      const citation = await this.extractWithLLM(responseNumber, query, fullResponseText, highlightContextual);
      
      // Validate citation exists in source
      if (this.validateCitation(citation.citation, fullResponseText)) {
        return {
          found: true,
          citation: citation.citation,
          startOffset: citation.startOffset || null,
          endOffset: citation.endOffset || null,
          confidence: citation.confidence || 0.9,
          method: 'llm',
          notes: citation.notes || ''
        };
      }
    } catch (error) {
      console.warn(`[CitationExtractor] LLM extraction failed: ${error.message}`);
    }

    // Fallback: Use vector search (skip if embeddings are pruned)
    const embeddingsPruned = allChunks.some(c => c._embeddingPruned);
    if (allChunks.length > 0 && !embeddingsPruned) {
      try {
        const vectorCitation = await this.extractWithVectorSearch(responseNumber, query, allChunks);
        if (vectorCitation.found) {
          return vectorCitation;
        }
      } catch (error) {
        console.warn(`[CitationExtractor] Vector search failed: ${error.message}`);
      }
    } else if (embeddingsPruned) {
      // Skip vector search when embeddings are pruned (optimization)
      // LLM extraction + fuzzy matching are sufficient
    }

    // Final fallback: Fuzzy matching
    return this.extractWithFuzzyMatch(query, fullResponseText, responseNumber);
  }

  /**
   * Extract citation using LLM
   */
  async extractWithLLM(responseNumber, query, fullResponseText, highlightContextual) {
    const prompt = this.buildPrompt(responseNumber, query, fullResponseText, highlightContextual);

    // For Responses API, we can't use json_object format (requires strict schema)
    // Instead, we'll request JSON in the prompt and parse it manually
    // Note: GPT-5 models don't support temperature parameter - it's controlled via verbosity/reasoning
    const response = await this.client.createCompletion({
      messages: [
        {
          role: 'system',
          content: 'Du er en specialist i at finde eksakte citater fra høringssvar. Returnér ALTID gyldig JSON uden markdown formatering eller kodeblokke - kun ren JSON. Hold svaret kort og præcist.'
        },
        {
          role: 'user',
          content: prompt + '\n\nVIGTIGT: Returnér KUN gyldig JSON uden markdown formatering. Start direkte med { og slut med }. Hold citatet kort (1-3 sætninger).'
        }
      ]
      // Don't use response_format for responses API - it requires strict schema
      // Don't use temperature - GPT-5 models don't support it (use verbosity/reasoning instead)
    });

    let content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in completion');
    }

    // Clean content: remove markdown code blocks if present
    content = content.trim();
    if (content.startsWith('```json')) {
      content = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    } else if (content.startsWith('```')) {
      content = content.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    }
    content = content.trim();

    // Try to extract JSON if wrapped in other text
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      content = jsonMatch[0];
    }

    // Clean control characters that break JSON parsing (but keep newlines and tabs)
    content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    const parsed = JSON.parse(content);
    
    // Format citation
    // Note: LLM might return citation already formatted, so check for that
    let citationText = parsed.citation || '';
    
    // Remove any existing formatting if LLM already formatted it
    citationText = citationText.replace(/^\*\*Henvendelse \d+\*\*\s*\n?\s*\*?"?/i, '');
    citationText = citationText.replace(/\*"?\s*$/, '');
    citationText = citationText.trim();
    
    // Format citation properly
    const formattedCitation = `**Henvendelse ${responseNumber}**\n*"${citationText}"*`;

    return {
      citation: formattedCitation,
      startOffset: parsed.startOffset || null,
      endOffset: parsed.endOffset || null,
      confidence: parsed.confidence || 0.9,
      notes: parsed.notes || ''
    };
  }

  /**
   * Build prompt for citation extraction
   */
  buildPrompt(responseNumber, query, fullResponseText, highlightContextual) {
    // Truncate fullResponseText to avoid timeout (max 3000 chars)
    // Keep the full text for validation, but use truncated version in prompt
    const maxTextLength = 3000;
    const safeFullText = fullResponseText || '';
    const truncatedText = safeFullText.length > maxTextLength 
      ? safeFullText.slice(0, maxTextLength) + '\n\n[... tekst afkortet for at spare tokens ...]'
      : safeFullText;
    
    // Also truncate query and highlightContextual if too long
    const maxQueryLength = 500;
    const safeQuery = query || '';
    const safeHighlight = highlightContextual || '';
    const truncatedQuery = safeQuery.length > maxQueryLength ? safeQuery.slice(0, maxQueryLength) + '...' : safeQuery;
    const truncatedHighlight = safeHighlight.length > maxQueryLength 
      ? safeHighlight.slice(0, maxQueryLength) + '...' 
      : safeHighlight;
    
    if (this.promptTemplate) {
      return this.promptTemplate
        .replace('{summary}', truncatedQuery)
        .replace('{highlightContextual}', truncatedHighlight)
        .replace('{responseNumber}', String(responseNumber))
        .replace('{fullResponseText}', truncatedText);
    }

    // Fallback prompt
    return `Find det eksakte citat fra høringssvaret der understøtter følgende opsummering:

Opsummering: "${truncatedQuery}"
Kontekstuel reference: "${truncatedHighlight}"
Svarnummer: ${responseNumber}

Høringssvar tekst:
"${truncatedText}"

Find det eksakte citat (1:1 fra teksten, ingen rettelser) og returnér JSON med citation, startOffset, endOffset og confidence.`;
  }

  /**
   * Extract citation using vector search
   */
  async extractWithVectorSearch(responseNumber, query, chunks) {
    // Filter chunks by response number
    const relevantChunks = chunks.filter(chunk => 
      chunk.responseNumber === responseNumber ||
      chunk.source?.includes(`response:${responseNumber}`) ||
      chunk.source?.includes(`svarnummer_${responseNumber}`)
    );

    if (relevantChunks.length === 0) {
      return { found: false };
    }

    // Retrieve most relevant chunk
    const results = await this.retriever.retrieve(query, relevantChunks, { topK: 1 });

    if (results.length === 0) {
      return { found: false };
    }

    const topChunk = results[0].chunk;
    const citationText = topChunk.content || '';

    return {
      found: true,
      citation: `**Henvendelse ${responseNumber}**\n*"${citationText}"*`,
      startOffset: topChunk.charOffset || null,
      endOffset: topChunk.charOffset ? topChunk.charOffset + citationText.length : null,
      confidence: results[0].score || 0.7,
      method: 'vector-search',
      notes: 'Found via vector search'
    };
  }

  /**
   * Extract citation using fuzzy matching
   */
  extractWithFuzzyMatch(query, fullResponseText, responseNumber) {
    // Simple approach: find sentences that contain query terms
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const sentences = fullResponseText.split(/[.!?]\s+/);

    let bestMatch = null;
    let bestScore = 0;

    sentences.forEach(sentence => {
      const lowerSentence = sentence.toLowerCase();
      const matches = queryTerms.filter(term => lowerSentence.includes(term)).length;
      const score = matches / queryTerms.length;

      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = sentence.trim();
      }
    });

    if (bestMatch) {
      return {
        found: true,
        citation: `**Henvendelse ${responseNumber}**\n*"${bestMatch}"*`,
        confidence: bestScore,
        method: 'fuzzy-match',
        notes: 'Found via fuzzy matching - verify accuracy'
      };
    }

    return {
      found: false,
      citation: null,
      confidence: 0,
      method: 'none',
      notes: 'Could not find citation'
    };
  }

  /**
   * Validate that citation exists in source text
   */
  validateCitation(citation, sourceText) {
    if (!citation || !sourceText) {
      return false;
    }

    // Extract actual citation text (remove formatting)
    const citationMatch = citation.match(/\*"([^"]+)"\*/);
    if (!citationMatch) {
      return false;
    }

    const citationText = citationMatch[1].trim();

    // Check for flexible match
    const match = findFlexibleQuote(sourceText, citationText);
    return match.found;
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

