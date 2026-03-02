import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env
const envPaths = [
  join(__dirname, '../../config/.env'),
  join(process.cwd(), 'config/.env'),
  join(process.cwd(), '.env')
];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
    break;
  }
}

/**
 * Pricing per 1M tokens (as of 2024)
 * Update these values when pricing changes
 */
const MODEL_PRICING = {
  // GPT-5 family (estimated pricing)
  'gpt-5-nano': { input: 0.10, output: 0.40 },
  'gpt-5-mini': { input: 0.40, output: 1.60 },
  'gpt-5': { input: 2.00, output: 8.00 },

  // GPT-4o family
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },

  // OpenAI Embeddings
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-3-small': { input: 0.02, output: 0 },

  // Alibaba Cloud Embeddings
  'text-embedding-v4': { input: 0.07, output: 0 },
  'text-embedding-v3': { input: 0.07, output: 0 },

  // Alibaba Cloud Reranking
  'gte-rerank': { input: 0.10, output: 0 },
  'qwen3-rerank': { input: 0.10, output: 0 },
  'gte-rerank-v2': { input: 0.115, output: 0 },

  // Fallback
  'default': { input: 0.50, output: 2.00 }
};

/**
 * RunSummaryGenerator
 * 
 * Generates a comprehensive summary of a pipeline run including:
 * - LLM model configuration from .env
 * - Token usage per model (LLM + Embeddings)
 * - Cost estimates
 * - Timing information
 * - Data statistics (responses, themes, positions)
 * - Validation results and quality score
 * - Warnings and errors
 */
export class RunSummaryGenerator {
  constructor(options = {}) {
    this.runDir = options.runDir;
    this.hearingId = options.hearingId;
    this.label = options.label;

    // Optional: pass in runtime data for more accurate stats
    this.embeddingUsage = options.embeddingUsage || null;
    this.validationResults = options.validationResults || {};
    this.dataStats = options.dataStats || null;
    this.warnings = options.warnings || [];
    this.errors = options.errors || [];

    // Baseline/inherited cost tracking
    this.sourceCheckpointLabel = options.sourceCheckpointLabel || null;
    this.resumedFromStep = options.resumedFromStep || null;
    this.inheritedSteps = options.inheritedSteps || [];
  }

  /**
   * Load baseline run-summary from source checkpoint to calculate inherited costs
   * @returns {Object|null} Baseline summary or null if not available
   */
  loadBaselineSummary() {
    if (!this.sourceCheckpointLabel || this.sourceCheckpointLabel === this.label) {
      return null; // No baseline if same label or not specified
    }

    // Construct path to baseline run-summary
    const baselinePath = join(
      dirname(this.runDir), // Parent of current run dir (runs/{hearingId}/)
      this.sourceCheckpointLabel,
      'run-summary.json'
    );

    if (!existsSync(baselinePath)) {
      console.log(`[RunSummaryGenerator] No baseline summary found at ${baselinePath}`);
      return null;
    }

    try {
      const content = readFileSync(baselinePath, 'utf-8');
      const baselineSummary = JSON.parse(content);
      console.log(`[RunSummaryGenerator] Loaded baseline summary from ${this.sourceCheckpointLabel}`);
      return baselineSummary;
    } catch (err) {
      console.warn(`[RunSummaryGenerator] Failed to load baseline summary: ${err.message}`);
      return null;
    }
  }

  /**
   * Calculate inherited costs from baseline summary
   * @param {Object} baselineSummary - Baseline run-summary
   * @returns {Object} Inherited cost information
   */
  calculateInheritedCosts(baselineSummary) {
    if (!baselineSummary || !baselineSummary.usage) {
      return null;
    }

    // Calculate costs from inherited steps only
    const inheritedStepCosts = (baselineSummary.usage.byStep || [])
      .filter(s => this.inheritedSteps.includes(s.step))
      .reduce((acc, s) => {
        acc.cost += s.cost || 0;
        acc.calls += s.calls || 0;
        acc.inputTokens += s.inputTokens || 0;
        acc.outputTokens += s.outputTokens || 0;
        return acc;
      }, { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 });

    // Include embedding costs if they were in inherited steps
    // (embeddings are typically done in 'embedding' step)
    let inheritedEmbeddingCost = 0;
    if (this.inheritedSteps.includes('embedding') && baselineSummary.usage.embedding) {
      inheritedEmbeddingCost = baselineSummary.usage.embedding.cost || 0;
    }

    return {
      sourceLabel: this.sourceCheckpointLabel,
      steps: this.inheritedSteps,
      stepCount: this.inheritedSteps.length,
      llmCost: inheritedStepCosts.cost,
      llmCalls: inheritedStepCosts.calls,
      embeddingCost: inheritedEmbeddingCost,
      totalCost: inheritedStepCosts.cost + inheritedEmbeddingCost,
      totalCostFormatted: `$${(inheritedStepCosts.cost + inheritedEmbeddingCost).toFixed(4)}`,
      llmCostFormatted: `$${inheritedStepCosts.cost.toFixed(4)}`,
      embeddingCostFormatted: `$${inheritedEmbeddingCost.toFixed(4)}`
    };
  }

