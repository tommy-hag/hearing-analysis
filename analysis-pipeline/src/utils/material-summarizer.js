/**
 * Material Summarizer
 * 
 * Creates a concise summary of hearing materials.
 * Uses standard createCompletion() like all other modules.
 * 
 * Supports hierarchical summarization for large documents:
 * Large doc -> Chunks -> Summarize each -> Merge -> Final summary
 */

import { OpenAIClientWrapper, getComplexityConfig } from './openai-client.js';
import { PDFConverter } from './pdf-converter.js';
import { smartChunk } from './document-chunker.js';
import { limitConcurrency } from './concurrency.js';

export class MaterialSummarizer {
  constructor(options = {}) {
    // Use HEAVY complexity level for final synthesis (complex merge)
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'heavy');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    
    // Use LIGHT complexity level for chunk summaries (fast + cheap)
    // Chunk summaries are simple tasks - use minimal reasoning for speed
    const lightConfig = getComplexityConfig('light');
    this.lightClient = new OpenAIClientWrapper({
      model: lightConfig.model,
      verbosity: lightConfig.verbosity,
      reasoningEffort: 'low' // Explicit low reasoning for speed
    });
    
    // Log actual models being used
    console.log(`[MaterialSummarizer] Initialized with HEAVY=${this.client.model} (final), LIGHT=${this.lightClient.model} (chunks)`);
    
    this.maxSummaryLength = options.maxSummaryLength || 2000;
    this.pdfConverter = new PDFConverter(options.pdfConverter || {});
    
