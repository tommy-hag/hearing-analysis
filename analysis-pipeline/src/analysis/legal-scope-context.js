/**
 * Legal Scope Context
 *
 * Provides legal context about what document types can and cannot regulate.
 * Used to enrich prompts and validate argument mappings.
 *
 * Supports LLM-based classification for uncertain cases (when heuristics don't match).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class LegalScopeContext {
  constructor(options = {}) {
    // Load theme templates
    try {
      const templatePath = join(__dirname, '../../config/theme-templates.json');
      this.templates = JSON.parse(readFileSync(templatePath, 'utf-8'));
    } catch (error) {
      console.warn('[LegalScopeContext] Could not load theme templates, using defaults');
      this.templates = {
        documentTypes: {
          default: {
            legalBasis: { authorities: [], limitations: [] },
            outOfScopeExamples: []
          }
        }
      };
    }

    this.options = options;

    // LLM client for uncertain cases (lazy initialized)
    this._llmClient = null;

    // Load out-of-scope classifier prompt
    try {
      const promptPath = join(__dirname, '../../prompts/out-of-scope-classifier-prompt.md');
      this.classifierPrompt = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[LegalScopeContext] Could not load out-of-scope classifier prompt');
      this.classifierPrompt = null;
    }
  }

  /**
   * Get or create LLM client (lazy initialization)
   * Uses 'light' complexity for cost efficiency
   */
  getLLMClient() {
    if (!this._llmClient) {
      const complexityConfig = getComplexityConfig('light');
      this._llmClient = new OpenAIClientWrapper({
        model: complexityConfig.model,
        verbosity: complexityConfig.verbosity,
        reasoningEffort: complexityConfig.reasoningEffort
      });
    }
    return this._llmClient;
  }

  /**
   * Set Job ID for LLM tracing
   */
  setJobId(jobId) {
    if (this._llmClient) {
      this._llmClient.setJobId(jobId);
    }
    this._pendingJobId = jobId;
  }

  /**
   * Get the template for a document type
   * @param {string} documentType - Document type (lokalplan, dispensation, etc.)
   * @returns {Object} Template configuration
   */
  getTemplate(documentType) {
    return this.templates.documentTypes[documentType] || 
           this.templates.documentTypes.default;
  }

  /**
   * Build legal context text for use in prompts
   * @param {string} documentType - Document type
   * @returns {string} Formatted legal context for prompt
   */
  buildContextForPrompt(documentType) {
    const template = this.getTemplate(documentType);
    const legalBasis = template.legalBasis || {};
    
    const sections = [];

    // Header
    sections.push(`## JURIDISK KONTEKST FOR ${(template.name || documentType).toUpperCase()}`);
    sections.push('');

    // Primary law
    if (legalBasis.primaryLaw) {
      sections.push(`**Lovgrundlag:** ${legalBasis.primaryLaw}`);
    }

    // What the document CAN regulate
    if (legalBasis.authorities && legalBasis.authorities.length > 0) {
      sections.push('');
      sections.push('**Dokumentet KAN regulere:**');
      legalBasis.authorities.forEach(auth => {
        sections.push(`- ${auth}`);
      });
    }

    // What the document CANNOT regulate (limitations)
    if (legalBasis.limitations && legalBasis.limitations.length > 0) {
      sections.push('');
      sections.push('**Dokumentet KAN IKKE regulere (out-of-scope):**');
      legalBasis.limitations.forEach(limit => {
        sections.push(`- ${limit}`);
      });
    }

    // Examples of out-of-scope topics
    if (template.outOfScopeExamples && template.outOfScopeExamples.length > 0) {
      sections.push('');
      sections.push('**Eksempler på emner UDEN FOR beføjelser:**');
      sections.push(template.outOfScopeExamples.join(', '));
    }

    // Instructions for handling out-of-scope
    sections.push('');
    sections.push('**VIGTIGT:** Hvis et argument handler om emner uden for dokumentets beføjelser, skal du:');
    sections.push('1. Sætte `outOfScope: true` på argumentet');
    sections.push('2. Stadig ekstraherer argumentets indhold korrekt (what/why/how)');
    sections.push('3. Sætte `relevantThemes: ["Andre emner"]`');

    return sections.join('\n');
  }

  /**
   * Check if an argument is out of scope for the document type
   * @param {Object} argument - Argument object with what/why/how
   * @param {string} documentType - Document type
   * @param {string} assignedTheme - Theme this argument was assigned to by ThemeMapper (optional)
   * @returns {Object} { outOfScope: boolean, reason: string, confidence: number }
   */
  isOutOfScope(argument, documentType, assignedTheme = null) {
    const template = this.getTemplate(documentType);
    const legalBasis = template.legalBasis || {};

    // Combine argument text for analysis
    const argumentText = [
      argument.what || '',
      argument.why || '',
      argument.how || '',
      argument.coreContent || '',
      argument.concern || ''
    ].join(' ').toLowerCase();

    // SAFE-LIST: §-references indicate regulatory content - ALWAYS in-scope
    // Pattern matches: §6, § 6, §6.5, § 6 stk. 5, stk. 5, etc.
    const sectionReferencePattern = /§\s*\d+|stk\.\s*\d+/i;
    if (sectionReferencePattern.test(argumentText)) {
      return {
        outOfScope: false,
        reason: 'Argumentet indeholder eksplicit §-reference til reguleringsbestemmelse',
        confidence: 0.95,
        matchedKeywords: [],
        _safeListed: true
      };
    }

    // PRIORITY FIX: Check if argument's ASSIGNED THEME matches a regulatory authority.
    // ThemeMapper already did semantic analysis to assign the argument to a theme.
    // If that theme corresponds to a regulatory authority, trust it.
    // Example: argument in "Anvendelse" theme should not be moved to "Andre emner"
    // even if it contains "priser" (economic keyword) - the theme assignment wins.
    const authorities = legalBasis.authorities || [];
    if (assignedTheme && assignedTheme !== 'Andre emner') {
      const themeMatch = this.matchThemeToAuthority(assignedTheme, authorities);
      if (themeMatch.matched) {
        return {
          outOfScope: false,
          reason: `Argumentets tema "${assignedTheme}" matcher reguleringsbeføjelse "${themeMatch.authority}"`,
          confidence: 0.9,
          matchedKeywords: themeMatch.matchedWords,
          _themeProtected: true
        };
      }
    }

    // Check authorities via text content
    for (const authority of authorities) {
      const authorityConcepts = this.extractKeyConcepts(authority.toLowerCase());
      const matchedConcepts = authorityConcepts.filter(concept =>
        argumentText.includes(concept)
      );

      if (matchedConcepts.length >= 1) {
        return {
          outOfScope: false,
          reason: `Argumentet vedrører: "${authority}"`,
          confidence: 0.8,
          matchedKeywords: matchedConcepts
        };
      }
    }

    // Check against out-of-scope examples (only if no authority match)
    const outOfScopeExamples = template.outOfScopeExamples || [];
    const matchedExamples = outOfScopeExamples.filter(example =>
      argumentText.includes(example.toLowerCase())
    );

    if (matchedExamples.length > 0) {
      return {
        outOfScope: true,
        reason: `Argumentet indeholder emner uden for dokumentets beføjelser: ${matchedExamples.join(', ')}`,
        confidence: Math.min(0.5 + (matchedExamples.length * 0.15), 0.95),
        matchedKeywords: matchedExamples
      };
    }

    // Check against limitations text
    const limitations = legalBasis.limitations || [];
    for (const limitation of limitations) {
      // Extract key concepts from limitation
      const limitationLower = limitation.toLowerCase();
      const limitationConcepts = this.extractKeyConcepts(limitationLower);

      const matchedConcepts = limitationConcepts.filter(concept =>
        argumentText.includes(concept)
      );

      if (matchedConcepts.length >= 2) {
        return {
          outOfScope: true,
          reason: `Argumentet vedrører: "${limitation}"`,
          confidence: 0.7,
          matchedKeywords: matchedConcepts
        };
      }
    }

    // Default: assume in scope if no clear match (heuristics uncertain)
    return {
      outOfScope: false,
      reason: 'Ingen klar indikation af out-of-scope',
      confidence: 0.5,
      matchedKeywords: [],
      _uncertain: true // Flag for async variant to use LLM
    };
  }

  /**
   * Async version of isOutOfScope that uses LLM for uncertain cases.
   * Use this when you can afford the latency/cost of LLM calls.
   *
   * @param {Object} argument - Argument with what/why/how
   * @param {string} documentType - Document type
   * @param {string} assignedTheme - Theme the argument was assigned to
   * @returns {Promise<Object>} { outOfScope: boolean, reason: string, confidence: number }
   */
  async isOutOfScopeAsync(argument, documentType, assignedTheme = null) {
    // First, try heuristic classification
    const heuristicResult = this.isOutOfScope(argument, documentType, assignedTheme);

    // If heuristics are confident, use their result
    if (!heuristicResult._uncertain || heuristicResult.confidence >= 0.6) {
      return heuristicResult;
    }

    // Heuristics are uncertain - use LLM classification
    const llmResult = await this.classifyWithLLM(argument, documentType, assignedTheme);
    if (llmResult) {
      return llmResult;
    }

    // LLM failed, fall back to heuristic result
    return heuristicResult;
  }

  /**
   * Extract key concepts from a text string
   * @private
   */
  extractKeyConcepts(text) {
    // Remove common words and extract meaningful concepts
    const stopWords = ['kan', 'ikke', 'det', 'er', 'og', 'af', 'til', 'i', 'en', 'at', 'den', 'de', 'som', 'for', 'med', 'på'];
    
    // Generic words that are too common in planning/regulatory texts to be meaningful
    // These appear in both in-scope and out-of-scope contexts
    const genericWords = [
      'område', 'området', 'områder', 'områdets',  // Too generic - used everywhere
      'krav', 'kravet', 'kravene',                  // Appears in all regulatory texts
      'forhold', 'forholdene',                      // Generic descriptor
      'regulere', 'regulering', 'reguleres',        // Meta-word about regulation itself
      'bygning', 'bygninger', 'bygningens',         // Appears in both in/out of scope
      'specifikke', 'specifik',                     // Qualifier word
      'kun', 'ydre', 'indre'                        // Context-dependent qualifiers
    ];
    
    return text
      .split(/[\s,()]+/)
      .filter(word => word.length > 3)
      .filter(word => !stopWords.includes(word))
      .filter(word => !genericWords.includes(word))
      .slice(0, 10); // Limit to first 10 concepts
  }

  /**
   * Match a theme name to regulatory authorities using multi-word matching.
   * Fixes the previous issue where "Bil- og cykelparkering" didn't match "Parkering"
   * because only the first word was checked.
   *
   * @param {string} themeName - Theme name to match
   * @param {Array} authorities - List of authority strings
   * @returns {Object} { matched: boolean, authority: string|null, matchedWords: Array }
   */
  matchThemeToAuthority(themeName, authorities) {
    const themeLower = themeName.toLowerCase();
    // Split theme into words, handling hyphens and compound words
    // "Bil- og cykelparkering" → ["bil", "og", "cykelparkering", "parkering", "cykel"]
    const themeWords = this.extractMatchableWords(themeLower);

    for (const authority of authorities) {
      const authorityLower = authority.toLowerCase();
      const authorityWords = this.extractMatchableWords(authorityLower);

      // Check for overlapping words (at least one meaningful match)
      const matchedWords = [];
      for (const tw of themeWords) {
        for (const aw of authorityWords) {
          // Match if words are identical or one contains the other (with min length 4)
          if (tw === aw ||
              (tw.length >= 4 && aw.length >= 4 && (tw.includes(aw) || aw.includes(tw)))) {
            matchedWords.push(tw);
          }
        }
      }

      if (matchedWords.length >= 1) {
        return {
          matched: true,
          authority,
          matchedWords: [...new Set(matchedWords)] // Deduplicate
        };
      }
    }

    return { matched: false, authority: null, matchedWords: [] };
  }

  /**
   * Extract matchable words from a string, handling Danish compound words and hyphens.
   * @private
   */
  extractMatchableWords(text) {
    const stopWords = ['og', 'til', 'af', 'i', 'på', 'for', 'med', 'den', 'det', 'de', 'en', 'et'];

    // Split on spaces and hyphens, but also try to extract roots from compounds
    const words = text.split(/[\s\-]+/).filter(w => w.length > 2 && !stopWords.includes(w));

    // For compound words like "cykelparkering", also add the components
    const expandedWords = [...words];
    for (const word of words) {
      // Common Danish compound word roots (generiske, ikke case-specifikke)
      const compoundRoots = ['parkering', 'trafik', 'vej', 'cykel', 'bil', 'bygning', 'areal', 'miljø', 'støj'];
      for (const root of compoundRoots) {
        if (word.includes(root) && word !== root) {
          expandedWords.push(root);
        }
      }
    }

    return [...new Set(expandedWords)];
  }

  /**
   * Use LLM to classify an argument as in-scope or out-of-scope.
   * Called when heuristic methods are uncertain (confidence <= 0.5).
   *
   * @param {Object} argument - Argument with what/why/how
   * @param {string} documentType - Document type
   * @param {string} assignedTheme - Theme the argument was assigned to
   * @returns {Promise<Object>} { outOfScope: boolean, reason: string, confidence: number }
   */
  async classifyWithLLM(argument, documentType, assignedTheme) {
    if (!this.classifierPrompt) {
      console.warn('[LegalScopeContext] No classifier prompt available, skipping LLM classification');
      return null;
    }

    const template = this.getTemplate(documentType);
    const legalBasis = template.legalBasis || {};

    // Build prompt with context
    const prompt = this.classifierPrompt
      .replace('{documentType}', template.name || documentType)
      .replace('{authorities}', (legalBasis.authorities || []).map(a => `- ${a}`).join('\n'))
      .replace('{limitations}', (legalBasis.limitations || []).map(l => `- ${l}`).join('\n'))
      .replace('{assignedTheme}', assignedTheme || 'Ikke tildelt')
      .replace('{what}', argument.what || argument.coreContent || '(ikke angivet)')
      .replace('{why}', argument.why || argument.concern || '(ikke angivet)')
      .replace('{how}', argument.how || '(ikke angivet)');

    try {
      const client = this.getLLMClient();
      if (this._pendingJobId) {
        client.setJobId(this._pendingJobId);
      }

      const response = await client.createCompletion({
        messages: [
          { role: 'system', content: 'Du er ekspert i dansk forvaltningsret. Svar kun med valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }, { step: 'validate-legal-scope', context: 'out-of-scope-classification' });

      const result = JSON.parse(response.content);
      return {
        outOfScope: result.outOfScope === true,
        reason: result.reason || 'LLM-klassificeret',
        confidence: typeof result.confidence === 'number' ? result.confidence : 0.7,
        _llmClassified: true,
        _coreSubject: result.coreSubject,
        _matchedAuthority: result.matchedAuthority
      };
    } catch (error) {
      console.error('[LegalScopeContext] LLM classification failed:', error.message);
      return null;
    }
  }

  /**
   * Validate all arguments in a micro-summary and flag out-of-scope ones
   * @param {Array} microSummaries - Array of micro-summaries
   * @param {string} documentType - Document type
   * @returns {Object} { summaries: Array, stats: Object }
   */
  validateMicroSummaries(microSummaries, documentType) {
    const stats = {
      total: 0,
      outOfScope: 0,
      inScope: 0,
      byReason: {}
    };

    const validatedSummaries = microSummaries.map(summary => {
      if (!summary.arguments || summary.arguments.length === 0) {
        return summary;
      }

      const validatedArguments = summary.arguments.map(arg => {
        stats.total++;
        
        // Skip if already marked
        if (arg.outOfScope !== undefined) {
          if (arg.outOfScope) {
            stats.outOfScope++;
          } else {
            stats.inScope++;
          }
          return arg;
        }

        const validation = this.isOutOfScope(arg, documentType);
        
        if (validation.outOfScope) {
          stats.outOfScope++;
          stats.byReason[validation.reason] = (stats.byReason[validation.reason] || 0) + 1;
        } else {
          stats.inScope++;
        }

        return {
          ...arg,
          outOfScope: validation.outOfScope,
          outOfScopeReason: validation.outOfScope ? validation.reason : undefined,
          outOfScopeConfidence: validation.confidence
        };
      });

      return {
        ...summary,
        arguments: validatedArguments
      };
    });

    return {
      summaries: validatedSummaries,
      stats
    };
  }

  /**
   * Move out-of-scope arguments to a dedicated theme
   * @param {Object} themeMapping - Theme mapping result from ThemeMapper
   * @param {string} documentType - Document type
   * @returns {Object} Updated theme mapping
   */
  moveOutOfScopeArguments(themeMapping, documentType) {
    const outOfScopeTheme = {
      name: 'Andre emner',
      level: 0,
      category: 'out-of-scope',
      description: 'Bemærkninger om emner uden for dokumentets juridiske beføjelser',
      arguments: [],
      summaries: []
    };

    let movedCount = 0;

    // Process each theme
    const updatedThemes = themeMapping.themes.map(theme => {
      // Skip if this is already the out-of-scope theme
      if (theme.name === 'Andre emner' || theme.category === 'out-of-scope') {
        return theme;
      }

      // Filter arguments, moving out-of-scope ones
      const inScopeArguments = [];
      
      for (const arg of (theme.arguments || [])) {
        // Check if argument is out of scope - pass theme name for context
        const validation = this.isOutOfScope(arg, documentType, theme.name);

        if (validation.outOfScope && validation.confidence >= 0.6) {
          // Move to out-of-scope theme
          outOfScopeTheme.arguments.push({
            ...arg,
            originalTheme: theme.name,
            outOfScopeReason: validation.reason
          });
          movedCount++;
        } else {
          inScopeArguments.push(arg);
        }
      }

      return {
        ...theme,
        arguments: inScopeArguments
      };
    });

    // Add out-of-scope theme if it has arguments
    if (outOfScopeTheme.arguments.length > 0) {
      // Check if there's already an "Andre emner" theme
      const existingOutOfScopeIndex = updatedThemes.findIndex(
        t => t.name === 'Andre emner' || t.category === 'out-of-scope'
      );

      if (existingOutOfScopeIndex >= 0) {
        // Merge with existing
        updatedThemes[existingOutOfScopeIndex].arguments = [
          ...updatedThemes[existingOutOfScopeIndex].arguments,
          ...outOfScopeTheme.arguments
        ];
      } else {
        // Add new theme at the end
        updatedThemes.push(outOfScopeTheme);
      }
    }

    console.log(`[LegalScopeContext] Moved ${movedCount} out-of-scope arguments to "Andre emner"`);

    return {
      ...themeMapping,
      themes: updatedThemes,
      _legalScopeValidation: {
        documentType,
        movedArguments: movedCount,
        outOfScopeThemeSize: outOfScopeTheme.arguments.length
      }
    };
  }

  /**
   * Async version of moveOutOfScopeArguments that uses LLM for uncertain cases.
   * This is more expensive but more accurate for ambiguous arguments.
   *
   * @param {Object} themeMapping - Theme mapping result from ThemeMapper
   * @param {string} documentType - Document type
   * @param {Object} options - Options: { useLLM: boolean, llmBatchSize: number }
   * @returns {Promise<Object>} Updated theme mapping
   */
  async moveOutOfScopeArgumentsAsync(themeMapping, documentType, options = {}) {
    const { useLLM = true, llmBatchSize = 5 } = options;

    const outOfScopeTheme = {
      name: 'Andre emner',
      level: 0,
      category: 'out-of-scope',
      description: 'Bemærkninger om emner uden for dokumentets juridiske beføjelser',
      arguments: [],
      summaries: []
    };

    let movedCount = 0;
    let llmClassifications = 0;

    // Collect all uncertain arguments for batch LLM processing
    const uncertainArgs = [];
    const themeArgMap = new Map(); // Map argument to its theme

    // First pass: identify uncertain arguments
    for (const theme of themeMapping.themes) {
      if (theme.name === 'Andre emner' || theme.category === 'out-of-scope') {
        continue;
      }
      for (const arg of (theme.arguments || [])) {
        const validation = this.isOutOfScope(arg, documentType, theme.name);
        if (validation._uncertain && useLLM) {
          uncertainArgs.push({ arg, theme: theme.name, validation });
          themeArgMap.set(arg, { themeName: theme.name, validation });
        }
      }
    }

    // Batch LLM classification for uncertain arguments
    const llmResults = new Map();
    if (uncertainArgs.length > 0 && useLLM) {
      console.log(`[LegalScopeContext] Running LLM classification for ${uncertainArgs.length} uncertain arguments`);
      for (let i = 0; i < uncertainArgs.length; i += llmBatchSize) {
        const batch = uncertainArgs.slice(i, i + llmBatchSize);
        const batchPromises = batch.map(async ({ arg, theme }) => {
          const result = await this.classifyWithLLM(arg, documentType, theme);
          return { arg, result };
        });
        const batchResults = await Promise.all(batchPromises);
        for (const { arg, result } of batchResults) {
          if (result) {
            llmResults.set(arg, result);
            llmClassifications++;
          }
        }
      }
    }

    // Second pass: process themes with combined results
    const updatedThemes = themeMapping.themes.map(theme => {
      if (theme.name === 'Andre emner' || theme.category === 'out-of-scope') {
        return theme;
      }

      const inScopeArguments = [];

      for (const arg of (theme.arguments || [])) {
        // Check LLM result first if available
        const llmResult = llmResults.get(arg);
        const heuristicResult = this.isOutOfScope(arg, documentType, theme.name);

        // Use LLM result if available and confident, otherwise use heuristic
        const validation = (llmResult && llmResult.confidence >= 0.6) ? llmResult : heuristicResult;

        if (validation.outOfScope && validation.confidence >= 0.6) {
          outOfScopeTheme.arguments.push({
            ...arg,
            originalTheme: theme.name,
            outOfScopeReason: validation.reason,
            _llmClassified: validation._llmClassified || false
          });
          movedCount++;
        } else {
          inScopeArguments.push(arg);
        }
      }

      return {
        ...theme,
        arguments: inScopeArguments
      };
    });

    // Add out-of-scope theme if it has arguments
    if (outOfScopeTheme.arguments.length > 0) {
      const existingOutOfScopeIndex = updatedThemes.findIndex(
        t => t.name === 'Andre emner' || t.category === 'out-of-scope'
      );

      if (existingOutOfScopeIndex >= 0) {
        updatedThemes[existingOutOfScopeIndex].arguments = [
          ...updatedThemes[existingOutOfScopeIndex].arguments,
          ...outOfScopeTheme.arguments
        ];
      } else {
        updatedThemes.push(outOfScopeTheme);
      }
    }

    console.log(`[LegalScopeContext] Moved ${movedCount} out-of-scope arguments (${llmClassifications} via LLM)`);

    return {
      ...themeMapping,
      themes: updatedThemes,
      _legalScopeValidation: {
        documentType,
        movedArguments: movedCount,
        llmClassifications,
        outOfScopeThemeSize: outOfScopeTheme.arguments.length
      }
    };
  }

  /**
   * Get a summary of document type capabilities
   * @param {string} documentType - Document type
   * @returns {Object} Summary of authorities and limitations
   */
  getCapabilitySummary(documentType) {
    const template = this.getTemplate(documentType);
    const legalBasis = template.legalBasis || {};

    return {
      name: template.name || documentType,
      description: template.description || '',
      primaryLaw: legalBasis.primaryLaw || 'Ukendt',
      canRegulate: legalBasis.authorities || [],
      cannotRegulate: legalBasis.limitations || [],
      outOfScopeExamples: template.outOfScopeExamples || [],
      relatedLaws: legalBasis.relatedLaws || []
    };
  }
}
