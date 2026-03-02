/**
 * PositionTitleGenerator
 *
 * Dedicated component for generating focused position titles that represent
 * the common minimum holding (master-holdning) shared by all respondents.
 *
 * This step runs after consolidate-positions and replaces vague titles
 * that contain "og" or multiple concepts with a single, focused title.
 *
 * Key features:
 * - Frequency analysis for mega-positions (>50 respondents)
 * - Stratified sampling to ensure representative input
 * - Strict "no og" validation
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';
import { validatePositionTitle, autoFixTitle } from '../validation/title-validator.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PositionTitleGenerator {
  constructor(options = {}) {
    // Use MEDIUM-PLUS complexity for title generation
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium-plus');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
      timeout: options.timeout || 30000
    });

    // Load prompt template
    const promptPath = join(__dirname, '../../prompts/position-title-prompt.md');
    this.promptTemplate = readFileSync(promptPath, 'utf-8');

    // Sampling thresholds
    this.samplingThresholds = {
      direct: 50,        // <=50: send all args directly
      small: 200,        // 51-200: freq analysis + 50 samples
      medium: 500,       // 201-500: freq analysis + 75 samples
      large: Infinity    // 500+: freq analysis + 100 samples
    };

    console.log(`[PositionTitleGenerator] Initialized with model=${this.client.model}`);
  }

  /**
   * Set Job ID for tracing
   * @param {string} jobId - The job ID for LLM call tracking
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
  }

  /**
   * Generate titles for all positions across themes.
   *
   * @param {Array} themes - Array of theme objects with positions
   * @param {Object} microSummaries - Map of responseNumber -> microSummary
   * @param {Object} options - Additional options
   * @returns {Promise<Array>} Themes with updated position titles
   */
  async generateTitles(themes, microSummaries = {}, options = {}) {
    if (!themes || !Array.isArray(themes)) {
      console.warn('[PositionTitleGenerator] No themes provided');
      return themes;
    }

    const results = [];
    let totalPositions = 0;
    let titlesChanged = 0;
    let titlesSkipped = 0;

    for (const theme of themes) {
      const updatedPositions = [];

      for (const position of (theme.positions || [])) {
        totalPositions++;

        try {
          const updated = await this.generateTitleForPosition(
            position,
            theme.name,
            microSummaries,
            options
          );

          if (updated.title !== position.title) {
            titlesChanged++;
            console.log(`[PositionTitleGenerator] Changed: "${position.title?.slice(0, 40)}..." → "${updated.title?.slice(0, 40)}..."`);
          } else {
            titlesSkipped++;
          }

          updatedPositions.push(updated);
        } catch (error) {
          console.error(`[PositionTitleGenerator] Error for position "${position.title?.slice(0, 30)}...":`, error.message);
          // Keep original title on error
          updatedPositions.push({
            ...position,
            _titleGenerationError: error.message
          });
        }
      }

      results.push({
        ...theme,
        positions: updatedPositions
      });
    }

    console.log(`[PositionTitleGenerator] Summary: ${titlesChanged}/${totalPositions} titles changed, ${titlesSkipped} kept`);

    return results;
  }

  /**
   * Generate title for a single position.
   *
   * @param {Object} position - Position object
   * @param {string} themeName - Parent theme name
   * @param {Object} microSummaries - Map of responseNumber -> microSummary
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Position with updated title
   */
  async generateTitleForPosition(position, themeName, microSummaries = {}, options = {}) {
    const respondentCount = position.responseNumbers?.length || 0;

    // ALL positions go through title generation for consistency
    // Even single-respondent positions need proper formatting with material context

    // Collect arguments for this position
    const args = this.collectArgumentsForPosition(position, microSummaries);

    if (args.length === 0) {
      console.warn(`[PositionTitleGenerator] No arguments found for position with ${respondentCount} respondents`);
      return {
        ...position,
        _titleSource: 'no-args-fallback'
      };
    }

    // Build input based on position size, including material context
    const input = this.buildTitleInput(position, themeName, args, options);

    // Call LLM
    const result = await this.callLLM(input);

    // Validate and apply title
    const newTitle = this.validateAndApplyTitle(result, position);

    return {
      ...position,
      title: newTitle,
      _hintTitle: position.title, // Preserve original as hint
      _titleSource: 'generated',
      _titleConfidence: result?.confidence || 'unknown',
      _titleReasoning: result?.reasoning || null
    };
  }

  /**
   * Collect arguments for a position from micro-summaries.
   */
  collectArgumentsForPosition(position, microSummaries) {
    const args = [];

    // Use sourceArgumentRefs if available
    if (position.sourceArgumentRefs && Array.isArray(position.sourceArgumentRefs)) {
      for (const ref of position.sourceArgumentRefs) {
        args.push({
          responseNumber: ref.responseNumber,
          consequence: ref.consequence || ref.what || '',
          coreContent: ref.coreContent || ref.what || '',
          desiredAction: ref.desiredAction || ref.how || '',
          direction: ref.direction || position._direction || 'neutral'
        });
      }
    }

    // Fallback: use args array if available
    if (args.length === 0 && position.args && Array.isArray(position.args)) {
      for (const arg of position.args) {
        args.push({
          responseNumber: arg.responseNumber,
          consequence: arg.consequence || arg.what || '',
          coreContent: arg.coreContent || arg.what || '',
          desiredAction: arg.desiredAction || arg.how || '',
          direction: arg.direction || position._direction || 'neutral'
        });
      }
    }

    // Fallback: lookup from microSummaries by responseNumber
    if (args.length === 0 && position.responseNumbers) {
      for (const respNum of position.responseNumbers) {
        const micro = microSummaries[respNum];
        if (micro && micro.arguments) {
          for (const arg of micro.arguments) {
            args.push({
              responseNumber: respNum,
              consequence: arg.consequence || arg.what || '',
              coreContent: arg.coreContent || arg.what || '',
              desiredAction: arg.desiredAction || arg.how || '',
              direction: arg.direction || 'neutral'
            });
          }
        }
      }
    }

    return args;
  }

  /**
   * Build input for LLM based on position size.
   * Uses frequency analysis for large positions.
   * Includes material context for sharper titles.
   */
  buildTitleInput(position, themeName, args, options = {}) {
    const respondentCount = position.responseNumbers?.length || args.length;

    const input = {
      theme: themeName,
      directionGroup: position._directionGroup || position._direction || 'neutral',
      respondentCount: respondentCount,
      hintTitle: position.title || position._hintTitle || null,
      mergedFrom: position._mergedFrom || []
    };

    // Add material context for sharper, grounded titles
    if (options.materialSummary) {
      // Extract key hearing context (first 500 chars to keep prompt focused)
      input.hearingContext = typeof options.materialSummary === 'string'
        ? options.materialSummary.slice(0, 500)
        : (options.materialSummary.summary || '').slice(0, 500);
    }

    // Add taxonomy themes for context
    if (options.taxonomy && Array.isArray(options.taxonomy)) {
      input.materialThemes = options.taxonomy.slice(0, 5).map(t => ({
        name: t.name,
        description: t.description?.slice(0, 100)
      }));
    }

    // Determine sampling strategy based on size
    if (respondentCount <= this.samplingThresholds.direct) {
      // Small position: send all args
      input.arguments = args.map(a => this.formatArgument(a));
      input.frequencyDistribution = null;
    } else {
      // Large position: frequency analysis + stratified sampling
      const { frequencyDistribution, samples } = this.buildFrequencyInput(args, respondentCount);
      input.frequencyDistribution = frequencyDistribution;
      input.arguments = samples.map(a => this.formatArgument(a));
    }

    return input;
  }

  /**
   * Build frequency distribution and stratified samples for mega-positions.
   */
  buildFrequencyInput(args, totalRespondents) {
    // Count consequences
    const consequenceCounts = new Map();

    for (const arg of args) {
      const key = this.normalizeConsequence(arg.consequence || arg.coreContent || 'ukendt');
      if (!consequenceCounts.has(key)) {
        consequenceCounts.set(key, { text: arg.consequence || arg.coreContent, count: 0, examples: [] });
      }
      const entry = consequenceCounts.get(key);
      entry.count++;
      if (entry.examples.length < 3) {
        entry.examples.push(arg);
      }
    }

    // Sort by frequency and take top 10
    const sorted = [...consequenceCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);

    // Build frequency distribution
    const frequencyDistribution = sorted.map(([key, data]) => ({
      text: data.text,
      count: data.count,
      pct: Math.round((data.count / args.length) * 100)
    }));

    // Stratified sampling: take examples from each frequency group
    const maxSamples = totalRespondents <= 200 ? 50 :
                       totalRespondents <= 500 ? 75 : 100;

    const samplesPerGroup = Math.max(3, Math.floor(maxSamples / Math.min(sorted.length, 10)));
    const samples = [];

    for (const [key, data] of sorted) {
      // Get more examples from this group
      const groupArgs = args.filter(a =>
        this.normalizeConsequence(a.consequence || a.coreContent || '') === key
      );

      // Random sample from group
      const shuffled = groupArgs.sort(() => Math.random() - 0.5);
      samples.push(...shuffled.slice(0, samplesPerGroup));
    }

    // Ensure we have at least some diversity
    if (samples.length < 20 && args.length >= 20) {
      const existing = new Set(samples.map(s => s.responseNumber));
      const additional = args.filter(a => !existing.has(a.responseNumber))
        .sort(() => Math.random() - 0.5)
        .slice(0, 20 - samples.length);
      samples.push(...additional);
    }

    return { frequencyDistribution, samples: samples.slice(0, maxSamples) };
  }

  /**
   * Normalize consequence text for grouping.
   */
  normalizeConsequence(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[.,;:!?]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100); // Limit length for grouping
  }

  /**
   * Format argument for prompt.
   */
  formatArgument(arg) {
    return {
      responseNumber: arg.responseNumber,
      consequence: arg.consequence || '',
      coreContent: arg.coreContent || '',
      desiredAction: arg.desiredAction || ''
    };
  }

  /**
   * Call LLM with formatted prompt.
   */
  async callLLM(input) {
    // Build prompt from template
    let prompt = this.promptTemplate
      .replace('{{THEME}}', input.theme || 'Ikke angivet')
      .replace('{{DIRECTION_GROUP}}', input.directionGroup || 'neutral')
      .replace('{{RESPONDENT_COUNT}}', String(input.respondentCount || 0));

    // Handle hearing context (material summary)
    if (input.hearingContext) {
      prompt = prompt
        .replace('{{#if HEARING_CONTEXT}}', '')
        .replace('{{HEARING_CONTEXT}}', input.hearingContext);
    } else {
      prompt = prompt.replace(/\{\{#if HEARING_CONTEXT\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    // Handle material themes
    if (input.materialThemes && input.materialThemes.length > 0) {
      const themesText = input.materialThemes
        .map(t => `- **${t.name}**: ${t.description || ''}`)
        .join('\n');
      prompt = prompt
        .replace('{{#if MATERIAL_THEMES}}', '')
        .replace('{{MATERIAL_THEMES}}', themesText);
    } else {
      prompt = prompt.replace(/\{\{#if MATERIAL_THEMES\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    // Clean up remaining {{/if}} tags
    prompt = prompt.replace(/\{\{\/if\}\}/g, '');

    // Handle frequency distribution
    if (input.frequencyDistribution && input.frequencyDistribution.length > 0) {
      const freqText = input.frequencyDistribution
        .map(f => `- "${f.text}" (${f.count} respondenter, ${f.pct}%)`)
        .join('\n');
      prompt = prompt
        .replace('{{#if FREQUENCY_DISTRIBUTION}}', '')
        .replace('{{FREQUENCY_DISTRIBUTION}}', freqText);
    } else {
      // Remove frequency section
      prompt = prompt.replace(/\{\{#if FREQUENCY_DISTRIBUTION\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    // Handle merged-from titles (for consolidated positions)
    if (input.mergedFrom && input.mergedFrom.length > 0) {
      const mergedText = input.mergedFrom.slice(0, 5).map(t => `- ${t}`).join('\n');
      prompt = prompt
        .replace('{{#if MERGED_FROM}}', '')
        .replace('{{MERGED_FROM}}', mergedText);
    } else {
      // Remove merged-from section
      prompt = prompt.replace(/\{\{#if MERGED_FROM\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    // Format arguments
    const argsText = input.arguments
      .map(a => `[${a.responseNumber}] ${a.consequence || a.coreContent || 'Ingen holdning angivet'}`)
      .join('\n');
    prompt = prompt.replace('{{ARGUMENTS}}', argsText);

    // Call LLM
    const result = await this.client.createCompletion({
      messages: [{ role: 'user', content: prompt }],
      response_format: getResponseFormat('positionTitle'),
      complexityTier: 'light-plus',
      maxTokens: 500
    });

    // Parse response
    try {
      const content = result?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }
      return JSON.parse(content);
    } catch (e) {
      console.error('[PositionTitleGenerator] Failed to parse LLM response:', e.message);
      return { title: null, confidence: 'low', reasoning: 'Parse error' };
    }
  }

  /**
   * Validate and apply title, with fallback to original.
   */
  validateAndApplyTitle(result, position) {
    let title = result?.title;

    if (!title) {
      // Fallback to existing title
      return position.title || position._hintTitle || 'Holdning';
    }

    // Check for forbidden "og" pattern
    if (this.hasForbiddenOg(title)) {
      console.warn(`[PositionTitleGenerator] Title contains forbidden "og": "${title}"`);
      // Try to auto-fix by taking first part
      const parts = title.split(/\s+og\s+/i);
      if (parts.length > 1) {
        title = parts[0].trim();
        console.log(`[PositionTitleGenerator] Auto-fixed to: "${title}"`);
      }
    }

    // Validate with existing validator
    const validation = validatePositionTitle(title);
    if (!validation.valid) {
      // Try auto-fix
      const fixed = autoFixTitle(title, position._direction || position._directionGroup);
      if (fixed !== title) {
        console.log(`[PositionTitleGenerator] Auto-fixed title: "${title}" → "${fixed}"`);
        title = fixed;
      }
    }

    // Log warnings
    if (validation.warnings?.length > 0) {
      for (const warn of validation.warnings) {
        console.warn(`[PositionTitleGenerator] Warning: ${warn}`);
      }
    }

    return title;
  }

  /**
   * Check if title contains forbidden "og" pattern (two holdninger joined).
   */
  hasForbiddenOg(title) {
    if (!title || !title.includes(' og ')) {
      return false;
    }

    // Pattern: holdningsmarkør ... og ... holdningsmarkør
    const pattern = /(modstand|bekymring|ønske|støtte|forslag|krav|opfordring)\s+.*\s+og\s+.*(modstand|bekymring|ønske|støtte|forslag|krav|opfordring)/i;
    if (pattern.test(title)) {
      return true;
    }

    // Pattern: two separate concerns joined by "og"
    // e.g., "Bekymring for trafik og støj" (two concerns)
    // vs "Bevaring af bygning og have" (one compound object - OK)

    // Heuristic: if "og" appears after a preposition, it's likely a compound object
    const compoundPattern = /\s+(af|for|mod|til|om|ved|på)\s+\w+\s+og\s+\w+/i;
    if (!compoundPattern.test(title)) {
      // "og" not in compound object context - likely forbidden
      const ogIndex = title.toLowerCase().indexOf(' og ');
      if (ogIndex > 20) { // "og" appears late in title - suspicious
        return true;
      }
    }

    return false;
  }
}

export default PositionTitleGenerator;