  /**
   * Get LLM configuration from environment
   */
  getLLMConfig() {
    return {
      light: {
        model: process.env.LLM_LIGHT_MODEL || 'gpt-5-nano',
        verbosity: process.env.LLM_LIGHT_VERBOSITY || 'low',
        reasoning: process.env.LLM_LIGHT_REASONING_LEVEL || 'minimal'
      },
      lightPlus: {
        model: process.env.LLM_LIGHT_PLUS_MODEL || 'gpt-5-nano',
        verbosity: process.env.LLM_LIGHT_PLUS_VERBOSITY || 'medium',
        reasoning: process.env.LLM_LIGHT_PLUS_REASONING_LEVEL || 'high'
      },
      medium: {
        model: process.env.LLM_MEDIUM_MODEL || 'gpt-5-mini',
        verbosity: process.env.LLM_MEDIUM_VERBOSITY || 'medium',
        reasoning: process.env.LLM_MEDIUM_REASONING_LEVEL || 'high'
      },
      mediumPlus: {
        model: process.env.LLM_MEDIUM_PLUS_MODEL || 'gpt-5-mini',
        verbosity: process.env.LLM_MEDIUM_PLUS_VERBOSITY || 'low',
        reasoning: process.env.LLM_MEDIUM_PLUS_REASONING_LEVEL || 'low'
      },
      heavy: {
        model: process.env.LLM_HEAVY_MODEL || 'gpt-5-mini',
        verbosity: process.env.LLM_HEAVY_VERBOSITY || 'medium',
        reasoning: process.env.LLM_HEAVY_REASONING_LEVEL || 'high'
      },
      ultra: {
        model: process.env.LLM_ULTRA_MODEL || 'gpt-5-mini',
        verbosity: process.env.LLM_ULTRA_VERBOSITY || 'medium',
        reasoning: process.env.LLM_ULTRA_REASONING_LEVEL || 'medium'
      },
      embedding: {
        model: process.env.EMBEDDING_MODEL || 'text-embedding-3-large',
        batchSize: process.env.EMBEDDING_BATCH_SIZE || 50
      }
    };
  }

  /**
   * Collect all LLM call logs from the run directory
   */
  collectLLMCalls() {
    const llmCallsDir = join(this.runDir, 'llm-calls');
    if (!existsSync(llmCallsDir)) {
      return [];
    }

    const calls = [];
    const files = readdirSync(llmCallsDir).filter(f => f.endsWith('.json') && !f.includes('failure'));
    
    for (const file of files) {
      try {
        const content = readFileSync(join(llmCallsDir, file), 'utf-8');
        const data = JSON.parse(content);
        calls.push({
          file,
          ...data
        });
      } catch (err) {
        // Skip invalid files
      }
    }

    return calls.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  /**
   * Calculate token usage and costs per model
   */
  calculateUsage(calls) {
    const modelStats = {};
    const stepStats = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let totalDuration = 0;
    let callCount = 0;

    for (const call of calls) {
      // Only count response events (they have usage data)
      if (call.type !== 'llm_response' || !call.payload?.usage) continue;

      const usage = call.payload.usage;
      const model = call.payload.model || 'unknown';
      const step = call.step || 'unknown';
      const duration = call.duration || 0;

      const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const outputTokens = usage.completion_tokens || usage.output_tokens || 0;

      // Get pricing for this model
      const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];
      const cost = (inputTokens / 1_000_000 * pricing.input) + 
                   (outputTokens / 1_000_000 * pricing.output);

      // Update model stats
      if (!modelStats[model]) {
        modelStats[model] = {
          model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cost: 0,
          duration: 0
        };
      }
      modelStats[model].calls++;
      modelStats[model].inputTokens += inputTokens;
      modelStats[model].outputTokens += outputTokens;
      modelStats[model].totalTokens += inputTokens + outputTokens;
      modelStats[model].cost += cost;
      modelStats[model].duration += duration;

      // Update step stats
      if (!stepStats[step]) {
        stepStats[step] = {
          step,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          duration: 0
        };
      }
      stepStats[step].calls++;
      stepStats[step].inputTokens += inputTokens;
      stepStats[step].outputTokens += outputTokens;
      stepStats[step].cost += cost;
      stepStats[step].duration += duration;

      // Update totals
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalCost += cost;
      totalDuration += duration;
      callCount++;
    }

    return {
      modelStats: Object.values(modelStats),
      stepStats: Object.values(stepStats),
      totals: {
        calls: callCount,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cost: totalCost,
        duration: totalDuration
      }
    };
  }

