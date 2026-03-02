/**
 * Edge Case Detector
 * 
 * Analytically screens responses and attachments for edge cases that don't fit the analysis structure.
 * Detects references to other responses, incomprehensible content, irrelevant content, etc.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';
import { getBatchSizeForStep } from '../utils/batch-calculator.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class EdgeCaseDetector {
  constructor(options = {}) {
    // Use LIGHT-PLUS complexity level for edge case screening (classification with medium reasoning)
    // Medium reasoning improves complexity classification accuracy for adaptive tier selection in MicroSummarizer
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'light-plus');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    this.model = this.client.model;
    
    // Log actual model being used
    console.log(`[EdgeCaseDetector] Initialized with model=${this.client.model}`);

    // Load consolidated screening prompt
    try {
      const screeningPath = join(__dirname, '../../prompts/edge-case-screening-prompt.md');
      this.screeningPrompt = readFileSync(screeningPath, 'utf-8');
    } catch (error) {
      console.warn('[EdgeCaseDetector] Could not load screening prompt template');
      this.screeningPrompt = null;
    }

    // Load comprehensive considerations prompt
    try {
      const comprehensivePath = join(__dirname, '../../prompts/comprehensive-considerations-prompt.md');
      this.comprehensivePrompt = readFileSync(comprehensivePath, 'utf-8');
    } catch (error) {
      console.warn('[EdgeCaseDetector] Could not load comprehensive considerations prompt template');
      this.comprehensivePrompt = null;
    }
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
  }

  /**
   * Screen a response for edge cases and determine how to handle it
   * @param {Object} response - Response to screen
   * @param {Array} allResponses - All responses (for reference resolution)
   * @param {string} materialSummary - Summarized hearing materials (for relevance checking)
   * @returns {Promise<Object>} Edge case report with handling instructions
   */
  async screenResponse(response, allResponses = [], materialSummary = '') {
    const responseText = response.text || '';
    if (!responseText.trim()) {
      return {
        responseNumber: response.id || response.responseNumber,
        analyzable: false,
        action: 'no-opinion',
        referencedNumbers: [],
        complexity: 'light',
        complexityFactors: {}
      };
    }

    // Use LLM to screen response (includes reference detection)
    const screeningResult = await this.screenWithLLM(responseText, materialSummary);

    // Return result with responseNumber
    return {
      responseNumber: response.id || response.responseNumber,
      analyzable: screeningResult.analyzable,
      action: screeningResult.action,
      referencedNumbers: screeningResult.referencedNumbers || [],
      complexity: screeningResult.complexity || 'medium',
      complexityFactors: screeningResult.complexityFactors || {}
    };
  }

  /**
   * Screen multiple responses in parallel batches
   * @param {Array} responses - Responses to screen
   * @param {Array} allResponses - All responses (for reference resolution)
   * @param {string} materialSummary - Summarized hearing materials
   * @param {Object} options - Options including batchSize (default: 10)
   * @returns {Promise<Array>} Array of edge case reports
   */
  async screenBatch(responses, allResponses = [], materialSummary = '', options = {}) {
    // Process responses in parallel batches (auto-calculated based on content & RPM/TPM)
    // OpenAI SDK handles rate limits with exponential backoff

    // Calculate context overhead (material summary + prompt template)
    const summaryChars = (materialSummary || '').length;
    const approxContextTokens = Math.ceil(summaryChars / 4) + 300; // +300 for prompt

    // Use content-aware batch size, but cap it for LLM context window if batching content
    // For content batching, we want a larger "logical" batch size (e.g. 20 items per prompt)
    // But we still need to respect parallelism limits.

    const useContentBatching = options.batchProcessing !== false; // Default to true
    const itemsPerPrompt = useContentBatching ? 20 : 1;

    const maxParallel = options.batchSize || getBatchSizeForStep('edge-case-screening', responses, {
      additionalContextTokens: approxContextTokens
    });

    const edgeCases = [];

    console.log(`[EdgeCaseDetector] Screening ${responses.length} responses. Content batching: ${useContentBatching ? 'ENABLED' : 'DISABLED'}`);

    if (useContentBatching) {
      // Group responses into chunks for content batching
      const batches = [];
      for (let i = 0; i < responses.length; i += itemsPerPrompt) {
        batches.push(responses.slice(i, i + itemsPerPrompt));
      }

      console.log(`[EdgeCaseDetector] Processing ${batches.length} content batches (size ${itemsPerPrompt})...`);

      // Process chunks in parallel (controlled by maxParallel)
      for (let i = 0; i < batches.length; i += maxParallel) {
        const parallelBatches = batches.slice(i, i + maxParallel);
        console.log(`[EdgeCaseDetector] Processing parallel group ${Math.floor(i / maxParallel) + 1}/${Math.ceil(batches.length / maxParallel)}...`);

        const batchPromises = parallelBatches.map(batchResponses =>
          this.screenBatchWithLLM(batchResponses, materialSummary)
            .catch(error => {
              console.error(`[EdgeCaseDetector] Failed to screen batch:`, error);
              // Fallback: mark all as skipped
              return batchResponses.map(r => ({
                responseNumber: r.id || r.responseNumber,
                analyzable: false,
                action: 'skip',
                referencedNumbers: [],
                complexity: 'medium',
                complexityFactors: {}
              }));
            })
        );

        const results = await Promise.all(batchPromises);
        results.forEach(result => edgeCases.push(...result));
      }
    } else {
      // Legacy individual processing
      // ... (existing logic if needed, or just remove if we fully commit)
      // For safety, let's keep the logic simple:

      // Large batch - process in chunks
      for (let i = 0; i < responses.length; i += maxParallel) {
        const batch = responses.slice(i, i + maxParallel);
        console.log(`[EdgeCaseDetector] Screening batch ${Math.floor(i / maxParallel) + 1}/${Math.ceil(responses.length / maxParallel)} (responses ${i + 1}-${Math.min(i + maxParallel, responses.length)}) in parallel...`);

        const batchPromises = batch.map(response =>
          this.screenResponse(response, allResponses, materialSummary)
            .catch(error => {
              console.error(`[EdgeCaseDetector] Failed to screen response ${response.id}:`, error);
              return {
                responseNumber: response.id || response.responseNumber,
                analyzable: false,
                action: 'skip',
                referencedNumbers: [],
                complexity: 'medium',
                complexityFactors: {}
              };
            })
        );

        const batchResults = await Promise.all(batchPromises);
        edgeCases.push(...batchResults);
      }
    }

    return edgeCases;
  }

  /**
   * Screen a batch of responses using a single LLM call
   * @param {Array} responses - Array of response objects
   * @param {string} materialSummary - Material summary
   * @returns {Promise<Array>} Array of screening results
   */
  async screenBatchWithLLM(responses, materialSummary) {
    // Filter out empty responses first
    const validResponses = responses.filter(r => (r.text || '').trim().length > 0);
    const emptyResponses = responses.filter(r => (r.text || '').trim().length === 0);

    if (validResponses.length === 0) {
      return emptyResponses.map(r => ({
        responseNumber: r.id || r.responseNumber,
        analyzable: false,
        action: 'no-opinion',
        referencedNumbers: []
      }));
    }

    const responsesText = validResponses.map(r =>
      `ID: ${r.id || r.responseNumber}\nTekst: ${(r.text || '').slice(0, 1000).replace(/\n/g, ' ')}`
    ).join('\n\n');

    const prompt = `Høringsmateriale (kontekst):
${materialSummary ? materialSummary.slice(0, 2000) : 'Ingen'}

Screen følgende høringssvar (antal: ${validResponses.length}). For hvert svar:
1. Vurder om det er analyserbart (indeholder holdninger)
2. Identificér henvisninger til andre svar
3. Vurder kompleksitetsniveau (light/medium/heavy)

Kompleksitetsniveauer:
- light: Kort, simpelt svar med én klar holdning
- medium: Standard kompleksitet med klar argumentation
- heavy: Juridiske/tekniske referencer (§, lokalplan), flere temaer, eller kræver ekspertise

Høringssvar:
${responsesText}

Returnér JSON liste:
{
  "results": [
    {
      "id": [ID fra teksten],
      "analyzable": true/false,
      "action": "analyze-normally" | "analyze-with-context" | "no-opinion",
      "referencedNumbers": [list af heltal],
      "complexity": "light" | "medium" | "heavy",
      "complexityFactors": {
        "legalRefs": true/false,
        "externalRefs": true/false,
        "technicalDensity": "low" | "medium" | "high",
        "multipleThemes": true/false,
        "hasAttachedContent": true/false
      }
    }
  ]
}`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i screening af høringssvar. Du behandler flere svar på én gang.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: "json_object" } // Use json_object for list wrapper
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        const resultsMap = new Map();
        if (parsed.results && Array.isArray(parsed.results)) {
          parsed.results.forEach(r => resultsMap.set(String(r.id), r));
        }

        // Map back to original order and merge with empty responses
        const batchResults = validResponses.map(r => {
          const id = r.id || r.responseNumber;
          const result = resultsMap.get(String(id));
          if (result) {
            let action = result.action || 'analyze-normally';
            const referencedNumbers = Array.isArray(result.referencedNumbers) ? result.referencedNumbers : [];
            
            // CRITICAL CONSISTENCY CHECK: If references exist, action MUST be 'analyze-with-context'
            if (referencedNumbers.length > 0 && action !== 'analyze-with-context') {
              console.warn(`[EdgeCaseDetector] Fixing inconsistent action for response ${id}: had references ${referencedNumbers.join(',')} but action was "${action}"`);
              action = 'analyze-with-context';
            }
            
            return {
              responseNumber: id,
              analyzable: Boolean(result.analyzable),
              action: action,
              referencedNumbers: referencedNumbers,
              complexity: result.complexity || 'medium',
              complexityFactors: result.complexityFactors || {}
            };
          } else {
            // Fallback if ID missing in output
            return {
              responseNumber: id,
              analyzable: true,
              action: 'analyze-normally',
              referencedNumbers: [],
              complexity: 'medium',
              complexityFactors: {}
            };
          }
        });

        // Add empty responses back
        const emptyResults = emptyResponses.map(r => ({
          responseNumber: r.id || r.responseNumber,
          analyzable: false,
          action: 'no-opinion',
          referencedNumbers: [],
          complexity: 'light',
          complexityFactors: {}
        }));

        return [...batchResults, ...emptyResults].sort((a, b) => a.responseNumber - b.responseNumber);
      }
    } catch (error) {
      console.error('[EdgeCaseDetector] Failed to screen batch:', error);
    }

    // Fallback: return default for all
    return responses.map(r => ({
      responseNumber: r.id || r.responseNumber,
      analyzable: true,
      action: 'analyze-normally',
      referencedNumbers: [],
      complexity: 'medium',
      complexityFactors: {}
    }));
  }

  /**
   * Screen response using LLM (consolidated screening with reference detection)
   * @param {string} responseText - Response text
   * @param {string} materialSummary - Material summary
   * @returns {Promise<Object>} Screening result
   */
  async screenWithLLM(responseText, materialSummary) {
    const prompt = this.screeningPrompt
      ? this.screeningPrompt
        .replace('{responseText}', responseText.slice(0, 2000))
        .replace('{materialSummary}', materialSummary || 'Ingen høringsmateriale tilgængeligt.')
      : `Vurder om følgende høringssvar er analyserbart, identificér eventuelle henvisninger til andre svar, og vurder kompleksitetsniveauet.

Høringssvar: ${responseText.slice(0, 2000)}

Høringsmateriale: ${materialSummary || 'Ingen høringsmateriale tilgængeligt.'}

Kompleksitetsniveauer:
- light: Kort, simpelt svar med én klar holdning
- medium: Standard kompleksitet med klar argumentation
- heavy: Juridiske/tekniske referencer (§, lokalplan), flere temaer, eller kræver ekspertise

Returnér JSON:
{
  "analyzable": true/false,
  "action": "analyze-normally" | "analyze-with-context" | "no-opinion",
  "referencedNumbers": [list af heltal],
  "complexity": "light" | "medium" | "heavy",
  "complexityFactors": {
    "legalRefs": true/false,
    "externalRefs": true/false,
    "technicalDensity": "low" | "medium" | "high",
    "multipleThemes": true/false,
    "hasAttachedContent": true/false
  }
}`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i screening af høringssvar for edge cases.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: getResponseFormat('edgeCaseScreening')
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        let action = parsed.action || 'analyze-normally';
        const referencedNumbers = Array.isArray(parsed.referencedNumbers) ? parsed.referencedNumbers : [];

        // CRITICAL CONSISTENCY CHECK: If references exist, action MUST be 'analyze-with-context'
        if (referencedNumbers.length > 0 && action !== 'analyze-with-context') {
          console.warn(`[EdgeCaseDetector] Fixing inconsistent action: had references ${referencedNumbers.join(',')} but action was "${action}"`);
          action = 'analyze-with-context';
        }

        return {
          analyzable: Boolean(parsed.analyzable),
          action: action,
          referencedNumbers: referencedNumbers,
          complexity: parsed.complexity || 'medium',
          complexityFactors: parsed.complexityFactors || {}
        };
      }
    } catch (error) {
      console.error('[EdgeCaseDetector] Failed to screen response:', error);
    }

    // Default: assume analyzable with medium complexity
    return {
      analyzable: true,
      action: 'analyze-normally',
      referencedNumbers: [],
      complexity: 'medium',
      complexityFactors: {}
    };
  }

  /**
   * Generate considerations text from edge cases
   */
  async generateConsiderations(edgeCases) {
    if (!edgeCases || edgeCases.length === 0) {
      return '';
    }

    const sections = [];

    // Reference cases (analyze-with-context)
    const referenceCases = edgeCases.filter(ec =>
      ec.action === 'analyze-with-context' && ec.referencedNumbers && ec.referencedNumbers.length > 0
    );
    if (referenceCases.length > 0) {
      const refNums = referenceCases.map(ec => ec.responseNumber).join(', ');
      const refDetails = referenceCases.map(ec =>
        `henvendelse ${ec.responseNumber} (henviser til ${ec.referencedNumbers.join(', ')})`
      ).join('; ');
      sections.push(`*henvisninger til andre høringssvar*\n${referenceCases.length} høringssvar (${refNums}) henviser til andre høringssvar. Disse er håndteret ved at inkludere kontekst fra de refererede svar i analysen: ${refDetails}.`);
    }

    return sections.length > 0 ? `**Edge cases og særlige forhold**\n${sections.join('\n\n')}` : '';
  }

  /**
   * Generate comprehensive considerations including primary analysis, patterns, and structure rationale
   * @param {Object} analysisContext - Context including edge cases, themes, aggregation, materials, responses
   * @returns {Promise<string>} Comprehensive considerations text
   */
  async generateComprehensiveConsiderations(analysisContext) {
    const {
      edgeCases = [],
      themes = [],
      aggregation = [],
      materialSummary = '',
      responses = [],
      microSummaries = []
    } = analysisContext;

    // Calculate statistics
    const totalResponses = responses.length;
    // Count analyzable responses (not no-opinion)
    const analyzableResponses = edgeCases.length > 0
      ? edgeCases.filter(ec => ec.analyzable !== false && ec.action !== 'no-opinion').length
      : responses.length;
    const noOpinionResponses = edgeCases.filter(ec => ec.action === 'no-opinion').length;
    const specialHandlingResponses = edgeCases.filter(ec =>
      ec.action !== 'analyze-normally' && ec.action !== 'no-opinion'
    ).length;

    // Generate edge cases summary
    const edgeCasesSummary = this.generateEdgeCasesSummary(edgeCases);

    // Generate themes summary
    const themesSummary = themes.map(t => `- ${t.name}`).join('\n') || 'Ingen temaer identificeret';

    // Generate aggregation summary
    const aggregationSummary = aggregation.map(theme => {
      const positionCount = theme.positions?.length || 0;
      const totalResponsesInTheme = theme.positions?.reduce((sum, pos) => sum + (pos.responseNumbers?.length || 0), 0) || 0;
      return `- ${theme.name}: ${positionCount} holdningsgrupper, ${totalResponsesInTheme} høringssvar`;
    }).join('\n') || 'Ingen aggregeret struktur';

    // Build prompt
    const prompt = this.comprehensivePrompt
      ? this.comprehensivePrompt
        .replace('{materialSummary}', materialSummary || 'Ingen høringsmateriale tilgængeligt.')
        .replace('{totalResponses}', totalResponses.toString())
        .replace('{analyzableResponses}', analyzableResponses.toString())
        .replace('{skippedResponses}', noOpinionResponses.toString())
        .replace('{specialHandlingResponses}', specialHandlingResponses.toString())
        .replace('{edgeCasesSummary}', edgeCasesSummary)
        .replace('{themesSummary}', themesSummary)
        .replace('{aggregationSummary}', aggregationSummary)
      : `Generér omfattende overvejelser om analysen baseret på følgende data:

Høringsmateriale (opsummering):
${materialSummary || 'Ingen høringsmateriale tilgængeligt.'}

Høringssvar oversigt:
- Total antal høringssvar: ${totalResponses}
- Antal analyserbare høringssvar: ${analyzableResponses}
- Antal høringssvar uden holdning: ${noOpinionResponses}
- Antal høringssvar med særlig håndtering: ${specialHandlingResponses}

Edge cases:
${edgeCasesSummary}

Temaer identificeret:
${themesSummary}

Aggregeret struktur:
${aggregationSummary}

Generér en omfattende overvejelse der dækker primært udgangspunkt, mønstre og tendenser, begrundelse for struktur, og edge cases.`;

    try {
      // Use HEAVY complexity for comprehensive considerations (complex synthesis)
      const complexityConfig = getComplexityConfig('heavy');
      const heavyClient = new OpenAIClientWrapper({
        model: complexityConfig.model,
        verbosity: complexityConfig.verbosity,
        reasoningEffort: complexityConfig.reasoningEffort
      });

      const response = await heavyClient.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en erfaren fuldmægtig der skal skabe en omfattende overvejelse om analysen af høringssvar.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
        // Note: GPT-5 models control temperature via verbosity/reasoning parameters
      });

      const content = response.choices[0]?.message?.content;
      if (content && content.trim()) {
        return content.trim();
      }
    } catch (error) {
      console.error('[EdgeCaseDetector] Failed to generate comprehensive considerations:', error);
    }

    // Fallback to edge cases only if LLM fails
    return await this.generateConsiderations(edgeCases) || 'Ingen særlige overvejelser.';
  }

  /**
   * Generate summary of edge cases for comprehensive considerations
   */
  generateEdgeCasesSummary(edgeCases) {
    if (!edgeCases || edgeCases.length === 0) {
      return 'Ingen edge cases identificeret.';
    }

    const sections = [];

    // Reference cases
    const referenceCases = edgeCases.filter(ec =>
      ec.action === 'analyze-with-context' && ec.referencedNumbers && ec.referencedNumbers.length > 0
    );
    if (referenceCases.length > 0) {
      const refNums = referenceCases.map(ec => ec.responseNumber).join(', ');
      sections.push(`henvisninger til andre høringssvar: ${referenceCases.length} høringssvar (${refNums}) henviser til andre høringssvar.`);
    }

    return sections.length > 0 ? sections.join(' ') : 'Ingen signifikante edge cases.';
  }
}

