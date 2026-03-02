import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { OpenAIClientWrapper, getComplexityConfig } from './openai-client.js';
import { getResponseFormat } from './json-schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM_PROMPT = 'Du er en erfaren fuldmægtig i en dansk kommune. Du skriver tematiske høringsopsummeringer i neutral, administrativ tone og indlejrer præcise CriticMarkup-citater direkte i teksten. Du må aldrig udelade respondenter eller fordreje citaterne.';

export class HybridPromptRunner {
  constructor(options = {}) {
    this.model = options.model || {};
    this.writePromptPath = options.writePromptPath;
    this.stitchPromptPath = options.stitchPromptPath;

    // Use HEAVY complexity level for position writing (synthesis requiring language coherence)
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'heavy');
    
    this.client = new OpenAIClientWrapper({
      model: this.model.name || options.model || complexityConfig.model,
      verbosity: this.model.verbosity || options.verbosity || complexityConfig.verbosity,
      reasoningEffort: this.model.reasoningEffort || options.reasoningEffort || complexityConfig.reasoningEffort,
      timeout: this.model.timeout || 1800000, // 30 minutes for large cases with hierarchical stitching (was 10 min)
      maxRetries: this.model.maxRetries || 3,
      jobId: options.jobId // Pass jobId for tracing
    });
  }

  loadPrompt(promptPath) {
    if (!promptPath) {
      throw new Error('Prompt path not specified');
    }

    const resolved = join(__dirname, '..', '..', promptPath);
    return readFileSync(resolved, 'utf-8');
  }

  /**
   * Compress JSON payload for prompt
   * OPTIMIZATION: Remove redundant fields and compress data
   * @private
   */
  compressJsonPayload(data) {
    // CONSERVATIVE: Only remove truly empty fields, keep everything else for quality
    const compressed = JSON.parse(JSON.stringify(data));
    
    // Only remove empty arrays and completely empty strings
    if (compressed.respondents) {
      compressed.respondents.forEach(r => {
        // Remove empty snippets array only
        if (r.snippets && r.snippets.length === 0) {
          delete r.snippets;
        }
        // Keep excerpts even if short - they provide context
      });
    }
    
    return compressed;
  }

  formatPrompt(template, data, options = {}) {
    // QUALITY-FIRST: Use readable indentation for better LLM comprehension
    const compressedData = this.compressJsonPayload(data);
    const jsonPayload = JSON.stringify(compressedData, null, 2); // Readable indentation for quality
    let prompt = template.replace('{{INPUT_JSON}}', jsonPayload);
    
    // NEVER add verbosity instructions when using ultra models (gpt-5*)
    // Ultra models should use their env-configured verbosity
    const isUltraModel = this.model?.name && /^gpt-5/i.test(this.model.name);
    
    if (!isUltraModel && options.verbosity && options.respondentCount && options.mergeCount) {
      const verbosityInstructions = this.getVerbosityInstructions(
        options.verbosity,
        options.respondentCount,
        options.mergeCount
      );
      prompt = verbosityInstructions + '\n\n' + prompt;
    }
    
    return prompt;
  }
  
  /**
   * Generate verbosity-based detail level instructions
   * @param {string} verbosity - 'low', 'medium', or 'high'
   * @param {number} respondentCount - Number of respondents
   * @param {number} mergeCount - Number of merged positions
   * @returns {string} Instruction text
   */
  getVerbosityInstructions(verbosity, respondentCount, mergeCount) {
    const instructions = [`**VIGTIG KONTEKST - DETALJENIVEAU:**`,
      `Denne position har ${respondentCount} respondenter konsolideret fra ${mergeCount} oprindelige positioner.`
    ];
    
    if (verbosity === 'high') {
      instructions.push(
        ``,
        `**Detaljeniveau: HØJ - LANGE, DETALJEREDE SUMMARIES PÅKRÆVET**`,
        ``,
        `**KRITISKE KRAV:**`,
        `- **MINIMUM 5-10 afsnit** der udpensler ALLE distinkte sub-argumenter`,
        `- **MINIMUM 800-1200 ord** for positioner med >50 respondenter`,
        `- **MINIMUM 400-600 ord** for positioner med 20-50 respondenter`,
        ``,
        `**Strukturér efter indholdets faktiske nuancer (ORGANISK STRUKTUR):**`,
        `1. **Fællesnævner** (1 afsnit): Hvad er det overordnede fælles mål som ALLE deler?`,
        `2. **Primære under-argumenter** (2-4 afsnit): Udyb de mest fremtrædende begrundelser eller nuancer (dem flest respondenter nævner).`,
        `3. **Sekundære/mindre nuancer** (1-3 afsnit): Beskriv distinkte men mindre udbredte perspektiver.`,
        `4. **Proces/metode** (hvis relevant): Argumenter om proces, inddragelse eller fremgangsmåde.`,
        `5. **Alternativer/modstand** (hvis relevant): Konkrete forslag til alternativer eller specifik modstand mod delelementer.`,
        ``,
        `**VIGTIGT - ORGANISK FLOW:**`,
        `- Lad indholdet diktere strukturen - tving IKKE emner ned over teksten, hvis de ikke er i dataene`,
        `- Skab flydende overgange mellem afsnit (narrativt flow)`,
        `- Opdel respondenter i grupper baseret på sub-argumenter`,
        `- Brug konkrete tal (fx "15 borgere fokuserer på...", "9 borgere fremhæver...")`,
        `- ALLE ${respondentCount} respondenter skal være dækket i detaljer`
      );
    } else if (verbosity === 'medium') {
      instructions.push(
        ``,
        `**Detaljeniveau: MEDIUM (moderat position)**`,
        ``,
        `Giv en omfattende dækning af hovedargumenterne:`,
        `- Identificer 2-3 centrale sub-argumenter`,
        `- Beskriv nuancer i begrundelser hvis relevant`,
        `- Brug 2-3 afsnit`
      );
    } else {
      instructions.push(
        ``,
        `**Detaljeniveau: LAV (lille position)**`,
        ``,
        `Skriv en koncis opsummering af kerneargumentet i 1-2 afsnit.`
      );
    }
    
    return instructions.join('\n');
  }

  async generatePosition(positionInput, verbosityOptions = {}) {
    const promptTemplate = this.loadPrompt(this.writePromptPath);
    const prompt = this.formatPrompt(promptTemplate, positionInput, verbosityOptions);
    
    const traceOptions = {
      step: 'generatePosition',
      context: {
        position: positionInput.position?.title,
        respondentCount: positionInput.respondents?.length
      }
    };

    const raw = await this.invokeModel(prompt, traceOptions);
    return this.parseDraft(raw, 'generatePosition');
  }

  async stitchPosition({ positionInput, partialDrafts, partialSummaries }) {
    // Support both partialDrafts and partialSummaries parameter names
    const summaries = partialDrafts || partialSummaries;
    const promptTemplate = this.loadPrompt(this.stitchPromptPath);
    const prompt = this.formatPrompt(promptTemplate, {
      positionInput,
      partialDrafts: summaries // Use partialDrafts as template expects
    });

    const traceOptions = {
      step: 'stitchPosition',
      context: {
        position: positionInput.position?.title,
        partialCount: summaries?.length
      }
    };

    const raw = await this.invokeModel(prompt, traceOptions);
    return this.parseDraft(raw, 'stitchPosition');
  }

  async invokeModel(userContent, traceOptions = {}) {
    // Only log ultra-high verbose models
    if (this.model?.name && /^gpt-5/i.test(this.model.name) && process.env.DEBUG_LLM) {
      console.log(`[HybridPromptRunner] Invoking ${this.model.name}`);
    }
    
    const response = await this.client.createCompletion({
      model: this.model.name,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      response_format: getResponseFormat('hybridPositionDraft')
    }, traceOptions);

    let content = response.choices[0]?.message?.content || '';
    content = content.trim();

    // Clean markdown wrappers if present (should not be needed with json_object mode, but defensive)
    if (content.startsWith('```')) {
      content = content.replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```$/i, '').trim();
    }

    return content;
  }

  parseDraft(rawContent, context) {
    const cleaned = rawContent
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim();

    try {
      const draft = JSON.parse(cleaned);
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
        throw new Error('Parsed value is not an object');
      }

      // CRITICAL: Validate expected structure - LLM sometimes returns malformed objects
      // e.g. {0: ..., 1: ..., 2: ...} instead of {title, summary, references}
      const hasExpectedFields = 'summary' in draft || 'title' in draft || 'references' in draft;
      const hasNumericKeys = Object.keys(draft).some(k => /^\d+$/.test(k));
      if (!hasExpectedFields && hasNumericKeys) {
        throw new Error(`Malformed response structure: received object with numeric keys instead of expected {title, summary, references}. First keys: ${Object.keys(draft).slice(0, 5).join(', ')}`);
      }

      draft.summary = (draft.summary || '').trim();
      draft.references = Array.isArray(draft.references) ? draft.references : [];
      draft.warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
      return draft;
    } catch (error) {
      throw new Error(
        `[HybridPromptRunner:${context}] Kunne ikke parse JSON-output: ${error.message}\nRå tekst (first 500 chars):\n${rawContent.substring(0, 500)}`
      );
    }
  }
}