  /**
   * Collect data statistics from checkpoints
   */
  collectDataStats() {
    if (this.dataStats) return this.dataStats;
    
    const checkpointsDir = join(this.runDir, 'checkpoints');
    const stats = {
      responseCount: 0,
      materialCount: 0,
      chunkCount: 0,
      embeddingCount: 0,
      themeCount: 0,
      positionCount: 0,
      argumentCount: 0,
      avgResponseLength: 0,
      totalResponseChars: 0,
      // Respondent coverage stats
      respondentCoverage: {
        allResponseIds: [],
        representedResponseIds: [],
        missingResponseIds: [],
        multiPositionRespondents: [], // respondents appearing in multiple positions
        allRepresented: false,
        representedCount: 0,
        multiPositionCount: 0
      }
    };

    try {
      // Load data from checkpoints
      const loadDataPath = join(checkpointsDir, 'load-data.json');
      let allResponseIds = [];
      if (existsSync(loadDataPath)) {
        const loadData = JSON.parse(readFileSync(loadDataPath, 'utf-8'));
        stats.responseCount = loadData.responses?.length || 0;
        stats.materialCount = loadData.materials?.length || 0;
        
        // Get all response IDs
        allResponseIds = (loadData.responses || []).map(r => r.id).sort((a, b) => a - b);
        stats.respondentCoverage.allResponseIds = allResponseIds;
        
        // Calculate avg response length
        if (loadData.responses?.length > 0) {
          stats.totalResponseChars = loadData.responses.reduce((sum, r) => 
            sum + (r.text?.length || r.textMd?.length || 0), 0);
          stats.avgResponseLength = Math.round(stats.totalResponseChars / stats.responseCount);
        }
      }

      // Get chunk count
      const chunkingPath = join(checkpointsDir, 'chunking.json');
      if (existsSync(chunkingPath)) {
        const chunks = JSON.parse(readFileSync(chunkingPath, 'utf-8'));
        stats.chunkCount = Array.isArray(chunks) ? chunks.length : 0;
      }

      // Get embedding count
      const embeddingPath = join(checkpointsDir, 'embedding.json');
      if (existsSync(embeddingPath)) {
        const embeddings = JSON.parse(readFileSync(embeddingPath, 'utf-8'));
        stats.embeddingCount = Array.isArray(embeddings) ? embeddings.length : 0;
      }

      // Get theme and argument count
      const themesPath = join(checkpointsDir, 'theme-mapping.json');
      if (existsSync(themesPath)) {
        const themes = JSON.parse(readFileSync(themesPath, 'utf-8'));
        stats.themeCount = themes.themes?.length || 0;
        stats.argumentCount = themes.themes?.reduce((sum, t) => 
          sum + (t.arguments?.length || 0), 0) || 0;
      }

      // Get position count from final output and analyze respondent coverage
      // Use validate-coverage.json (which includes "Ingen holdning" respondents) if available,
      // fall back to sort-positions.json for older checkpoints
      const validateCoveragePath = join(checkpointsDir, 'validate-coverage.json');
      const sortedPath = join(checkpointsDir, 'sort-positions.json');
      const coveragePath = existsSync(validateCoveragePath) ? validateCoveragePath : sortedPath;
      
      if (existsSync(coveragePath)) {
        const sorted = JSON.parse(readFileSync(coveragePath, 'utf-8'));
        stats.positionCount = Array.isArray(sorted) 
          ? sorted.reduce((sum, t) => sum + (t.positions?.length || 0), 0)
          : 0;
        
        // Analyze respondent representation across positions
        if (Array.isArray(sorted)) {
          const respondentPositionCount = {}; // Track how many positions each respondent appears in
          
          for (const theme of sorted) {
            for (const position of (theme.positions || [])) {
              const responseNumbers = position.responseNumbers || [];
              for (const respId of responseNumbers) {
                respondentPositionCount[respId] = (respondentPositionCount[respId] || 0) + 1;
              }
            }
          }
          
          // Calculate coverage statistics
          const representedIds = Object.keys(respondentPositionCount).map(Number).sort((a, b) => a - b);
          const representedSet = new Set(representedIds);
          const missingIds = allResponseIds.filter(id => !representedSet.has(id));
          const multiPositionRespondents = Object.entries(respondentPositionCount)
            .filter(([_, count]) => count > 1)
            .map(([id, count]) => ({ responseId: Number(id), positionCount: count }))
            .sort((a, b) => b.positionCount - a.positionCount);
          
          stats.respondentCoverage = {
            allResponseIds,
            representedResponseIds: representedIds,
            missingResponseIds: missingIds,
            multiPositionRespondents,
            allRepresented: missingIds.length === 0,
            representedCount: representedIds.length,
            multiPositionCount: multiPositionRespondents.length
          };
        }
      }
    } catch (err) {
      // Ignore errors - return partial stats
    }

    return stats;
  }

