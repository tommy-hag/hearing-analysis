/**
 * ProseProofreader
 *
 * LLM-based proofreader that fixes semantic prose quality issues in position summaries.
 * Uses heuristic pre-check to skip clean prose (saving LLM cost), then validates
 * output to ensure markers and labels are preserved.
 *
 * Fixes: first-person voice, broken fragments, grammar errors, truncated titles,
 * orphaned subjects, awkward transitions.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ProseProofreader {
  constructor(options = {}) {
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'light-plus');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });

    this._jobId = options.jobId || null;

    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/prose-proofreader-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[ProseProofreader] Could not load prompt template');
      this.promptTemplate = null;
    }

    // Stats for logging
    this.stats = { checked: 0, proofread: 0, skipped: 0, fallbacks: 0 };

    console.log(`[ProseProofreader] Initialized with model=${this.client.model}`);
  }

  /**
   * Set Job ID for tracing - required for cost tracking
   * @param {string} jobId - The job ID for LLM call tracking
   */
  setJobId(jobId) {
    this._jobId = jobId;
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
  }

  /**
   * Set run directory for LLM call logging
   * @param {string} llmCallsDir - Directory for LLM call logs
   */
  setRunDirectory(llmCallsDir) {
    this._llmCallsDir = llmCallsDir;
    if (this.client?.tracer?.setRunDirectory) {
      this.client.tracer.setRunDirectory(llmCallsDir);
    }
  }

  /**
   * Heuristic pre-check: does this summary have known prose quality issues?
   * Returns early if no issues detected, saving LLM cost.
   *
   * @param {string} summary - The summary text with <<REF_X>> markers
   * @param {string} title - The position title
   * @returns {{ needed: boolean, reasons: string[] }}
   */
  needsProofreading(summary, title = '') {
    const reasons = [];

    if (!summary || typeof summary !== 'string') {
      return { needed: false, reasons: [] };
    }

    // Strip quoted text (between *"..."*) to avoid false positives on citizen quotes
    const withoutQuotes = summary.replace(/\*"[^"]*"\*/g, '');

    // 1. First-person in prose (not inside quotes)
    if (/\bJeg\b/.test(withoutQuotes)) {
      reasons.push('first-person "Jeg"');
    }

    // 2. Broken fragment: "Vedkommende/De skriver." followed by capital letter or end
    if (/(?:Vedkommende|De)\s+(?:skriver|bemærker|anfører)\.\s*(?=\p{Lu}|\s*$)/mu.test(withoutQuotes)) {
      reasons.push('broken fragment (skriver./bemærker.)');
    }

    // 3. Awkward transition: "De skriver, [Capital]" suggesting malformed prose
    if (/De skriver,\s*\p{Lu}/u.test(withoutQuotes)) {
      reasons.push('awkward transition "De skriver, [Uppercase]"');
    }

    // 4. Double article: "en én" or "En én"
    if (/\b[Ee]n\s+én\b/.test(withoutQuotes)) {
      reasons.push('double article "en én"');
    }

    // 5. Truncated word in title: ends with hyphen
    if (title && /-\s*$/.test(title.trim())) {
      reasons.push('truncated title (ends with -)');
    }

    // 6. Orphaned subject: sentence ending with "anfører." or "skriver." alone
    if (/(anfører|skriver|bemærker)\.\s*$/m.test(withoutQuotes)) {
      reasons.push('orphaned subject (verb at end of sentence)');
    }

    return { needed: reasons.length > 0, reasons };
  }

  /**
   * Main entry: proofread a hybridSummary's summary and title.
   *
   * @param {Object} hybridSummary - { summary, title, references, ... }
   * @returns {Object} Updated hybridSummary (or original if no changes needed)
   */
  async proofread(hybridSummary) {
    if (!hybridSummary?.summary || !this.promptTemplate) {
      return hybridSummary;
    }

    this.stats.checked++;

    const { needed, reasons } = this.needsProofreading(hybridSummary.summary, hybridSummary.title);
    if (!needed) {
      this.stats.skipped++;
      return hybridSummary;
    }

    console.log(`[ProseProofreader] Issues detected: ${reasons.join(', ')}`);

    // Build prompt
    const prompt = this.promptTemplate
      .replace('{{POSITION_TITLE}}', hybridSummary.title || '(ingen titel)')
      .replace('{{SUMMARY_TEXT}}', hybridSummary.summary);

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en korrekturlæser for danske forvaltningsopsummeringer. Du retter KUN sproglige fejl og bevarer alle <<REF_X>> markører nøjagtigt.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      }, {
        step: 'prose-proofread',
        context: `proofread: reasons=${reasons.join(',')}`
      });

      const rawOutput = (response.choices?.[0]?.message?.content || '').trim();

      if (!rawOutput) {
        console.warn('[ProseProofreader] Empty LLM response, keeping original');
        this.stats.fallbacks++;
        return hybridSummary;
      }

      // Parse output: check if title was corrected (first line + --- separator)
      let proofreadSummary = rawOutput;
      let proofreadTitle = null;

      const separatorIndex = rawOutput.indexOf('\n---\n');
      if (separatorIndex > 0 && separatorIndex < 200) {
        // Title correction present
        proofreadTitle = rawOutput.substring(0, separatorIndex).trim();
        proofreadSummary = rawOutput.substring(separatorIndex + 5).trim();
      }

      // Extract ref IDs from original
      const originalRefs = this.extractRefIds(hybridSummary.summary);

      // Validate output
      const validation = this.validateOutput(
        hybridSummary.summary,
        proofreadSummary,
        originalRefs
      );

      if (!validation.valid) {
        console.warn(`[ProseProofreader] Validation failed: ${validation.reasons.join(', ')}. Keeping original.`);
        this.stats.fallbacks++;
        return hybridSummary;
      }

      // Apply corrections
      const result = { ...hybridSummary, summary: proofreadSummary };
      if (proofreadTitle && proofreadTitle !== hybridSummary.title) {
        // Validate title change is minor (not a complete rewrite)
        if (proofreadTitle.length > 0 && proofreadTitle.length < hybridSummary.title.length * 2) {
          result.title = proofreadTitle;
          console.log(`[ProseProofreader] Title corrected: "${hybridSummary.title}" → "${proofreadTitle}"`);
        }
      }

      this.stats.proofread++;
      console.log(`[ProseProofreader] ✅ Proofread applied (${reasons.length} issues)`);
      return result;

    } catch (error) {
      console.warn(`[ProseProofreader] LLM error: ${error.message}. Keeping original.`);
      this.stats.fallbacks++;
      return hybridSummary;
    }
  }

  /**
   * Extract all <<REF_X>> IDs from text.
   * @param {string} text
   * @returns {Set<string>}
   */
  extractRefIds(text) {
    const ids = new Set();
    const pattern = /<<(REF_\d+)>>/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      ids.add(match[1]);
    }
    return ids;
  }

  /**
   * Validate proofread output to ensure safety.
   *
   * @param {string} original - Original summary text
   * @param {string} proofread - Proofread summary text
   * @param {Set<string>} originalRefIds - Set of REF IDs from original
   * @returns {{ valid: boolean, reasons: string[] }}
   */
  validateOutput(original, proofread, originalRefIds) {
    const reasons = [];

    if (!proofread || typeof proofread !== 'string' || proofread.trim().length === 0) {
      reasons.push('empty output');
      return { valid: false, reasons };
    }

    // 1. Marker validation: all <<REF_X>> must survive
    const proofreadRefs = this.extractRefIds(proofread);
    for (const refId of originalRefIds) {
      if (!proofreadRefs.has(refId)) {
        reasons.push(`missing marker: <<${refId}>>`);
      }
    }
    // Also check for added markers
    for (const refId of proofreadRefs) {
      if (!originalRefIds.has(refId)) {
        reasons.push(`added marker: <<${refId}>>`);
      }
    }

    if (reasons.length > 0) {
      return { valid: false, reasons };
    }

    // 2. Change ratio: Levenshtein-like approximation
    // Use simple character-level difference as proxy
    const changeRatio = Math.abs(original.length - proofread.length) / Math.max(original.length, 1);
    // Also count shared substrings to detect rewrites
    const shorterLen = Math.min(original.length, proofread.length);
    let matchingChars = 0;
    for (let i = 0; i < shorterLen; i++) {
      if (original[i] === proofread[i]) matchingChars++;
    }
    const similarityRatio = matchingChars / Math.max(original.length, 1);

    // If less than 50% of characters match at same positions, it's likely a rewrite
    if (similarityRatio < 0.50) {
      reasons.push(`excessive rewrite (similarity=${(similarityRatio * 100).toFixed(0)}%)`);
    }

    // If length changed by more than 25%, suspicious
    if (changeRatio > 0.25) {
      reasons.push(`excessive length change (${(changeRatio * 100).toFixed(0)}%)`);
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Get summary statistics.
   * @returns {Object} Stats about proofread operations
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Log final stats.
   */
  logStats() {
    const { checked, proofread, skipped, fallbacks } = this.stats;
    console.log(`[ProseProofreader] Stats: ${checked} checked, ${proofread} proofread, ${skipped} skipped (clean), ${fallbacks} fallbacks`);
  }
}