    // Chunking threshold - documents larger than this will use hierarchical summarization
    this.chunkThreshold = options.chunkThreshold || 15000;
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
    if (this.lightClient) this.lightClient.setJobId(jobId);
  }

  /**
   * Summarize hearing materials
   * Uses hierarchical summarization for large documents to avoid content cutoff.
   * @param {Array} materials - Hearing materials  
   * @returns {Promise<Object>} Object with summary string and convertedMaterials array
   */
  async summarize(materials) {
    if (!materials || materials.length === 0) {
      return { summary: '', convertedMaterials: [] };
    }

    // Try PDF conversion if contentMd is empty
    const convertedMaterials = await this.pdfConverter.convertMaterials(materials);

    // Extract contentMd from materials - NO CUTOFF per material
    const materialTexts = [];
    for (const material of convertedMaterials) {
      const title = material.title || 'Materiale';
      const content = material.contentMd || material.content || '';
      if (content && content.trim()) {
        // Only add title header if content doesn't already start with a header
        const hasExistingHeader = content.trim().startsWith('#');
        materialTexts.push(hasExistingHeader ? content : `## ${title}\n\n${content}`);
      }
    }

    const combinedText = materialTexts.join('\n\n').trim();
    
    // If no contentMd available, return empty
    if (combinedText.length === 0) {
      console.log('[MaterialSummarizer] No contentMd available, skipping');
      return { summary: '', convertedMaterials };
    }

    console.log(`[MaterialSummarizer] Material text: ${combinedText.length} chars (threshold: ${this.chunkThreshold})`);

    // If short enough, return as-is
    if (combinedText.length <= this.maxSummaryLength) {
      return { summary: combinedText, convertedMaterials };
    }

    // Check if single-pass summarization is sufficient
    if (combinedText.length <= this.chunkThreshold) {
      // Small document - single pass summarization
      console.log(`[MaterialSummarizer] Small document - single pass summarization`);
      const summary = await this.singlePassSummarize(combinedText);
      return { summary, convertedMaterials };
    }

    // Large document - hierarchical summarization
    console.log(`[MaterialSummarizer] Large document - using hierarchical summarization`);
    const summary = await this.hierarchicalSummarize(combinedText);
    return { summary, convertedMaterials };
  }

  /**
   * Single pass summarization for small documents
   */
  async singlePassSummarize(text) {
    const prompt = `Opsummér følgende høringsmateriale koncist i max ${this.maxSummaryLength} tegn:

${text}`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          { role: 'system', content: 'Du er specialist i at opsummere høringsmaterialer.' },
          { role: 'user', content: prompt }
        ]
      });

      const summary = response.choices[0]?.message?.content || '';
      return summary.slice(0, this.maxSummaryLength);
    } catch (error) {
      console.warn('[MaterialSummarizer] Single pass failed:', error.message);
      return text.slice(0, this.maxSummaryLength);
    }
  }

  /**
   * Hierarchical summarization for large documents
   * Step 1: Chunk the document
   * Step 2: Summarize each chunk in parallel
   * Step 3: Combine chunk summaries into final summary
   */
  async hierarchicalSummarize(text) {
    // Split into chunks
    const chunks = smartChunk(text, {
      maxChunkSize: 12000,  // Smaller chunks for better summarization
      minChunkSize: 3000,
      overlapSize: 500,
      preferHeaderBreaks: true
    });

    console.log(`[MaterialSummarizer] Split into ${chunks.length} chunks for hierarchical summarization`);

    // Step 1: Summarize each chunk with limited concurrency to avoid API overload
    const chunkTasks = chunks.map((chunk, idx) => async () => {
      try {
        return await this.summarizeChunk(chunk.text, idx + 1, chunks.length);
      } catch (err) {
        console.warn(`[MaterialSummarizer] Chunk ${idx + 1} failed: ${err.message}`);
        // Fallback: return truncated chunk
        return chunk.text.slice(0, 500) + '...';
      }
    });

    // Limit to 5 concurrent API calls to prevent timeouts
    const chunkSummaries = await limitConcurrency(chunkTasks, 5);
    console.log(`[MaterialSummarizer] Got ${chunkSummaries.length} chunk summaries`);

    // Step 2: Combine summaries into final summary
    const mergedSummaries = chunkSummaries
      .filter(s => s && s.trim())
      .join('\n\n---\n\n');

    // If merged summaries are short enough, use directly
    if (mergedSummaries.length <= this.maxSummaryLength) {
      return mergedSummaries;
    }

    // Otherwise, create a final summary from the merged chunk summaries
    console.log(`[MaterialSummarizer] Creating final summary from ${mergedSummaries.length} chars of chunk summaries`);
    
    const finalPrompt = `Du har fået opsummeringer af forskellige dele af et høringsmateriale.
Lav én samlet opsummering (max ${this.maxSummaryLength} tegn) der dækker alle hovedpunkter:

${mergedSummaries}`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          { role: 'system', content: 'Du sammenfatter delopsummeringer til én helhed.' },
          { role: 'user', content: finalPrompt }
        ]
      });

      const summary = response.choices[0]?.message?.content || '';
      return summary.slice(0, this.maxSummaryLength);
    } catch (error) {
      console.warn('[MaterialSummarizer] Final summary failed:', error.message);
      return mergedSummaries.slice(0, this.maxSummaryLength);
    }
  }

  /**
   * Summarize a single chunk
   * Uses LIGHT model for cost optimization - chunk summaries are simpler tasks
   */
  async summarizeChunk(chunkText, chunkNum, totalChunks) {
    const maxChunkSummary = Math.ceil(this.maxSummaryLength / Math.max(totalChunks, 1)) + 200;
    
    const prompt = `Opsummér denne del (${chunkNum}/${totalChunks}) af høringsmaterialet (max ${maxChunkSummary} tegn).
Fokusér på hovedpunkter og konkret indhold:

${chunkText}`;

    // Use lightClient for chunk summaries (cost optimization)
    const response = await this.lightClient.createCompletion({
      messages: [
        { role: 'system', content: 'Du opsummerer dele af høringsmaterialer koncist.' },
        { role: 'user', content: prompt }
      ]
    });

    const summary = response.choices[0]?.message?.content || '';
    console.log(`[MaterialSummarizer] Chunk ${chunkNum}/${totalChunks} summarized: ${summary.length} chars`);
    return summary;
  }

  /**
   * Create a "Lite" summary for context-heavy operations
   * Focuses strictly on Title, Purpose, and Key Proposals
   * Max 800 chars to save tokens
   * 
   * Uses hierarchical approach for large documents.
   */
  async summarizeLite(materials) {
    // Extract content from materials - NO artificial cutoff
    const materialTexts = [];
    for (const material of materials) {
      const title = material.title || 'Materiale';
      const content = material.contentMd || material.content || '';
      if (content && content.trim()) {
        const hasExistingHeader = content.trim().startsWith('#');
        materialTexts.push(hasExistingHeader ? content : `## ${title}\n\n${content}`);
      }
    }

    const combinedText = materialTexts.join('\n\n').trim();
    if (!combinedText) return '';

    const liteMaxLength = 800;
    const liteChunkThreshold = 10000;

    console.log(`[MaterialSummarizer] Lite summary: ${combinedText.length} chars (threshold: ${liteChunkThreshold})`);

    // Small document - single pass
    if (combinedText.length <= liteChunkThreshold) {
      return this.singlePassLiteSummarize(combinedText, liteMaxLength);
    }

    // Large document - hierarchical approach
    console.log(`[MaterialSummarizer] Lite: using hierarchical approach for large document`);
    
    const chunks = smartChunk(combinedText, {
      maxChunkSize: 8000,
      minChunkSize: 2000,
      overlapSize: 300,
      preferHeaderBreaks: true
    });

    // Extract key points from each chunk with limited concurrency to avoid API overload
    const keyPointTasks = chunks.map((chunk, idx) => async () => {
      try {
        return await this.extractLiteKeyPoints(chunk.text, idx + 1, chunks.length);
      } catch (err) {
        console.warn(`[MaterialSummarizer] Lite chunk ${idx + 1} failed: ${err.message}`);
        return '';
      }
    });

    // Limit to 5 concurrent API calls to prevent timeouts
    const keyPoints = await limitConcurrency(keyPointTasks, 5);
    const mergedPoints = keyPoints.filter(p => p && p.trim()).join('\n');

    // Final lite summary from key points
    if (mergedPoints.length <= liteMaxLength) {
      return mergedPoints;
    }

    return this.singlePassLiteSummarize(mergedPoints, liteMaxLength);
  }

  /**
   * Single pass lite summarization
   */
  async singlePassLiteSummarize(text, maxLength = 800) {
    const prompt = `Lav en ultrakort "Lite" opsummering af dette høringsmateriale (max ${maxLength} tegn).
Fokusér KUN på:
1. Hvad er titlen/emnet?
2. Hvad er hovedformålet? (fx "opføre 5 etager", "nedrive bygning")
3. Hvad er de vigtigste konkrete ændringer?

Udelad alle detaljer om proces, paragraffer, miljørapporter osv.

Tekst:
${text}`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          { role: 'system', content: 'Du laver ultrakorte resumeer.' },
          { role: 'user', content: prompt }
        ]
      });
      return response.choices[0]?.message?.content || '';
    } catch (error) {
      console.warn('[MaterialSummarizer] Lite summary failed, returning truncated text');
      return text.slice(0, maxLength);
    }
  }

  /**
   * Extract key points from a chunk for lite summary
   * Uses LIGHT model for cost optimization
   */
  async extractLiteKeyPoints(chunkText, chunkNum, totalChunks) {
    const prompt = `Ekstraher de 2-3 vigtigste nøglepunkter fra denne del (${chunkNum}/${totalChunks}).
Kun titel, formål og konkrete ændringer. Max 150 tegn total. Stikord er fint.

${chunkText}`;

    // Use lightClient for key point extraction (cost optimization)
    const response = await this.lightClient.createCompletion({
      messages: [
        { role: 'system', content: 'Du ekstraherer nøglepunkter ultrakort.' },
        { role: 'user', content: prompt }
      ]
    });

    return response.choices[0]?.message?.content || '';
  }
}