  /**
   * Collect validation results from checkpoints
   */
  collectValidationResults() {
    if (Object.keys(this.validationResults).length > 0) {
      return this.validationResults;
    }

    const checkpointsDir = join(this.runDir, 'checkpoints');
    const results = {};

    const validationFiles = [
      { file: 'validate-citations.json', key: 'citations' },
      { file: 'validate-writer-output.json', key: 'writerOutput' },
      { file: 'validate-positions.json', key: 'positions' },
      { file: 'validate-coverage.json', key: 'coverage' },
      { file: 'format-output.json', key: 'format' }
    ];

    for (const { file, key } of validationFiles) {
      try {
        const filePath = join(checkpointsDir, file);
        if (existsSync(filePath)) {
          const data = JSON.parse(readFileSync(filePath, 'utf-8'));
          results[key] = {
            valid: data.valid !== false,
            errorCount: data.errors?.length || data.errorCount || 0,
            warningCount: data.warnings?.length || data.warningCount || 0,
            details: data.stats || data.summary || null
          };
        }
      } catch (err) {
        // Skip invalid files
      }
    }

    return results;
  }

  /**
   * Collect warnings and errors from terminal log
   */
  collectWarningsAndErrors() {
    if (this.warnings.length > 0 || this.errors.length > 0) {
      return { warnings: this.warnings, errors: this.errors };
    }

    const terminalLogPath = join(this.runDir, 'terminal.log');
    const warnings = [];
    const errors = [];

    if (existsSync(terminalLogPath)) {
      try {
        const log = readFileSync(terminalLogPath, 'utf-8');
        
        // Extract warnings
        const warnMatches = log.matchAll(/\[WARN\]\s*(.+)/g);
        for (const match of warnMatches) {
          const msg = match[1].trim();
          if (!warnings.some(w => w.message === msg)) {
            warnings.push({ message: msg });
          }
        }

        // Extract errors
        const errorMatches = log.matchAll(/\[ERROR\]\s*(.+)/g);
        for (const match of errorMatches) {
          const msg = match[1].trim();
          if (!errors.some(e => e.message === msg)) {
            errors.push({ message: msg });
          }
        }

        // Also extract specific pipeline warnings
        const pipelineWarns = log.matchAll(/⚠️\s*(.+)/g);
        for (const match of pipelineWarns) {
          const msg = match[1].trim();
          if (!warnings.some(w => w.message === msg)) {
            warnings.push({ message: msg, type: 'pipeline' });
          }
        }
      } catch (err) {
        // Ignore errors
      }
    }

    return { warnings, errors };
  }

