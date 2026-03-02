/**
 * Micro Summarizer
 * 
 * Per-response micro-summarization with structured keys (argument, consequence, desired action, material references).
 */

import { OpenAIClientWrapper } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';
import { getBatchSizeForStep } from '../utils/batch-calculator.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

import { getComplexityConfig } from '../utils/openai-client.js';
import { findFlexibleQuote } from '../utils/text-matcher.js';
import { LegalScopeContext } from './legal-scope-context.js';

export class MicroSummarizer {
  constructor(options = {}) {
    // Use MEDIUM-PLUS complexity level for micro-summarization
    // Quality (mini) + conciseness (medium verbosity) for better argument extraction
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium-plus');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    this.model = this.client.model;

    // Initialize LIGHT client for simple responses
    // This uses a faster, cheaper model (e.g. gpt-5-nano) for simple responses
    // Use light-plus for better extraction quality on small texts
    const lightConfig = getComplexityConfig('light-plus');
    this.lightClient = new OpenAIClientWrapper({
      model: options.lightModel || lightConfig.model,
      verbosity: options.lightVerbosity || lightConfig.verbosity,
      reasoningEffort: options.lightReasoningEffort || lightConfig.reasoningEffort
    });

    // Initialize HEAVY client for complex responses (legal refs, technical language, etc.)
    const heavyConfig = getComplexityConfig('heavy');
    this.heavyClient = new OpenAIClientWrapper({
      model: options.heavyModel || heavyConfig.model,
      verbosity: options.heavyVerbosity || heavyConfig.verbosity,
      reasoningEffort: options.heavyReasoningEffort || heavyConfig.reasoningEffort
    });

    // Log actual models being used
    console.log(`[MicroSummarizer] Initialized with LIGHT=${this.lightClient.model}, MEDIUM=${this.client.model}, HEAVY=${this.heavyClient.model}`);

    // Citation registry for preserving quotes
    this.citationRegistry = options.citationRegistry || null;

    // Initialize legal scope context for out-of-scope detection
    this.legalScopeContext = new LegalScopeContext(options);

    // RAG-based substance selection
    this.embeddedSubstance = null;
    this.substanceEmbedder = null;
    this.useRAGSubstance = false;

    // Pre-computed query embeddings for efficient RAG (avoids per-response API calls)
    this.preEmbeddedQueries = null; // Map<responseId, embedding>

    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/micro-summary-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[MicroSummarizer] Could not load prompt template, using default');
      this.promptTemplate = null;
    }
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
    if (this.lightClient) this.lightClient.setJobId(jobId);
    if (this.heavyClient) this.heavyClient.setJobId(jobId);
  }

  /**
   * Set embedded substance for RAG-based context selection
   * @param {Array} embeddedItems - Substance items with embeddings
   * @param {SubstanceEmbedder} embedder - Embedder for query embedding
   */
  setEmbeddedSubstance(embeddedItems, embedder) {
    this.embeddedSubstance = embeddedItems;
    this.substanceEmbedder = embedder;
    this.useRAGSubstance = embeddedItems && embeddedItems.length > 0 && embedder;
    
    if (this.useRAGSubstance) {
      const withEmbeddings = embeddedItems.filter(i => i.hasEmbedding).length;
      console.log(`[MicroSummarizer] RAG mode enabled: ${withEmbeddings}/${embeddedItems.length} items with embeddings`);
    }
  }

  /**
   * Set pre-computed query embeddings for efficient RAG lookup
   * This eliminates individual embedding API calls during processing
   *
   * @param {Map<string|number, Array>} embeddingsMap - Map of responseId → embedding vector
   */
  setPreEmbeddedQueries(embeddingsMap) {
    this.preEmbeddedQueries = embeddingsMap;
    if (embeddingsMap && embeddingsMap.size > 0) {
      console.log(`[MicroSummarizer] Pre-embedded queries loaded: ${embeddingsMap.size} responses`);
    }
  }

  /**
   * Set material summary for context.
   * This summary provides context about the hearing proposal.
   *
   * @param {string} materialSummary - Summary of the hearing material/proposal
   */
  setMaterialSummary(materialSummary) {
    this.materialSummary = materialSummary;
    if (materialSummary) {
      console.log(`[MicroSummarizer] Material summary set (${materialSummary.length} chars)`);
    }
  }

  /**
   * Infer complexity level from response text using heuristics.
   * Used when edge-case complexity data is not available.
   *
   * @param {string} text - Response text
   * @param {Object} edgeCase - Optional edge case data (may contain LLM-determined complexity)
   * @returns {'light'|'medium'|'heavy'} Complexity level
   */
  /**
   * Infer complexity level from response text and metadata using heuristics.
   * Used when edge-case complexity data is not available.
   *
   * @param {string} text - Response text
   * @param {Object} edgeCase - Optional edge case data (may contain LLM-determined complexity)
   * @param {Object} response - Optional full response object (may contain attachment metadata)
   * @returns {'light'|'medium'|'heavy'} Complexity level
   */
  inferComplexity(text, edgeCase = null, response = null) {
    // If edge case has LLM-determined complexity, use it
    if (edgeCase?.complexity) {
      return edgeCase.complexity;
    }

    // Heuristic complexity detection
    const length = (text || '').length;

    // Check for attachments from response metadata (more reliable than text detection)
    const hasAttachments = response?.hasAttachments || false;

    // Legal references: §, stk., lovbekendtgørelse, bekendtgørelse nr.
    const hasLegalRefs = /§\s*\d|stk\.\s*\d|lovbekendtgørelse|bekendtgørelse\s+nr/i.test(text);

    // External references: bilag, notat, vedlagt, se venligst, henvises til
    const hasExternalRefs = /bilag|notat|vedlagt|se venligst|henvises til/i.test(text);

    // Technical terms common in Danish planning context
    const hasTechnicalTerms = /lokalplan|miljøvurdering|VVM|kommuneplan|bevaringsværdi|servitut|dispensation/i.test(text);

    // Attached content indicators (articles, reports, etc. that are not the respondent's opinion)
    const hasAttachedContent = /^(vedlagt|bilag|artikel|rapport|notat):/im.test(text) ||
                              /se vedlagte|vedlagte dokument|vedlagte artikel/i.test(text);

    // Heavy: legal/external refs, attachments, or attached content always indicate complexity
    if (hasLegalRefs || hasExternalRefs || hasAttachedContent || hasAttachments) {
      return 'heavy';
    }

    // Length-based with technical term boost
    if (length < 200 && !hasTechnicalTerms) {
      return 'light';
    }
    if (length > 1500 || (length > 800 && hasTechnicalTerms)) {
      return 'heavy';
    }

    return 'medium';
  }

  /**
   * Get the appropriate OpenAI client for a given complexity level.
   *
   * @param {'light'|'medium'|'heavy'} complexity - Complexity level
   * @returns {OpenAIClientWrapper} The appropriate client
   */
  getClientForComplexity(complexity) {
    switch (complexity) {
      case 'light':
        return this.lightClient;
      case 'heavy':
        return this.heavyClient;
      case 'medium':
      default:
        return this.client;
    }
  }

  /**
   * Set feedback context for re-analysis runs
   * This context will be injected into prompts to address user corrections
   * @param {Object} feedbackContext - Context from FeedbackOrchestrator
   */
  setFeedbackContext(feedbackContext) {
    this.feedbackContext = feedbackContext;
    const contextNotes = feedbackContext.contextNotes?.length || 0;
    const highlightedContent = feedbackContext.highlightedContent?.length || 0;
    if (contextNotes > 0 || highlightedContent > 0) {
      console.log(`[MicroSummarizer] Feedback context set: ${contextNotes} context notes, ${highlightedContent} highlighted content items`);
    }
  }

  /**
   * Build feedback section for prompt injection
   * @param {number} responseNumber - Response number to filter feedback
   * @returns {string} Formatted feedback section for prompt
   * @private
   */
  buildFeedbackSection(responseNumber) {
    if (!this.feedbackContext) return '';

    const sections = [];

    // Add context notes
    const contextNotes = this.feedbackContext.contextNotes || [];
    const relevantContextNotes = contextNotes.filter(
      note => !note.responseNumber || note.responseNumber === responseNumber
    );
    if (relevantContextNotes.length > 0) {
      sections.push(`\n## Vigtig kontekst fra bruger\nFølgende kontekst-noter skal anvendes:\n${
        relevantContextNotes.map(note => `- ${note.text}`).join('\n')
      }`);
    }

    // Add highlighted content
    const highlighted = this.feedbackContext.highlightedContent || [];
    const relevantHighlighted = highlighted.filter(h => h.responseNumber === responseNumber);
    if (relevantHighlighted.length > 0) {
      sections.push(`\n## Vigtigt indhold fremhævet af bruger\nFølgende passager er markeret som vigtige og skal inkluderes:\n${
        relevantHighlighted.map(h => `- "${h.text}"`).join('\n')
      }`);
    }

    return sections.join('\n');
  }

  /**
   * Get relevant substance items for a response using RAG
   * Uses pre-computed embeddings if available (fast path), otherwise falls back to API call
   * 
   * @param {string} responseText - Response text to match against
   * @param {number} topK - Number of items to return
   * @param {string|number} responseId - Response ID for pre-computed embedding lookup
   * @returns {Promise<Array>} Relevant substance items
   */
  async getRelevantSubstance(responseText, topK = 8, responseId = null) {
    if (!this.useRAGSubstance || !this.substanceEmbedder) {
      return null; // Fallback to full substance
    }

    try {
      // OPTIMIZATION: Use pre-computed embedding if available (avoids API call)
      if (responseId && this.preEmbeddedQueries && this.preEmbeddedQueries.has(responseId)) {
        const preComputedEmbedding = this.preEmbeddedQueries.get(responseId);
        
        // Use synchronous RAG lookup with pre-computed embedding
        const relevantItems = this.substanceEmbedder.retrieveRelevantWithEmbedding(
          preComputedEmbedding,
          responseText,
          this.embeddedSubstance,
          { topK, minScore: 0.25 }
        );
        
        return relevantItems;
      }
      
      // Fallback: compute embedding on-the-fly (old behavior)
      // This path is used if pre-embedding failed or wasn't done
      const relevantItems = await this.substanceEmbedder.retrieveRelevant(
        responseText,
        this.embeddedSubstance,
        { topK, minScore: 0.25 }
      );
      
      return relevantItems;
    } catch (error) {
      console.warn(`[MicroSummarizer] RAG retrieval failed: ${error.message}, using fallback`);
      return null;
    }
  }

  /**
   * Format substance items for prompt inclusion
   * Groups by § reference to make it clear which section regulates which elements
   * IMPORTANT: IDs must be prominent for substanceRef anchoring
   * @param {Array} items - Substance items
   * @returns {string} Formatted text
   */
  formatSubstanceForPrompt(items) {
    if (!items || items.length === 0) {
      return 'Ingen relevant substans fundet.';
    }

    // Group items by § reference to make regulatory context clear
    const groupedBySection = new Map();

    for (const item of items) {
      // Extract § number from reference if present
      const ref = item.reference || 'Andre emner';
      const sectionMatch = ref.match(/§\s*\d+/);
      const sectionKey = sectionMatch ? sectionMatch[0] : ref;

      if (!groupedBySection.has(sectionKey)) {
        groupedBySection.set(sectionKey, {
          fullRef: ref,
          items: []
        });
      }
      groupedBySection.get(sectionKey).items.push(item);
    }

    // Format grouped output with PROMINENT IDs for substanceRef anchoring
    const sections = [];
    for (const [sectionKey, group] of groupedBySection) {
      const header = `**${sectionKey}** - ${group.fullRef}:`;
      const itemTexts = group.items.map(item => {
        const id = item.id || '';
        const title = item.title || '';
        const content = item.content || '';
        const score = item.similarityScore
          ? ` (relevans: ${(item.similarityScore * 100).toFixed(0)}%)`
          : '';
        // CRITICAL: ID in brackets and BOLD for easy LLM reference
        // Format: - **[LP-§5]** Titel: Indhold
        return `  - **[${id}]** ${title}: ${content}${score}`.trim();
      });
      sections.push(`${header}\n${itemTexts.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Get the legal scope context for external use (e.g., post-validation)
   * @returns {LegalScopeContext}
   */
  getLegalScopeContext() {
    return this.legalScopeContext;
  }

  /**
   * Build DYNAMIC theme corrections based on actual taxonomy from current hearing
   * Instead of hardcoded corrections, we use the actual theme names from the material
   * @param {Object} taxonomy - The taxonomy from material analysis
   * @returns {Object} Mapping of common variations to correct theme names
   */
  buildDynamicThemeCorrections(taxonomy) {
    const corrections = {
      // Generic catch-alls that are always valid
      'andet': 'Andre emner',
      'generelt': 'Andre emner',
      'øvrige': 'Andre emner'
    };

    if (!taxonomy || !taxonomy.themes || !Array.isArray(taxonomy.themes)) {
      return corrections;
    }

    // Build corrections based on actual theme names from this hearing's taxonomy
    for (const theme of taxonomy.themes) {
      const themeName = theme.name || '';
      const themeNameLower = themeName.toLowerCase().trim();
      
      // Skip empty or generic themes
      if (!themeNameLower || themeNameLower === 'andre emner' || themeNameLower === 'generelt') {
        continue;
      }

      // Generate common variations that should map to this exact theme name
      // Only add corrections for SHORTENED versions, not the other way around
      
      // If theme is "Støj og anden forurening", add "støj" → theme
      if (themeNameLower.includes('støj')) {
        corrections['støj'] = themeName;
        corrections['støjforhold'] = themeName;
        corrections['støjafskærmning'] = themeName;
        corrections['støj og miljø'] = themeName;
        corrections['miljø og støj'] = themeName;
      }
      
      // If theme is "Bebyggelsens omfang og placering", add "bebyggelse" → theme
      if (themeNameLower.includes('bebyggelse')) {
        corrections['bebyggelse'] = themeName;
        if (themeNameLower.includes('omfang')) {
          corrections['bygningshøjde'] = themeName;
          corrections['placering'] = themeName;
        }
      }
      
      // If theme is "Bil- og cykelparkering", add "parkering" → theme
      if (themeNameLower.includes('parkering')) {
        corrections['parkering'] = themeName;
        corrections['bilparkering'] = themeName;
        corrections['cykelparkering'] = themeName;
      }
      
      // Add the exact name as self-reference (preserves correct names)
      corrections[themeNameLower] = themeName;
    }

    return corrections;
  }

  /**
   * Build physical element → theme overrides based on taxonomy's regulates field
   * @param {Object} taxonomy - The taxonomy from material analysis
   * @returns {Array} Array of {keywords, correctTheme} objects
   */
  buildPhysicalElementOverrides(taxonomy) {
    const overrides = [];

    if (!taxonomy || !taxonomy.themes || !Array.isArray(taxonomy.themes)) {
      // Fallback to minimal static overrides if no taxonomy
      return [
        { keywords: ['højde', 'meter', 'etager'], correctTheme: 'Bebyggelsens omfang og placering' },
        { keywords: ['parkering', 'p-plads'], correctTheme: 'Bil- og cykelparkering' }
      ];
    }

    // Build overrides from the regulates field in taxonomy
    for (const theme of taxonomy.themes) {
      const themeName = theme.name || '';
      const regulates = theme.regulates || [];
      
      if (themeName && regulates.length > 0) {
        overrides.push({
          keywords: regulates.map(r => r.toLowerCase()),
          correctTheme: themeName
        });
      }
    }

    return overrides;
  }

  /**
   * Summarize a single response
   * @param {Object} response - Response object
   * @param {Array} materials - Hearing materials
   * @param {Array} allResponses - All responses (for reference resolution)
   * @param {Object} options - Options (including taxonomy)
   * @returns {Promise<Object>} Structured micro-summary
   */
  async summarizeResponse(response, materials, allResponses = [], options = {}) {
    const responseText = response.text || '';
    if (!responseText.trim()) {
      return {
        responseNumber: response.id || response.responseNumber,
        respondentName: response.respondentName || null,
        respondentType: response.respondentType || null,
        analyzable: false,
        arguments: [],
        edgeCaseFlags: {
          referencesOtherResponses: false,
          referencesOtherResponseNumbers: [],
          incomprehensible: false,
          irrelevant: true,
          notes: 'Empty response'
        }
      };
    }

    // Prepare context message (Static for Caching)
    // RAG OPTIMIZATION: If enabled, retrieve only relevant substance items for this response
    let materialsText;
    let ragUsed = false;
    let relevantSubstance = null; // Store for use in buildProposalContext

    if (this.useRAGSubstance) {
      const responseId = response.id || response.responseNumber;
      relevantSubstance = await this.getRelevantSubstance(responseText, 8, responseId);
      if (relevantSubstance && relevantSubstance.length > 0) {
        materialsText = this.formatSubstanceForPrompt(relevantSubstance);
        ragUsed = true;
        if (process.env.DEBUG) {
          console.log(`[MicroSummarizer] Response ${response.id}: RAG selected ${relevantSubstance.length} substance items (saved ~${Math.round((1 - materialsText.length / 15000) * 100)}% tokens)`);
        }
      } else {
        // Fallback to full materials
        materialsText = this.buildMaterialsText(materials);
      }
    } else {
      materialsText = this.buildMaterialsText(materials);
    }

    const taxonomyText = this.buildTaxonomyText(options.taxonomy);

    // Store taxonomy for use in validateAndCorrectThemes
    this.currentTaxonomy = options.taxonomy;

    const contextMessage = `BAGGRUNDSVIDEN (${ragUsed ? 'Relevant Substans - RAG' : 'Høringsmateriale'}):
${materialsText || 'Ingen materiale'}

TAKSONOMI (Temaer):
${taxonomyText}`;

    // Build dynamic prompt (Task specific)
    // Pass includeMaterials=false because we put it in contextMessage
    // Pass documentType for legal context (if available in taxonomy)
    // Pass relevantSubstance for precise direction classification
    const documentType = options.taxonomy?.documentType || options.documentType || null;
    const prompt = this.buildPrompt(response, materials, options.taxonomy, false, documentType, relevantSubstance);

    // Adaptive Model Selection based on complexity
    // Check if we have edge case data with LLM-determined complexity
    const edgeCase = options.edgeCases?.find(ec => ec.responseNumber === (response.id || response.responseNumber));
    const complexity = this.inferComplexity(responseText, edgeCase, response);
    const clientToUse = this.getClientForComplexity(complexity);

    // Always log complexity routing (useful for verification)
    const attachmentInfo = response.hasAttachments ? `, attachments=${response.attachmentFilenames?.length || 0}` : '';
    console.log(`[MicroSummarizer] Response ${response.id || response.responseNumber}: ${responseText.length} chars${attachmentInfo}, complexity=${complexity.toUpperCase()} → ${clientToUse.model}`);

    let attempts = 0;
    const maxAttempts = 2; // Allow 1 retry of the entire summarization process
    let lastError = null;

    while (attempts < maxAttempts) {
      attempts++;
      if (attempts > 1) {
        console.log(`[MicroSummarizer] Response ${response.id || response.responseNumber}: Re-running full summarization (attempt ${attempts}/${maxAttempts}) due to citation failures.`);
      }

      try {
        // Use json_schema for enforced JSON output
        const completion = await clientToUse.createCompletion({
          messages: [
            {
              role: 'system',
              content: 'Du er en erfaren fuldmægtig der analyserer høringssvar og ekstraherer strukturerede nøgler. Vær grundig og præcis.'
            },
            {
              role: 'user',
              content: contextMessage // Static context first for Caching
            },
            {
              role: 'user',
              content: prompt // Dynamic task
            }
          ],
          response_format: getResponseFormat('microSummary')
          // Note: GPT-5 models control temperature via verbosity/reasoning parameters
        });

        let content = completion.choices[0]?.message?.content;
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

        // Try to fix common JSON issues
        // Fix unescaped quotes in strings
        content = content.replace(/("(?:[^"\\]|\\.)*")\s*:\s*"([^"]*)"([,}])/g, (match, key, value, end) => {
          // Escape quotes in value
          const escapedValue = value.replace(/"/g, '\\"');
          return `${key}: "${escapedValue}"${end}`;
        });

        let summary;
        try {
          summary = JSON.parse(content);
        } catch (parseError) {
          // Try to fix trailing commas
          content = content.replace(/,(\s*[}\]])/g, '$1');
          try {
            summary = JSON.parse(content);
          } catch (e2) {
            // Last resort: try to extract just the arguments array
            const argsMatch = content.match(/"arguments"\s*:\s*\[([\s\S]*?)\]/);
            if (argsMatch) {
              try {
                const argsJson = `[${argsMatch[1]}]`;
                const args = JSON.parse(argsJson);
                summary = {
                  responseNumber: response.id || response.responseNumber,
                  respondentName: response.respondentName || null,
                  respondentType: response.respondentType || null,
                  analyzable: args.length > 0,
                  arguments: args,
                  edgeCaseFlags: {
                    referencesOtherResponses: false,
                    referencesOtherResponseNumbers: [],
                    incomprehensible: false,
                    irrelevant: false,
                    notes: ''
                  }
                };
              } catch (e3) {
                throw parseError; // Throw original error
              }
            } else {
              throw parseError; // Throw original error
            }
          }
        }

        // Validate and enhance summary
        let enhancedSummary = this.validateAndEnhanceSummary(summary, response, allResponses);

        // Retry quote extraction if needed
        if (enhancedSummary._needsQuoteRetry) {
          enhancedSummary = await this.retryQuoteExtraction(enhancedSummary, response);
        }

        // Check if we still have invalid quotes after extraction retry
        if (enhancedSummary._hasInvalidQuotes) {
          if (attempts < maxAttempts) {
            // Loop will continue and retry summarization
            continue;
          } else {
            // Out of attempts, perform fallback (remove invalid arguments)
            enhancedSummary = this.removeInvalidArguments(enhancedSummary);
          }
        }

        return enhancedSummary;
      } catch (error) {
        lastError = error;
        console.warn(`[MicroSummarizer] Attempt ${attempts} failed: ${error.message}`);

        if (attempts >= maxAttempts) {
          console.error(`[MicroSummarizer] Failed to summarize response ${response.id} after ${maxAttempts} attempts:`, lastError);
          break; // Fall through to error handler
        }
      }
    } // End of retry loop

    // If we get here, all attempts failed with exceptions
    console.error(`[MicroSummarizer] All attempts failed for response ${response.id}`);

    // Return fallback summary
    return {
      responseNumber: response.id || response.responseNumber,
      respondentName: response.respondentName || null,
      respondentType: response.respondentType || null,
      analyzable: false,
      arguments: [],
      edgeCaseFlags: {
        referencesOtherResponses: false,
        referencesOtherResponseNumbers: [],
        incomprehensible: true,
        irrelevant: false,
        notes: `Failed to analyze after ${maxAttempts} attempts: ${lastError ? lastError.message : 'Unknown error'}`
      }
    };
  }

  /**
   * Build prompt for micro-summarization
   * @param {Object} response - Response object
   * @param {Array|string} materials - Hearing materials
   * @param {Object} taxonomy - Taxonomy object with themes
   * @param {boolean} includeMaterials - Whether to include materials in prompt
   * @param {string} documentType - Document type for legal context (optional)
   * @param {Array} relevantSubstance - RAG-retrieved substance items for direction context (optional)
   */
  buildPrompt(response, materials, taxonomy, includeMaterials = true, documentType = null, relevantSubstance = null) {
    const responseNumber = response.id || response.responseNumber || '?';
    const respondentName = response.respondentName || 'Ukendt';
    const respondentType = response.respondentType || 'Borger';
    const responseText = response.text || '';

    // Format taxonomy if provided
    const taxonomyText = this.buildTaxonomyText(taxonomy);

    // Handle materials
    const materialsText = this.buildMaterialsText(materials);

    // Build legal context if document type is known
    const legalContextText = documentType
      ? this.legalScopeContext.buildContextForPrompt(documentType)
      : '';

    // Build proposal context with relevant substance for direction classification
    const proposalContextText = this.buildProposalContext(relevantSubstance);

    if (this.promptTemplate) {
      let filled = this.promptTemplate
        .replace('{responseNumber}', String(responseNumber))
        .replace('{respondentName}', String(respondentName))
        .replace('{respondentType}', String(respondentType))
        .replace('{responseText}', responseText)
        .replace('{taxonomy}', taxonomyText)
        .replace('{legalContext}', legalContextText)
        .replace('{proposalContext}', proposalContextText);

      if (includeMaterials) {
        filled = filled.replace('{materials}', materialsText || 'Ingen materiale');
      } else {
        // If we exclude materials (because they are in previous message),
        // we should replace the placeholder with a reference note or empty string
        filled = filled.replace('{materials}', '(Se baggrundsviden i tidligere besked)');
      }
      return filled;
    }

    // Fallback prompt
    return `Analysér følgende høringssvar og ekstraher strukturerede information:

Svarnummer: ${responseNumber}
Respondent: ${respondentName} (${respondentType})
Tekst: ${responseText}

${includeMaterials ? `Taksonomi (Temaer):
${taxonomyText}

Høringsmateriale:
${materialsText || 'Ingen materiale'}` : '(Se baggrundsviden for Taksonomi og Høringsmateriale)'}

${legalContextText}

${proposalContextText}

Returnér JSON med strukturerede argumenter, konsekvenser, materiale-referencer og edge case flags.`;
  }

  buildMaterialsText(materials) {
    if (typeof materials === 'string') {
      return materials.slice(0, 30000);
    } else if (Array.isArray(materials)) {
      return materials
        .map(m => `## ${m.title || 'Materiale'}\n${(m.contentMd || m.content || '').slice(0, 10000)}`)
        .join('\n\n')
        .slice(0, 30000);
    }
    return '';
  }

  /**
   * Build proposal context with relevant substance items for direction classification.
   * Uses RAG-retrieved substance when available, falls back to material summary.
   *
   * @param {Array} relevantSubstance - RAG-retrieved substance items for this response (optional)
   * @returns {string} Formatted context for direction classification
   */
  buildProposalContext(relevantSubstance = null) {
    // If we have relevant substance items, use them for precise direction context
    if (relevantSubstance && relevantSubstance.length > 0) {
      const substanceLines = relevantSubstance
        .slice(0, 5) // Top 5 most relevant
        .map(item => {
          const id = item.id || '';
          const title = item.title || '';
          const content = (item.content || '').slice(0, 150);
          return `- **[${id}]** ${title}: ${content}${content.length >= 150 ? '...' : ''}`;
        })
        .join('\n');

      return `
## Relevant substans for dette argument

Disse elementer fra høringsmaterialet er mest relevante for argumentet:

${substanceLines}

**Brug disse til direction-klassificering:** Sammenlign respondentens holdning med det konkrete indhold ovenfor.
`;
    }

    // Fallback to general material summary if no RAG substance
    if (!this.materialSummary) {
      return '';
    }

    return `
## Høringsmaterialets indhold (generelt)

${this.materialSummary}
`;
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
   * Attempt to repair malformed JSON
   * @private
   */
  repairJson(jsonString) {
    try {
      return JSON.parse(jsonString);
    } catch (e) {
      // Simple repairs
      let repaired = jsonString.trim();

      // Remove markdown code blocks if present
      repaired = repaired.replace(/^```json\s*/, '').replace(/\s*```$/, '');

      // Fix trailing commas
      repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

      // Try to close unclosed braces/brackets
      const openBraces = (repaired.match(/\{/g) || []).length;
      const closeBraces = (repaired.match(/\}/g) || []).length;
      const openBrackets = (repaired.match(/\[/g) || []).length;
      const closeBrackets = (repaired.match(/\]/g) || []).length;

      if (openBraces > closeBraces) repaired += '}'.repeat(openBraces - closeBraces);
      if (openBrackets > closeBrackets) repaired += ']'.repeat(openBrackets - closeBrackets);

      try {
        return JSON.parse(repaired);
      } catch (e2) {
        // Last resort: try to find the last valid JSON object
        try {
          const lastClose = repaired.lastIndexOf('}');
          if (lastClose > 0) {
            return JSON.parse(repaired.substring(0, lastClose + 1));
          }
        } catch (e3) {
          console.warn('[MicroSummarizer] JSON repair failed:', e.message);
          return null;
        }
        return null;
      }
    }
  }

  buildTaxonomyText(taxonomy) {
    if (taxonomy && taxonomy.themes && Array.isArray(taxonomy.themes)) {
      return taxonomy.themes
        .map(t => {
          // Include section reference if available for precise matching
          const sectionRef = t.sectionReference ? `[${t.sectionReference}] ` : '';
          
          // Include "regulates" information to help LLM choose correct theme
          // E.g., "Ubebyggede arealer" regulates ["boldbane", "legeplads"] - NOT "Støj"
          let regulatesInfo = '';
          if (t.regulates && Array.isArray(t.regulates) && t.regulates.length > 0) {
            regulatesInfo = ` (REGULERER: ${t.regulates.join(', ')})`;
          }
          
          return `- ${sectionRef}${t.name}: ${t.description || ''}${regulatesInfo}`;
        })
        .join('\n');
    } else if (taxonomy) {
      return String(taxonomy);
    }
    return 'Ingen taksonomi angivet - brug generelle temaer.';
  }

  /**
   * Validate and enhance summary
   */
  validateAndEnhanceSummary(summary, response, allResponses) {
    // CRITICAL: Always override responseNumber from the actual response object
    // LLM can return wrong responseNumber, causing mapping errors
    summary.responseNumber = response.id || response.responseNumber;
    
    // CRITICAL: Propagate respondentName and respondentType from input response
    // These are needed for proper labeling in position-writer (e.g., "Indre By Lokaludvalg")
    if (response.respondentName) {
      summary.respondentName = response.respondentName;
    }
    if (response.respondentType) {
      summary.respondentType = response.respondentType;
    }

    if (!summary.arguments || !Array.isArray(summary.arguments)) {
      summary.arguments = [];
    }

    if (!summary.edgeCaseFlags) {
      summary.edgeCaseFlags = {
        referencesOtherResponses: false,
        referencesOtherResponseNumbers: [],
        incomprehensible: false,
        irrelevant: false,
        notes: ''
      };
    }

    // Enhance edge case detection
    const responseText = (response.textMd || response.text || '').toLowerCase();

    // Check for references to other responses
    const referencePatterns = [
      /henvendelse\s+(\d+)/gi,
      /svarnummer\s+(\d+)/gi,
      /jeg er enig (?:med|i) (?:henvendelse|svaret|svar)\s+(\d+)/gi,
      /(?:henvendelse|svar)\s+(\d+)/gi
    ];

    const referencedNumbers = new Set();
    referencePatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const num = parseInt(match[1]);
        if (!isNaN(num) && num !== summary.responseNumber) {
          referencedNumbers.add(num);
        }
      }
    });

    if (referencedNumbers.size > 0) {
      summary.edgeCaseFlags.referencesOtherResponses = true;
      summary.edgeCaseFlags.referencesOtherResponseNumbers = Array.from(referencedNumbers);
    }

    // Check for "no comments" responses
    const noCommentsPatterns = [
      /ingen\s+bemærkninger/i,
      /ingen\s+kommentarer/i,
      /har\s+ikke\s+bemærkninger/i,
      /har\s+ikke\s+kommentarer/i,
      /ingen\s+indvendinger/i,
      /ingen\s+indsigelser/i
    ];

    const isNoComments = noCommentsPatterns.some(pattern => pattern.test(responseText));

    if (isNoComments && summary.arguments.length === 0) {
      // Mark as "no comments" response for special handling
      summary.edgeCaseFlags.noComments = true;
      summary.edgeCaseFlags.notes = summary.edgeCaseFlags.notes
        ? `${summary.edgeCaseFlags.notes}; Ingen bemærkninger`
        : 'Ingen bemærkninger';
    }

    // Validate arguments
    summary.arguments = summary.arguments.map(arg => {
      // CRITICAL FIX: Deduplicate relevantThemes - LLM sometimes outputs 400+ duplicates
      const rawThemes = Array.isArray(arg.relevantThemes) ? arg.relevantThemes : [];
      const uniqueThemes = [...new Set(rawThemes)];
      
      // Log if significant deduplication occurred (more than just 1-2 duplicates)
      if (rawThemes.length > uniqueThemes.length + 2) {
        console.warn(`[MicroSummarizer] ⚠️ Deduplicated relevantThemes for response ${summary.responseNumber}: ${rawThemes.length} → ${uniqueThemes.length}`);
      }
      
      // CRITICAL FIX: Validate and correct invalid themes
      // LLM sometimes returns hallucinated themes like "Støj og miljø" instead of "Støj og anden forurening"
      const validatedThemes = this.validateAndCorrectThemes(uniqueThemes, arg.what || '');
      
      // Validate substanceRefs against known IDs
      const rawSubstanceRefs = Array.isArray(arg.substanceRefs) ? arg.substanceRefs : [];
      const validatedSubstanceRefs = this.validateSubstanceRefs(rawSubstanceRefs);

      return {
        what: arg.what || '',
        why: arg.why || '',
        how: arg.how || '',
        direction: arg.direction || 'neutral', // pro_change | pro_status_quo | neutral
        consequence: arg.consequence || '',
        concern: arg.concern || '',
        sourceQuote: arg.sourceQuote || '',
        relevantThemes: validatedThemes,
        // Substance references - links argument to specific regulatory items in hearing material
        // Validated against known IDs from extract-substance
        substanceRefs: validatedSubstanceRefs,
        // Out-of-scope flag for arguments outside document's legal authority
        outOfScope: arg.outOfScope === true,
        // Add deprecated fields for backward compatibility
        coreContent: arg.what || arg.coreContent || '',
        desiredAction: arg.how || arg.desiredAction || ''
      };
    });

    // Verify all quotes are exact matches
    const responseTextForValidation = (response.textMd || response.text || '');
    if (summary.arguments && summary.arguments.length > 0 && responseTextForValidation) {
      // Filter out common irrelevant patterns from quotes
      const irrelevantPatterns = [
        /^Kære\s+[\w\s]+[,.]?$/i,
        /^Venlig\s+hilsen[\w\s,]*$/i,
        /^Med\s+venlig\s+hilsen[\w\s,]*$/i,
        /^Hilsen[\w\s,]*$/i,
        /^Mvh\.?[\w\s,]*$/i,
        /^Tak\s+for\s+[\w\s]+$/i
      ];

      const invalidQuotes = [];

      for (let i = 0; i < summary.arguments.length; i++) {
        const arg = summary.arguments[i];
        if (arg.sourceQuote) {
          // First check if quote is irrelevant
          const isIrrelevant = irrelevantPatterns.some(pattern => pattern.test(arg.sourceQuote.trim()));
          if (isIrrelevant) {
            invalidQuotes.push({
              index: i,
              quote: arg.sourceQuote,
              what: arg.what,
              reason: 'irrelevant'
            });
          }
          // Then check for exact match in source text
          else {
            const match = findFlexibleQuote(responseTextForValidation, arg.sourceQuote);
            const MIN_CONFIDENCE = 0.6; // Reject low-confidence matches to prevent hallucinations

            if (match.found && match.confidence >= MIN_CONFIDENCE) {
              // Auto-fix the quote to the exact source text to ensure consistency
              arg.sourceQuote = match.exactQuote;
            } else {
              const reason = match.found ? 'low_confidence' : 'not_found';
              invalidQuotes.push({
                index: i,
                quote: arg.sourceQuote,
                what: arg.what,
                reason: reason,
                confidence: match.confidence || 0
              });
            }
          }
        }
      }

      // If any quotes are invalid, retry with quote extraction only
      if (invalidQuotes.length > 0) {
        console.log(`[MicroSummarizer] Response ${summary.responseNumber}: Found ${invalidQuotes.length} invalid/irrelevant quotes. Initiating quote extraction retry...`);

        // Store invalid quotes info for potential retry after return
        summary._invalidQuotes = invalidQuotes;
        summary._needsQuoteRetry = true;
      }
    }

    summary.analyzable = summary.arguments.length > 0 &&
      !summary.edgeCaseFlags.incomprehensible &&
      !summary.edgeCaseFlags.irrelevant;

    return summary;
  }

  /**
   * Validate and correct hallucinated/invalid theme names
   * LLM sometimes returns themes that don't exist in the taxonomy
   * @param {Array} themes - Array of theme names from LLM
   * @param {string} argWhat - The argument's "what" field for context
   * @returns {Array} Corrected theme names
   */
  validateAndCorrectThemes(themes, argWhat) {
    if (!themes || !Array.isArray(themes) || themes.length === 0) {
      return ['Andre emner'];
    }

    const argLower = argWhat.toLowerCase();
    
    // =====================================================================
    // PRIORITY 1: §-REFERENCE BASED THEME CORRECTION
    // If argument explicitly mentions §-reference, that determines the theme
    // This overrides LLM's theme assignment because explicit legal references
    // are authoritative indicators of what the argument is about
    // =====================================================================
    const sectionToTheme = {
      // Standard lokalplan structure
      '3': 'Anvendelse',
      '4': 'Veje',  // Will be corrected to full name below
      '5': 'Parkering',  // Will be corrected to full name below
      '6': 'Bebyggelsens omfang og placering',
      '7': 'Bebyggelsens ydre fremtræden',
      '8': 'Ubebyggede arealer',  // Will be corrected to full name below
      '9': 'Beplantning',
      '10': 'Lednings- og forsyningsanlæg',
      '11': 'Miljø',
      '12': 'Grundejerforening'
    };
    
    // Extract §-references from argument text
    // Matches: §6, § 6, §6., § 6 stk, stk. 5, etc.
    const sectionMatch = argLower.match(/§\s*(\d+)/);
    if (sectionMatch) {
      const sectionNum = sectionMatch[1];
      const themeFromSection = sectionToTheme[sectionNum];
      
      if (themeFromSection) {
        console.log(`[MicroSummarizer] 📜 §-reference override: Found "§${sectionNum}" → using theme "${themeFromSection}" as PRIMARY`);
        // Return with the §-matched theme FIRST, then other themes
        const otherThemes = themes.filter(t => 
          t.toLowerCase() !== themeFromSection.toLowerCase()
        ).slice(0, 2); // Keep up to 2 other themes
        return [themeFromSection, ...otherThemes];
      }
    }

    // Build DYNAMIC theme corrections based on actual taxonomy from this hearing
    // This prevents hardcoded corrections that don't match the current material
    const themeCorrections = this.buildDynamicThemeCorrections(this.currentTaxonomy);
    
    // Context-based corrections using DYNAMIC physical element → theme mapping from taxonomy
    // Uses the `regulates` field to determine which theme regulates which physical elements
    const physicalElementOverrides = this.buildPhysicalElementOverrides(this.currentTaxonomy);
    
    // Generic themes that should be overridden when physical elements are present
    const genericThemes = ['formål og overblik', 'områdeafgrænsning og delområder', 'andre emner', 'generelt', 'formål'];
    
    // Check if we have a physical element override
    for (const override of physicalElementOverrides) {
      const hasKeyword = override.keywords.some(kw => argLower.includes(kw));
      if (hasKeyword) {
        // Check if any current theme is generic
        const hasGenericTheme = themes.some(t => genericThemes.includes(t.toLowerCase().trim()));
        if (hasGenericTheme) {
          console.log(`[MicroSummarizer] 🎯 Context override: Found "${override.keywords.find(kw => argLower.includes(kw))}" in argument, correcting generic theme to "${override.correctTheme}"`);
          // Replace generic themes with the correct one
          return [override.correctTheme];
        }
      }
    }

    const correctedThemes = [];
    let hadCorrection = false;

    for (const theme of themes) {
      const themeLower = theme.toLowerCase().trim();
      
      // Check if this theme needs correction
      if (themeCorrections[themeLower]) {
        const corrected = themeCorrections[themeLower];
        if (!correctedThemes.includes(corrected)) {
          correctedThemes.push(corrected);
          hadCorrection = true;
          console.log(`[MicroSummarizer] 🔧 Theme correction: "${theme}" → "${corrected}"`);
        }
      } else {
        // Keep original theme (might be valid)
        if (!correctedThemes.includes(theme)) {
          correctedThemes.push(theme);
        }
      }
    }

    // If all themes were invalid/corrected to same thing, ensure we have at least one
    if (correctedThemes.length === 0) {
      correctedThemes.push('Andre emner');
    }

    // Limit to max 3 themes to prevent spam
    if (correctedThemes.length > 3) {
      console.warn(`[MicroSummarizer] ⚠️ Too many themes (${correctedThemes.length}), keeping first 3`);
      return correctedThemes.slice(0, 3);
    }

    return correctedThemes;
  }

  /**
   * Set known substance IDs for validation
   * Call this before processing to enable substanceRef validation
   * @param {Array} substanceItems - Items from extract-substance output
   */
  setKnownSubstanceIds(substanceItems) {
    if (!substanceItems || !Array.isArray(substanceItems)) {
      this.knownSubstanceIds = new Set();
      return;
    }

    this.knownSubstanceIds = new Set(
      substanceItems.map(item => item.id).filter(Boolean)
    );

    console.log(`[MicroSummarizer] Loaded ${this.knownSubstanceIds.size} known substance IDs for validation`);
  }

  /**
   * Validate and correct substanceRefs against known substance IDs.
   * Fixes common mismatches like "LP-§6" when the actual ID is "LP-§6-stk1".
   *
   * @param {Array} substanceRefs - Array of substance reference IDs from LLM
   * @returns {Array} Validated/corrected substanceRefs
   */
  validateSubstanceRefs(substanceRefs) {
    if (!substanceRefs || !Array.isArray(substanceRefs) || substanceRefs.length === 0) {
      return [];
    }

    // If no known IDs loaded, just return as-is
    if (!this.knownSubstanceIds || this.knownSubstanceIds.size === 0) {
      return substanceRefs;
    }

    const validatedRefs = [];

    for (const ref of substanceRefs) {
      if (!ref || typeof ref !== 'string') continue;

      // STRICT: Only accept exact matches
      // No fuzzy fallback - if LLM generates wrong ID, we want to know
      if (this.knownSubstanceIds.has(ref)) {
        validatedRefs.push(ref);
      } else {
        // Log invalid ref for debugging, but don't include it
        console.warn(`[MicroSummarizer] Invalid substanceRef "${ref}" - not in known IDs (${this.knownSubstanceIds.size} available)`);
      }
    }

    return [...new Set(validatedRefs)]; // Deduplicate
  }

  /**
   * Build quote extraction prompt for retry
   */
  buildQuoteExtractionPrompt(responseText, args, invalidQuotes) {
    const prompt = `Find EKSAKTE citater fra følgende tekst som understøtter de givne argumenter. Citater SKAL være 100% identiske med kildeteksten.

KILDETEKST:
${responseText}

ARGUMENTER DER MANGLER VALIDE CITATER:
${invalidQuotes.map(({ index, what, reason }) => {
      const reasonText = reason === 'irrelevant' ? 'Citatet var irrelevant (fx "Kære..." eller "Venlig hilsen")' : 'Citatet blev ikke fundet i kildeteksten';
      return `${index + 1}. WHAT: ${what}\n   Problem: ${reasonText}`;
    }).join('\n\n')}

KRITISKE REGLER:
- Find EKSAKT 1-3 SAMMENHÆNGENDE sætninger fra kildeteksten
- **SAMMENHÆNGENDE betyder: Sætningerne skal komme DIREKTE efter hinanden - INGEN tekst må springes over**
- ❌ FORKERT: "Første sætning. [springer noget over] Tredje sætning."
- ✅ KORREKT: "Første sætning. Anden sætning." (kommer direkte efter hinanden)
- Kopier PRÆCIST inkl. alle mellemrum, tegnsætning, stavefejl, store/små bogstaver
- ALDRIG omskriv, ret (fx stavefejl) eller modificer citatet
- Hvis teksten indeholder fejl (fx "jeg syns"), kopier fejlen præcist ("jeg syns")
- Undgå irrelevante citater som "Kære København", "Venlig hilsen", osv.
- HVIS du ikke kan finde sammenhængende sætninger, brug KUN 1 sætning
- Hvis du ikke kan finde et eksakt match, brug en tom streng ""`;

    return prompt;
  }

  /**
   * Retry quote extraction for invalid quotes
   */
  async retryQuoteExtraction(summary, response, maxRetries = 3) {
    if (!summary._needsQuoteRetry || !summary._invalidQuotes || summary._invalidQuotes.length === 0) {
      return summary;
    }

    const responseTextForValidation = (response.textMd || response.text || '');
    let invalidQuotes = [...summary._invalidQuotes];
    delete summary._invalidQuotes;
    delete summary._needsQuoteRetry;

    // Filter out common irrelevant patterns
    const irrelevantPatterns = [
      /^Kære\s+[\w\s]+[,.]?$/i,
      /^Venlig\s+hilsen[\w\s,]*$/i,
      /^Med\s+venlig\s+hilsen[\w\s,]*$/i,
      /^Hilsen[\w\s,]*$/i,
      /^Mvh\.?[\w\s,]*$/i,
      /^Tak\s+for\s+[\w\s]+$/i
    ];

    let retryCount = 0;

    while (retryCount < maxRetries && invalidQuotes.length > 0) {
      retryCount++;
      console.log(`[MicroSummarizer] Quote extraction retry ${retryCount}/${maxRetries} for response ${summary.responseNumber}`);

      try {
        const quoteExtractionPrompt = this.buildQuoteExtractionPrompt(
          responseTextForValidation,
          summary.arguments,
          invalidQuotes
        );

        const completion = await this.client.createCompletion({
          messages: [
            {
              role: 'system',
              content: 'Du skal finde EKSAKTE citater fra teksten. Kopier PRÆCIST uden ændringer.'
            },
            {
              role: 'user',
              content: quoteExtractionPrompt
            }
          ],
          response_format: getResponseFormat('quoteExtraction')
          // Note: GPT-5 models control precision via verbosity/reasoning parameters
        });

        let quoteContent = completion.choices[0]?.message?.content;
        if (!quoteContent) continue;

        // Parse result
        const quoteResult = JSON.parse(quoteContent);
        const quotes = quoteResult.quotes || quoteResult.arguments || [];

        if (quotes.length === invalidQuotes.length) {
          // Update quotes and verify again
          const stillInvalid = [];
          const MIN_CONFIDENCE = 0.6; // Reject low-confidence matches to prevent hallucinations

          for (let j = 0; j < invalidQuotes.length; j++) {
            const invalidQuote = invalidQuotes[j];
            const newQuote = quotes[j].sourceQuote || quotes[j].quote || '';

            // Check if new quote is irrelevant
            const isIrrelevant = irrelevantPatterns.some(pattern => pattern.test(newQuote.trim()));

            const match = findFlexibleQuote(responseTextForValidation, newQuote);

            if (!isIrrelevant && newQuote && match.found && match.confidence >= MIN_CONFIDENCE) {
              // Valid quote found with sufficient confidence, update it with exact match
              summary.arguments[invalidQuote.index].sourceQuote = match.exactQuote;
              console.log(`[MicroSummarizer] Fixed quote for argument ${invalidQuote.index + 1} (confidence: ${match.confidence.toFixed(2)})`);
            } else {
              // Still invalid
              const reason = isIrrelevant ? 'irrelevant' :
                (!newQuote ? 'empty' :
                (match.found ? 'low_confidence' : 'not_found'));
              stillInvalid.push({
                ...invalidQuote,
                quote: newQuote,
                reason: reason,
                confidence: match.confidence || 0
              });
            }
          }

          invalidQuotes = stillInvalid;
        } else {
          console.warn('[MicroSummarizer] Quote extraction returned mismatched number of quotes');
          break;
        }
      } catch (error) {
        console.error(`[MicroSummarizer] Quote extraction retry ${retryCount} failed:`, error.message);
      }
    }

    // If still invalid quotes after retries, MARK them for caller but don't remove yet
    if (invalidQuotes.length > 0) {
      console.warn(`[MicroSummarizer] Response ${summary.responseNumber}: ${invalidQuotes.length} arguments still have missing/invalid quotes after ${maxRetries} retries.`);

      // Mark summary as having invalid quotes so caller can decide to re-summarize
      summary._hasInvalidQuotes = true;
      summary._invalidQuotes = invalidQuotes;
    }

    return summary;
  }

  /**
   * Helper to extract a relevant sentence from source text based on argument content.
   * Used as a fallback when LLM-generated quotes can't be validated.
   * @param {string} sourceText - The full source text
   * @param {Object} arg - The argument with what/why fields
   * @returns {string|null} The extracted quote, or null if none found
   */
  extractRelevantSentence(sourceText, arg) {
    if (!sourceText || !arg) return null;

    // Get keywords from the argument's "what" and "why" fields
    const whatWords = (arg.what || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const whyWords = (arg.why || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const keywords = [...new Set([...whatWords, ...whyWords])].slice(0, 10);

    if (keywords.length === 0) return null;

    // Split source text into sentences
    const sentences = sourceText.split(/(?<=[.!?])\s+/);
    if (sentences.length === 0) return null;

    // Score each sentence by keyword matches
    let bestSentence = null;
    let bestScore = 0;

    for (const sentence of sentences) {
      const sentenceLower = sentence.toLowerCase();

      // Skip very short sentences or greetings/signatures
      if (sentence.length < 20) continue;
      if (/^(kære|venlig|hilsen|tak for|med venlig)/i.test(sentence)) continue;

      // Count keyword matches
      let score = 0;
      for (const keyword of keywords) {
        if (sentenceLower.includes(keyword)) {
          score++;
        }
      }

      // Prefer sentences with more matches
      if (score > bestScore) {
        bestScore = score;
        bestSentence = sentence;
      }
    }

    // Only return if we found a reasonable match (at least 2 keywords or >30% of keywords)
    const minScore = Math.max(2, Math.floor(keywords.length * 0.3));
    if (bestScore >= minScore && bestSentence) {
      return bestSentence.trim();
    }

    return null;
  }

  /**
   * Helper to remove invalid arguments (fallback strategy)
   * Before removal, tries to extract relevant sentences from source text
   */
  removeInvalidArguments(summary, responseText = '') {
    if (!summary._hasInvalidQuotes || !summary._invalidQuotes) {
      return summary;
    }

    const invalidQuotes = summary._invalidQuotes;

    // First, try to extract relevant sentences as fallback quotes
    let extractedCount = 0;
    for (const invalid of invalidQuotes) {
      const arg = summary.arguments[invalid.index];
      if (arg && responseText) {
        const extractedQuote = this.extractRelevantSentence(responseText, arg);
        if (extractedQuote) {
          arg.sourceQuote = extractedQuote;
          extractedCount++;
          console.log(`[MicroSummarizer] 🔧 Auto-extracted quote for response ${summary.responseNumber}, arg ${invalid.index + 1}`);
        }
      }
    }

    // Filter invalidQuotes to only those that couldn't be fixed
    const stillInvalid = invalidQuotes.filter(invalid => {
      const arg = summary.arguments[invalid.index];
      return !arg.sourceQuote || arg.sourceQuote.trim() === '';
    });

    if (extractedCount > 0) {
      console.log(`[MicroSummarizer] Auto-extracted ${extractedCount}/${invalidQuotes.length} quotes for response ${summary.responseNumber}`);
    }

    if (stillInvalid.length === 0) {
      // All quotes were fixed via extraction
      delete summary._hasInvalidQuotes;
      delete summary._invalidQuotes;
      return summary;
    }

    console.warn(`[MicroSummarizer] FALLBACK: Removing ${stillInvalid.length} arguments from response ${summary.responseNumber} due to persistent citation failures.`);

    // Create a set of indices to remove (only the ones that still couldn't be fixed)
    const indicesToRemove = new Set(stillInvalid.map(iq => iq.index));

    // Filter arguments
    summary.arguments = summary.arguments.filter((_, index) => !indicesToRemove.has(index));

    // Update analyzable flag if all arguments were removed
    summary.analyzable = summary.arguments.length > 0 &&
      !summary.edgeCaseFlags.incomprehensible &&
      !summary.edgeCaseFlags.irrelevant;

    if (!summary.analyzable && summary.arguments.length === 0) {
      summary.edgeCaseFlags.notes = summary.edgeCaseFlags.notes
        ? `${summary.edgeCaseFlags.notes}; Removed all arguments due to citation failures`
        : 'Removed all arguments due to citation failures';
    }

    // Cleanup internal flags
    delete summary._hasInvalidQuotes;
    delete summary._invalidQuotes;

    return summary;
  }

  /**
   * Batch summarize multiple responses
   * Uses parallel processing (Batch API removed for reliability and speed)
   */
  async summarizeBatch(responses, materials, allResponses = [], options = {}) {
    // Always use parallel processing
    return await this.summarizeBatchParallel(responses, materials, allResponses, options);
  }

  /**
   * Summarize a batch of responses in parallel (with batching for short ones)
   */
  async summarizeBatchParallel(responses, materials, allResponses = [], options = {}) {
    const startTime = Date.now();

    // 1. Separate short (batchable) and long (individual) responses
    const SHORT_RESPONSE_LIMIT = 300; // Characters
    const shortResponses = [];
    const longResponses = [];
    const emptyResponses = [];
    const skippedResponses = []; // NEW: Responses skipped due to screening

    responses.forEach(r => {
      // OPTIMIZATION: Check edge cases to skip unanalyzable responses
      if (options.edgeCases) {
        const edgeCase = options.edgeCases.find(ec => ec.responseNumber === r.id);
        if (edgeCase) {
          // Skip if not analyzable OR if it's a "no-opinion" response (handled via flags)
          if (!edgeCase.analyzable || edgeCase.action === 'no-opinion' || edgeCase.action === 'skip') {
            skippedResponses.push({
              responseNumber: r.id || r.responseNumber,
              analyzable: false,
              arguments: [],
              edgeCaseFlags: {
                referencesOtherResponses: edgeCase.referencedNumbers?.length > 0,
                referencesOtherResponseNumbers: edgeCase.referencedNumbers || [],
                incomprehensible: false,
                irrelevant: true,
                noComments: edgeCase.action === 'no-opinion',
                notes: `Skipped based on screening: ${edgeCase.reason || edgeCase.action}`
              }
            });
            return; // Skip further processing
          }
        }
      }

      const text = r.text || '';
      if (!text.trim()) {
        emptyResponses.push(r);
      } else if (text.length <= SHORT_RESPONSE_LIMIT) {
        shortResponses.push(r);
      } else {
        longResponses.push(r);
      }
    });

    console.log(`[MicroSummarizer] Split: ${shortResponses.length} short, ${longResponses.length} long, ${emptyResponses.length} empty, ${skippedResponses.length} skipped (screening)`);

    const summaries = [...skippedResponses]; // Start with skipped ones

    // Calculate concurrency limit (how many parallel LLM calls)
    const approxContextTokens = 2000; // Materials + Taxonomy
    const concurrencyLimit = options.batchSize || getBatchSizeForStep('micro-summarize', shortResponses, {
      additionalContextTokens: approxContextTokens
    });
    
    // CRITICAL: Limit responses per LLM call to prevent timeout
    // This is different from concurrency - it controls how many responses go into ONE prompt
    // Too many responses in one prompt = huge prompt = timeout
    const MAX_RESPONSES_PER_LLM_CALL = 15; // Safe limit for short responses
    const contentBatchSize = Math.min(MAX_RESPONSES_PER_LLM_CALL, concurrencyLimit);

    // 2. Process short responses in batches
    if (shortResponses.length > 0) {
      let batches = [];

      // SMART BATCHING: Group similar responses using embeddings
      if (this.smartBatching && shortResponses.length > contentBatchSize) {
        console.log(`[MicroSummarizer] 🧠 Smart Batching: Grouping ${shortResponses.length} responses by semantic similarity...`);
        try {
          // Embed all short responses
          const texts = shortResponses.map(r => r.text);
          const embeddings = await this.embedder.embedBatch(texts);

          // Create pool of responses with embeddings
          let pool = shortResponses.map((r, i) => ({ ...r, embedding: embeddings[i] }));

          while (pool.length > 0) {
            // Pick first as pivot
            const pivot = pool[0];

            // Calculate similarity to pivot for all others
            pool.forEach(item => {
              item._similarity = this.cosineSimilarity(pivot.embedding, item.embedding);
            });

            // Sort by similarity (descending)
            pool.sort((a, b) => b._similarity - a._similarity);

            // Take top contentBatchSize
            const batch = pool.slice(0, contentBatchSize);
            batches.push(batch);

            // Remove from pool
            pool = pool.slice(contentBatchSize);
          }
          console.log(`[MicroSummarizer] Created ${batches.length} smart batches`);
        } catch (error) {
          console.warn(`[MicroSummarizer] Smart batching failed, falling back to sequential: ${error.message}`);
          // Fallback to sequential
          for (let i = 0; i < shortResponses.length; i += contentBatchSize) {
            batches.push(shortResponses.slice(i, i + contentBatchSize));
          }
        }
      } else {
        // Sequential batching
        for (let i = 0; i < shortResponses.length; i += contentBatchSize) {
          batches.push(shortResponses.slice(i, i + contentBatchSize));
        }
      }

      console.log(`[MicroSummarizer] Processing ${batches.length} content batches of short responses...`);

      // Process batches in parallel
      const batchPromises = batches.map(batch =>
        this.summarizeBatchWithLLM(batch, materials, options.taxonomy)
          .catch(error => {
            console.error(`[MicroSummarizer] Failed to summarize batch:`, error);
            // Fallback: mark all as failed
            return batch.map(r => ({
              responseNumber: r.id || r.responseNumber,
              analyzable: false,
              arguments: [],
              edgeCaseFlags: {
                referencesOtherResponses: false,
                referencesOtherResponseNumbers: [],
                incomprehensible: true,
                irrelevant: false,
                notes: `Failed to analyze batch: ${error.message}`
              }
            }));
          })
      );

      const results = await Promise.all(batchPromises);
      results.forEach(result => summaries.push(...result));
    }


    // 2. Process long responses individually
    if (longResponses.length > 0) {
      console.log(`[MicroSummarizer] Processing ${longResponses.length} long responses individually...`);

      // Process in batches (using concurrencyLimit for parallel individual calls)
      for (let i = 0; i < longResponses.length; i += concurrencyLimit) {
        const batch = longResponses.slice(i, i + concurrencyLimit);
        console.log(`[MicroSummarizer] Processing individual batch ${Math.floor(i / concurrencyLimit) + 1}/${Math.ceil(longResponses.length / concurrencyLimit)}...`);

        // Process batch in parallel - SDK handles rate limits automatically
        const batchPromises = batch.map(response =>
          this.summarizeResponse(response, materials, allResponses, options)
            .catch(error => {
              console.error(`[MicroSummarizer] Failed to summarize response ${response.id}:`, error);
              return {
                responseNumber: response.id || response.responseNumber,
                analyzable: false,
                arguments: [],
                edgeCaseFlags: {
                  referencesOtherResponses: false,
                  referencesOtherResponseNumbers: [],
                  incomprehensible: true,
                  irrelevant: false,
                  notes: `Failed to analyze: ${error.message}`
                }
              };
            })
        );

        const batchResults = await Promise.all(batchPromises);
        summaries.push(...batchResults);
      }
    }

    // Transform summaries using citation registry if available
    if (this.citationRegistry) {
      console.log('[MicroSummarizer] Transforming summaries with citation registry');
      return this.citationRegistry.transformMicroSummaries(summaries);
    }
    return summaries;
  }

  /**
   * Summarize a batch of short responses
   */
  async summarizeBatchWithLLM(responses, materials, taxonomy) {
    const materialsText = this.buildMaterialsText(materials);
    const taxonomyText = this.buildTaxonomyText(taxonomy);

    const responsesText = responses.map(r =>
      `ID: ${r.id || r.responseNumber}\nTekst: ${(r.text || '').replace(/\n/g, ' ')}`
    ).join('\n\n');

    const prompt = `BAGGRUNDSVIDEN (Høringsmateriale):
${materialsText || 'Ingen materiale'}

TAKSONOMI (Temaer):
${taxonomyText}

Analysér følgende høringssvar (antal: ${responses.length}). Ekstraher argumenter og konsekvenser.

HØRINGSSVAR:
${responsesText}

Returnér JSON liste:
{
  "results": [
    {
      "id": [ID fra teksten],
      "analyzable": true/false,
      "arguments": [
        {
          "what": "Hvad mener borgeren? (kort)",
          "why": "Hvorfor? (begrundelse)",
          "how": "Hvordan/forslag? (valgfri)",
          "direction": "pro_change | pro_status_quo | neutral",
          "consequence": "Konsekvens hvis ikke hørt",
          "relevantThemes": ["Tema 1", "Tema 2"],
          "sourceQuote": "Eksakt citat fra teksten (1-3 sætninger)"
        }
      ],
      "edgeCaseFlags": {
        "incomprehensible": false,
        "irrelevant": false,
        "notes": ""
      }
    }
  ]
}`;

    const MAX_RETRIES = 3;
    let lastError = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const completion = await this.client.createCompletion({
          messages: [
            {
              role: 'system',
              content: 'Du er en erfaren fuldmægtig der analyserer høringssvar. Du SKAL returnere gyldig JSON. Du behandler flere svar på én gang.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          response_format: { type: "json_object" }
        });

        const content = completion.choices[0]?.message?.content;
        if (content) {
          // Check if response is clearly not JSON (plain text response)
          const trimmed = content.trim();
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            const preview = trimmed.slice(0, 50);
            console.warn(`[MicroSummarizer] Non-JSON response (attempt ${attempt}/${MAX_RETRIES}): "${preview}..."`);
            if (attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
              continue; // Retry
            }
            throw new Error(`LLM returned non-JSON response: "${preview}..."`);
          }
          
          const parsed = this.repairJson(content);
          if (!parsed) {
            const preview = content.slice(0, 100);
            console.warn(`[MicroSummarizer] JSON parse failed (attempt ${attempt}/${MAX_RETRIES}): "${preview}..."`);
            if (attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
              continue; // Retry
            }
            throw new Error(`Failed to parse batch response JSON: "${preview}..."`);
          }
        const resultsMap = new Map();
        if (parsed.results && Array.isArray(parsed.results)) {
          parsed.results.forEach(r => resultsMap.set(String(r.id), r));
        }

        return responses.map(r => {
          const id = r.id || r.responseNumber;
          const result = resultsMap.get(String(id));

          if (result) {
            // Helper to clean text
            const clean = (text) => (text || '').replace(/\{\+\+|\+\+\}/g, '').trim();

            const args = Array.isArray(result.arguments) ? result.arguments.map(arg => ({
              what: clean(arg.what),
              why: clean(arg.why),
              how: clean(arg.how),
              direction: arg.direction || 'neutral',
              directionReasoning: arg.directionReasoning || '',
              consequence: clean(arg.consequence),
              concern: clean(arg.concern) || '',
              relevantThemes: arg.relevantThemes || [],
              sourceQuote: clean(arg.sourceQuote) || '',
              outOfScope: arg.outOfScope === true
            })) : [];

            // Validate and fix quotes with findFlexibleQuote (same as validateAndEnhanceSummary)
            // This ensures batch-processed short responses get the same quote validation as long responses
            const sourceText = r.textMd || r.text || '';
            const MIN_CONFIDENCE = 0.6; // Reject low-confidence matches to prevent hallucinations
            if (args.length > 0 && sourceText) {
              for (const arg of args) {
                if (arg.sourceQuote) {
                  const match = findFlexibleQuote(sourceText, arg.sourceQuote);
                  if (match.found && match.confidence >= MIN_CONFIDENCE) {
                    arg.sourceQuote = match.exactQuote;
                  } else if (match.found && match.confidence < MIN_CONFIDENCE) {
                    // Low confidence match - clear the quote to force retry
                    console.log(`[MicroSummarizer] Batch: Rejected low-confidence quote (${match.confidence.toFixed(2)}) for response ${id}`);
                    arg.sourceQuote = '';
                  } else {
                    // Quote not found in source text at all - clear to prevent hallucination
                    // This happens when LLM assigns a quote from one response to another in batch processing
                    console.log(`[MicroSummarizer] Batch: Quote not found in source text for response ${id}, clearing to prevent hallucination`);
                    arg.sourceQuote = '';
                  }
                }
              }
            }

            return {
              responseNumber: id,
              analyzable: Boolean(result.analyzable),
              arguments: args,
              edgeCaseFlags: {
                referencesOtherResponses: false,
                referencesOtherResponseNumbers: [],
                incomprehensible: Boolean(result.edgeCaseFlags?.incomprehensible),
                irrelevant: Boolean(result.edgeCaseFlags?.irrelevant),
                notes: clean(result.edgeCaseFlags?.notes)
              }
            };
          } else {
            // Fallback
            return {
              responseNumber: id,
              analyzable: false,
              arguments: [],
              edgeCaseFlags: {
                referencesOtherResponses: false,
                referencesOtherResponseNumbers: [],
                incomprehensible: true,
                irrelevant: false,
                notes: 'Missing from batch output'
              }
            };
          }
        });
      }
      } catch (error) {
        lastError = error;
        console.error(`[MicroSummarizer] Batch attempt ${attempt}/${MAX_RETRIES} failed:`, error.message);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
          continue; // Retry
        }
      }
    }
    
    // All retries exhausted
    console.error('[MicroSummarizer] All retry attempts failed for batch');
    throw lastError || new Error('Failed to summarize batch after all retries');
  }
}