  /**
   * Calculate quality score based on validation results
   */
  calculateQualityScore(validationResults, dataStats) {
    let score = 100;
    const deductions = [];

    // Deduct for validation errors
    for (const [key, result] of Object.entries(validationResults)) {
      if (result.errorCount > 0) {
        const deduction = Math.min(result.errorCount * 5, 25);
        score -= deduction;
        deductions.push({ reason: `${key} errors (${result.errorCount})`, deduction });
      }
      if (result.warningCount > 0) {
        const deduction = Math.min(result.warningCount * 1, 10);
        score -= deduction;
        deductions.push({ reason: `${key} warnings (${result.warningCount})`, deduction });
      }
    }

    // Bonus for good coverage ratios
    if (dataStats.responseCount > 0 && dataStats.positionCount > 0) {
      const ratio = dataStats.positionCount / dataStats.responseCount;
      if (ratio >= 0.5 && ratio <= 2) {
        // Good consolidation ratio
      } else if (ratio > 3) {
        score -= 10;
        deductions.push({ reason: 'Position explosion (too many positions per response)', deduction: 10 });
      }
    }

    // Check for corrupted output in final markdown
    if (this.runDir && existsSync(this.runDir)) {
      try {
        const files = readdirSync(this.runDir);
        const markdownFile = files.find(f => f.match(/hearing-\d+-analysis\.md$/));
        if (markdownFile) {
          const markdownPath = join(this.runDir, markdownFile);
          const markdownContent = readFileSync(markdownPath, 'utf-8');

          const corruptionPatterns = [
            { pattern: /\[object Object\]/g, name: 'Object serialization error' },
            { pattern: /\[Fejl:.*?\]/g, name: 'Error message in output' },
            { pattern: /\[Error:.*?\]/g, name: 'Error message in output' },
            { pattern: /\[Denne delposition kunne ikke/g, name: 'Fallback message in output' },
            // Note: <<} is legitimate CriticMarkup (end of citation block), so we exclude it
            // Only flag patterns like "borger<<text" which are truly malformed
            { pattern: /\b(?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)\s+borger(?:e)?\s*<<(?!REF_)/gi, name: 'Malformed borger<< pattern' },
            { pattern: /\bDer\s*<<(?!REF_)/gi, name: 'Malformed Der<< pattern' },
            { pattern: /som\s{2,}og/g, name: 'Empty citation placeholder' },
            { pattern: /<<REF_\d+>>/g, name: 'Unresolved REF placeholder' }
          ];

          for (const { pattern, name } of corruptionPatterns) {
            const matches = markdownContent.match(pattern);
            if (matches && matches.length > 0) {
              const deduction = Math.min(matches.length * 10, 30);
              score -= deduction;
              deductions.push({
                reason: `${name} (${matches.length}x occurrences)`,
                deduction
              });
            }
          }
        }
      } catch (err) {
        // Ignore errors reading markdown file
      }
    }

    return {
      score: Math.max(0, Math.min(100, score)),
      grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F',
      deductions
    };
  }

  /**
   * Get timing information from terminal log or checkpoints
   */
  getTimingInfo() {
    const terminalLogPath = join(this.runDir, 'terminal.log');
    const timing = {
      startTime: null,
      endTime: null,
      totalDuration: null,
      steps: []
    };

    if (existsSync(terminalLogPath)) {
      try {
        const log = readFileSync(terminalLogPath, 'utf-8');
        
        // Extract start time from header
        const startMatch = log.match(/Pipeline Run Started: ([^\n]+)/);
        if (startMatch) {
          timing.startTime = startMatch[1];
        }

        // Extract end time from footer
        const endMatch = log.match(/Pipeline Run (Completed Successfully|FAILED): ([^\n]+)/);
        if (endMatch) {
          timing.endTime = endMatch[2];
        }

        // Extract step timings
        const stepMatches = log.matchAll(/\[Pipeline\] ✓ (.+?) completed \(([0-9.]+)s\)/g);
        for (const match of stepMatches) {
          timing.steps.push({
            step: match[1],
            duration: parseFloat(match[2])
          });
        }

        // Calculate total duration
        if (timing.startTime && timing.endTime) {
          const start = new Date(timing.startTime);
          const end = new Date(timing.endTime);
          timing.totalDuration = (end - start) / 1000; // seconds
        }
      } catch (err) {
        // Ignore errors
      }
    }

    return timing;
  }

  /**
   * Generate the complete run summary
   */
  generate() {
    const llmConfig = this.getLLMConfig();
    const calls = this.collectLLMCalls();
    const usage = this.calculateUsage(calls);
    const timing = this.getTimingInfo();
    const dataStats = this.collectDataStats();
    const validationResults = this.collectValidationResults();
    const { warnings, errors } = this.collectWarningsAndErrors();
    const qualityScore = this.calculateQualityScore(validationResults, dataStats);

    // Load baseline summary and calculate inherited costs
    const baselineSummary = this.loadBaselineSummary();
    const inheritedCosts = this.calculateInheritedCosts(baselineSummary);

    // Add embedding costs if available
    let embeddingCost = 0;
    let embeddingTokens = 0;
    if (this.embeddingUsage) {
      embeddingTokens = this.embeddingUsage.totalTokens || 0;
      const embeddingModel = this.embeddingUsage.model || 'text-embedding-3-large';
      const pricing = MODEL_PRICING[embeddingModel] || MODEL_PRICING['text-embedding-3-large'];
      embeddingCost = (embeddingTokens / 1_000_000) * pricing.input;
    }

    const totalCost = usage.totals.cost + embeddingCost;

    // Calculate combined cost including inherited
    const combinedTotalCost = totalCost + (inheritedCosts?.totalCost || 0);

    const summary = {
      meta: {
        hearingId: this.hearingId,
        label: this.label,
        generatedAt: new Date().toISOString(),
        runDir: this.runDir,
        // Include baseline info if using a different source checkpoint
        ...(this.sourceCheckpointLabel && this.sourceCheckpointLabel !== this.label && {
          sourceCheckpointLabel: this.sourceCheckpointLabel,
          resumedFromStep: this.resumedFromStep,
          inheritedSteps: this.inheritedSteps
        })
      },
      
      // Quality score
      quality: qualityScore,
      
      // Timing
      timing: {
        startTime: timing.startTime,
        endTime: timing.endTime,
        totalDurationSeconds: timing.totalDuration,
        totalDurationFormatted: timing.totalDuration 
          ? this.formatDuration(timing.totalDuration)
          : null,
        stepTimings: timing.steps
      },
      
      // Data statistics
      dataStats: {
        ...dataStats,
        summary: `${dataStats.responseCount} responses → ${dataStats.themeCount} themes → ${dataStats.positionCount} positions`
      },
      
      // LLM configuration
      llmConfig,
      
      // Usage and costs
      usage: {
        totals: {
          ...usage.totals,
          embeddingTokens,
          embeddingCost,
          embeddingCostFormatted: `$${embeddingCost.toFixed(4)}`,
          totalCost,
          totalCostFormatted: `$${totalCost.toFixed(4)}`,
          llmCostFormatted: `$${usage.totals.cost.toFixed(4)}`,
          durationFormatted: this.formatDuration(usage.totals.duration / 1000)
        },
        byModel: usage.modelStats.map(m => ({
          ...m,
          costFormatted: `$${m.cost.toFixed(4)}`,
          avgTokensPerCall: m.calls > 0 ? Math.round(m.totalTokens / m.calls) : 0,
          avgDurationMs: m.calls > 0 ? Math.round(m.duration / m.calls) : 0
        })),
        byStep: usage.stepStats.map(s => ({
          ...s,
          costFormatted: `$${s.cost.toFixed(4)}`
        })),
        embedding: this.embeddingUsage ? {
          model: this.embeddingUsage.model,
          tokens: embeddingTokens,
          calls: this.embeddingUsage.totalCalls || 0,
          texts: this.embeddingUsage.totalTexts || 0,
          cost: embeddingCost,
          costFormatted: `$${embeddingCost.toFixed(4)}`
        } : null,
        // Inherited costs from baseline checkpoint (if resuming from different checkpoint)
        inherited: inheritedCosts,
        // Combined totals including inherited
        combined: inheritedCosts ? {
          totalCost: combinedTotalCost,
          totalCostFormatted: `$${combinedTotalCost.toFixed(4)}`,
          note: `Includes ${inheritedCosts.stepCount} inherited steps from "${inheritedCosts.sourceLabel}"`
        } : null
      },
      
      // Validation results
      validation: validationResults,
      
      // Warnings and errors
      issues: {
        errorCount: errors.length,
        warningCount: warnings.length,
        errors: errors.slice(0, 20), // Limit to first 20
        warnings: warnings.slice(0, 50) // Limit to first 50
      },
      
      // Pricing reference
      pricing: MODEL_PRICING
    };

    return summary;
  }

  /**
   * Format duration in human-readable format
   */
  formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return 'N/A';
    
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    } else if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${mins}m`;
    }
  }

  /**
   * Generate and save summary to files
   */
  async saveToFiles() {
    const summary = this.generate();
    
    // Save JSON summary
    const jsonPath = join(this.runDir, 'run-summary.json');
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf-8');

    // Generate and save markdown summary
    const markdown = this.generateMarkdown(summary);
    const mdPath = join(this.runDir, 'run-summary.md');
    writeFileSync(mdPath, markdown, 'utf-8');

    return { jsonPath, mdPath, summary };
  }

  /**
   * Generate markdown version of summary
   */
  generateMarkdown(summary) {
    const lines = [];
    
    lines.push(`# Pipeline Run Summary`);
    
    // Quality Score Box
    const gradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴', 'F': '⛔' }[summary.quality.grade] || '⚪';
    lines.push(`\n## Quality Score: ${gradeEmoji} ${summary.quality.score}/100 (Grade: ${summary.quality.grade})`);
    if (summary.quality.deductions?.length > 0) {
      lines.push(`<details><summary>Score Deductions</summary>\n`);
      for (const d of summary.quality.deductions) {
        lines.push(`- ${d.reason}: -${d.deduction} points`);
      }
      lines.push(`</details>`);
    }

    lines.push(`\n## Overview`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Hearing ID | ${summary.meta.hearingId} |`);
    lines.push(`| Label | ${summary.meta.label} |`);
    lines.push(`| Duration | ${summary.timing.totalDurationFormatted || 'N/A'} |`);
    lines.push(`| Total Cost | ${summary.usage.totals.totalCostFormatted} |`);
    lines.push(`| LLM Calls | ${summary.usage.totals.calls} |`);
    lines.push(`| Total Tokens | ${(summary.usage.totals.totalTokens + (summary.usage.totals.embeddingTokens || 0)).toLocaleString()} |`);

    // Data Statistics
    lines.push(`\n## Data Statistics`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Responses | ${summary.dataStats.responseCount} |`);
    lines.push(`| Materials | ${summary.dataStats.materialCount} |`);
    lines.push(`| Chunks | ${summary.dataStats.chunkCount} |`);
    lines.push(`| Themes | ${summary.dataStats.themeCount} |`);
    lines.push(`| Arguments | ${summary.dataStats.argumentCount} |`);
    lines.push(`| Positions | ${summary.dataStats.positionCount} |`);
    lines.push(`| Avg Response Length | ${summary.dataStats.avgResponseLength.toLocaleString()} chars |`);
    
    if (summary.dataStats.responseCount > 0 && summary.dataStats.positionCount > 0) {
      const ratio = (summary.dataStats.positionCount / summary.dataStats.responseCount).toFixed(2);
      lines.push(`| Position/Response Ratio | ${ratio} |`);
    }

    // Respondent Coverage Section
    const coverage = summary.dataStats.respondentCoverage;
    if (coverage) {
      lines.push(`\n## Respondent Coverage`);
      const coverageEmoji = coverage.allRepresented ? '✅' : '⚠️';
      const coverageStatus = coverage.allRepresented 
        ? `${coverageEmoji} All ${coverage.representedCount} respondents are represented in the final output`
        : `${coverageEmoji} ${coverage.representedCount}/${coverage.allResponseIds.length} respondents represented (${coverage.missingResponseIds.length} missing)`;
      lines.push(coverageStatus);
      
      if (!coverage.allRepresented && coverage.missingResponseIds.length > 0) {
        lines.push(`\n**Missing respondents:** ${coverage.missingResponseIds.join(', ')}`);
      }
      
      if (coverage.multiPositionCount > 0) {
        lines.push(`\n**Respondents in multiple positions:** ${coverage.multiPositionCount}`);
        lines.push(`| Respondent | Positions |`);
        lines.push(`|------------|-----------|`);
        for (const resp of coverage.multiPositionRespondents.slice(0, 10)) {
          lines.push(`| Henvendelse ${resp.responseId} | ${resp.positionCount} |`);
        }
        if (coverage.multiPositionRespondents.length > 10) {
          lines.push(`| ... | ${coverage.multiPositionRespondents.length - 10} more |`);
        }
      } else {
        lines.push(`\n*No respondents appear in multiple positions.*`);
      }
    }

    // Timing
    lines.push(`\n## Timing`);
    lines.push(`- **Start:** ${summary.timing.startTime || 'N/A'}`);
    lines.push(`- **End:** ${summary.timing.endTime || 'N/A'}`);
    lines.push(`- **Total Duration:** ${summary.timing.totalDurationFormatted || 'N/A'}`);

    if (summary.timing.stepTimings?.length > 0) {
      lines.push(`\n### Step Timings (Top 10 by duration)`);
      lines.push(`| Step | Duration |`);
      lines.push(`|------|----------|`);
      const sortedSteps = [...summary.timing.stepTimings].sort((a, b) => b.duration - a.duration).slice(0, 10);
      for (const step of sortedSteps) {
        lines.push(`| ${step.step} | ${step.duration.toFixed(1)}s |`);
      }
    }

    // Cost Summary
    lines.push(`\n## Cost Summary`);
    lines.push(`| Category | Cost |`);
    lines.push(`|----------|------|`);
    lines.push(`| LLM Calls | ${summary.usage.totals.llmCostFormatted} |`);
    lines.push(`| Embeddings | ${summary.usage.totals.embeddingCostFormatted} |`);
    lines.push(`| **This Run Total** | **${summary.usage.totals.totalCostFormatted}** |`);

    // Inherited costs (if using baseline checkpoint)
    if (summary.usage.inherited) {
      const inherited = summary.usage.inherited;
      lines.push(`\n### Inherited from Baseline`);
      lines.push(`*Resumed from step "${summary.meta.resumedFromStep}" using checkpoint "${inherited.sourceLabel}"*\n`);
      lines.push(`| Category | Cost |`);
      lines.push(`|----------|------|`);
      lines.push(`| Inherited LLM | ${inherited.llmCostFormatted} |`);
      lines.push(`| Inherited Embeddings | ${inherited.embeddingCostFormatted} |`);
      lines.push(`| Inherited Total | ${inherited.totalCostFormatted} |`);
      lines.push(`| Inherited Steps | ${inherited.stepCount} (${inherited.steps.slice(0, 5).join(', ')}${inherited.steps.length > 5 ? '...' : ''}) |`);

      if (summary.usage.combined) {
        lines.push(`\n**Combined Total (This Run + Inherited): ${summary.usage.combined.totalCostFormatted}**`);
      }
    }

    // Usage by Model
    if (summary.usage.byModel?.length > 0) {
      lines.push(`\n### Usage by Model`);
      lines.push(`| Model | Calls | Input Tokens | Output Tokens | Cost |`);
      lines.push(`|-------|-------|--------------|---------------|------|`);
      for (const m of summary.usage.byModel) {
        lines.push(`| ${m.model} | ${m.calls} | ${m.inputTokens.toLocaleString()} | ${m.outputTokens.toLocaleString()} | ${m.costFormatted} |`);
      }
      
      // Add embedding if available
      if (summary.usage.embedding) {
        lines.push(`| ${summary.usage.embedding.model} (embedding) | ${summary.usage.embedding.calls} | ${summary.usage.embedding.tokens.toLocaleString()} | - | ${summary.usage.embedding.costFormatted} |`);
      }
    }

    // Usage by Step (top 10)
    if (summary.usage.byStep?.length > 0) {
      lines.push(`\n### Usage by Step (Top 10 by cost)`);
      lines.push(`| Step | Calls | Tokens | Cost |`);
      lines.push(`|------|-------|--------|------|`);
      const sortedSteps = [...summary.usage.byStep].sort((a, b) => b.cost - a.cost).slice(0, 10);
      for (const s of sortedSteps) {
        const totalTokens = s.inputTokens + s.outputTokens;
        lines.push(`| ${s.step} | ${s.calls} | ${totalTokens.toLocaleString()} | ${s.costFormatted} |`);
      }
    }

    // Validation Results
    if (Object.keys(summary.validation).length > 0) {
      lines.push(`\n## Validation Results`);
      lines.push(`| Validation | Status | Errors | Warnings |`);
      lines.push(`|------------|--------|--------|----------|`);
      for (const [key, result] of Object.entries(summary.validation)) {
        const status = result.valid ? '✅ Pass' : '❌ Fail';
        lines.push(`| ${key} | ${status} | ${result.errorCount} | ${result.warningCount} |`);
      }
    }

    // Issues
    if (summary.issues.errorCount > 0 || summary.issues.warningCount > 0) {
      lines.push(`\n## Issues`);
      lines.push(`- **Errors:** ${summary.issues.errorCount}`);
      lines.push(`- **Warnings:** ${summary.issues.warningCount}`);
      
      if (summary.issues.errors?.length > 0) {
        lines.push(`\n### Errors`);
        for (const e of summary.issues.errors.slice(0, 10)) {
          lines.push(`- ${e.message}`);
        }
        if (summary.issues.errors.length > 10) {
          lines.push(`- ... and ${summary.issues.errors.length - 10} more`);
        }
      }
    }

    // LLM Configuration
    lines.push(`\n## LLM Configuration`);
    lines.push(`| Level | Model | Verbosity | Reasoning |`);
    lines.push(`|-------|-------|-----------|-----------|`);
    for (const [level, config] of Object.entries(summary.llmConfig)) {
      if (level === 'embedding') {
        lines.push(`| embedding | ${config.model} | - | - |`);
      } else {
        lines.push(`| ${level} | ${config.model} | ${config.verbosity} | ${config.reasoning} |`);
      }
    }

    // Pricing Reference
    lines.push(`\n## Pricing Reference`);
    lines.push(`*Prices per 1M tokens*`);
    lines.push(`| Model | Input | Output |`);
    lines.push(`|-------|-------|--------|`);
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      if (model !== 'default') {
        lines.push(`| ${model} | $${pricing.input.toFixed(2)} | $${pricing.output.toFixed(2)} |`);
      }
    }

    lines.push(`\n---`);
    lines.push(`*Generated: ${summary.meta.generatedAt}*`);

    return lines.join('\n');
  }
}

