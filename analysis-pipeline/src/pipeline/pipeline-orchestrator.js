/**
 * Pipeline Orchestrator
 * 
 * Main orchestration of the analysis pipeline with step-by-step observability.
 */

import { DataLoader } from '../utils/data-loader.js';
import { MaterialSummarizer } from '../utils/material-summarizer.js';
import { MaterialAnalyzer } from '../analysis/material-analyzer.js';
import { EdgeCaseDetector } from '../analysis/edge-case-detector.js';
import { ConsiderationsGenerator } from '../analysis/considerations-generator.js';
// ResponseEnricher removed - inline enrichment instead
import { StructuredChunker } from '../chunking/structured-chunker.js';
import { ArgumentChunker } from '../chunking/argument-chunker.js';
import { BatchEmbedder } from '../embedding/batch-embedder.js';
import { SubstanceEmbedder } from '../embedding/substance-embedder.js';
import { configureGlobalEmbeddingConcurrency } from '../embedding/embedding-service.js';
import embeddingRegistry from '../embedding/embedding-registry.js';
import { MicroSummarizer } from '../analysis/micro-summarizer.js';
import { SimilarityAnalyzer } from '../analysis/similarity-analyzer.js';
import { RelevanceScorer } from '../analysis/relevance-scorer.js';
import { ThemeMapper } from '../analysis/theme-mapper.js';
import { SubstanceExtractor } from '../analysis/substance-extractor.js';
import { LegalScopeContext } from '../analysis/legal-scope-context.js';
import { Aggregator } from '../analysis/aggregator.js';
import { PositionConsolidator } from '../analysis/position-consolidator.js';
import { SubPositionExtractor } from '../analysis/sub-position-extractor.js';
import { PositionGrouper } from '../analysis/position-grouper.js';
import { PositionQualityValidator } from '../analysis/position-quality-validator.js';
import { PositionSorter } from '../analysis/position-sorter.js';
import { ArgumentDeduplicator } from '../analysis/argument-deduplicator.js';
import { PositionTitleGenerator } from '../analysis/position-title-generator.js';
import { CitationExtractor } from '../citation/citation-extractor.js';
import { CitationValidator } from '../validation/citation-validator.js';
import { CitationIntegrityValidator } from '../validation/citation-integrity-validator.js';
import { MicroSummaryQuoteValidator } from '../validation/micro-summary-quote-validator.js';
import { DirectionValidator } from '../validation/direction-validator.js';
import { GroupingQualityValidator } from '../validation/grouping-quality-validator.js';
import { CitationRegistry } from '../citation/citation-registry.js';
import { FormatValidator } from '../validation/format-validator.js';
import { PositionWriter } from '../analysis/position-writer.js';
import { ProseProofreader } from '../analysis/prose-proofreader.js';
import { QualityValidator } from '../analysis/quality-validator.js';
import { OutputFormatter } from '../utils/output-formatter.js';
import { DynamicParameterCalculator } from '../utils/dynamic-parameter-calculator.js';
import { DocxBuilder } from '../utils/docx-builder.js';
import { normalizeMarkdownNewlines } from '../utils/markdown-normalizer.js';
import { PIPELINE_PHASES, getPhaseForStep, logPhaseStart, logPhaseComplete, formatSkipMessage } from '../utils/step-logger.js';
import { JobTracker } from './job-tracker.js';
import { CheckpointManager } from './checkpoint-manager.js';
import { IncrementalManager } from './incremental-manager.js';
import { ProgressTracker } from './progress-tracker.js';
import { StepLogGenerator } from './step-log-generator.js';
import { FeedbackOrchestrator } from './feedback-orchestrator.js';
import { MaterialCacheManager, MATERIAL_CACHE_STEPS } from './material-cache-manager.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Exception thrown to signal early pipeline stop (--stop-after / --step flag)
 */
class EarlyStopException extends Error {
  constructor(stepName, artifacts) {
    super(`Pipeline stopped after step: ${stepName}`);
    this.stepName = stepName;
    this.artifacts = artifacts;
    this.isEarlyStop = true;
  }
}

export class PipelineOrchestrator {
  constructor(options = {}) {
    // Load config
    try {
      const configPath = join(__dirname, '../../config/pipeline-config.json');
      this.config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (error) {
      console.warn('[PipelineOrchestrator] Could not load config, using defaults');
      this.config = {
        chunking: { chunkSize: 600, chunkOverlap: 120 },
        embedding: { batchSize: 50 },
        retrieval: { topK: 20, reRankTopK: 10 },
        analysis: { microSummary: true, themeMapping: true, conflictRule: true },
        observability: { saveArtifacts: true, generateDebugReports: true }
      };
    }

    // Initialize citation registry
    this.citationRegistry = new CitationRegistry();

    // Initialize components
    this.dataLoader = new DataLoader(options);
    this.materialSummarizer = new MaterialSummarizer(options);
    this.materialAnalyzer = new MaterialAnalyzer(options);
    this.edgeCaseDetector = new EdgeCaseDetector(options);
    this.considerationsGenerator = new ConsiderationsGenerator();
    // Initialize chunker with merged config (response + material chunking options)
    this.chunker = new StructuredChunker({
      ...this.config.chunking,
      // Material chunking options
      materialMinChunkSize: this.config.materialChunking?.minChunkSize || 400,
      materialMaxChunkSize: this.config.materialChunking?.maxChunkSize || 1500,
      headerDepthWeight: this.config.materialChunking?.headerDepthWeight !== false,
      includeParentContext: this.config.materialChunking?.includeParentContext !== false,
      materialOverlap: this.config.materialChunking?.chunkOverlap || 100
    });
    
    // Initialize argument chunker for argument-aligned strategy
    this.argumentChunker = new ArgumentChunker(this.config.argumentChunking || {});
    this.embedder = new BatchEmbedder(this.config.embedding);
    this.microSummarizer = new MicroSummarizer({ ...options, citationRegistry: this.citationRegistry });
    this.relevanceScorer = new RelevanceScorer(options.relevanceScorer);
    this.similarityAnalyzer = new SimilarityAnalyzer(options);
    this.themeMapper = new ThemeMapper(options);
    this.substanceExtractor = new SubstanceExtractor(options);
    this.substanceEmbedder = new SubstanceEmbedder(options);
    this.legalScopeContext = new LegalScopeContext(options);
    this.aggregator = new Aggregator(this.config.retrieval);
    this.positionConsolidator = new PositionConsolidator(options.consolidation);
    this.positionTitleGenerator = new PositionTitleGenerator(options.titleGenerator);
    this.subPositionExtractor = new SubPositionExtractor({
      ...options.subPositionExtractor,
      citationRegistry: this.citationRegistry
    });
    this.positionGrouper = new PositionGrouper(options.positionGrouper);
    this.positionQualityValidator = new PositionQualityValidator(options.positionQualityValidator);
    this.positionSorter = new PositionSorter();
    this.argumentDeduplicator = new ArgumentDeduplicator(options.argumentDeduplicator);
    this.citationExtractor = new CitationExtractor(options);
    this.citationValidator = new CitationValidator(options.citationValidator);
    this.citationIntegrityValidator = new CitationIntegrityValidator(options.citationIntegrityValidator);

    // Initialize prose proofreader for quality fixes
    this.proseProofreader = new ProseProofreader(options.proseProofreader);

    // Pass jobId to PositionWriter for tracing
    this.positionWriter = new PositionWriter({
      ...options.positionWriter,
      citationRegistry: this.citationRegistry,
      proseProofreader: this.proseProofreader
    });

    this.qualityValidator = new QualityValidator(options);
    this.outputFormatter = new OutputFormatter();
    this.formatValidator = new FormatValidator(options.formatValidator);
    this.docxBuilder = new DocxBuilder(options);
    this.jobTracker = new JobTracker(options);
    this.checkpointManager = new CheckpointManager(options);

    // Store dynamic parameters (will be calculated per hearing)
    this.dynamicParams = null;

    // Preview mode - pause after sort-positions for interactive editing
    this.previewMode = options.previewMode || false;

    // Load analysis prompt
    try {
      const promptPath = join(__dirname, '../../prompts/analysis-prompt.md');
      this.analysisPrompt = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[PipelineOrchestrator] Could not load analysis prompt');
      this.analysisPrompt = null;
    }
  }

  /**
   * Map step name to artifact key
   * @private
   */
  /**
   * Get step definitions (static method for workbench/CLI tools)
   * @returns {Array<{name: string, key: string}>} Array of step definitions
   */
  static getStepDefinitions() {
    const steps = [
      'load-data', 'material-summary', 'analyze-material', 'extract-substance',
      'embed-substance', 'edge-case-screening', 'enrich-responses',
      'chunking', 'embedding', 'calculate-dynamic-parameters',
      'micro-summarize', 'citation-registry', 'validate-quote-sources',
      'embed-arguments', 'similarity-analysis', 'theme-mapping',
      'validate-legal-scope', 'validate-directions',
      'aggregate', 'consolidate-positions', 'generate-titles', 'extract-sub-positions',
      'group-positions', 'validate-positions', 'sort-positions',
      'deduplicate-arguments',  // Cross-position argument deduplication
      'hybrid-position-writing', 'validate-grouping-quality', 'validate-writer-output',
      'extract-citations', 'validate-citations', 'validate-coverage',
      'considerations', 'format-output', 'build-docx'
    ];

    const mapping = {
      'load-data': 'loadData',
      'material-summary': 'materialSummary',
      'analyze-material': 'taxonomy',
      'extract-substance': 'substance',
      'embed-substance': 'embeddedSubstance',
      'edge-case-screening': 'edgeCases',
      'enrich-responses': 'enrichedResponses',
      'chunking': 'chunking',
      'embedding': 'embeddings',
      'calculate-dynamic-parameters': 'dynamicParameters',
      'micro-summarize': 'microSummaries',
      'citation-registry': 'citationRegistryStats',
      'validate-quote-sources': 'quoteSourceValidation',
      'embed-arguments': 'argumentEmbeddings',
      'similarity-analysis': 'similarityAnalysis',
      'theme-mapping': 'themes',
      'validate-legal-scope': 'legalScopeValidation',
      'validate-directions': 'directionValidation',
      'aggregate': 'aggregation',
      'consolidate-positions': 'consolidatedPositions',
      'generate-titles': 'titledPositions',
      'extract-sub-positions': 'subPositionExtracted',
      'group-positions': 'groupedPositions',
      'validate-positions': 'validatedPositions',
      'sort-positions': 'sortedPositions',
      'deduplicate-arguments': 'deduplicatedPositions',
      'hybrid-position-writing': 'hybridPositions',
      'validate-grouping-quality': 'groupingValidation',
      'validate-writer-output': 'positionWriterValidation',
      'extract-citations': 'citedPositions',
      'validate-citations': 'citationValidation',
      'validate-coverage': 'validatedCoverage',
      'considerations': 'considerations',
      'format-output': 'formattedOutput',
      'build-docx': 'docxPath'
    };

    return steps.map(name => ({ name, key: mapping[name] || name }));
  }

  stepNameToArtifactKey(stepName) {
    const mapping = {
      'load-data': 'loadData',
      'material-summary': 'materialSummary',
      'analyze-material': 'taxonomy',
      'extract-substance': 'substance',
      'edge-case-screening': 'edgeCases',
      'enrich-responses': 'enrichedResponses',
      'chunking': 'chunking',
      'embedding': 'embeddings',
      'calculate-dynamic-parameters': 'dynamicParameters',
      'micro-summarize': 'microSummaries',
      'relevance-scoring': 'relevanceScoring',
      'citation-registry': 'citationRegistryStats',
      'validate-quote-sources': 'quoteSourceValidation',
      'validate-micro-citations': 'microSummaryValidation',
      'similarity-analysis': 'similarityAnalysis',
      'theme-mapping': 'themes',
      'validate-legal-scope': 'legalScopeValidation',
      'validate-directions': 'directionValidation',
      'aggregate': 'aggregation',
      'consolidate-positions': 'consolidatedPositions',
      'generate-titles': 'titledPositions',
      'extract-sub-positions': 'subPositionExtracted',
      'group-positions': 'groupedPositions',
      'validate-positions': 'validatedPositions',
      'sort-positions': 'sortedPositions',
      'deduplicate-arguments': 'deduplicatedPositions',
      'extract-citations': 'citedPositions',
      'validate-citations': 'citationValidation',
      'hybrid-position-writing': 'hybridPositions',
      'validate-grouping-quality': 'groupingValidation',
      'validate-writer-output': 'positionWriterValidation',
      'validate-coverage': 'validatedCoverage',
      'considerations': 'considerations',
      'format-output': 'formattedOutput',
      'build-docx': 'docxPath'
    };
    return mapping[stepName] || stepName;
  }

  /**
   * OPTIMIZATION: Merge enrichment deltas with original responses
   * Used for delta storage optimization - reconstructs full enriched responses on-demand
   * @private
   */
  getEnrichedResponses(originalResponses, enrichmentDeltas) {
    // Create enrichment lookup map
    const enrichmentMap = new Map(enrichmentDeltas.map(e => [e.id, e]));

    // Merge enrichments with originals
    return originalResponses.map(response => {
      const enrichment = enrichmentMap.get(response.id);
      if (enrichment) {
        // Apply enrichment
        return {
          ...response,
          text: enrichment.enrichedText,
          textEnriched: true,
          enrichmentReason: enrichment.enrichmentReason
        };
      }
      // No enrichment - return original
      return response;
    });
  }

  /**
   * Identify document type from materials
   * @private
   */
  identifyDocumentType(materials) {
    const combinedText = materials
      .map(m => (m.title || '') + ' ' + (m.contentMd || m.content || ''))
      .join(' ')
      .toLowerCase();

    // Check for document type indicators
    if (combinedText.includes('lokalplan') || combinedText.includes('lokal plan')) {
      return 'lokalplan';
    }
    if (combinedText.includes('dispensation')) {
      return 'dispensation';
    }
    if (combinedText.includes('partshøring') || combinedText.includes('parthøring')) {
      return 'partshoring';
    }
    if (combinedText.includes('politik') || combinedText.includes('strategi')) {
      return 'politik';
    }
    if (combinedText.includes('bygningsreglement')) {
      return 'bygningsreglement';
    }
    if (combinedText.includes('vedtægt')) {
      return 'vedtægt';
    }

    return 'default';
  }

  /**
   * Apply sampling strategy to responses
   * @private
   * @param {Array} responses - All responses
   * @param {number} limit - Maximum number to return
   * @param {string} strategy - Sampling strategy: 'random', 'diverse', 'representative'
   * @returns {Array} Sampled responses
   */
  applySampleStrategy(responses, limit, strategy) {
    if (responses.length <= limit) {
      return responses;
    }

    switch (strategy) {
      case 'random':
        return [...responses].sort(() => Math.random() - 0.5).slice(0, limit);

      case 'diverse':
        const sortedByLength = [...responses].sort((a, b) =>
          (a.text?.length || 0) - (b.text?.length || 0)
        );
        const step = Math.max(1, Math.floor(sortedByLength.length / limit));
        return sortedByLength.filter((_, i) => i % step === 0).slice(0, limit);

      case 'representative':
        const byLen = [...responses].sort((a, b) =>
          (a.text?.length || 0) - (b.text?.length || 0)
        );
        const shortCount = Math.ceil(limit * 0.2);
        const longCount = Math.ceil(limit * 0.2);
        const mediumCount = limit - shortCount - longCount;

        const shortResponses = byLen.slice(0, shortCount);
        const mediumStart = Math.floor((byLen.length - mediumCount) / 2);
        const mediumResponses = byLen.slice(mediumStart, mediumStart + mediumCount);
        const longResponses = byLen.slice(-longCount);

        return [...shortResponses, ...mediumResponses, ...longResponses];

      default:
        console.warn(`[PipelineOrchestrator] Unknown sample strategy "${strategy}", using first N`);
        return responses.slice(0, limit);
    }
  }

  /**
   * Run the full pipeline
   * @param {number} hearingId - Hearing ID
   * @param {Object} options - Pipeline options
   * @param {Object} [options.runDirManager] - RunDirectoryManager instance for consolidated output
   * @returns {Promise<Object>} Analysis result
   */
  async run(hearingId, options = {}) {
    // Store run directory manager for use in step() and other methods
    this.runDirManager = options.runDirManager || null;

    // NOTE: Don't reset embedding registry here - embedders are already registered
    // in component constructors. Each EmbeddingService tracks its own usage which
    // starts at 0 when instantiated. Resetting would clear registrations but not usage.

    // Configure components to use run directory if available
    if (this.runDirManager) {
      const llmCallsDir = this.runDirManager.getLLMCallsDir();
      
      // Update checkpoint manager to use run directory
      if (this.checkpointManager.setRunDirectory) {
        this.checkpointManager.setRunDirectory(this.runDirManager.getCheckpointsDir());
      }
      
      // Update job tracker to use run directory
      if (this.jobTracker.setRunDirectory) {
        this.jobTracker.setRunDirectory(this.runDirManager.getDebugDir());
      }
      
      // Update LLM tracer in ALL components that have OpenAI clients
      // This ensures all LLM call logs go to the consolidated run directory
      const componentsWithClients = [
        this.microSummarizer,
        this.themeMapper,
        this.edgeCaseDetector,
        this.materialSummarizer,
        this.materialAnalyzer,
        this.positionWriter,
        this.aggregator,
        this.positionConsolidator,
        this.subPositionExtractor,
        this.positionGrouper,
        this.considerationsGenerator,
        this.proseProofreader
      ];

      for (const component of componentsWithClients) {
        // Try setting on primary client if component has one
        if (component?.client?.setRunDirectory) {
          component.client.setRunDirectory(llmCallsDir);
        }
        // Try setting on light client (used by aggregator, micro-summarizer, etc.)
        if (component?.lightClient?.setRunDirectory) {
          component.lightClient.setRunDirectory(llmCallsDir);
        }
        // Try setting on heavy client (used by micro-summarizer)
        if (component?.heavyClient?.setRunDirectory) {
          component.heavyClient.setRunDirectory(llmCallsDir);
        }
        // Also try setting directly on tracer if exposed
        if (component?.tracer?.setRunDirectory) {
          component.tracer.setRunDirectory(llmCallsDir);
        }
        // Try component's own setRunDirectory method (for PositionWriter, ConsiderationsGenerator)
        if (component?.setRunDirectory) {
          component.setRunDirectory(llmCallsDir);
        }
      }

      // Position writer has special structure with promptRunner
      if (this.positionWriter?.promptRunner?.client?.setRunDirectory) {
        this.positionWriter.promptRunner.client.setRunDirectory(llmCallsDir);
      }
    }
    
    const jobId = this.jobTracker.createJob(hearingId, { ...this.config, ...options });

    // Enable tracing for all components
    if (this.microSummarizer.setJobId) this.microSummarizer.setJobId(jobId);
    if (this.themeMapper.setJobId) this.themeMapper.setJobId(jobId);
    if (this.edgeCaseDetector.setJobId) this.edgeCaseDetector.setJobId(jobId);
    if (this.materialSummarizer.setJobId) this.materialSummarizer.setJobId(jobId);
    if (this.materialAnalyzer.setJobId) this.materialAnalyzer.setJobId(jobId);
    if (this.substanceExtractor.setJobId) this.substanceExtractor.setJobId(jobId);
    if (this.aggregator.setJobId) this.aggregator.setJobId(jobId);
    if (this.considerationsGenerator.setJobId) this.considerationsGenerator.setJobId(jobId);

    // Enable tracing for consolidation/grouping components (added for cost tracking fix)
    if (this.positionConsolidator?.setJobId) this.positionConsolidator.setJobId(jobId);
    if (this.positionTitleGenerator?.setJobId) this.positionTitleGenerator.setJobId(jobId);
    if (this.subPositionExtractor?.setJobId) this.subPositionExtractor.setJobId(jobId);
    if (this.positionGrouper?.setJobId) this.positionGrouper.setJobId(jobId);
    if (this.positionQualityValidator?.setJobId) this.positionQualityValidator.setJobId(jobId);
    if (this.citationExtractor?.setJobId) this.citationExtractor.setJobId(jobId);
    if (this.proseProofreader?.setJobId) this.proseProofreader.setJobId(jobId);

    // Initialize PositionWriter tracing
    if (this.positionWriter.setJobId) {
      this.positionWriter.setJobId(jobId);
    }
    if (this.positionWriter.promptRunner?.client?.setJobId) {
      this.positionWriter.promptRunner.client.setJobId(jobId);
    }
    
    // Re-apply run directory after setJobId creates new tracers
    // (setJobId creates new LLMTracer instances, so we need to configure them again)
    if (this.runDirManager) {
      const llmCallsDir = this.runDirManager.getLLMCallsDir();
      const componentsWithClients = [
        this.microSummarizer,
        this.themeMapper,
        this.substanceExtractor,
        this.edgeCaseDetector,
        this.materialSummarizer,
        this.materialAnalyzer,
        this.positionWriter,
        this.aggregator,
        this.positionConsolidator,
        this.positionTitleGenerator,
        this.subPositionExtractor,
        this.positionGrouper,
        this.positionQualityValidator,
        this.citationExtractor,
        this.considerationsGenerator,
        this.proseProofreader
      ];

      for (const component of componentsWithClients) {
        // Set run directory on primary client tracer
        if (component?.client?.tracer?.setRunDirectory) {
          component.client.tracer.setRunDirectory(llmCallsDir);
        }
        // Set run directory on light client tracer (used by aggregator, micro-summarizer, etc.)
        if (component?.lightClient?.tracer?.setRunDirectory) {
          component.lightClient.tracer.setRunDirectory(llmCallsDir);
        }
        // Set run directory on heavy client tracer (used by micro-summarizer)
        if (component?.heavyClient?.tracer?.setRunDirectory) {
          component.heavyClient.tracer.setRunDirectory(llmCallsDir);
        }
        if (component?.tracer?.setRunDirectory) {
          component.tracer.setRunDirectory(llmCallsDir);
        }
        // Try component's own setRunDirectory method
        if (component?.setRunDirectory) {
          component.setRunDirectory(llmCallsDir);
        }
      }

      if (this.positionWriter?.promptRunner?.client?.tracer?.setRunDirectory) {
        this.positionWriter.promptRunner.client.tracer.setRunDirectory(llmCallsDir);
      }
    }

    const artifacts = {};

    // Checkpoint configuration
    this.currentHearingId = hearingId; // Store for step() method
    this.saveCheckpoints = options.saveCheckpoints || false;
    this.checkpointLabel = options.checkpointLabel || options.checkpoint || 'default';
    
    // Source checkpoint label for reading during resume (defaults to checkpointLabel)
    // This enables the "baseline" feature: read from one checkpoint, write to another
    // Usage: --checkpoint=source:target will set sourceCheckpointLabel=source, checkpointLabel=target
    this.sourceCheckpointLabel = options.sourceCheckpointLabel || this.checkpointLabel;

    // Resume functionality
    const resumeFromStep = options.resumeFromStep || null;
    const stepOrder = [
      'load-data',
      'material-summary',
      'analyze-material',
      'extract-substance',
      'embed-substance',
      'edge-case-screening',
      'enrich-responses',
      'chunking',
      'embedding',
      'calculate-dynamic-parameters',
      'micro-summarize',
      'citation-registry',
      'validate-quote-sources',
      'embed-arguments',
      'similarity-analysis',
      'theme-mapping',
      'validate-legal-scope',
      'validate-directions',
      'aggregate',
      'consolidate-positions',
      'generate-titles',
      'extract-sub-positions',
      'group-positions',
      'validate-positions',
      'sort-positions',
      'deduplicate-arguments',        // Cross-position argument deduplication
      'hybrid-position-writing',      // Moved BEFORE extract-citations
      'validate-grouping-quality',    // NEW: Validate and repair grouping issues
      'validate-writer-output',
      'extract-citations',            // Moved AFTER hybrid-position-writing (depends on it)
      'validate-citations',
      'validate-coverage',
      'considerations',
      'format-output',
      'build-docx'
    ];

    // Initialize progress tracker for run directory mode
    this.progressTracker = null;
    this.stepLogGenerator = null;
    if (this.runDirManager) {
      this.progressTracker = new ProgressTracker({
        runDir: this.runDirManager.getRunDir(),
        hearingId,
        label: this.checkpointLabel
      });
      this.progressTracker.setTotalSteps(stepOrder.length);
      
      // Initialize step log generator for detailed markdown logs
      this.stepLogGenerator = new StepLogGenerator({
        runDirManager: this.runDirManager
      });
    }

    if (this.saveCheckpoints) {
      const checkpointPath = this.runDirManager 
        ? this.runDirManager.getCheckpointsDir()
        : `checkpoints/${hearingId}/${this.checkpointLabel}/`;
      console.log(`[Pipeline] 💾 Checkpoints enabled: saving to ${checkpointPath}\n`);
    }

    // Incremental mode configuration
    // Usage: --incremental=<baseline-label> enables incremental processing
    // Only new/modified responses will be processed; unchanged ones are reused from baseline
    this.incrementalMode = options.incrementalMode || false;
    this.incrementalBaseline = options.incrementalBaseline || null;
    this.incrementalManager = null;
    
    if (this.incrementalMode && this.incrementalBaseline) {
      console.log(`[Pipeline] 🔄 INCREMENTAL MODE: Using "${this.incrementalBaseline}" as baseline\n`);
      this.incrementalManager = new IncrementalManager({
        hearingId,
        baselineLabel: this.incrementalBaseline,
        targetLabel: this.checkpointLabel,
        checkpointManager: this.checkpointManager
      });
    }

    // Patch mode configuration
    // Usage: --patch-baseline=<baseline> --response-ids=<ids> enables patch mode
    // Re-processes only specified responses and merges with baseline
    this.patchMode = options.patchMode || false;
    this.patchBaseline = options.patchBaseline || null;
    this.patchResponseIds = null;
    this.patchManager = null; // Separate manager for patch mode

    if (this.patchMode && this.patchBaseline) {
      // In patch mode, response IDs come from options.responseIds
      this.patchResponseIds = new Set(options.responseIds || []);
      if (this.patchResponseIds.size === 0) {
        throw new Error('Patch mode requires --response-ids to specify which responses to re-process');
      }

      console.log(`[Pipeline] 🔧 PATCH MODE: Using "${this.patchBaseline}" as baseline`);
      console.log(`[Pipeline]   → Re-processing ${this.patchResponseIds.size} responses: ${[...this.patchResponseIds].join(', ')}\n`);

      this.patchManager = new IncrementalManager({
        hearingId,
        baselineLabel: this.patchBaseline,
        targetLabel: this.checkpointLabel,
        checkpointManager: this.checkpointManager
      });
    }

    // Light Patch Mode: Skip aggregation for small patches (<1% of responses)
    // When patching only a few responses, it's faster to reuse baseline positions
    // and only update citation references for patched responses
    this.forceReaggregate = options.forceReaggregate || false;

    // Material Cache Configuration
    // Caches material-level analysis (taxonomy, substance, etc.) at hearing level
    // These steps are independent of respondent scope and can be reused
    this.materialCacheManager = new MaterialCacheManager();
    this.useMaterialCache = options.useMaterialCache !== false; // Default: enabled
    this.clearMaterialCache = options.clearMaterialCache || false;
    this.materialBaseline = options.materialBaseline || null;
    this.materialCacheHash = null; // Will be set after loading data

    // Feedback integration for re-analysis runs
    // Usage: pass userFeedback array via options to inject corrections into prompts
    this.feedbackContext = null;
    if (options.userFeedback && Array.isArray(options.userFeedback) && options.userFeedback.length > 0) {
      const feedbackOrchestrator = new FeedbackOrchestrator({ hearingId });
      this.feedbackContext = feedbackOrchestrator.buildPromptContext(options.userFeedback);

      const feedbackSummary = {
        contextNotes: this.feedbackContext.contextNotes?.length || 0,
        citationCorrections: this.feedbackContext.citationCorrections?.length || 0,
        highlightedContent: this.feedbackContext.highlightedContent?.length || 0,
        excludePositions: this.feedbackContext.excludePositions?.length || 0,
        structureChanges: this.feedbackContext.structureChanges?.length || 0,
        corrections: this.feedbackContext.corrections?.length || 0
      };

      const totalItems = Object.values(feedbackSummary).reduce((a, b) => a + b, 0);
      console.log(`[Pipeline] 📝 FEEDBACK MODE: Processing ${totalItems} feedback items`);
      console.log(`[Pipeline]   - Context notes: ${feedbackSummary.contextNotes}`);
      console.log(`[Pipeline]   - Citation corrections: ${feedbackSummary.citationCorrections}`);
      console.log(`[Pipeline]   - Highlighted content: ${feedbackSummary.highlightedContent}`);
      console.log(`[Pipeline]   - Exclude positions: ${feedbackSummary.excludePositions}`);
      console.log(`[Pipeline]   - Structure changes: ${feedbackSummary.structureChanges}`);
      console.log(`[Pipeline]   - Factual corrections: ${feedbackSummary.corrections}\n`);
    }

    // Handle resume functionality
    let resumeFromIndex = -1;
    if (resumeFromStep) {
      resumeFromIndex = stepOrder.indexOf(resumeFromStep);
      if (resumeFromIndex === -1) {
        throw new Error(`Invalid resumeFromStep: "${resumeFromStep}". Must be one of: ${stepOrder.join(', ')}`);
      }

      console.log(`[Pipeline] 🔄 RESUME MODE: Starting from step "${resumeFromStep}" (${resumeFromIndex + 1}/${stepOrder.length})\n`);
      
      // Log source/target checkpoint labels if different (baseline feature)
      if (this.sourceCheckpointLabel !== this.checkpointLabel) {
        console.log(`[Pipeline] 📥 Loading checkpoints from: "${this.sourceCheckpointLabel}"`);
        console.log(`[Pipeline] 📤 Saving new checkpoints to: "${this.checkpointLabel}"\n`);
        
        // COPY BASELINE CHECKPOINTS: Make the target run self-contained
        // This ensures future resumes from this run will work without the original baseline
        const stepsToKopi = stepOrder.slice(0, resumeFromIndex);
        console.log(`[Pipeline] 📋 Copying ${stepsToKopi.length} baseline checkpoints to make run self-contained...`);
        
        const copyResult = this.checkpointManager.copyFromBaseline(hearingId, this.sourceCheckpointLabel, stepsToKopi);
        
        if (copyResult.copied.length > 0) {
          console.log(`[Pipeline] ✅ Copied ${copyResult.copied.length} checkpoints from "${this.sourceCheckpointLabel}"`);
        }
        if (copyResult.skipped.length > 0) {
          console.log(`[Pipeline] ⏩ Skipped ${copyResult.skipped.length} (already exist in target)`);
        }
        if (copyResult.failed.length > 0) {
          console.warn(`[Pipeline] ⚠️  Failed to copy ${copyResult.failed.length}: ${copyResult.failed.join(', ')}`);
        }
        console.log('');
      }

      // Load checkpoints for all steps before resume point
      // Use sourceCheckpointLabel for reading (enables baseline feature)
      console.log(`[Pipeline] Loading checkpoints for steps 1-${resumeFromIndex}...`);
      for (let i = 0; i < resumeFromIndex; i++) {
        const stepName = stepOrder[i];
        try {
          const checkpoint = await this.checkpointManager.load(hearingId, stepName, this.sourceCheckpointLabel);
          // Check for null/undefined (not found), but allow empty strings, empty arrays, etc.
          if (checkpoint !== null && checkpoint !== undefined) {
            artifacts[this.stepNameToArtifactKey(stepName)] = checkpoint;
            console.log(`[Pipeline] ✅ Loaded checkpoint: ${stepName}`);

            // SPECIAL HANDLING: Hydrate citation registry if loaded
            if (stepName === 'citation-registry' && checkpoint.citations) {
              console.log(`[Pipeline] Hydrating citation registry with ${Object.keys(checkpoint.citations).length} citations...`);
              // Repopulate the in-memory registry
              this.citationRegistry.citations = new Map(Object.entries(checkpoint.citations));
              this.citationRegistry.citationsByResponse = new Map();

              // Rebuild citationsByResponse index
              for (const [, citation] of this.citationRegistry.citations) {
                if (!this.citationRegistry.citationsByResponse.has(citation.responseNumber)) {
                  this.citationRegistry.citationsByResponse.set(citation.responseNumber, new Set());
                }
                this.citationRegistry.citationsByResponse.get(citation.responseNumber).add(citation.id);
              }
              console.log(`[Pipeline] ✅ Citation registry hydrated`);
            }
          } else {
            throw new Error(`Checkpoint not found for step "${stepName}" in "${this.sourceCheckpointLabel}" - cannot resume from "${resumeFromStep}"`);
          }
        } catch (error) {
          throw new Error(`Failed to load checkpoint for "${stepName}" from "${this.sourceCheckpointLabel}": ${error.message}. Cannot resume.`);
        }
      }

      console.log(`[Pipeline] ✅ Successfully loaded ${resumeFromIndex} checkpoints from "${this.sourceCheckpointLabel}"\n`);
    }

    // Store resume state for step() method to check
    this.resumeFromIndex = resumeFromIndex;
    this.stepOrder = stepOrder;
    this.artifacts = artifacts; // Store artifacts for step() to access in resume mode

    // Stop-after functionality (for running single steps or step ranges)
    const stopAfterStep = options.stopAfterStep || null;
    this.stopAfterIndex = -1;
    if (stopAfterStep) {
      this.stopAfterIndex = stepOrder.indexOf(stopAfterStep);
      if (this.stopAfterIndex === -1) {
        throw new Error(`Invalid stopAfterStep: "${stopAfterStep}". Must be one of: ${stepOrder.join(', ')}`);
      }
      console.log(`[Pipeline] ⏹️  STOP AFTER: Will stop after step "${stopAfterStep}" (${this.stopAfterIndex + 1}/${stepOrder.length})\n`);
    }

    try {
      this.jobTracker.updateJob(jobId, { status: 'running', current_step: resumeFromStep || 'load-data' });
      this.jobTracker.logEvent(jobId, 'info', resumeFromStep ? `Pipeline resumed from ${resumeFromStep}` : 'Pipeline started', { 
        hearingId, 
        checkpointLabel: this.checkpointLabel, 
        sourceCheckpointLabel: this.sourceCheckpointLabel,
        resumeFromStep 
      });

      // Step 1: Load data
      artifacts.loadData = await this.step('load-data', async () => {
        const data = await this.dataLoader.loadPublishedHearing(hearingId);

        // Response filtering - applied in priority order
        const testLimit = process.env.TEST_LIMIT_RESPONSES ? parseInt(process.env.TEST_LIMIT_RESPONSES, 10) : 0;
        const limitResponses = options.limitResponses !== undefined ? options.limitResponses : testLimit;

        // PATCH MODE: Do NOT filter responses at load time
        // We need all responses for proper merging - filtering happens in micro-summarize
        if (this.patchMode) {
          this.jobTracker.logEvent(jobId, 'info', `🔧 PATCH MODE: Loading ALL ${data.responses.length} responses (filtering in micro-summarize step)`);
          console.log(`[Pipeline] 🔧 PATCH MODE: Keeping all ${data.responses.length} responses for merge`);
        }
        // Filter by specific response IDs (highest priority) - but NOT in patch mode
        else if (options.responseIds?.length > 0) {
          const originalCount = data.responses.length;
          const idSet = new Set(options.responseIds);
          data.responses = data.responses.filter(r => idSet.has(r.id));
          this.jobTracker.logEvent(jobId, 'info', `🔍 Filtered to ${data.responses.length} specific response IDs (from ${originalCount} total)`);
          console.log(`[Pipeline] 🔍 Response IDs filter: ${options.responseIds.join(', ')}`);
        }
        // Filter by pattern (regex match on respondent name or text)
        else if (options.responsePattern) {
          const originalCount = data.responses.length;
          try {
            const pattern = new RegExp(options.responsePattern, 'i');
            data.responses = data.responses.filter(r =>
              pattern.test(r.respondentName || '') || pattern.test(r.text || '')
            );
            this.jobTracker.logEvent(jobId, 'info', `🔍 Filtered by pattern "${options.responsePattern}": ${data.responses.length} matches (from ${originalCount} total)`);
          } catch (e) {
            throw new Error(`Invalid response pattern regex: ${e.message}`);
          }
        }
        // Apply sampling strategy with limit
        else if (options.sampleStrategy && limitResponses > 0) {
          const originalCount = data.responses.length;
          data.responses = this.applySampleStrategy(data.responses, limitResponses, options.sampleStrategy);
          this.jobTracker.logEvent(jobId, 'info', `🔍 Sampled ${data.responses.length} responses using "${options.sampleStrategy}" strategy (from ${originalCount} total)`);
        }
        // Simple limit (first N responses)
        else if (limitResponses > 0) {
          const originalCount = data.responses.length;
          data.responses = data.responses.slice(0, limitResponses);
          this.jobTracker.logEvent(jobId, 'info', `🔍 Limited to first ${limitResponses} responses (from ${originalCount} total)`);
        }

        this.jobTracker.logEvent(jobId, 'info', `Loaded ${data.responses.length} responses and ${data.materials.length} materials`);
        
        // Update progress tracker with data stats
        if (this.progressTracker) {
          const totalChars = data.responses.reduce((sum, r) => sum + (r.text?.length || r.textMd?.length || 0), 0);
          this.progressTracker.updateDataStats({
            responseCount: data.responses.length,
            materialCount: data.materials.length,
            avgResponseLength: data.responses.length > 0 ? Math.round(totalChars / data.responses.length) : 0
          });
        }
        
        return data;
      }, jobId);

      // INCREMENTAL ANALYSIS: After load-data, analyze what needs reprocessing
      if (this.incrementalManager) {
        const incrementalAnalysis = this.incrementalManager.analyzeIncrementalNeeds(artifacts.loadData);
        this.incrementalAnalysis = incrementalAnalysis; // Store for use in steps

        const summary = this.incrementalManager.getSummary();
        this.jobTracker.logEvent(jobId, 'info',
          `Incremental analysis: ${summary.stats.newCount} new, ${summary.stats.modifiedCount} modified, ${summary.stats.reusedCount} reusable responses`
        );

        if (summary.estimatedSavings.percentReused > 0) {
          console.log(`[Pipeline] 💰 Estimated savings: ${summary.estimatedSavings.percentReused}% responses reused (${summary.estimatedSavings.estimatedSavedCost})\n`);
        }

        if (incrementalAnalysis.materialsChanged) {
          console.log(`[Pipeline] ⚠️  Materials changed - material-dependent steps will run fresh\n`);
        }
      }

      // PATCH MODE SETUP: Load baseline checkpoints for material-related steps
      // In patch mode, we reuse ALL material-related steps from baseline
      if (this.patchMode && this.patchManager) {
        console.log(`[Pipeline] 🔧 PATCH MODE: Loading baseline checkpoints for material-related steps...`);

        // Load citation registry from baseline and hydrate
        const baselineCitationRegistry = this.checkpointManager.load(hearingId, 'citation-registry', this.patchBaseline);
        if (baselineCitationRegistry?.citations) {
          const hydrateStats = this.citationRegistry.hydrateFromCheckpoint(baselineCitationRegistry);
          console.log(`[Pipeline] 🔧 PATCH: Citation registry hydrated: ${hydrateStats.hydrated} baseline citations (nextId=${this.citationRegistry.nextId})`);
          this.jobTracker.logEvent(jobId, 'info', `[PATCH] Hydrated citation registry: ${hydrateStats.hydrated} citations from baseline`);
        } else {
          console.warn('[Pipeline] ⚠️ PATCH: Could not load baseline citation-registry');
        }
      }

      // MATERIAL CACHE: Compute hash and check cache status
      // Material cache is independent of respondent scope and persists across runs
      this.materialCacheHash = this.materialCacheManager.computeMaterialHash(artifacts.loadData.materials);
      this.materialCacheLoaded = {}; // Track which steps were loaded from cache

      // Clear cache if requested
      if (this.clearMaterialCache) {
        const clearResult = this.materialCacheManager.clearCache(hearingId);
        if (clearResult.cleared) {
          console.log(`[Pipeline] 🗑️  Material cache cleared: ${clearResult.path}`);
          this.jobTracker.logEvent(jobId, 'info', `Material cache cleared for hearing ${hearingId}`);
        }
      }

      // Check cache validity (only if not in patch mode - patch mode has its own reuse logic)
      if (this.useMaterialCache && !this.patchMode && !this.incrementalMode) {
        const cacheStatus = this.materialCacheManager.getCacheStatus(hearingId, this.materialCacheHash);

        if (cacheStatus.valid) {
          console.log(`[Pipeline] 📦 Material cache: VALID (hash ${this.materialCacheHash})`);
          console.log(`[Pipeline]   → Cached steps: ${cacheStatus.cachedSteps.join(', ')}`);
          console.log(`[Pipeline]   → Last updated: ${cacheStatus.lastUpdated}`);
          if (cacheStatus.sourceRun) {
            console.log(`[Pipeline]   → Source run: ${cacheStatus.sourceRun}`);
          }
          console.log(`[Pipeline]   → Estimated savings: ~$0.35 and ~45 seconds\n`);
          this.jobTracker.logEvent(jobId, 'info',
            `Material cache VALID - reusing ${cacheStatus.cachedSteps.length} steps (hash: ${this.materialCacheHash})`
          );
        } else {
          console.log(`[Pipeline] 📦 Material cache: INVALID (${cacheStatus.reason})`);
          console.log(`[Pipeline]   → Current hash: ${this.materialCacheHash}`);
          console.log(`[Pipeline]   → Will compute fresh material analysis\n`);
          this.jobTracker.logEvent(jobId, 'info',
            `Material cache invalid: ${cacheStatus.reason} (hash: ${this.materialCacheHash})`
          );
        }
      } else if (this.materialBaseline) {
        // Load materials from a specific baseline run
        console.log(`[Pipeline] 📦 Material baseline: Loading from "${this.materialBaseline}"`);
        this.jobTracker.logEvent(jobId, 'info', `Using material baseline: ${this.materialBaseline}`);
      }

      // Step 1.5: Summarize materials (to reduce token usage)
      // INCREMENTAL/PATCH: Reuse from baseline if materials unchanged
      // MATERIAL CACHE: Check hearing-level cache first
      artifacts.materialSummary = await this.step('material-summary', async () => {
        // PATCH MODE: Always reuse materials from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'material-summary', this.patchBaseline);
          if (baseline) {
            const baselineLite = this.checkpointManager.load(hearingId, 'material-summary-lite', this.patchBaseline);
            if (baselineLite) artifacts.materialSummaryLite = baselineLite;
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused material summary from baseline`);
            return baseline;
          }
        }

        if (this.incrementalManager?.canReuseStep('material-summary')) {
          const baseline = this.checkpointManager.load(hearingId, 'material-summary', this.incrementalBaseline);
          if (baseline) {
            // Also load lite summary from baseline
            const baselineLite = this.checkpointManager.load(hearingId, 'material-summary-lite', this.incrementalBaseline);
            if (baselineLite) artifacts.materialSummaryLite = baselineLite;
            this.jobTracker.logEvent(jobId, 'info', `[INCREMENTAL] Reused material summary from baseline (materials unchanged)`);
            return baseline;
          }
        }

        // MATERIAL CACHE: Check hearing-level cache
        if (this.useMaterialCache && this.materialCacheHash) {
          const cached = this.materialCacheManager.loadCachedStep(hearingId, 'material-summary');
          const cacheValid = this.materialCacheManager.isCacheValid(hearingId, this.materialCacheHash);
          if (cached && cacheValid.valid) {
            // Also load lite summary from cache
            const cachedLite = this.materialCacheManager.loadCachedStep(hearingId, 'material-summary-lite');
            if (cachedLite) artifacts.materialSummaryLite = cachedLite;
            this.materialCacheLoaded['material-summary'] = true;
            this.jobTracker.logEvent(jobId, 'info', `[CACHE] Reused material summary from hearing cache`);
            console.log(`[Pipeline]   📦 Loaded from material cache`);
            return cached;
          }
        }

        // Run standard and lite summarization in parallel
        const [result, liteSummary] = await Promise.all([
          this.materialSummarizer.summarize(artifacts.loadData.materials),
          this.materialSummarizer.summarizeLite(artifacts.loadData.materials)
        ]);

        // Store lite summary for token-efficient operations
        artifacts.materialSummaryLite = liteSummary;

        // Update artifacts.loadData.materials with converted materials (for theme extraction)
        if (result.convertedMaterials && result.convertedMaterials.length > 0) {
          artifacts.loadData.materials = result.convertedMaterials;
        }

        // Save to material cache
        if (this.useMaterialCache && this.materialCacheHash) {
          this.materialCacheManager.saveToCache(hearingId, 'material-summary', result.summary, this.materialCacheHash, {
            sourceRun: this.checkpointLabel
          });
          // Also cache the lite summary
          this.materialCacheManager.saveToCache(hearingId, 'material-summary-lite', liteSummary, this.materialCacheHash, {
            sourceRun: this.checkpointLabel
          });
          console.log(`[Pipeline]   📦 Saved to material cache`);
        }

        this.jobTracker.logEvent(jobId, 'info', `Created material summary (${result.summary.length} chars) and lite summary (${liteSummary.length} chars)`);
        return result.summary;
      }, jobId);

      // Step 1.6: Material Analysis (Taxonomy Generation)
      // INCREMENTAL/PATCH: Reuse from baseline if materials unchanged
      // MATERIAL CACHE: Check hearing-level cache first
      artifacts.taxonomy = await this.step('analyze-material', async () => {
        // PATCH MODE: Always reuse taxonomy from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'analyze-material', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused taxonomy from baseline (${baseline.themes?.length || 0} themes)`);
            return baseline;
          }
        }

        if (this.incrementalManager?.canReuseStep('analyze-material')) {
          const baseline = this.checkpointManager.load(hearingId, 'analyze-material', this.incrementalBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[INCREMENTAL] Reused taxonomy from baseline (${baseline.themes?.length || 0} themes)`);
            return baseline;
          }
        }

        // MATERIAL CACHE: Check hearing-level cache
        if (this.useMaterialCache && this.materialCacheHash) {
          const cached = this.materialCacheManager.loadCachedStep(hearingId, 'analyze-material');
          const cacheValid = this.materialCacheManager.isCacheValid(hearingId, this.materialCacheHash);
          if (cached && cacheValid.valid) {
            this.materialCacheLoaded['analyze-material'] = true;
            this.jobTracker.logEvent(jobId, 'info', `[CACHE] Reused taxonomy from hearing cache (${cached.themes?.length || 0} themes)`);
            console.log(`[Pipeline]   📦 Loaded from material cache`);
            return cached;
          }
        }

        const taxonomy = await this.materialAnalyzer.analyze(artifacts.loadData.materials);

        // Save to material cache
        if (this.useMaterialCache && this.materialCacheHash) {
          this.materialCacheManager.saveToCache(hearingId, 'analyze-material', taxonomy, this.materialCacheHash, {
            sourceRun: this.checkpointLabel
          });
          console.log(`[Pipeline]   📦 Saved to material cache`);
        }

        this.jobTracker.logEvent(jobId, 'info', `Generated taxonomy with ${taxonomy.themes.length} themes`);
        // Log theme names
        const themeNames = taxonomy.themes.map(t => t.name).join(', ');
        this.jobTracker.logEvent(jobId, 'info', `Themes: ${themeNames}`);

        return taxonomy;
      }, jobId);

      // Step 1.7: Substance Extraction (what the document actually regulates/proposes)
      // INCREMENTAL/PATCH: Reuse from baseline if materials unchanged
      artifacts.substance = await this.step('extract-substance', async () => {
        // PATCH MODE: Always reuse substance from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'extract-substance', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused substance extraction from baseline (${baseline.items?.length || 0} items)`);
            return baseline;
          }
        }

        if (this.incrementalManager?.canReuseStep('extract-substance')) {
          const baseline = this.checkpointManager.load(hearingId, 'extract-substance', this.incrementalBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[INCREMENTAL] Reused substance extraction from baseline (${baseline.items?.length || 0} items)`);
            return baseline;
          }
        }

        // MATERIAL CACHE: Check hearing-level cache
        if (this.useMaterialCache && this.materialCacheHash) {
          const cached = this.materialCacheManager.loadCachedStep(hearingId, 'extract-substance');
          const cacheValid = this.materialCacheManager.isCacheValid(hearingId, this.materialCacheHash);
          if (cached && cacheValid.valid) {
            this.materialCacheLoaded['extract-substance'] = true;
            this.jobTracker.logEvent(jobId, 'info', `[CACHE] Reused substance extraction from hearing cache (${cached.items?.length || 0} items)`);
            console.log(`[Pipeline]   📦 Loaded from material cache`);
            return cached;
          }
        }

        // Identify document type from taxonomy or material analysis
        const documentType = artifacts.taxonomy?.documentType ||
                            this.identifyDocumentType(artifacts.loadData.materials);

        const substance = await this.substanceExtractor.extractSubstance(
          artifacts.loadData.materials,
          documentType
        );

        // Save to material cache
        if (this.useMaterialCache && this.materialCacheHash) {
          this.materialCacheManager.saveToCache(hearingId, 'extract-substance', substance, this.materialCacheHash, {
            sourceRun: this.checkpointLabel
          });
          console.log(`[Pipeline]   📦 Saved to material cache`);
        }

        this.jobTracker.logEvent(jobId, 'info',
          `Extracted ${substance.items?.length || 0} substance items (type: ${substance.documentType}, confidence: ${(substance.confidence * 100).toFixed(0)}%)`
        );

        // Log first few items
        if (substance.items?.length > 0) {
          const preview = substance.items.slice(0, 3).map(i => `${i.reference || ''} ${i.title}`).join(', ');
          this.jobTracker.logEvent(jobId, 'info', `Substance preview: ${preview}...`);
        }

        return substance;
      }, jobId);

      // Step 1.8: Embed Substance Items (for RAG-based context selection)
      // INCREMENTAL/PATCH: Reuse from baseline if materials unchanged
      // MATERIAL CACHE: Check hearing-level cache first
      artifacts.embeddedSubstance = await this.step('embed-substance', async () => {
        // PATCH MODE: Always reuse substance embeddings from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'embed-substance', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused substance embeddings from baseline (${baseline.items?.length || 0} items)`);
            return baseline;
          }
        }

        if (this.incrementalManager?.canReuseStep('embed-substance')) {
          const baseline = this.checkpointManager.load(hearingId, 'embed-substance', this.incrementalBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[INCREMENTAL] Reused substance embeddings from baseline (${baseline.items?.length || 0} items)`);
            return baseline;
          }
        }

        // MATERIAL CACHE: Check hearing-level cache
        if (this.useMaterialCache && this.materialCacheHash) {
          const cached = this.materialCacheManager.loadCachedStep(hearingId, 'embed-substance');
          const cacheValid = this.materialCacheManager.isCacheValid(hearingId, this.materialCacheHash);
          if (cached && cacheValid.valid) {
            this.materialCacheLoaded['embed-substance'] = true;
            this.jobTracker.logEvent(jobId, 'info', `[CACHE] Reused substance embeddings from hearing cache (${cached.items?.length || 0} items)`);
            console.log(`[Pipeline]   📦 Loaded from material cache`);
            return cached;
          }
        }

        if (!artifacts.substance?.items || artifacts.substance.items.length === 0) {
          this.jobTracker.logEvent(jobId, 'info', 'No substance items to embed');
          const emptyResult = { items: [], hasEmbeddings: false };
          // Still cache empty result
          if (this.useMaterialCache && this.materialCacheHash) {
            this.materialCacheManager.saveToCache(hearingId, 'embed-substance', emptyResult, this.materialCacheHash, {
              sourceRun: this.checkpointLabel
            });
          }
          return emptyResult;
        }

        const embeddedItems = await this.substanceEmbedder.embedSubstanceItems(
          artifacts.substance.items
        );

        const successCount = embeddedItems.filter(i => i.hasEmbedding).length;

        const result = {
          items: embeddedItems,
          hasEmbeddings: successCount > 0,
          documentType: artifacts.substance.documentType
        };

        // Save to material cache
        if (this.useMaterialCache && this.materialCacheHash) {
          this.materialCacheManager.saveToCache(hearingId, 'embed-substance', result, this.materialCacheHash, {
            sourceRun: this.checkpointLabel
          });
          console.log(`[Pipeline]   📦 Saved to material cache`);
        }

        this.jobTracker.logEvent(jobId, 'info',
          `Embedded ${successCount}/${embeddedItems.length} substance items for RAG retrieval`
        );

        return result;
      }, jobId);

      // Step 2: Edge case screening (PARALLEL BATCH with auto batch size)
      // INCREMENTAL/PATCH: Only screen new/modified responses, merge with baseline for unchanged
      artifacts.edgeCases = await this.step('edge-case-screening', async () => {
        const responsesToProcess = artifacts.loadData.responses;
        const materialContext = artifacts.materialSummaryLite || artifacts.materialSummary;

        // PATCH MODE: Process only patched responses, merge with baseline
        if (this.patchMode && this.patchManager) {
          const baselineEdgeCases = this.checkpointManager.load(hearingId, 'edge-case-screening', this.patchBaseline);

          if (baselineEdgeCases && Array.isArray(baselineEdgeCases)) {
            // Filter to only process patched responses
            const patchedResponses = responsesToProcess.filter(r => this.patchResponseIds.has(r.id));

            let newEdgeCases = [];
            if (patchedResponses.length > 0) {
              newEdgeCases = await this.edgeCaseDetector.screenBatch(
                patchedResponses,
                responsesToProcess, // Full list for reference resolution
                materialContext
              );
            }

            // Merge using patchMerge
            const merged = this.patchManager.patchMerge('edge-case-screening', newEdgeCases, this.patchResponseIds);

            this.jobTracker.logEvent(jobId, 'info',
              `[PATCH] Edge cases: ${newEdgeCases.length} re-processed, ${merged.length - newEdgeCases.length} from baseline`
            );
            return merged;
          }
        }

        // Check for incremental mode with per-response processing
        if (this.incrementalManager && this.incrementalAnalysis) {
          const needsProcessing = this.incrementalManager.getResponsesNeedingProcessing();
          const reusableIds = new Set(this.incrementalManager.getReusableResponseIds());
          
          if (needsProcessing.length < responsesToProcess.length && reusableIds.size > 0) {
            // Load baseline edge cases for reuse
            const baselineEdgeCases = this.checkpointManager.load(hearingId, 'edge-case-screening', this.incrementalBaseline);
            
            if (baselineEdgeCases && Array.isArray(baselineEdgeCases)) {
              // Filter to only process new/modified responses
              const responsesNeedingProcessing = responsesToProcess.filter(r => 
                needsProcessing.includes(r.id)
              );
              
              let newEdgeCases = [];
              if (responsesNeedingProcessing.length > 0) {
                newEdgeCases = await this.edgeCaseDetector.screenBatch(
                  responsesNeedingProcessing,
                  responsesToProcess, // Full list for reference resolution
                  materialContext
                );
              }
              
              // Merge: use baseline for unchanged, new results for processed
              const merged = this.incrementalManager.mergeWithBaseline(
                'edge-case-screening',
                newEdgeCases,
                responsesToProcess
              );
              
              this.jobTracker.logEvent(jobId, 'info', 
                `[INCREMENTAL] Edge cases: ${newEdgeCases.length} new, ${merged.length - newEdgeCases.length} reused from baseline`
              );
              return merged;
            }
          }
        }
        
        // Full processing (no incremental or fallback)
        const edgeCases = await this.edgeCaseDetector.screenBatch(
          responsesToProcess,
          responsesToProcess,
          materialContext
        );
        this.jobTracker.logEvent(jobId, 'info', `Screened ${edgeCases.length} responses for edge cases (batch mode)`);
        return edgeCases;
      }, jobId);

      // Step 3: Enrich responses (OPTIMIZATION: delta storage - only store enrichments)
      artifacts.enrichedResponses = await this.step('enrich-responses', async () => {
        const enrichments = [];

        artifacts.loadData.responses.forEach(response => {
          const edgeCase = artifacts.edgeCases.find(ec => ec.responseNumber === response.id);

          // Only enrich if edge case has references to other responses
          if (edgeCase?.referencedNumbers?.length > 0 && edgeCase.action === 'analyze-with-context') {
            const contextTexts = edgeCase.referencedNumbers
              .map(num => {
                const ref = artifacts.loadData.responses.find(r => r.id === num);
                return ref ? `\n\n[Kontekst fra relaterede svar: ${ref.text}]` : '';
              })
              .filter(Boolean);

            if (contextTexts.length > 0) {
              // Store only the delta (enriched text and metadata)
              enrichments.push({
                id: response.id,
                enrichedText: response.text + contextTexts.join(''),
                originalLength: response.text?.length || 0,
                enrichmentReason: `Tilføjet kontekst fra henvendelse ${edgeCase.referencedNumbers.join(', ')}`,
                textEnriched: true
              });
            }
          }
        });

        this.jobTracker.logEvent(jobId, 'info',
          `Enriched ${enrichments.length} responses with context (delta storage: ${((enrichments.length / artifacts.loadData.responses.length) * 100).toFixed(1)}% of responses)`
        );

        // Return enrichment deltas, not full responses
        return enrichments;
      }, jobId);

      // Step 4: Chunking (with argument-aligned strategy support)
      // PATCH: Reuse from baseline (chunking is deterministic)
      artifacts.chunking = await this.step('chunking', async () => {
        // PATCH MODE: Reuse chunking from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'chunking', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused chunking from baseline (${baseline.length} chunks)`);
            return baseline;
          }
        }

        const chunks = [];
        const chunkingStrategy = this.config.chunking?.responseStrategy || 'legacy';
        const shortThreshold = this.config.chunking?.shortResponseThreshold || 800;

        // Track statistics
        let shortResponsesSkipped = 0;
        let longResponsesChunked = 0;
        let responseChunkCount = 0;
        let materialChunkCount = 0;

        // Chunk responses (merge enrichments with originals)
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);
        fullResponses.forEach(response => {
          const text = response.textMd || response.text || '';
          const responseChunks = this.chunker.chunk(
            text,
            {
              source: `response:${response.id}`,
              responseNumber: response.id,
              documentType: 'response'
            }
          );
          chunks.push(...responseChunks);
          responseChunkCount += responseChunks.length;

          // Track statistics for argument-aligned strategy
          if (chunkingStrategy === 'argument-aligned') {
            if (text.length < shortThreshold) {
              shortResponsesSkipped++;
            } else if (responseChunks.length > 1) {
              longResponsesChunked++;
            }
          }
        });

        // Chunk materials (always use section-aware chunking)
        artifacts.loadData.materials.forEach(material => {
          const materialChunks = this.chunker.chunk(
            material.contentMd || material.content || '',
            {
              source: `material:${material.materialId}`,
              documentType: 'material',
              materialId: material.materialId
            }
          );
          chunks.push(...materialChunks);
          materialChunkCount += materialChunks.length;
        });

        // Log chunking statistics
        const stats = StructuredChunker.getChunkingStats(chunks);
        this.jobTracker.logEvent(jobId, 'info', 
          `Created ${chunks.length} chunks (strategy: ${chunkingStrategy})`
        );
        this.jobTracker.logEvent(jobId, 'info', 
          `  - Responses: ${responseChunkCount} chunks from ${fullResponses.length} responses`
        );
        this.jobTracker.logEvent(jobId, 'info', 
          `  - Materials: ${materialChunkCount} chunks`
        );
        
        if (chunkingStrategy === 'argument-aligned') {
          this.jobTracker.logEvent(jobId, 'info', 
            `  - Short responses (< ${shortThreshold} chars): ${shortResponsesSkipped} skipped chunking`
          );
          this.jobTracker.logEvent(jobId, 'info', 
            `  - Long responses chunked: ${longResponsesChunked}`
          );
        }

        return chunks;
      }, jobId);

      // Step 4: Embedding
      // PATCH: Reuse from baseline (expensive operation)
      artifacts.embeddings = await this.step('embedding', async () => {
        // PATCH MODE: Reuse embeddings from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'embedding', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused embeddings from baseline (${baseline.length} chunks)`);
            return baseline;
          }
        }

        const embeddedChunks = await this.embedder.embedChunks(artifacts.chunking, {
          onProgress: (progress) => {
            this.jobTracker.updateJob(jobId, { progress: 10 + Math.round(progress.percentage * 0.2) });
          }
        });

        const validation = this.embedder.validateEmbeddings(embeddedChunks);
        this.jobTracker.logEvent(jobId, 'info', `Embedded ${validation.validChunks}/${validation.totalChunks} chunks`);

        // Update progress tracker with chunk/embedding stats
        if (this.progressTracker) {
          this.progressTracker.updateDataStats({
            chunkCount: validation.totalChunks,
            embeddingCount: validation.validChunks
          });
        }

        return embeddedChunks;
      }, jobId);

      // Step 4.5: Calculate initial dynamic parameters (will be recalculated after aggregation)
      // PATCH: Reuse from baseline (based on same response count)
      artifacts.dynamicParameters = await this.step('calculate-dynamic-parameters', async () => {
        // PATCH MODE: Reuse dynamic parameters from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'calculate-dynamic-parameters', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused dynamic parameters from baseline`);

            // Still apply to aggregator
            if (this.aggregator.setDynamicParameters) {
              this.aggregator.setDynamicParameters(baseline);
            }
            this.dynamicParams = baseline;
            return baseline;
          }
        }

        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);
        const responseCount = fullResponses.length;
        const chunkCount = artifacts.embeddings.length;

        // Calculate response length and diversity
        const totalWords = fullResponses.reduce((sum, r) => {
          const text = r.text || '';
          return sum + text.split(/\s+/).length;
        }, 0);
        const avgResponseLength = Math.round(totalWords / Math.max(1, responseCount));

        // Calculate semantic diversity from embeddings
        const responseEmbeddings = artifacts.embeddings.filter(e => e.metadata?.documentType === 'response');
        const semanticDiversity = this.calculateSemanticDiversity(responseEmbeddings);

        const params = DynamicParameterCalculator.getParametersForHearing({
          responseCount,
          chunkCount,
          avgResponseLength,
          semanticDiversity,
          positionCount: Math.ceil(responseCount * 1.5), // Estimate for now
          themeCount: 5 // Estimate
        });

        // Log parameters
        DynamicParameterCalculator.logParameters(params, {
          log: (msg) => this.jobTracker.logEvent(jobId, 'info', msg)
        });

        // CRITICAL: Configure global embedding concurrency based on dynamic parameters
        // This prevents "Connection error" / timeout floods from too many parallel requests
        configureGlobalEmbeddingConcurrency(params);

        // Apply to aggregator
        if (this.aggregator.setDynamicParameters) {
          this.aggregator.setDynamicParameters(params);
        }

        this.dynamicParams = params;
        return params;
      }, jobId);

      // Step 5: Micro-summarization (with RAG-based substance selection)
      // INCREMENTAL/PATCH: Only summarize new/modified responses, merge with baseline for unchanged
      artifacts.microSummaries = await this.step('micro-summarize', async () => {
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);

        // OPTIMIZATION: Use embedded substance for RAG-based context selection
        // Each response will get only the most relevant substance items (top 15) instead of all 60+
        const useRAGSubstance = artifacts.embeddedSubstance?.hasEmbeddings;

        // Fallback: if no embeddings, use full substance formatted for prompt
        const materialContext = !useRAGSubstance && artifacts.substance
          ? this.substanceExtractor.formatForPrompt(artifacts.substance)
          : (artifacts.materialSummaryLite || artifacts.materialSummary);

        // PATCH MODE: Process only patched responses, merge with baseline
        if (this.patchMode && this.patchManager) {
          const baselineSummaries = this.checkpointManager.load(hearingId, 'micro-summarize', this.patchBaseline);

          if (baselineSummaries && Array.isArray(baselineSummaries)) {
            // Filter to only process patched responses
            const responsesToProcess = fullResponses.filter(r => this.patchResponseIds.has(r.id));

            const msg = `[PATCH] Micro-summarize: Processing ${responsesToProcess.length}/${fullResponses.length} responses`;
            console.log(`[Pipeline] ${msg}`);
            this.jobTracker.logEvent(jobId, 'info', msg);

            // Pass feedback context to MicroSummarizer if available
            if (this.feedbackContext) {
              this.microSummarizer.setFeedbackContext(this.feedbackContext);
            }

            // Set material summary for proposal context (helps direction classification)
            this.microSummarizer.setMaterialSummary(artifacts.materialSummary);

            // Set known substance IDs for substanceRef validation
            if (artifacts.substance?.items) {
              this.microSummarizer.setKnownSubstanceIds(artifacts.substance.items);
            }

            // Configure MicroSummarizer with embedded substance for RAG
            if (useRAGSubstance) {
              this.microSummarizer.setEmbeddedSubstance(
                artifacts.embeddedSubstance.items,
                this.substanceEmbedder
              );

              // Pre-embed only patched response texts
              const queryItems = responsesToProcess
                .filter(r => r.text && r.text.trim().length > 0)
                .map(r => ({ id: r.id || r.responseNumber, text: r.text }));

              if (queryItems.length > 0) {
                const preEmbeddedQueries = await this.substanceEmbedder.preEmbedQueries(queryItems);
                this.microSummarizer.setPreEmbeddedQueries(preEmbeddedQueries);
              }
            }

            // Process patched responses
            let summaries = [];
            if (responsesToProcess.length > 0) {
              summaries = await this.microSummarizer.summarizeBatch(
                responsesToProcess,
                materialContext,
                fullResponses, // Full list for reference resolution
                {
                  taxonomy: artifacts.taxonomy,
                  substance: artifacts.substance,
                  edgeCases: artifacts.edgeCases,
                  useRAGSubstance
                }
              );
            }

            // Merge using patchMerge
            const merged = this.patchManager.patchMerge('micro-summarize', summaries, this.patchResponseIds);

            this.jobTracker.logEvent(jobId, 'info',
              `[PATCH] Micro-summaries: ${summaries.length} re-processed, ${merged.length - summaries.length} from baseline = ${merged.length} total`
            );
            return merged;
          }
        }

        // INCREMENTAL MODE: Only process new/modified responses
        let responsesToProcess = fullResponses;
        let baselineSummaries = null;
        let incrementalReuse = false;

        if (this.incrementalManager && this.incrementalAnalysis) {
          const needsProcessing = this.incrementalManager.getResponsesNeedingProcessing();
          const reusableIds = new Set(this.incrementalManager.getReusableResponseIds());
          
          // Only use incremental if we have some responses to reuse
          if (needsProcessing.length < fullResponses.length && reusableIds.size > 0) {
            baselineSummaries = this.checkpointManager.load(hearingId, 'micro-summarize', this.incrementalBaseline);
            
            if (baselineSummaries && Array.isArray(baselineSummaries)) {
              // Filter to only process new/modified responses
              responsesToProcess = fullResponses.filter(r => needsProcessing.includes(r.id));
              incrementalReuse = true;
              
              const msg = `[INCREMENTAL] Micro-summarize: Processing ${responsesToProcess.length}/${fullResponses.length} responses (${reusableIds.size} reused from baseline)`;
              console.log(`[IncrementalManager] ${msg}`);
              this.jobTracker.logEvent(jobId, 'info', msg);
              
              // CRITICAL FIX: Hydrate citation registry with baseline citations
              // Reused micro-summaries have CITE_xxx references that must exist in the registry
              // Without this, PositionWriter fails with "No quote found for respondent X"
              const baselineCitationRegistry = this.checkpointManager.load(hearingId, 'citation-registry', this.incrementalBaseline);
              if (baselineCitationRegistry?.citations) {
                const hydrateStats = this.citationRegistry.hydrateFromCheckpoint(baselineCitationRegistry);
                const hydrateMsg = `[INCREMENTAL] Citation registry hydrated: ${hydrateStats.hydrated} baseline citations (nextId=${this.citationRegistry.nextId})`;
                console.log(`[IncrementalManager] ${hydrateMsg}`);
                this.jobTracker.logEvent(jobId, 'info', hydrateMsg);
              } else {
                console.warn('[IncrementalManager] ⚠️ Could not load baseline citation-registry - reused micro-summaries may fail to resolve');
              }
            }
          }
        }
        
        // Pass feedback context to MicroSummarizer if available
        if (this.feedbackContext) {
          this.microSummarizer.setFeedbackContext(this.feedbackContext);
        }

        // Set material summary for proposal context (helps direction classification)
        this.microSummarizer.setMaterialSummary(artifacts.materialSummary);

        // Set known substance IDs for substanceRef validation
        if (artifacts.substance?.items) {
          this.microSummarizer.setKnownSubstanceIds(artifacts.substance.items);
        }

        // Configure MicroSummarizer with embedded substance for RAG
        if (useRAGSubstance) {
          this.microSummarizer.setEmbeddedSubstance(
            artifacts.embeddedSubstance.items,
            this.substanceEmbedder
          );

          // OPTIMIZATION: Pre-embed only response texts that need processing
          const queryItems = responsesToProcess
            .filter(r => r.text && r.text.trim().length > 0)
            .map(r => ({
              id: r.id || r.responseNumber,
              text: r.text
            }));
          
          if (queryItems.length > 0) {
            this.jobTracker.logEvent(jobId, 'info', 
              `Pre-embedding ${queryItems.length} response texts for RAG lookup...`
            );
            
            const preEmbeddedQueries = await this.substanceEmbedder.preEmbedQueries(queryItems);
            this.microSummarizer.setPreEmbeddedQueries(preEmbeddedQueries);
            
            this.jobTracker.logEvent(jobId, 'info', 
              `RAG mode: Pre-embedded ${preEmbeddedQueries.size}/${queryItems.length} responses, will retrieve top-15 substance items per response`
            );
          } else if (!incrementalReuse) {
            this.jobTracker.logEvent(jobId, 'info', 
              `RAG mode: MicroSummarizer will retrieve top-15 substance items per response`
            );
          }
        }
        
        let summaries;
        
        if (responsesToProcess.length === 0 && incrementalReuse) {
          // All responses reused from baseline
          summaries = [];
          this.jobTracker.logEvent(jobId, 'info', `[INCREMENTAL] All responses reused from baseline - no new processing needed`);
        } else if (responsesToProcess.length > 0) {
          // Process responses (either all or just new/modified)
          summaries = await this.microSummarizer.summarizeBatch(
            responsesToProcess,
            materialContext,
            fullResponses, // Full list for reference resolution
            {
              taxonomy: artifacts.taxonomy,
              substance: artifacts.substance,
              edgeCases: artifacts.edgeCases,
              useRAGSubstance
            }
          );
          this.jobTracker.logEvent(jobId, 'info', `Summarized ${summaries.length} responses`);
        } else {
          summaries = [];
        }
        
        // Merge with baseline if in incremental mode
        if (incrementalReuse && baselineSummaries) {
          const merged = this.incrementalManager.mergeWithBaseline(
            'micro-summarize',
            summaries,
            fullResponses
          );
          const mergeMsg = `Merged micro-summaries: ${summaries.length} new + ${merged.length - summaries.length} reused = ${merged.length} total`;
          console.log(`[IncrementalManager] ${mergeMsg}`);
          this.jobTracker.logEvent(jobId, 'info', `[INCREMENTAL] ${mergeMsg}`);
          return merged;
        }

        // Store transformed summaries (with citation refs) back in artifacts
        return summaries;
      }, jobId);

      // Step 5.0.5: Relevance Scoring (filter tangential/irrelevant arguments)
      // This runs after micro-summarize to filter out low-relevance arguments
      // before they flow into theme-mapping and aggregation.
      // PATCH: Score only patched responses, merge with baseline scoring
      if (this.dynamicParams?.relevance?.enabled && this.relevanceScorer) {
        artifacts.microSummaries = await this.step('relevance-scoring', async () => {
          // PATCH MODE: Score only patched responses, merge with baseline
          if (this.patchMode && this.patchManager) {
            const baselineRelevance = this.checkpointManager.load(hearingId, 'relevance-scoring', this.patchBaseline);

            if (baselineRelevance && Array.isArray(baselineRelevance)) {
              // Extract just the patched micro-summaries
              const patchedSummaries = artifacts.microSummaries.filter(s =>
                this.patchResponseIds.has(s.responseNumber)
              );

              if (patchedSummaries.length > 0) {
                // Score only the patched summaries
                const hearingContext = this.relevanceScorer.buildHearingContext(
                  artifacts.materialSummary,
                  artifacts.taxonomy?.themes || []
                );

                const { summaries: scoredPatched, totalFiltered, totalKept } = await this.relevanceScorer.scoreAndFilterSummaries(
                  patchedSummaries,
                  hearingContext,
                  this.dynamicParams
                );

                // Merge: baseline results + newly scored patched results
                const merged = this.patchManager.patchMerge('relevance-scoring', scoredPatched, this.patchResponseIds);

                this.jobTracker.logEvent(jobId, 'info',
                  `[PATCH] Relevance scoring: ${patchedSummaries.length} patched scored (kept ${totalKept}, filtered ${totalFiltered}), merged with baseline`
                );
                return merged;
              } else {
                // No patched summaries - use baseline directly
                this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused relevance scoring from baseline (${baselineRelevance.length} summaries)`);
                return baselineRelevance;
              }
            }
          }

          // Build hearing context from material summary and themes
          const hearingContext = this.relevanceScorer.buildHearingContext(
            artifacts.materialSummary,
            artifacts.taxonomy?.themes || []
          );

          const { summaries, totalFiltered, totalKept } = await this.relevanceScorer.scoreAndFilterSummaries(
            artifacts.microSummaries,
            hearingContext,
            this.dynamicParams
          );

          this.jobTracker.logEvent(jobId, 'info',
            `Relevance filtering: kept ${totalKept} arguments, filtered ${totalFiltered} low-relevance arguments`
          );

          return summaries;
        }, jobId);
      }

      // Step 5.1: Citation registry or validation
      if (this.citationRegistry) {
        // When using citation registry, just log stats (no heavy validation needed)
        artifacts.citationRegistryStats = await this.step('citation-registry', async () => {
          const stats = this.citationRegistry.getStats();
          this.jobTracker.logEvent(jobId, 'info',
            `✓ Citation Registry: ${stats.totalCitations} citations registered from ${stats.totalResponses} responses`
          );

          // Always export full registry (needed for citation resolution on resume)
          return this.citationRegistry.export();
        }, jobId);
      } else if (this.config.validation?.validateMicroCitations !== false) {
        // Original validation only if not using citation registry
        artifacts.microSummaryValidation = await this.step('validate-micro-citations', async () => {
          const validation = this.citationIntegrityValidator.validateMicroSummaryQuotes(artifacts.microSummaries);

          if (!validation.valid) {
            this.jobTracker.logEvent(jobId, 'warning',
              `Citation validation issues in micro-summaries: ${validation.issues.length} issues found`
            );

            // Log statistics
            const stats = validation.stats;
            this.jobTracker.logEvent(jobId, 'info',
              `Citation stats: ${stats.validQuotes}/${stats.totalQuotes} valid quotes, ${stats.missingQuotes} missing, ${stats.emptyQuotes} empty`
            );

            // Log first few issues
            validation.issues.slice(0, 5).forEach(issue => {
              this.jobTracker.logEvent(jobId, 'warning',
                `  - Response ${issue.responseNumber}: ${issue.type} - ${issue.message}`
              );
            });
          } else {
            this.jobTracker.logEvent(jobId, 'info',
              `✓ All micro-summary citations valid: ${validation.stats.validQuotes} quotes verified`
            );
          }

          return validation;
        }, jobId);
      }

      // Step 5.2: Validate quote sources against original text (catches LLM hallucinations early)
      if (this.citationRegistry && this.config.validation?.validateQuoteSources !== false) {
        artifacts.quoteSourceValidation = await this.step('validate-quote-sources', async () => {
          const quoteValidator = new MicroSummaryQuoteValidator({
            similarityThreshold: 0.85,
            suggestFixes: true,
            verbose: this.config.verbose
          });

          const registryExport = artifacts.citationRegistryStats || this.citationRegistry.export();
          const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);
          const validation = quoteValidator.validateCitationRegistry(registryExport, fullResponses);

          console.log(`[Validate Quote Sources] ${validation.summary}`);

          if (validation.stats.hallucinations > 0) {
            this.jobTracker.logEvent(jobId, 'warning',
              `⚠️ Quote validation: ${validation.stats.hallucinations} hallucinated quotes detected`
            );

            // Log first few hallucinations
            validation.issues
              .filter(i => i.type === 'hallucination')
              .slice(0, 5)
              .forEach(issue => {
                console.log(`[Validate Quote Sources]   ❌ ${issue.citeId} (response ${issue.responseNumber}): "${issue.hallucinated?.substring(0, 50)}..."`);
                if (issue.fallbackQuote) {
                  console.log(`[Validate Quote Sources]      → Suggested fix: "${issue.fallbackQuote.substring(0, 50)}..."`);
                }
              });

            // Auto-fix mode: apply suggested fixes to citation registry
            if (this.config.validation?.autoFixQuotes !== false) {
              const { registry: fixedRegistry, fixCount } = quoteValidator.applyFixes(registryExport, validation);
              if (fixCount > 0) {
                console.log(`[Validate Quote Sources] ✅ Auto-fixed ${fixCount} hallucinated quotes`);
                // Update the citation registry with fixed quotes
                if (this.citationRegistry) {
                  this.citationRegistry.importFixes(fixedRegistry);
                }
                // Update the checkpoint
                artifacts.citationRegistryStats = fixedRegistry;
                validation.autoFixed = fixCount;
              }
            }

            // Strict mode: fail if hallucinations found and not auto-fixed
            if (this.config.validation?.strictQuoteValidation && validation.stats.hallucinations > (validation.autoFixed || 0)) {
              const unfixedCount = validation.stats.hallucinations - (validation.autoFixed || 0);
              throw new Error(`CRITICAL: ${unfixedCount} hallucinated quotes could not be auto-fixed. Run with --auto-fix-quotes or fix manually.`);
            }
          } else {
            this.jobTracker.logEvent(jobId, 'info',
              `✓ Quote validation passed: ${validation.stats.validCitations}/${validation.stats.totalCitations} quotes verified in source text`
            );
          }

          return validation;
        }, jobId);
      }

      // Step 5.5: Embed arguments (OPTIMIZATION: embed what/why/how instead of full text)
      // PATCH: Reuse from baseline (embedding is expensive)
      artifacts.argumentEmbeddings = await this.step('embed-arguments', async () => {
        // PATCH MODE: Reuse argument embeddings from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'embed-arguments', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused argument embeddings from baseline (${baseline.length} embeddings)`);
            return baseline;
          }
        }

        // Extract all arguments from microSummaries
        const argumentsToEmbed = [];
        artifacts.microSummaries.forEach(summary => {
          if (summary.arguments && summary.arguments.length > 0) {
            summary.arguments.forEach((arg, idx) => {
              // Combine what/why/how for rich semantic representation
              const textToEmbed = [
                arg.what || '',
                arg.why || '',
                arg.how || ''
              ].filter(t => t).join(' ');

              if (textToEmbed.trim()) {
                argumentsToEmbed.push({
                  content: textToEmbed, // CRITICAL: BatchEmbedder expects 'content' not 'text'
                  text: textToEmbed, // Keep for backward compatibility
                  responseNumber: summary.responseNumber,
                  argumentIndex: idx,
                  metadata: {
                    what: arg.what,
                    why: arg.why,
                    how: arg.how,
                    sourceQuote: arg.sourceQuote,
                    relevantThemes: arg.relevantThemes
                  }
                });
              }
            });
          }
        });

        // Embed all arguments
        const embeddedArguments = await this.embedder.embedChunks(argumentsToEmbed, {
          onProgress: (progress) => {
            this.jobTracker.updateJob(jobId, { progress: 10 + Math.round(progress.percentage * 0.2) });
          }
        });

        const validation = this.embedder.validateEmbeddings(embeddedArguments);
        this.jobTracker.logEvent(jobId, 'info', `Embedded ${validation.validChunks}/${validation.totalChunks} arguments`);

        return embeddedArguments;
      }, jobId);

      // Step 5.5: Similarity Analysis (for mass agreement detection)
      // PATCH: Reuse from baseline (pattern analysis is on whole dataset)
      artifacts.similarityAnalysis = await this.step('similarity-analysis', async () => {
        // PATCH MODE: Reuse similarity analysis from baseline
        if (this.patchMode) {
          const baseline = this.checkpointManager.load(hearingId, 'similarity-analysis', this.patchBaseline);
          if (baseline) {
            this.jobTracker.logEvent(jobId, 'info', `[PATCH] Reused similarity analysis from baseline`);
            return baseline;
          }
        }

        const analysis = await this.similarityAnalyzer.analyzePatterns(
          artifacts.loadData.responses,
          artifacts.microSummaries
        );

        // Log analysis results
        this.similarityAnalyzer.logAnalysis(analysis);

        // Apply recommendations to dynamic parameters
        if (analysis.massAgreementDetected.detected && artifacts.dynamicParameters) {
          // Apply floor to prevent over-merging even with mass agreement
          // NEW: Lower floor for small hearings
          const recommendedThreshold = analysis.recommendations.consolidationThreshold;
          const responseCount = artifacts.loadData?.responses?.length || 0;
          const thresholdFloor = responseCount <= 20 ? 0.75 : 0.82;
          const flooredThreshold = Math.max(thresholdFloor, recommendedThreshold);
          const crossThemeThreshold = DynamicParameterCalculator.getCrossThemeThreshold(flooredThreshold, responseCount);
          
          const updatedParams = {
            ...artifacts.dynamicParameters,
            consolidationStrategy: analysis.recommendations.consolidationStrategy,
            consolidationThreshold: flooredThreshold,
            crossThemeThreshold: crossThemeThreshold,
            ...analysis.recommendations.parameters
          };

          // Update components with new parameters
          if (this.aggregator.setDynamicParameters) {
            this.aggregator.setDynamicParameters(updatedParams);
          }
          if (this.positionConsolidator.setDynamicThreshold) {
            this.positionConsolidator.setDynamicThreshold(flooredThreshold, crossThemeThreshold);
          }

          // Store updated parameters
          artifacts.dynamicParameters = updatedParams;

          this.jobTracker.logEvent(jobId, 'info',
            `Mass agreement detected (${(analysis.massAgreementDetected.confidence * 100).toFixed(0)}% confidence) - adjusted parameters (threshold: ${flooredThreshold.toFixed(3)}, cross-theme: ${crossThemeThreshold.toFixed(3)})`
          );
        }

        return analysis;
      }, jobId);

      // Step 6: Theme mapping
      artifacts.themes = await this.step('theme-mapping', async () => {
        // Apply dynamic parameters to themeMapper before mapping
        if (this.themeMapper.setDynamicParameters && artifacts.dynamicParameters) {
          this.themeMapper.setDynamicParameters(artifacts.dynamicParameters);
        }
        
        // RAG: Configure ThemeMapper with embedded substance for theme correction
        // This allows looking up what the hearing material says about physical elements
        if (artifacts.embeddedSubstance?.hasEmbeddings && this.themeMapper.setEmbeddedSubstance) {
          this.themeMapper.setEmbeddedSubstance(
            artifacts.embeddedSubstance.items,
            this.substanceEmbedder
          );
        }

        const mapping = await this.themeMapper.mapToThemes(
          artifacts.microSummaries,
          artifacts.loadData.materials,
          artifacts.taxonomy?.themes // Pass pre-extracted themes to avoid re-extraction
        );

        // Log theme mapping results
        this.jobTracker.logEvent(jobId, 'info', `Mapped to ${mapping.themes.length} themes: ${mapping.themes.map(t => t.name).join(', ')}`);

        // Log argument counts per theme
        const argCounts = mapping.themes.map(t => `${t.name}: ${t.arguments?.length || 0}`).join(', ');
        this.jobTracker.logEvent(jobId, 'info', `Arguments per theme: ${argCounts}`);

        // Update progress tracker with theme stats
        if (this.progressTracker) {
          const totalArguments = mapping.themes.reduce((sum, t) => sum + (t.arguments?.length || 0), 0);
          this.progressTracker.updateDataStats({
            themeCount: mapping.themes.length,
            argumentCount: totalArguments
          });
        }

        return mapping;
      }, jobId);

      // Step 6.5: Validate Legal Scope (post-validation of out-of-scope arguments)
      artifacts.legalScopeValidation = await this.step('validate-legal-scope', async () => {
        // Get document type from taxonomy
        const documentType = artifacts.taxonomy?.documentType || 'lokalplan';
        
        // Use LegalScopeContext to move any remaining out-of-scope arguments
        const validationResult = this.legalScopeContext.moveOutOfScopeArguments(
          artifacts.themes,
          documentType
        );

        // Update themes with validated version
        artifacts.themes = validationResult;

        // Log validation statistics
        const movedCount = validationResult._legalScopeValidation?.movedArguments || 0;
        const outOfScopeTheme = validationResult.themes.find(t => t.name === 'Andre emner');
        const outOfScopeCount = outOfScopeTheme?.arguments?.length || 0;

        if (movedCount > 0) {
          this.jobTracker.logEvent(jobId, 'info', 
            `Legal scope validation: Moved ${movedCount} additional arguments to "Andre emner" (total: ${outOfScopeCount})`
          );
        } else {
          this.jobTracker.logEvent(jobId, 'info', 
            `Legal scope validation: No additional out-of-scope arguments found (total in "Andre emner": ${outOfScopeCount})`
          );
        }

        // Log document type capabilities summary
        const capabilities = this.legalScopeContext.getCapabilitySummary(documentType);
        this.jobTracker.logEvent(jobId, 'info', 
          `Document type: ${capabilities.name} (${capabilities.primaryLaw}) - ${capabilities.canRegulate.length} authorities, ${capabilities.cannotRegulate.length} limitations`
        );

        return {
          documentType,
          movedArguments: movedCount,
          totalOutOfScope: outOfScopeCount,
          capabilities
        };
      }, jobId);

      // Step: Validate directions using embeddings
      // Uses semantic similarity to find and correct direction misclassifications
      artifacts.directionValidation = await this.step('validate-directions', async () => {
        const directionValidator = new DirectionValidator(this.microSummarizer.client);

        const result = await directionValidator.validateDirections(
          artifacts.microSummaries,
          artifacts.materialSummary?.summary || ''
        );

        if (result.corrections && result.corrections.length > 0) {
          this.jobTracker.logEvent(jobId, 'info',
            `Direction validation: Found ${result.outlierCount} outliers, corrected ${result.corrections.length} misclassifications`
          );

          // Log specific corrections for debugging
          for (const correction of result.corrections) {
            console.log(`[DirectionValidator] Corrected R${correction.responseNumber}: ${correction.originalDirection} → ${correction.correctedDirection} ("${correction.what?.slice(0, 50)}...")`);
          }
        } else {
          this.jobTracker.logEvent(jobId, 'info',
            `Direction validation: ${result.reason === 'no_outliers' ? 'No outliers found' : result.reason}`
          );
        }

        return result;
      }, jobId);

      // Step 7: Aggregation (OPTIMIZATION: use argument embeddings instead of chunk embeddings)
      // PATCH: Only re-aggregate touched themes, merge with baseline for untouched
      artifacts.aggregation = await this.step('aggregate', async () => {
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);

        // PATCH MODE: Selective theme re-aggregation
        if (this.patchMode && this.patchManager) {
          const baselineAggregate = this.checkpointManager.load(hearingId, 'aggregate', this.patchBaseline);

          if (baselineAggregate && Array.isArray(baselineAggregate)) {
            // LIGHT PATCH MODE: Skip aggregation for small patches (<1% of responses)
            // When patching only a few responses, reuse baseline position structure
            // and only update citation references for patched responses
            const totalResponses = fullResponses.length;
            const patchedCount = this.patchResponseIds.size;
            const patchRatio = patchedCount / totalResponses;
            const lightPatchThreshold = 0.01; // 1%

            if (patchRatio < lightPatchThreshold && !this.forceReaggregate) {
              console.log(`[Pipeline] 🚀 LIGHT PATCH: ${patchedCount} patched (${(patchRatio * 100).toFixed(2)}% of ${totalResponses}) - skipping aggregation`);
              this.jobTracker.logEvent(jobId, 'info',
                `[LIGHT PATCH] Skipping aggregation - ${patchedCount} responses (${(patchRatio * 100).toFixed(2)}%) below threshold`
              );

              // Update baseline aggregation with new micro-summaries for patched responses
              const updatedAggregate = this._updateAggregationWithPatchedMicroSummaries(
                baselineAggregate,
                artifacts.microSummaries,
                this.patchResponseIds
              );

              const totalPositions = updatedAggregate.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
              this.jobTracker.logEvent(jobId, 'info',
                `[LIGHT PATCH] Reused baseline aggregation with ${totalPositions} positions, updated ${patchedCount} response citations`
              );

              return updatedAggregate;
            }

            // Standard patch mode: selective theme re-aggregation
            if (this.forceReaggregate) {
              console.log(`[Pipeline] 🔧 PATCH: Force re-aggregate enabled, proceeding with full theme re-aggregation`);
            }

            // Get responseToThemes mapping from theme-mapping checkpoint
            const responseToThemes = artifacts.themes?.responseToThemes || {};

            // Calculate which themes are touched by patched responses
            const touchedThemes = this.patchManager.getTouchedThemes(this.patchResponseIds, responseToThemes);

            if (touchedThemes.size === 0) {
              // No themes touched - use baseline entirely
              this.jobTracker.logEvent(jobId, 'info', `[PATCH] No themes touched by patched responses, using baseline aggregate`);
              return baselineAggregate;
            }

            const allThemeNames = (artifacts.themes?.themes || []).map(t => t.name);
            const untouchedThemes = allThemeNames.filter(name => !touchedThemes.has(name));

            console.log(`[Pipeline] 🔧 PATCH: Re-aggregating ${touchedThemes.size} themes (${[...touchedThemes].join(', ')}), reusing ${untouchedThemes.length} from baseline`);
            this.jobTracker.logEvent(jobId, 'info',
              `[PATCH] Re-aggregating ${touchedThemes.size} touched themes, reusing ${untouchedThemes.length} from baseline`
            );

            // RAG setup
            if (artifacts.embeddedSubstance?.hasEmbeddings) {
              this.aggregator.setEmbeddedSubstance(
                artifacts.embeddedSubstance.items,
                this.substanceEmbedder
              );
            }

            // Filter theme mapping to only include touched themes
            const touchedThemesMapping = {
              ...artifacts.themes,
              themes: (artifacts.themes?.themes || []).filter(t => touchedThemes.has(t.name))
            };

            // Aggregate only touched themes
            const touchedAggregated = await this.aggregator.aggregate(
              touchedThemesMapping,
              artifacts.argumentEmbeddings || artifacts.embeddings,
              artifacts.loadData.materials,
              fullResponses
            );

            // Merge: use re-aggregated for touched themes, baseline for untouched
            const mergedAggregate = [];
            const touchedByName = new Map(touchedAggregated.map(t => [t.name, t]));

            // Add all themes in order, preferring touched results
            for (const baselineTheme of baselineAggregate) {
              if (touchedThemes.has(baselineTheme.name)) {
                // Use re-aggregated version
                const reAggregated = touchedByName.get(baselineTheme.name);
                if (reAggregated) {
                  mergedAggregate.push(reAggregated);
                }
              } else {
                // Use baseline version
                mergedAggregate.push(baselineTheme);
              }
            }

            // Add any new themes from re-aggregation not in baseline
            for (const reAggregatedTheme of touchedAggregated) {
              const existsInMerged = mergedAggregate.some(t => t.name === reAggregatedTheme.name);
              if (!existsInMerged) {
                mergedAggregate.push(reAggregatedTheme);
              }
            }

            const totalPositions = mergedAggregate.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
            this.jobTracker.logEvent(jobId, 'info',
              `[PATCH] Merged aggregate: ${mergedAggregate.length} themes with ${totalPositions} positions`
            );
            return mergedAggregate;
          }
        }

        // Pass feedback context to Aggregator if available
        if (this.feedbackContext) {
          this.aggregator.setFeedbackContext(this.feedbackContext);
        }

        // RAG: Configure Aggregator with embedded substance for theme-based retrieval
        if (artifacts.embeddedSubstance?.hasEmbeddings) {
          this.aggregator.setEmbeddedSubstance(
            artifacts.embeddedSubstance.items,
            this.substanceEmbedder
          );
        }

        // INCREMENTAL AGGREGATE: Load partial state if available (for crash recovery)
        // Check in both: 1) current run's checkpoints, 2) source checkpoint (if resuming)
        const currentPartialPath = this.runDirManager
          ? join(this.runDirManager.getCheckpointsDir(), 'partial-aggregate.json')
          : null;

        // Also check source checkpoint folder (for --checkpoint=crashedRun --resume=aggregate)
        const sourcePartialPath = this.sourceCheckpointLabel && this.checkpointManager
          ? join(this.checkpointManager.directoryFor(hearingId, this.sourceCheckpointLabel), 'partial-aggregate.json')
          : null;

        // Try source first (resuming from crashed run), then current (interrupted current run)
        let partialState = null;
        let partialStateSource = null;

        for (const [path, source] of [[sourcePartialPath, 'source checkpoint'], [currentPartialPath, 'current run']]) {
          if (path && existsSync(path)) {
            try {
              partialState = JSON.parse(readFileSync(path, 'utf-8'));
              partialStateSource = source;
              const completedCount = Object.keys(partialState.completedThemes || {}).length;
              console.log(`[Pipeline] 📦 Found partial aggregate state in ${source} with ${completedCount} completed themes`);
              break;
            } catch (loadErr) {
              console.warn(`[Pipeline] ⚠️ Could not load partial aggregate state from ${source}:`, loadErr.message);
            }
          }
        }

        if (partialState) {
          this.aggregator.loadPartialState(partialState);
        }

        // Setup incremental save callback (saves after each theme completes)
        if (currentPartialPath) {
          this.aggregator.setIncrementalSaveCallback(async (state) => {
            writeFileSync(currentPartialPath, JSON.stringify(state, null, 2));
          });
        }

        const aggregated = await this.aggregator.aggregate(
          artifacts.themes,
          artifacts.argumentEmbeddings || artifacts.embeddings, // Use argument embeddings if available, fallback to chunks
          artifacts.loadData.materials,
          fullResponses
        );
        const totalPositions = aggregated.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
        this.jobTracker.logEvent(jobId, 'info', `Aggregated ${aggregated.length} themes with ${totalPositions} positions`);
        return aggregated;
      }, jobId);

      // OPTIMIZATION: Prune embedding vectors after aggregation to save storage
      // Embeddings are only needed later for citation extraction (vector search)
      // We keep metadata but remove the heavy vector arrays
      const originalEmbeddingSize = JSON.stringify(artifacts.embeddings).length;
      artifacts.embeddings = artifacts.embeddings.map(chunk => ({
        ...chunk,
        embedding: null, // Remove 1536-dimension vector
        _embeddingPruned: true,
        _originalDimensions: chunk.embedding?.length || 0
      }));
      const prunedEmbeddingSize = JSON.stringify(artifacts.embeddings).length;
      const savedMB = ((originalEmbeddingSize - prunedEmbeddingSize) / 1024 / 1024).toFixed(2);
      this.jobTracker.logEvent(jobId, 'info', `Pruned embedding vectors: saved ${savedMB}MB (${((1 - prunedEmbeddingSize / originalEmbeddingSize) * 100).toFixed(1)}% reduction)`);

      // Step 8: Position Consolidation
      artifacts.consolidatedPositions = await this.step('consolidate-positions', async () => {
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);
        const positionCount = artifacts.aggregation.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
        const responseCount = fullResponses.length;
        const themeCount = artifacts.aggregation.length;

        // Recalculate parameters with ACTUAL position count
        const avgResponseLength = artifacts.dynamicParameters?._stats?.avgResponseLength || 100;
        const semanticDiversity = artifacts.dynamicParameters?._stats?.semanticDiversity || 0.5;
        
        // NEW: Extract object stats from micro-summaries for concentration calculation
        // This enables detection of mass-agreement cases like "Bevar Palads"
        const objectStats = DynamicParameterCalculator.extractObjectStatsFromMicroSummaries(
          artifacts.microSummaries || []
        );

        const recalculatedParams = DynamicParameterCalculator.getParametersForHearing({
          responseCount,
          chunkCount: artifacts.embeddings.length,
          avgResponseLength,
          semanticDiversity,
          positionCount, // ACTUAL count now
          themeCount,
          objectStats // NEW: Pass object stats for concentration analysis
        });

        this.dynamicParams = recalculatedParams; // Update stored params

        // NEW: Use crossThemeStrategy instead of boolean mergeAcrossThemes
        const crossThemeStrategy = recalculatedParams.consolidation?.crossThemeStrategy || 'none';
        const mergeAcrossThemes = recalculatedParams.consolidation?.mergeAcrossThemes || false; // Legacy fallback
        const threshold = recalculatedParams.consolidation?.similarityThreshold || 0.87;
        const enabled = recalculatedParams.consolidation?.enabled !== false;

        if (!enabled) {
          this.jobTracker.logEvent(jobId, 'info', 'Consolidation disabled by dynamic parameters, skipping');
          return artifacts.aggregation;
        }

        // Set dynamic threshold before consolidation
        // Use separate, higher threshold for cross-theme consolidation
        // NEW: Pass responseCount for adaptive thresholding on small hearings
        const crossThemeThreshold = DynamicParameterCalculator.getCrossThemeThreshold(threshold, responseCount);
        if (this.positionConsolidator.setDynamicThreshold) {
          this.positionConsolidator.setDynamicThreshold(threshold, crossThemeThreshold);
        }

        // Calculate and log argument-to-position explosion ratio
        const totalArguments = artifacts.themes.themes.reduce((sum, theme) => sum + (theme.arguments?.length || 0), 0);
        const explosionAnalysis = DynamicParameterCalculator.analyzeExplosionRatio(
          totalArguments,
          positionCount,
          threshold
        );

        this.jobTracker.logEvent(jobId, 'info',
          `Consolidation config: ${positionCount} positions from ${totalArguments} arguments (ratio=${(explosionAnalysis.ratio * 100).toFixed(1)}%), ` +
          `complexity=${recalculatedParams._complexity?.category}-${recalculatedParams._complexity?.subCategory}, ` +
          `strategy=${crossThemeStrategy}, threshold=${threshold.toFixed(3)}`
        );

        if (explosionAnalysis.suggestedAdjustment !== 0) {
          this.jobTracker.logEvent(jobId, 'info', explosionAnalysis.message);
        }

        // RAG: Configure Consolidator with embedded substance for context-aware merge validation
        if (artifacts.embeddedSubstance?.hasEmbeddings) {
          this.positionConsolidator.setEmbeddedSubstance(
            artifacts.embeddedSubstance.items,
            this.substanceEmbedder
          );

          // OPTIMIZATION: Pre-embed all position queries in ONE batch call
          // This prevents connection saturation from many parallel embedding requests
          const allPositions = artifacts.aggregation.flatMap(theme => 
            (theme.positions || []).map(pos => ({
              theme: theme.name,
              ...pos
            }))
          );

          if (allPositions.length > 0) {
            const queryItems = allPositions
              .filter(pos => pos.title)
              .map(pos => ({
                id: `${pos.theme}::${pos.title}`,
                text: `${pos.title} ${pos.summary || ''}`
              }));

            if (queryItems.length > 0) {
              this.jobTracker.logEvent(jobId, 'info',
                `Pre-embedding ${queryItems.length} position queries for RAG lookup...`
              );

              const preEmbeddedPositions = await this.substanceEmbedder.preEmbedQueries(queryItems);
              this.positionConsolidator.setPreEmbeddedPositions(preEmbeddedPositions);

              this.jobTracker.logEvent(jobId, 'info',
                `RAG mode: Pre-embedded ${preEmbeddedPositions.size}/${queryItems.length} positions`
              );
            }
          }
        }

        // NEW: Pass object concentration for same-object mega-merge detection
        const objectConcentration = recalculatedParams.objectConcentration;
        if (objectConcentration?.status !== 'NO_DATA') {
          this.jobTracker.logEvent(jobId, 'info',
            `Object concentration: ${(objectConcentration.concentration * 100).toFixed(1)}% (${objectConcentration.status})`
          );
          if (objectConcentration.dominantObjects?.length > 0) {
            const dominantStr = objectConcentration.dominantObjects
              .map(o => `${o.object} (${o.percentage}%)`)
              .join(', ');
            this.jobTracker.logEvent(jobId, 'info', `Dominant objects: ${dominantStr}`);
          }
        }

        const consolidated = await this.positionConsolidator.consolidate(
          artifacts.aggregation,
          {
            responseCount,
            positionCount,
            complexity: recalculatedParams._complexity?.subCategory
              ? `${recalculatedParams._complexity.category}-${recalculatedParams._complexity.subCategory}`
              : recalculatedParams._complexity?.category || 'unknown',
            // NEW: Pass object concentration for same-object mega-merge
            objectConcentration
          },
          crossThemeStrategy || (mergeAcrossThemes ? 'full' : 'none'), // Use new strategy, fallback to legacy
          fullResponses, // Pass enriched responses for breakdown recalculation
          artifacts.microSummaries // Pass micro-summaries for mega-position enrichment
        );

        const newPositionCount = consolidated.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
        const reduction = positionCount - newPositionCount;
        const reductionPercent = positionCount > 0 ? ((reduction / positionCount) * 100).toFixed(1) : '0.0';

        this.jobTracker.logEvent(jobId, 'info',
          `Consolidated: ${positionCount} → ${newPositionCount} positions (${reduction} merged, ${reductionPercent}% reduction)`
        );

        // Log consolidation metadata if available
        const totalCrossThemeRemoved = consolidated.reduce((sum, theme) =>
          sum + (theme._consolidationMeta?.crossThemeRemoved || 0), 0
        );
        if (totalCrossThemeRemoved > 0) {
          this.jobTracker.logEvent(jobId, 'info',
            `Cross-theme deduplication: removed ${totalCrossThemeRemoved} duplicate positions`
          );
        }

        // CRITICAL VALIDATION: Ensure no responses were lost during consolidation
        const preConsolidationResponses = new Set(
          artifacts.aggregation.flatMap(t => (t.positions || []).flatMap(p => p.responseNumbers || []))
        );
        const postConsolidationResponses = new Set(
          consolidated.flatMap(t => (t.positions || []).flatMap(p => p.responseNumbers || []))
        );

        if (preConsolidationResponses.size !== postConsolidationResponses.size) {
          const lost = [...preConsolidationResponses].filter(r => !postConsolidationResponses.has(r));
          this.jobTracker.logEvent(jobId, 'error',
            `🚨 CRITICAL: Consolidation lost ${lost.length} responses: ${lost.join(', ')}`
          );
          throw new Error(`CRITICAL: Consolidation lost ${lost.length} responses: ${lost.join(', ')}. This indicates a bug in consolidation logic!`);
        }

        this.jobTracker.logEvent(jobId, 'info',
          `✓ Response coverage validated: All ${preConsolidationResponses.size} responses preserved`
        );

        return consolidated;
      }, jobId);

      // Step 8a-new: Generate Titles (focused title generation for master-holdning)
      artifacts.titledPositions = await this.step('generate-titles', async () => {
        // Build microSummary lookup map
        const microSummaryMap = {};
        for (const micro of (artifacts.microSummaries || [])) {
          if (micro.responseNumber) {
            microSummaryMap[micro.responseNumber] = micro;
          }
        }

        // Generate focused titles for all positions
        // Include material context for sharper, grounded titles
        const withTitles = await this.positionTitleGenerator.generateTitles(
          artifacts.consolidatedPositions,
          microSummaryMap,
          {
            taxonomy: artifacts.taxonomy,
            materialSummary: artifacts.materialSummary,
            dynamicParams: this.dynamicParams
          }
        );

        // Count title changes
        let titlesChanged = 0;
        let totalPositions = 0;
        for (const theme of withTitles) {
          for (const pos of (theme.positions || [])) {
            totalPositions++;
            if (pos._titleSource === 'generated') {
              titlesChanged++;
            }
          }
        }

        this.jobTracker.logEvent(jobId, 'info',
          `Title generation: ${titlesChanged}/${totalPositions} positions received new focused titles`
        );

        return withTitles;
      }, jobId);

      // Step 8b: Sub-Position Extraction (extracts nuances from mega-positions)
      artifacts.subPositionExtracted = await this.step('extract-sub-positions', async () => {
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);

        // Build context for sub-position extraction
        const subPositionContext = {
          massAgreementDetected: artifacts.similarityAnalysis?.massAgreementDetected?.detected || false,
          massAgreementConfidence: artifacts.similarityAnalysis?.massAgreementDetected?.confidence || 0,
          objectConcentration: artifacts.dynamicParameters?.objectConcentration || null,
          diversityScore: artifacts.similarityAnalysis?.clusterAnalysis?.diversityScore || 0.5
        };

        // Extract sub-positions from titled positions (not consolidatedPositions)
        const withSubPositions = await this.subPositionExtractor.extractFromThemes(
          artifacts.titledPositions,
          artifacts.microSummaries,
          fullResponses,
          subPositionContext
        );

        // Count how many positions had sub-positions extracted
        let totalSubPositions = 0;
        let positionsWithSubs = 0;

        for (const theme of withSubPositions) {
          for (const position of (theme.positions || [])) {
            if (position.subPositions && position.subPositions.length > 0) {
              totalSubPositions += position.subPositions.length;
              positionsWithSubs++;
            }
          }
        }

        if (totalSubPositions > 0) {
          this.jobTracker.logEvent(jobId, 'info',
            `Sub-position extraction: ${totalSubPositions} sub-positions extracted from ${positionsWithSubs} mega-positions`
          );
        } else {
          this.jobTracker.logEvent(jobId, 'info',
            'Sub-position extraction: No mega-positions requiring extraction'
          );
        }

        return withSubPositions;
      }, jobId);

      // Step 8b: Hierarchical Position Grouping (NEW)
      artifacts.groupedPositions = await this.step('group-positions', async () => {
        // Set dynamic parameters for position grouper
        if (this.positionGrouper.setDynamicParameters && artifacts.dynamicParameters) {
          this.positionGrouper.setDynamicParameters(artifacts.dynamicParameters);
        }

        const grouped = await this.positionGrouper.groupPositions(artifacts.subPositionExtracted);

        const hierarchicalThemes = grouped.filter(t => t._hierarchical).length;
        if (hierarchicalThemes > 0) {
          this.jobTracker.logEvent(jobId, 'info',
            `Hierarchical grouping: ${hierarchicalThemes} themes with master/sub structure`
          );
        } else {
          this.jobTracker.logEvent(jobId, 'info',
            'Hierarchical grouping: No hierarchy created (flat structure maintained)'
          );
        }

        return grouped;
      }, jobId);

      // Step 9: Quality Validation
      artifacts.validatedPositions = await this.step('validate-positions', async () => {
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);
        const responseCount = fullResponses.length;
        const avgResponseLength = artifacts.dynamicParameters?._stats?.avgResponseLength || 100;
        const complexityObj = artifacts.dynamicParameters?._complexity || {};
        const complexity = complexityObj.subCategory
          ? `${complexityObj.category}-${complexityObj.subCategory}`
          : complexityObj.category || 'unknown';

        // Calculate explosion ratio for conditional validation
        const totalArguments = artifacts.themes?.themes?.reduce((sum, theme) => sum + (theme.arguments?.length || 0), 0) || 0;
        const currentPositionCount = artifacts.consolidatedPositions.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
        const explosionRatio = totalArguments > 0 ? currentPositionCount / totalArguments : 0;

        const validation = await this.positionQualityValidator.validate(
          artifacts.groupedPositions,
          { responseCount, avgResponseLength, complexity, complexityObj, explosionRatio }
        );

        // Log validation results
        if (validation.skipped) {
          this.jobTracker.logEvent(jobId, 'info', `Quality validation: SKIPPED - ${validation.skipReason}`);
          console.log(`[PositionQualityValidator] ⏩ SKIPPED: ${validation.skipReason}`);
        } else {
          const report = this.positionQualityValidator.formatReport(validation);
          this.jobTracker.logEvent(jobId, 'info', `Quality validation: ${validation.valid ? 'PASS' : 'ISSUES'} (${validation.issues?.length || 0} issues, ${validation.recommendations?.length || 0} recommendations)`);
          console.log(report);
        }

        // QUALITY FIX: STOP pipeline if mega-positions detected (>10 respondents)
        if (validation.megaPositionsDetected) {
          const criticalIssues = validation.issues.filter(i => i.severity === 'CRITICAL');
          console.error(`[Pipeline] 🚨 PIPELINE STOPPED: ${criticalIssues.length} mega-positions detected (>10 respondents per position)`);
          criticalIssues.forEach(issue => {
            console.error(`  - ${issue.theme} / ${issue.position}: ${issue.respondentCount} respondents`);
          });
          throw new Error(
            `PIPELINE QUALITY FAILURE: ${criticalIssues.length} positions have >10 respondents without sub-structure. ` +
            `This destroys all nuance and is unacceptable. ` +
            `The aggregation stage must create better sub-positions. ` +
            `Issues: ${criticalIssues.map(i => `${i.theme}/${i.position} (${i.respondentCount})`).join(', ')}`
          );
        }

        // Use validated/fixed positions if auto-fix is enabled, otherwise use grouped
        return validation.fixedThemes || artifacts.groupedPositions;
      }, jobId);

      // Step 9b: Sort Positions
      artifacts.sortedPositions = await this.step('sort-positions', async () => {
        const sorted = this.positionSorter.sortThemes(artifacts.validatedPositions);
        const totalPositions = sorted.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
        this.jobTracker.logEvent(jobId, 'info', `Sorted ${totalPositions} positions across ${sorted.length} themes`);
        
        // Update progress tracker with final position count
        if (this.progressTracker) {
          this.progressTracker.updateDataStats({
            positionCount: totalPositions
          });
        }
        
        return sorted;
      }, jobId);

      // Step 9c: Deduplicate Arguments
      // Identifies semantically similar arguments across positions and marks
      // secondary occurrences to prevent redundant explanations in output
      artifacts.deduplicatedPositions = await this.step('deduplicate-arguments', async () => {
        if (!this.argumentDeduplicator) {
          this.jobTracker.logEvent(jobId, 'info', 'Argument deduplicator not initialized, skipping');
          return artifacts.sortedPositions;
        }

        try {
          const deduplicated = await this.argumentDeduplicator.deduplicate(
            artifacts.sortedPositions,
            artifacts.microSummaries,
            {
              // Pass citation registry for argument matching
              citationRegistry: this.citationRegistry
            }
          );

          // Count deduplication results
          let secondaryCount = 0;
          let primaryCount = 0;
          for (const theme of deduplicated) {
            for (const position of (theme.positions || [])) {
              primaryCount += position._deduplication?.primaryArguments?.length || 0;
              secondaryCount += position._deduplication?.secondaryArguments?.length || 0;
            }
          }

          this.jobTracker.logEvent(jobId, 'info',
            `Argument deduplication: ${primaryCount} primary, ${secondaryCount} secondary`
          );

          return deduplicated;
        } catch (error) {
          this.jobTracker.logEvent(jobId, 'warn',
            `Argument deduplication failed: ${error.message}, using original positions`
          );
          console.warn('[Pipeline] Argument deduplication failed:', error.message);
          return artifacts.sortedPositions;
        }
      }, jobId);

      // PREVIEW MODE: Pause here for interactive editing
      if (this.previewMode) {
        console.log(`[Pipeline] 🔍 PREVIEW MODE: Pausing after sort-positions for interactive editing`);
        this.jobTracker.logEvent(jobId, 'info', 'Preview mode: Pipeline paused for interactive editing');

        // Save preview checkpoint
        if (this.checkpointManager && this.currentCheckpointLabel) {
          await this.checkpointManager.save(hearingId, '_preview-state', {
            sortedPositions: artifacts.sortedPositions,
            deduplicatedPositions: artifacts.deduplicatedPositions,
            microSummaries: artifacts.microSummaries,
            pausedAt: Date.now()
          }, this.currentCheckpointLabel);
        }

        // Return preview result
        return {
          status: 'preview',
          message: 'Pipeline paused for interactive editing',
          hearingId,
          label: this.currentCheckpointLabel,
          groupings: artifacts.deduplicatedPositions,
          responseCount: artifacts.loadData?.responses?.length || 0,
          positionCount: artifacts.deduplicatedPositions.reduce((sum, t) => sum + (t.positions?.length || 0), 0),
          themeCount: artifacts.deduplicatedPositions.length,
          resumeFrom: 'hybrid-position-writing'
        };
      }

      // Step 10: Hybrid Position Writing
      // PATCH: Only re-write positions that contain patched responses, merge with baseline
      artifacts.hybridPositions = await this.step('hybrid-position-writing', async () => {
        if (!this.positionWriter) {
          return artifacts.validatedPositions;
        }

        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);

        // PATCH MODE: Selective position re-writing
        if (this.patchMode && this.patchManager) {
          const baselineHybridPositions = this.checkpointManager.load(hearingId, 'hybrid-position-writing', this.patchBaseline);

          if (baselineHybridPositions && Array.isArray(baselineHybridPositions)) {
            // Calculate which positions are touched by patched responses
            const { touchedPositions, touchedCount, skippedCount } = this.patchManager.getTouchedPositions(
              this.patchResponseIds,
              artifacts.deduplicatedPositions
            );

            if (touchedCount === 0) {
              // No positions touched - use baseline entirely
              this.jobTracker.logEvent(jobId, 'info', `[PATCH] No positions contain patched responses, using baseline`);
              return baselineHybridPositions;
            }

            console.log(`[Pipeline] 🔧 PATCH: Re-writing ${touchedCount} positions, reusing ${skippedCount} from baseline`);
            this.jobTracker.logEvent(jobId, 'info',
              `[PATCH] Position writing: ${touchedCount} affected, ${skippedCount} unchanged`
            );

            // RAG setup
            if (artifacts.embeddedSubstance?.hasEmbeddings) {
              this.positionWriter.setEmbeddedSubstance(
                artifacts.embeddedSubstance.items,
                this.substanceEmbedder
              );
            }

            // Filter input to only include touched positions
            const touchedThemes = artifacts.deduplicatedPositions.map(theme => {
              const touchedInTheme = touchedPositions.get(theme.name);
              if (!touchedInTheme || touchedInTheme.size === 0) {
                // No positions touched in this theme
                return null;
              }

              return {
                ...theme,
                positions: (theme.positions || []).filter(pos => touchedInTheme.has(pos.title))
              };
            }).filter(t => t !== null && t.positions.length > 0);

            // Write only touched positions
            const touchedHybridPositions = await this.positionWriter.writePositions({
              aggregatedThemes: touchedThemes,
              microSummaries: artifacts.microSummaries,
              embeddings: artifacts.embeddings,
              rawResponses: fullResponses
            });

            // Merge: baseline positions + re-written positions
            const mergedHybridPositions = [];
            const touchedByThemeAndTitle = new Map();
            for (const theme of touchedHybridPositions) {
              for (const position of (theme.positions || [])) {
                const key = `${theme.name}::${position.title}`;
                touchedByThemeAndTitle.set(key, position);
              }
            }

            // Iterate over baseline themes, replacing touched positions
            for (const baselineTheme of baselineHybridPositions) {
              const mergedPositions = [];
              const touchedTitles = touchedPositions.get(baselineTheme.name) || new Set();

              for (const baselinePos of (baselineTheme.positions || [])) {
                if (touchedTitles.has(baselinePos.title)) {
                  // Use re-written position
                  const key = `${baselineTheme.name}::${baselinePos.title}`;
                  const rewritten = touchedByThemeAndTitle.get(key);
                  if (rewritten) {
                    mergedPositions.push(rewritten);
                  } else {
                    // Fallback to baseline if re-write didn't produce result
                    mergedPositions.push(baselinePos);
                  }
                } else {
                  // Use baseline position
                  mergedPositions.push(baselinePos);
                }
              }

              mergedHybridPositions.push({
                ...baselineTheme,
                positions: mergedPositions
              });
            }

            const totalPositions = mergedHybridPositions.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
            this.jobTracker.logEvent(jobId, 'info',
              `[PATCH] Merged ${totalPositions} positions (${touchedCount} re-written, ${skippedCount} from baseline)`
            );
            return mergedHybridPositions;
          }
        }

        // Pass feedback context to PositionWriter if available
        if (this.feedbackContext) {
          this.positionWriter.setFeedbackContext(this.feedbackContext);
        }

        // RAG: Configure PositionWriter with embedded substance for position-based retrieval
        if (artifacts.embeddedSubstance?.hasEmbeddings) {
          this.positionWriter.setEmbeddedSubstance(
            artifacts.embeddedSubstance.items,
            this.substanceEmbedder
          );
        }

        const hybridPositions = await this.positionWriter.writePositions({
          aggregatedThemes: artifacts.deduplicatedPositions,
          microSummaries: artifacts.microSummaries,
          embeddings: artifacts.embeddings,
          rawResponses: fullResponses // Use enriched responses
        });

        // Validate for duplicate REF_X references in summaries
        let totalDuplicateRefs = 0;
        let positionsWithDuplicates = 0;
        for (const theme of hybridPositions) {
          if (theme.positions && Array.isArray(theme.positions)) {
            for (const position of theme.positions) {
              if (position.summary && typeof position.summary === 'string') {
                const refs = position.summary.match(/<<REF_\d+>>/g) || [];
                const uniqueRefs = new Set(refs);
                if (refs.length !== uniqueRefs.size) {
                  const duplicateCount = refs.length - uniqueRefs.size;
                  totalDuplicateRefs += duplicateCount;
                  positionsWithDuplicates++;
                  console.warn(`[Pipeline] ⚠️  Position "${position.title}" has ${duplicateCount} duplicate REF_X in summary`);
                }
              }
            }
          }
        }

        if (totalDuplicateRefs > 0) {
          this.jobTracker.logEvent(jobId, 'warning',
            `Found ${totalDuplicateRefs} duplicate REF_X references in ${positionsWithDuplicates} positions (should have been auto-fixed by PositionWriter)`
          );
        } else {
          this.jobTracker.logEvent(jobId, 'info',
            `✓ No duplicate REF_X references found in position summaries`
          );
        }

        this.jobTracker.logEvent(jobId, 'info', `Generated hybrid outputs for ${hybridPositions.length} themes`);

        // Log prose proofreader stats
        if (this.proseProofreader) {
          this.proseProofreader.logStats();
          const proofStats = this.proseProofreader.getStats();
          this.jobTracker.logEvent(jobId, 'info',
            `[ProseProofreader] ${proofStats.proofread} proofread, ${proofStats.skipped} skipped, ${proofStats.fallbacks} fallbacks`
          );
        }

        return hybridPositions;
      }, jobId);

      // Step 10.0.5: Validate and repair grouping quality (NEW)
      // Catches: duplicate citations, redundant positions, micro-positions
      artifacts.groupingValidation = await this.step('validate-grouping-quality', async () => {
        const validator = new GroupingQualityValidator({
          autoRepair: this.config.validation?.autoRepairGrouping !== false,
          enabled: this.config.validation?.validateGroupingQuality !== false
        });

        const result = await validator.validate(artifacts.hybridPositions, {
          microSummaries: artifacts.microSummaries,
          responseCount: artifacts.loadData?.responses?.length || 0
        });

        // Log issues found
        if (result.issueCount > 0) {
          this.jobTracker.logEvent(jobId, 'warning',
            `[GroupingQuality] Found ${result.issueCount} grouping issues`
          );

          // Log by type
          const byType = {};
          result.issues.forEach(issue => {
            byType[issue.type] = (byType[issue.type] || 0) + 1;
          });
          Object.entries(byType).forEach(([type, count]) => {
            this.jobTracker.logEvent(jobId, 'info', `  - ${type}: ${count}`);
          });
        }

        // Log repairs applied
        if (result.repairs && result.repairs.length > 0) {
          this.jobTracker.logEvent(jobId, 'info',
            `[GroupingQuality] Applied ${result.repairs.length} auto-repairs`
          );
          result.repairs.forEach(repair => {
            this.jobTracker.logEvent(jobId, 'info', `  ✓ ${repair.action}: ${repair.description}`);
          });

          // Update hybridPositions with repaired themes
          if (result.themes) {
            artifacts.hybridPositions = result.themes;
          }
        }

        if (result.valid) {
          this.jobTracker.logEvent(jobId, 'info',
            `✓ Grouping quality validation passed`
          );
        }

        return result;
      }, jobId);

      // Step 10.1: Validate position writer output (simplified when using citation registry)
      if (this.citationRegistry) {
        // With citation registry, only validate structure and CriticMarkup (citations are already protected)
        artifacts.positionWriterValidation = await this.step('validate-writer-output', async () => {
          const allPositions = [];
          artifacts.hybridPositions.forEach(theme => {
            if (theme.positions && Array.isArray(theme.positions)) {
              allPositions.push(...theme.positions);
            }
          });

          // Only validate reference structure (not quote content)
          const refValidation = this.citationIntegrityValidator.validateHybridReferences(allPositions);

          if (!refValidation.valid) {
            this.jobTracker.logEvent(jobId, 'warning',
              `Reference structure issues: ${refValidation.issues.length} issues found`
            );
            refValidation.issues.slice(0, 5).forEach(issue => {
              this.jobTracker.logEvent(jobId, 'warning',
                `  - Position "${issue.position}": ${issue.type} - ${issue.message}`
              );
            });
          } else {
            this.jobTracker.logEvent(jobId, 'info',
              `✓ All position references valid (Citation Registry protecting quote integrity)`
            );
          }

          // NEW: Validate sub-position usage when available
          const subPosValidation = this.citationIntegrityValidator.validateSubPositionUsage(allPositions);
          
          if (subPosValidation.stats.positionsWithSubPositions > 0) {
            this.jobTracker.logEvent(jobId, 'info',
              `Sub-position utilization: ${subPosValidation.stats.subPositionUtilization} ` +
              `(${subPosValidation.stats.positionsWithMultipleRefs}/${subPosValidation.stats.positionsWithSubPositions} positions with multiple refs)`
            );
            
            if (subPosValidation.warnings.length > 0) {
              subPosValidation.warnings.forEach(warn => {
                this.jobTracker.logEvent(jobId, 'warning',
                  `⚠️ ${warn.position}: ${warn.message}`
                );
              });
            }
          }

          return { ...refValidation, subPositionValidation: subPosValidation };
        }, jobId);
      } else if (this.config.validation?.validateWriterOutput !== false) {
        // Original full validation when not using citation registry
        artifacts.positionWriterValidation = await this.step('validate-writer-output', async () => {
          const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);

          // Extract all positions from themes
          const allPositions = [];
          artifacts.hybridPositions.forEach(theme => {
            if (theme.positions && Array.isArray(theme.positions)) {
              allPositions.push(...theme.positions);
            }
          });

          // Validate quote integrity
          const quoteValidation = this.citationIntegrityValidator.validatePositionWriterQuotes(
            allPositions,
            artifacts.microSummaries,
            fullResponses
          );

          // Validate hybrid references structure
          const refValidation = this.citationIntegrityValidator.validateHybridReferences(allPositions);

          // Create combined report
          const report = this.citationIntegrityValidator.createValidationReport(
            artifacts.microSummaryValidation || { valid: true, stats: {}, issues: [] },
            quoteValidation,
            refValidation
          );

          if (!report.valid) {
            this.jobTracker.logEvent(jobId, 'warning',
              `⚠️  Position writer validation issues found`
            );

            // Log quote validation stats
            if (quoteValidation.stats.totalQuotesChecked > 0) {
              const accuracy = (quoteValidation.stats.accuracy * 100).toFixed(1);
              this.jobTracker.logEvent(jobId, 'info',
                `Quote integrity: ${accuracy}% accurate (${quoteValidation.stats.exactMatches}/${quoteValidation.stats.totalQuotesChecked} exact matches)`
              );

              if (quoteValidation.stats.modifiedQuotes > 0) {
                this.jobTracker.logEvent(jobId, 'warning',
                  `  - ${quoteValidation.stats.modifiedQuotes} quotes were modified from source`
                );
              }
              if (quoteValidation.stats.notFoundInSource > 0) {
                this.jobTracker.logEvent(jobId, 'error',
                  `  - ${quoteValidation.stats.notFoundInSource} quotes not found in source text!`
                );
              }
            }

            // Log reference structure issues
            if (refValidation.issues.length > 0) {
              this.jobTracker.logEvent(jobId, 'warning',
                `  - ${refValidation.issues.length} hybrid reference structure issues`
              );

              // Count issue types
              const issueCounts = {};
              refValidation.issues.forEach(issue => {
                issueCounts[issue.type] = (issueCounts[issue.type] || 0) + 1;
              });

              Object.entries(issueCounts).forEach(([type, count]) => {
                this.jobTracker.logEvent(jobId, 'warning', `    • ${type}: ${count}`);
              });
            }
          } else {
            this.jobTracker.logEvent(jobId, 'info',
              `✓ Position writer output validation passed`
            );
          }

          return report;
        }, jobId);
      }

      // Step 11: Validate citations (quotes should already be populated by PositionWriter from sourceQuotes)
      artifacts.citedPositions = await this.step('extract-citations', async () => {

        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);

        // Process themes in parallel (OPTIMIZED)
        let totalMissingQuotes = 0;
        let totalPopulatedQuotes = 0;

        const positionsWithCitations = await Promise.all(artifacts.hybridPositions.map(async (theme) => {

          // Process positions in parallel within theme (more controlled)
          const positions = await Promise.all(
            theme.positions.map(async (position) => {
              // Skip if no hybrid references
              if (!position.hybridReferences?.length) {
                return position;
              }

              // Process each hybrid reference sequentially to avoid overwhelming API
              const updatedReferences = [];
              for (const ref of position.hybridReferences) {

                // Check if quotes are already populated by PositionWriter (from sourceQuotes)
                // CRITICAL FIX: Also check for [MANGLER] placeholders which indicate the Writer failed to find the quote
                const hasQuotes = ref.quotes?.length > 0;
                const hasInvalidQuotes = hasQuotes && ref.quotes.some(q =>
                  !q.quote ||
                  q.quote.includes('[MANGLER') ||
                  q.quote.includes('sourceQuote ikke tilgængelig')
                );

                if (hasQuotes && !hasInvalidQuotes) {

                  // Resolve citation IDs to actual quote text if needed
                  const resolvedQuotes = ref.quotes.map(quoteObj => {
                    // Check if quote is a citation ID (starts with CITE_)
                    if (quoteObj.quote && quoteObj.quote.startsWith('CITE_')) {

                      // Search through all citations to find matching ID
                      const allCitations = Array.from(this.citationRegistry.citations.values());

                      const citation = allCitations.find(c => c.id === quoteObj.quote);

                      if (citation) {
                        return {
                          responseNumber: quoteObj.responseNumber,
                          quote: citation.quote
                        };
                      } else {
                        console.warn(`[Pipeline] Citation ID not found in registry: ${quoteObj.quote}`);
                        return quoteObj; // Keep original if not found
                      }
                    }
                    return quoteObj; // Already resolved
                  });

                  // Quotes already populated - excellent!
                  totalPopulatedQuotes += resolvedQuotes.length;
                  updatedReferences.push({ ...ref, quotes: resolvedQuotes });
                  continue;
                }

                // Skip if skipCitationExtraction flag is set (deliberately skipped by PositionWriter)
                if (ref.skipCitationExtraction) {
                  updatedReferences.push(ref);
                  continue;
                }

                // Skip if >15 respondents (should use notes instead)
                if (ref.respondents?.length > 15 || ref.notes) {
                  updatedReferences.push(ref);
                  continue;
                }

                // Quotes missing - this should rarely happen with new sourceQuote system
                console.warn(`[Pipeline] MISSING QUOTES for reference ${ref.id} (${ref.respondents?.length} respondents) in position "${position.title}"`);
                console.warn(`[Pipeline] This indicates PositionWriter did not populate quotes from sourceQuotes - check LLM output`);
                totalMissingQuotes += ref.respondents?.length || 0;

                // FALLBACK: Use old CitationExtractor (but log as warning - this should be rare)
                console.warn(`[Pipeline] Falling back to CitationExtractor for reference ${ref.id}...`);
                const quotes = await Promise.all(
                  (ref.respondents || []).map(async (responseNumber) => {
                    const response = fullResponses.find(r => r.id === responseNumber);
                    if (!response) {
                      return { responseNumber, quote: '[MANGLER - response ikke fundet]' };
                    }

                    try {
                      const result = await this.citationExtractor.extractCitation(
                        responseNumber,
                        position.summary,
                        response.text || '',
                        ref.label || '',
                        artifacts.embeddings
                      );

                      // Extract just the quote text (remove formatting added by extractor)
                      let quoteText = '[MANGLER - kunne ikke finde citat]';
                      if (result.found && result.citation) {
                        quoteText = result.citation
                          .replace(/\*\*Henvendelse \d+\*\*\s*\n?\s*\*?"?/gi, '')
                          .replace(/\*"?\s*$/g, '')
                          .trim();
                      }

                      return {
                        responseNumber,
                        quote: quoteText,
                        respondentName: response.respondentName?.trim() || null // CRITICAL: Include name for output formatting
                      };
                    } catch (error) {
                      console.warn(`[Pipeline] Citation extraction failed for response ${responseNumber}:`, error.message);
                      return { responseNumber, quote: '[MANGLER - extraction fejlede]', respondentName: response?.respondentName?.trim() || null };
                    }
                  })
                );

                updatedReferences.push({ ...ref, quotes });
              }

              return { ...position, hybridReferences: updatedReferences };
            })
          );

          return { ...theme, positions };
        }));

        const totalCitations = positionsWithCitations.reduce((sum, theme) =>
          sum + theme.positions.reduce((s, p) =>
            s + (p.hybridReferences?.reduce((c, r) => c + (r.quotes?.length || 0), 0) || 0), 0), 0);

        if (totalMissingQuotes > 0) {
          console.warn(`[Pipeline] WARNING: ${totalMissingQuotes} quotes required CitationExtractor fallback - check PositionWriter LLM output`);
        }

        this.jobTracker.logEvent(jobId, 'info', `Validated ${totalCitations} citations (${totalPopulatedQuotes} from sourceQuotes, ${totalMissingQuotes} from fallback)`);
        return positionsWithCitations;
      }, jobId);

      // Step 11a: Validate citation quality
      artifacts.citationValidation = await this.step('validate-citations', async () => {
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);

        // Create analysis result format for validator
        const analysisResult = {
          topics: artifacts.citedPositions,
          considerations: '' // Not needed for citation validation
        };

        // Validate citations
        const validationReport = this.citationValidator.validateAnalysis(analysisResult, fullResponses);

        // Log validation results prominently to terminal
        if (validationReport.valid) {
          console.log(`[Validate Citations] ✅ PASSED: ${validationReport.totalCitations} citations validated`);
          this.jobTracker.logEvent(jobId, 'info',
            `✓ Citation validation passed: ${validationReport.totalCitations} citations validated`
          );
        } else {
          // Print prominent error message
          console.error(`[Validate Citations] ❌ FAILED: ${validationReport.errors.length} errors, ${validationReport.warnings.length} warnings`);

          // Print all errors (not just first 3) since these are quality issues
          if (validationReport.errors.length > 0) {
            console.error(`[Validate Citations] Citation errors:`);
            validationReport.errors.forEach((error, i) => {
              console.error(`  ${i + 1}. ${error}`);
            });
          }

          // Print warning summary (not each individual warning)
          if (validationReport.warnings.length > 0) {
            console.warn(`[Validate Citations] ${validationReport.warnings.length} warnings (see run-summary.md for details)`);
          }

          this.jobTracker.logEvent(jobId, 'warning',
            `⚠️  Citation validation found issues: ${validationReport.errors.length} errors, ${validationReport.warnings.length} warnings`
          );

          // Log first few errors to job tracker
          validationReport.errors.slice(0, 3).forEach(error => {
            this.jobTracker.logEvent(jobId, 'warning', `  - ${error}`);
          });
        }

        return validationReport;
      }, jobId);

      // QUALITY GATE: Fail pipeline on citation hallucination
      // This catches cases where quotes were fabricated by LLM and don't exist in source
      if (artifacts.citationValidation?.stats?.nonExistentCitations > 0) {
        const hallucinationCount = artifacts.citationValidation.stats.nonExistentCitations;
        const errorMsg = `CRITICAL: ${hallucinationCount} citation hallucination(s) detected - quotes not found in source text`;

        // Log the specific hallucinated citations for debugging
        const hallucinationErrors = artifacts.citationValidation.errors
          .filter(e => e.includes('not found in response'));

        if (options.skipCitationGate) {
          // Continue with warning instead of failing
          console.warn(`\n[Pipeline] ⚠️ ${errorMsg}`);
          console.warn(`[Pipeline] --skip-citation-gate flag set, continuing despite citation validation failures.`);
          hallucinationErrors.slice(0, 5).forEach(err => {
            console.warn(`[Pipeline]   - ${err}`);
          });
          if (hallucinationErrors.length > 5) {
            console.warn(`[Pipeline]   ... and ${hallucinationErrors.length - 5} more`);
          }
          this.jobTracker.logEvent(jobId, 'warn', errorMsg);
        } else {
          console.error(`\n[Pipeline] ❌ ${errorMsg}`);
          console.error(`[Pipeline] This indicates LLM fabricated quotes that don't exist in the original responses.`);
          console.error(`[Pipeline] Review the citation errors above and fix the root cause.`);
          console.error(`[Pipeline] Use --skip-citation-gate to continue despite these errors.`);
          hallucinationErrors.slice(0, 5).forEach(err => {
            console.error(`[Pipeline]   - ${err}`);
          });
          if (hallucinationErrors.length > 5) {
            console.error(`[Pipeline]   ... and ${hallucinationErrors.length - 5} more`);
          }

          this.jobTracker.logEvent(jobId, 'error', errorMsg);
          throw new Error(errorMsg);
        }
      }

      // Step 11b: Validate respondent coverage
      artifacts.validatedCoverage = await this.step('validate-coverage', async () => {
        const fullResponses = this.getEnrichedResponses(artifacts.loadData.responses, artifacts.enrichedResponses);
        const validated = this.validateRespondentCoverage(
          artifacts.citedPositions,
          fullResponses
        );

        const missingCount = fullResponses.length -
          new Set(validated.flatMap(t => t.positions.flatMap(p => p.responseNumbers))).size;

        this.jobTracker.logEvent(jobId, 'info',
          missingCount > 0
            ? `Added ${missingCount} missing respondents to "Ingen holdning fundet"`
            : 'All respondents covered in analysis');

        return validated;
      }, jobId);

      // Step 12: Generate considerations
      artifacts.considerations = await this.step('considerations', async () => {
        // Generate analytical considerations
        const analyticalConsiderations = await this.considerationsGenerator.generateConsiderations({
          microSummaries: artifacts.microSummaries,
          themes: artifacts.themes,
          aggregation: artifacts.validatedCoverage
        });

        // Generate edge case considerations
        const edgeCaseText = await this.edgeCaseDetector.generateConsiderations(artifacts.edgeCases);

        // Combine considerations
        const sections = [];

        if (analyticalConsiderations && analyticalConsiderations.trim() &&
          analyticalConsiderations !== 'Analysen fulgte standardprocessen uden særlige analytiske dilemmaer.') {
          sections.push(`**Analytiske overvejelser**\n${analyticalConsiderations}`);
        }

        if (edgeCaseText && edgeCaseText.trim() && edgeCaseText !== 'Ingen signifikante edge cases.') {
          sections.push(edgeCaseText); // edgeCaseText already includes header
        }

        return sections.length > 0
          ? sections.join('\n\n')
          : 'Ingen særlige overvejelser.';
      }, jobId);

      // Step 13: Format output
      artifacts.output = await this.step('format-output', async () => {
        const result = {
          hearingId,
          title: artifacts.loadData.hearing?.title || `Høring ${hearingId}`,
          considerations: artifacts.considerations,
          topics: artifacts.validatedCoverage
        };

        // Format as markdown if needed
        const formatted = this.outputFormatter.formatForDocx(result);
        this.jobTracker.logEvent(jobId, 'info', `Formatted output: ${formatted.length} chars`);

        // Validate the formatted output
        const formatValidation = this.formatValidator.validateOutput(formatted, result);
        if (!formatValidation.valid) {
          this.jobTracker.logEvent(jobId, 'warning',
            `⚠️  Format validation found issues: ${formatValidation.errors.length} errors, ${formatValidation.warnings.length} warnings`
          );

          // Log first few errors
          formatValidation.errors.slice(0, 3).forEach(error => {
            this.jobTracker.logEvent(jobId, 'warning', `  - ${error}`);
          });

          // Apply additional normalization if needed
          if (formatValidation.stats.escapedCharacters > 0) {
            const { normalizeMarkdown } = await import('../utils/markdown-normalizer.js');
            const normalizedFormatted = normalizeMarkdown(formatted);
            this.jobTracker.logEvent(jobId, 'info', 'Applied additional markdown normalization');
            return {
              json: result,
              markdown: normalizedFormatted,
              formatValidation
            };
          }
        } else {
          this.jobTracker.logEvent(jobId, 'info',
            `✓ Format validation passed: ${formatValidation.stats.criticMarkupBlocks} CriticMarkup blocks`
          );
        }

        // Save formatted output if path provided (legacy mode)
        if (options.markdownPath) {
          const { writeFileSync } = await import('fs');
          writeFileSync(options.markdownPath, formatted, 'utf-8');
          this.jobTracker.logEvent(jobId, 'info', `Saved markdown to ${options.markdownPath}`);
        }

        // Save JSON and markdown to run directory
        if (this.runDirManager) {
          const { writeFileSync } = await import('fs');
          
          // Save JSON
          const jsonPath = this.runDirManager.getFinalJsonPath();
          writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
          this.jobTracker.logEvent(jobId, 'info', `Saved JSON to ${jsonPath}`);
          
          // Save markdown (with CriticMarkup for DOCX)
          const mdPath = this.runDirManager.getFinalMarkdownPath();
          writeFileSync(mdPath, formatted, 'utf-8');
          this.jobTracker.logEvent(jobId, 'info', `Saved markdown to ${mdPath}`);

          // Generate and save clean prose version (for LLM evaluation)
          const { CriticMarkupCleaner } = await import('../utils/criticmarkup-cleaner.js');
          const cleanFormatted = CriticMarkupCleaner.toCleanProse(formatted);
          const cleanMdPath = mdPath.replace('.md', '-clean.md');
          writeFileSync(cleanMdPath, cleanFormatted, 'utf-8');
          this.jobTracker.logEvent(jobId, 'info', `Saved clean prose to ${cleanMdPath}`);
        }

        return {
          json: result,
          markdown: formatted,
          formatValidation: formatValidation || null
        };
      }, jobId);

      // Step 14: Build DOCX
      artifacts.docxPath = await this.step('build-docx', async () => {
        const markdown = artifacts.output.markdown;

        // Normalize newline characters in CriticMarkup comments before DOCX conversion
        const normalizedMarkdown = normalizeMarkdownNewlines(markdown);

        // Determine output directory - use run directory if available
        const outputDir = this.runDirManager 
          ? this.runDirManager.getRunDir()
          : null;

        // Build DOCX file
        const docxPath = await this.docxBuilder.buildDocx(
          normalizedMarkdown,
          hearingId,
          outputDir,
          this.checkpointLabel
        );

        this.jobTracker.logEvent(jobId, 'info', `Generated DOCX: ${docxPath}`);
        return docxPath;
      }, jobId);

      // Generate debug report
      if (this.config.observability?.generateDebugReports) {
        await this.generateDebugReport(jobId, artifacts);
      }

      // Complete the final phase logging
      this._completeFinalPhase();

      this.jobTracker.updateJob(jobId, { status: 'completed', progress: 100 });
      this.jobTracker.logEvent(jobId, 'info', 'Pipeline completed successfully');

      // Save incremental metadata for future runs
      if (this.incrementalManager && this.saveCheckpoints) {
        this.incrementalManager.saveMetadata();
        const summary = this.incrementalManager.getSummary();
        this.jobTracker.logEvent(jobId, 'info', 
          `[INCREMENTAL] Metadata saved: ${summary.stats.totalResponses} responses tracked for future incremental runs`
        );
      }

      // Mark progress tracker as complete
      if (this.progressTracker) {
        this.progressTracker.complete();
      }

      return artifacts.output;
    } catch (error) {
      // Handle early stop gracefully (not an error)
      if (error.isEarlyStop) {
        console.log(`[Pipeline] ✅ Pipeline stopped early after "${error.stepName}" as requested`);
        this.jobTracker.updateJob(jobId, {
          status: 'completed',
          progress: 100
        });
        this.jobTracker.logEvent(jobId, 'info', `Pipeline stopped early after ${error.stepName}`, {
          stoppedAt: error.stepName,
          availableArtifacts: Object.keys(error.artifacts || {})
        });

        // Mark progress tracker as complete (early stop is successful completion)
        if (this.progressTracker) {
          this.progressTracker.complete();
        }

        // Return artifacts for workbench inspection
        if (options.returnArtifacts) {
          const returnArtifacts = error.artifacts || artifacts;
          returnArtifacts.lastExecutedStep = error.stepName;
          returnArtifacts.availableArtifacts = Object.keys(returnArtifacts);
          return returnArtifacts;
        }

        return error.artifacts?.output || null;
      }

      this.jobTracker.updateJob(jobId, {
        status: 'failed',
        error: error.message,
        progress: 100
      });
      this.jobTracker.logEvent(jobId, 'error', 'Pipeline failed', { error: error.message, stack: error.stack });

      // Mark progress tracker as failed
      if (this.progressTracker) {
        this.progressTracker.fail(error);
      }

      // Save error artifacts
      if (this.config.observability?.saveArtifacts) {
        this.jobTracker.saveArtifact(jobId, 'error', 'error', {
          message: error.message,
          stack: error.stack,
          artifacts: Object.keys(artifacts)
        });
      }

      throw error;
    }
  }

  /**
   * Set the current step name on all OpenAI clients for LLM call labeling
   * @param {string} stepName - The pipeline step name
   * @private
   */
  _setCurrentStepOnClients(stepName) {
    // All components that have OpenAI clients
    const componentsWithClients = [
      this.microSummarizer?.client,
      this.microSummarizer?.lightClient,
      this.microSummarizer?.heavyClient,
      this.themeMapper?.client,
      this.edgeCaseDetector?.client,
      this.materialSummarizer?.client,
      this.materialSummarizer?.lightClient,
      this.materialAnalyzer?.client,
      this.aggregator?.client,
      this.aggregator?.lightClient,
      this.positionConsolidator?.client,
      this.subPositionExtractor?.client,
      this.subPositionExtractor?.lightClient,
      this.positionGrouper?.client,
      this.positionQualityValidator?.client,
      this.citationExtractor?.client,
      this.substanceExtractor?.client,
      this.substanceExtractor?.lightClient,
      this.positionWriter?.promptRunner?.client,
      this.considerationsGenerator?.client,
      this.proseProofreader?.client
    ];

    for (const client of componentsWithClients) {
      if (client?.setCurrentStep) {
        client.setCurrentStep(stepName);
      }
    }
  }

  /**
   * Execute a pipeline step with artifact saving
   */
  async step(stepName, stepFn, jobId, options = {}) {
    const stepDisplayName = stepName.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Set current step on all OpenAI clients for LLM call labeling
    this._setCurrentStepOnClients(stepName);

    // Check if we should skip this step (resume mode)
    if (this.resumeFromIndex >= 0 && this.stepOrder) {
      const currentStepIndex = this.stepOrder.indexOf(stepName);
      if (currentStepIndex !== -1 && currentStepIndex < this.resumeFromIndex) {
        // This step was already completed and loaded from checkpoint
        const artifactKey = this.stepNameToArtifactKey(stepName);
        const artifact = this.artifacts[artifactKey];
        const skipMessage = formatSkipMessage(stepName, artifact, this.sourceCheckpointLabel || this.checkpointLabel);
        console.log(`\n[Pipeline] ${skipMessage}`);
        this.jobTracker.logEvent(jobId, 'info', `Skipped step (resume mode): ${stepName}`);

        // Track step for step log generator (even skipped steps)
        if (this.stepLogGenerator) {
          this.stepLogGenerator.startStep();
        }

        // Return the pre-loaded artifact (artifactKey and artifact already retrieved above)
        if (artifact === undefined) {
          console.warn(`[Pipeline] Warning: No checkpoint loaded for ${stepName}, but should have been`);
        }

        return artifact;
      }
    }

    // Check if we're starting a new phase
    const currentPhase = getPhaseForStep(stepName);
    if (currentPhase && (!this._currentPhase || this._currentPhase !== currentPhase)) {
      // Starting a new phase
      if (this._currentPhase && this._phaseStartTime) {
        // Complete the previous phase
        const phaseDuration = Date.now() - this._phaseStartTime;
        logPhaseComplete(this._currentPhase, phaseDuration, this._phaseSummary || {});
      }

      // Start the new phase
      this._currentPhase = currentPhase;
      this._phaseStartTime = Date.now();
      this._phaseSummary = {};

      const phaseConfig = PIPELINE_PHASES[currentPhase];
      if (phaseConfig) {
        logPhaseStart(currentPhase, phaseConfig.steps.length, phaseConfig.steps);
      }
    }

    const startTime = Date.now();
    console.log(`\n[Pipeline] ${stepDisplayName}...`);
    this.jobTracker.logEvent(jobId, 'info', `Starting step: ${stepName}`);

    // Track step for step log generator
    if (this.stepLogGenerator) {
      this.stepLogGenerator.startStep();
    }

    // Update progress tracker
    if (this.progressTracker) {
      this.progressTracker.startStep(stepName);
    }

    // Build input context from current artifacts for step logging
    const inputContext = this._buildStepInputContext(stepName);

    try {
      const result = await stepFn();
      const duration = Date.now() - startTime;
      const durationSec = (duration / 1000).toFixed(1);

      // Save to database (debug reports)
      if (this.config.observability?.saveArtifacts) {
        this.jobTracker.saveArtifact(jobId, stepName, 'output', {
          step: stepName,
          duration: duration,
          timestamp: new Date().toISOString(),
          result: this.sanitizeForStorage(result)
        });
      }

      // Save to filesystem checkpoints if enabled
      if (this.saveCheckpoints && this.checkpointLabel && this.currentHearingId) {
        this.checkpointManager.save(this.currentHearingId, stepName, result, this.checkpointLabel);
        console.log(`[Pipeline] 💾 Checkpoint saved: ${this.checkpointLabel}/${stepName}.json`);
      }

      // Generate step log markdown
      if (this.stepLogGenerator) {
        await this.stepLogGenerator.generateLog(stepName, inputContext, result, duration, {
          hearingId: this.currentHearingId,
          artifacts: this.artifacts
        });
        console.log(`[Pipeline] 📝 Step log saved: step-logs/${String(this.stepLogGenerator.stepNumber).padStart(2, '0')}-${stepName}.md`);
      }

      // Update progress tracker
      if (this.progressTracker) {
        this.progressTracker.completeStep(stepName, result);
      }

      // Update phase summary with step results
      if (this._phaseSummary) {
        this._updatePhaseSummary(stepName, result);
      }

      console.log(`[Pipeline] ✓ ${stepDisplayName} completed (${durationSec}s)`);
      this.jobTracker.logEvent(jobId, 'info', `Completed step: ${stepName}`, { duration });

      // Check if we should stop after this step (--stop-after / --step flag)
      if (this.stopAfterIndex >= 0 && this.stepOrder) {
        const currentStepIndex = this.stepOrder.indexOf(stepName);
        if (currentStepIndex === this.stopAfterIndex) {
          console.log(`\n[Pipeline] ⏹️  STOPPING: Reached target step "${stepName}"`);
          // Store the result in artifacts before throwing
          const artifactKey = this.stepNameToArtifactKey(stepName);
          this.artifacts[artifactKey] = result;
          throw new EarlyStopException(stepName, this.artifacts);
        }
      }

      return result;
    } catch (error) {
      // Re-throw EarlyStopException without logging as error
      if (error.isEarlyStop) {
        throw error;
      }

      const duration = Date.now() - startTime;
      console.error(`[Pipeline] ✗ ${stepDisplayName} failed after ${(duration / 1000).toFixed(1)}s:`, error.message);
      this.jobTracker.logEvent(jobId, 'error', `Step failed: ${stepName}`, { error: error.message, duration });

      // Log error to progress tracker
      if (this.progressTracker) {
        this.progressTracker.addError(error);
      }

      throw error;
    }
  }

  /**
   * Update phase summary with step results
   * @private
   */
  _updatePhaseSummary(stepName, result) {
    if (!this._phaseSummary) return;

    // Extract relevant metrics based on step
    switch (stepName) {
      case 'load-data':
        if (result) {
          this._phaseSummary.responses = result.responses?.length || 0;
          this._phaseSummary.materials = result.materials?.length || 0;
        }
        break;

      case 'chunking':
        if (Array.isArray(result)) {
          this._phaseSummary.chunks = result.length;
        }
        break;

      case 'embedding':
        if (Array.isArray(result)) {
          this._phaseSummary.embeddings = result.length;
        }
        break;

      case 'micro-summarize':
        if (Array.isArray(result)) {
          this._phaseSummary.microSummaries = result.length;
          this._phaseSummary.arguments = result.reduce((sum, s) => sum + (s.arguments?.length || 0), 0);
        }
        break;

      case 'theme-mapping':
        if (result?.themes) {
          this._phaseSummary.themes = result.themes.length;
        }
        break;

      case 'aggregate':
        if (Array.isArray(result)) {
          this._phaseSummary.themes = result.length;
          this._phaseSummary.positions = result.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
        }
        break;

      case 'sort-positions':
        if (Array.isArray(result)) {
          this._phaseSummary.sortedThemes = result.length;
          this._phaseSummary.sortedPositions = result.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
        }
        break;

      case 'hybrid-position-writing':
        if (Array.isArray(result)) {
          this._phaseSummary.writtenPositions = result.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
        }
        break;

      case 'format-output':
        if (typeof result === 'string') {
          this._phaseSummary.outputChars = result.length;
        }
        break;
    }
  }

  /**
   * Log final phase completion (called at end of pipeline)
   */
  _completeFinalPhase() {
    if (this._currentPhase && this._phaseStartTime) {
      const phaseDuration = Date.now() - this._phaseStartTime;
      logPhaseComplete(this._currentPhase, phaseDuration, this._phaseSummary || {});
      this._currentPhase = null;
      this._phaseStartTime = null;
      this._phaseSummary = null;
    }
  }

  /**
   * Build input context for step logging based on step name
   * @private
   */
  _buildStepInputContext(stepName) {
    const artifacts = this.artifacts || {};
    
    switch (stepName) {
      case 'load-data':
        return {};
      
      case 'material-summary':
        return { materials: artifacts.loadData?.materials };
      
      case 'analyze-material':
        return { 
          materials: artifacts.loadData?.materials,
          materialSummary: artifacts.materialSummary 
        };
      
      case 'extract-substance':
        return { 
          materials: artifacts.loadData?.materials,
          documentType: artifacts.taxonomy?.documentType
        };
      
      case 'edge-case-screening':
        return { 
          responses: artifacts.loadData?.responses,
          materialSummary: artifacts.materialSummaryLite || artifacts.materialSummary
        };
      
      case 'enrich-responses':
        return { 
          responses: artifacts.loadData?.responses,
          edgeCases: artifacts.edgeCases
        };
      
      case 'chunking':
        return { 
          responses: artifacts.loadData?.responses,
          materials: artifacts.loadData?.materials,
          enrichedResponses: artifacts.enrichedResponses
        };
      
      case 'embedding':
        return { chunks: artifacts.chunking };
      
      case 'micro-summarize':
        return { 
          responses: artifacts.loadData?.responses,
          materialContext: artifacts.materialSummaryLite || artifacts.materialSummary,
          taxonomy: artifacts.taxonomy,
          substance: artifacts.substance
        };
      
      case 'citation-registry':
        return { microSummaries: artifacts.microSummaries };
      
      case 'embed-arguments':
        return { microSummaries: artifacts.microSummaries };
      
      case 'similarity-analysis':
        return { 
          responses: artifacts.loadData?.responses,
          microSummaries: artifacts.microSummaries
        };
      
      case 'theme-mapping':
        return { 
          microSummaries: artifacts.microSummaries,
          materials: artifacts.loadData?.materials,
          taxonomy: artifacts.taxonomy
        };
      
      case 'aggregate':
        return { 
          themes: artifacts.themes,
          embeddings: artifacts.argumentEmbeddings || artifacts.embeddings,
          materials: artifacts.loadData?.materials
        };
      
      case 'consolidate-positions':
        return { 
          aggregation: artifacts.aggregation,
          dynamicParameters: artifacts.dynamicParameters
        };
      
      case 'extract-sub-positions':
        return { 
          positions: artifacts.consolidatedPositions,
          microSummaries: artifacts.microSummaries
        };
      
      case 'group-positions':
        return { positions: artifacts.subPositionExtracted };
      
      case 'validate-positions':
        return { positions: artifacts.groupedPositions };
      
      case 'sort-positions':
        return { positions: artifacts.validatedPositions };

      case 'deduplicate-arguments':
        return {
          positions: artifacts.sortedPositions,
          microSummaries: artifacts.microSummaries
        };

      case 'hybrid-position-writing':
        return {
          positions: artifacts.deduplicatedPositions,
          microSummaries: artifacts.microSummaries,
          embeddings: artifacts.embeddings
        };
      
      case 'validate-writer-output':
        return { hybridPositions: artifacts.hybridPositions };
      
      case 'extract-citations':
        return { hybridPositions: artifacts.hybridPositions };
      
      case 'validate-citations':
        return { citedPositions: artifacts.citedPositions };
      
      case 'validate-coverage':
        return { 
          citedPositions: artifacts.citedPositions,
          responses: artifacts.loadData?.responses
        };
      
      case 'considerations':
        return { 
          microSummaries: artifacts.microSummaries,
          themes: artifacts.themes,
          aggregation: artifacts.validatedCoverage
        };
      
      case 'format-output':
        return { 
          validatedCoverage: artifacts.validatedCoverage,
          considerations: artifacts.considerations
        };
      
      case 'build-docx':
        return { output: artifacts.output };
      
      default:
        return artifacts;
    }
  }

  /**
   * Sanitize data for storage (remove large embeddings, etc.)
   */
  sanitizeForStorage(data) {
    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeForStorage(item));
    }

    if (data && typeof data === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        if (key === 'embedding' && Array.isArray(value)) {
          sanitized[key] = `[${value.length} dimensions]`;
        } else if (key === 'content' && typeof value === 'string' && value.length > 1000) {
          sanitized[key] = value.slice(0, 1000) + '...';
        } else {
          sanitized[key] = this.sanitizeForStorage(value);
        }
      }
      return sanitized;
    }

    return data;
  }

  /**
   * Generate debug report
   */
  async generateDebugReport(jobId, artifacts) {
    const report = {
      jobId: jobId,
      timestamp: new Date().toISOString(),
      steps: Object.keys(artifacts),
      summary: {
        responses: artifacts.loadData?.responses?.length || 0,
        materials: artifacts.loadData?.materials?.length || 0,
        chunks: artifacts.chunking?.length || 0,
        embeddedChunks: artifacts.embeddings?.filter(c => c.hasEmbedding)?.length || 0,
        microSummaries: artifacts.microSummaries?.length || 0,
        themes: artifacts.themes?.themes?.length || 0,
        edgeCases: artifacts.edgeCases?.filter(ec => ec.category !== 'normal')?.length || 0
      },
      artifacts: {}
    };

    // Add artifact summaries
    Object.keys(artifacts).forEach(key => {
      const artifact = artifacts[key];
      if (Array.isArray(artifact)) {
        report.artifacts[key] = {
          type: 'array',
          length: artifact.length,
          sample: artifact.slice(0, 2)
        };
      } else if (artifact && typeof artifact === 'object') {
        report.artifacts[key] = {
          type: 'object',
          keys: Object.keys(artifact)
        };
      }
    });

    this.jobTracker.saveArtifact(jobId, 'debug-report', 'report', report);
  }

  /**
   * Validate that all respondents are covered in the final output
   * Adds missing respondents to "Andre emner" > "Ingen holdning fundet"
   */
  validateRespondentCoverage(themes, allResponses) {
    // Collect all response numbers that are already in positions
    const coveredResponseNumbers = new Set();
    themes.forEach(theme => {
      theme.positions?.forEach(position => {
        position.responseNumbers?.forEach(num => coveredResponseNumbers.add(num));
      });
    });

    // Find missing respondents
    const missingResponseNumbers = allResponses
      .map(r => r.id)
      .filter(id => !coveredResponseNumbers.has(id));

    if (missingResponseNumbers.length === 0) {
      // All respondents are covered
      return themes;
    }

    // Create or find "Andre emner" theme (not "Generelt" - that's for general substantive content)
    let andreEmnerTheme = themes.find(t => t.name === 'Andre emner');
    if (!andreEmnerTheme) {
      andreEmnerTheme = {
        name: 'Andre emner',
        positions: []
      };
      themes = [...themes, andreEmnerTheme];
    }

    // Create respondent breakdown for missing respondents
    const respondentBreakdown = {
      localCommittees: [],
      publicAuthorities: [],
      organizations: [],
      citizens: 0,
      total: missingResponseNumbers.length
    };

    missingResponseNumbers.forEach(responseNumber => {
      const response = allResponses.find(r => r.id === responseNumber);
      if (!response) {
        respondentBreakdown.citizens++;
        return;
      }

      const respondentType = (response.respondentType || '').toLowerCase();
      const respondentName = response.respondentName || '';

      if (respondentType.includes('lokaludvalg') || respondentName.toLowerCase().includes('lokaludvalg')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!respondentBreakdown.localCommittees.includes(name)) {
          respondentBreakdown.localCommittees.push(name);
        }
      } else if (respondentType.includes('organisation') ||
        (respondentName && !respondentType.includes('borger') &&
          !respondentType.includes('privat') && !respondentType.includes('myndighed'))) {
        if (respondentName && !respondentBreakdown.organizations.includes(respondentName)) {
          respondentBreakdown.organizations.push(respondentName);
        }
      } else if (respondentType.includes('myndighed') || respondentType.includes('forvaltning') ||
        respondentName.toLowerCase().includes('kommune') ||
        respondentName.toLowerCase().includes('ministerium')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!respondentBreakdown.publicAuthorities.includes(name)) {
          respondentBreakdown.publicAuthorities.push(name);
        }
      } else {
        respondentBreakdown.citizens++;
      }
    });

    // Generate citations for each missing respondent to document why they have no position
    // Returns { hybridReferences, confirmedCount, unconfirmedCount }
    const citationResult = this.generateNoOpinionCitations(missingResponseNumbers, allResponses);
    const { hybridReferences, confirmedCount, unconfirmedCount } = citationResult;

    // Build dynamic summary based on whether respondents explicitly stated no opinion
    let summary = this.buildNoOpinionSummary(
      missingResponseNumbers.length,
      confirmedCount,
      unconfirmedCount,
      hybridReferences,
      allResponses
    );

    // Add or update "Ingen holdning" position
    const existingPosition = andreEmnerTheme.positions.find(p =>
      p.title === 'Ingen holdning' || p.title.includes('Ingen holdning')
    );

    if (existingPosition) {
      // Merge with existing position
      existingPosition.responseNumbers = [
        ...new Set([...(existingPosition.responseNumbers || []), ...missingResponseNumbers])
      ].sort((a, b) => a - b);
      existingPosition.respondentBreakdown = respondentBreakdown;
      // Merge hybridReferences
      existingPosition.hybridReferences = [
        ...(existingPosition.hybridReferences || []),
        ...hybridReferences
      ];
      // Update summary with new references
      existingPosition.summary = summary;
    } else {
      // Create new position
      andreEmnerTheme.positions.push({
        title: 'Ingen holdning',
        responseNumbers: missingResponseNumbers.sort((a, b) => a - b),
        summary: summary,
        materialReferences: [],
        respondentBreakdown: respondentBreakdown,
        hybridReferences: hybridReferences,
        citations: []
      });
    }

    return themes;
  }

  /**
   * Build dynamic summary text for "no opinion" responses
   * Always lists each respondent individually with their citation (no 15-respondent limit)
   * @param {number} totalCount - Total number of responses without positions
   * @param {number} confirmedCount - Respondents who explicitly stated no opinion
   * @param {number} unconfirmedCount - Respondents where we couldn't identify a position
   * @param {Array} hybridReferences - References for citations
   * @param {Array} allResponses - All responses for name lookup
   * @returns {string} Dynamic summary text
   */
  buildNoOpinionSummary(totalCount, confirmedCount, unconfirmedCount, hybridReferences, allResponses) {
    // Build individual references for each respondent (always - no limit)
    const summaryParts = [];
    hybridReferences.forEach((ref) => {
      const response = allResponses.find(r => r.id === ref.respondents[0]);
      const responseNumber = ref.respondents[0];
      // Use "Henvendelse X" for unnamed/generic respondents (e.g. "Borger")
      const respondentName = this.getDisplayName(response?.respondentName, responseNumber);
      summaryParts.push(`${respondentName}<<${ref.id}>>`);
    });

    if (summaryParts.length === 0) {
      return 'Disse høringssvar indeholder ikke en identificerbar holdning til forslaget.';
    }

    // Dynamic intro based on confirmation status
    let intro;
    if (confirmedCount === totalCount) {
      intro = 'Følgende respondenter har tilkendegivet, at de ikke har bemærkninger:';
    } else if (unconfirmedCount === totalCount) {
      intro = 'Følgende høringssvar indeholder ikke en identificerbar holdning til forslaget:';
    } else {
      intro = 'Følgende høringssvar indeholder ingen holdning til forslaget:';
    }

    return `${intro} ${summaryParts.join(', ')}.`;
  }

  /**
   * Generate citations for "no opinion" responses to document why they have no position
   * Also tracks whether respondents explicitly stated no opinion vs we couldn't identify one
   * @param {Array<number>} responseNumbers - Response numbers without positions
   * @param {Array<Object>} allResponses - All responses with text content
   * @returns {Object} { hybridReferences, confirmedCount, unconfirmedCount }
   */
  generateNoOpinionCitations(responseNumbers, allResponses) {
    // Always generate individual quotes for each respondent (no limit)
    const MAX_QUOTE_LENGTH = 400; // Cap quote length to avoid bloated output

    // Patterns that indicate respondent explicitly stated "no opinion/comment"
    const explicitNoOpinionPatterns = [
      /vurderer[^.]*(?:ikke|ingen)[^.]*anledning til (?:bemærkninger?|kommentarer?)/i,
      /(?:har|indeholder) ingen (?:bemærkninger?|kommentarer?|holdning(?:er)?|indsigelser?)/i,
      /ingen (?:bemærkninger?|kommentarer?|holdning(?:er)?|indsigelser?) (?:hertil|til (?:forslaget|planen|lokalplanen))/i,
      /(?:ikke|ingen) anledning til (?:bemærkninger?|kommentarer?)/i,
      /tager[^.]*til efterretning/i,
      /(?:har ingen indvendinger mod|ingen indvendinger til) (?:forslaget|planen)/i,
      /(?:overordnet )?(?:ingen) (?:indvendinger|anledning)/i
    ];

    // Check each response for explicit "no opinion" pattern
    const checkExplicitNoOpinion = (text) => {
      if (!text) return false;
      return explicitNoOpinionPatterns.some(pattern => pattern.test(text));
    };

    // Generate individual quotes for each respondent
    const hybridReferences = [];
    let confirmedCount = 0;
    let unconfirmedCount = 0;

    responseNumbers.forEach((responseNumber, index) => {
      const response = allResponses.find(r => r.id === responseNumber);
      if (!response || !response.text) {
        unconfirmedCount++;
        return;
      }

      const text = response.text;
      let quote = null;
      let isConfirmed = false;

      // For short responses (< 500 chars), use the full text (but still cap it)
      if (text.length < 500) {
        quote = text.replace(/\s+/g, ' ').trim();
        isConfirmed = checkExplicitNoOpinion(text);
      } else {
        // For longer responses, find the relevant passage with a no-opinion pattern
        for (const pattern of explicitNoOpinionPatterns) {
          const match = text.match(pattern);
          if (match) {
            isConfirmed = true;
            // Extract ~200 chars around the match for context
            const matchIndex = match.index;
            const start = Math.max(0, matchIndex - 50);
            const end = Math.min(text.length, matchIndex + match[0].length + 150);
            
            // Find sentence boundaries
            let sentenceStart = start;
            let sentenceEnd = end;
            
            // Find start of sentence
            const beforeMatch = text.substring(0, matchIndex);
            const lastPeriod = Math.max(
              beforeMatch.lastIndexOf('. '),
              beforeMatch.lastIndexOf('.\n'),
              beforeMatch.lastIndexOf('\n\n')
            );
            if (lastPeriod > start - 100) {
              sentenceStart = lastPeriod + 2;
            }
            
            // Find end of sentence
            const afterMatch = text.substring(matchIndex);
            const nextPeriodMatch = afterMatch.match(/[.!?]\s/);
            if (nextPeriodMatch && nextPeriodMatch.index < 200) {
              sentenceEnd = matchIndex + nextPeriodMatch.index + 1;
            }
            
            quote = text.substring(sentenceStart, sentenceEnd).replace(/\s+/g, ' ').trim();
            break;
          }
        }

        // Fallback: use first ~300 chars if no pattern found
        if (!quote) {
          quote = text.substring(0, 300).replace(/\s+/g, ' ').trim();
          if (text.length > 300) quote += '...';
        }
      }

      // Track confirmation status
      if (isConfirmed) {
        confirmedCount++;
      } else {
        unconfirmedCount++;
      }

      // Apply character cap to avoid bloated output
      if (quote && quote.length > MAX_QUOTE_LENGTH) {
        quote = quote.substring(0, MAX_QUOTE_LENGTH).trim();
        // Try to cut at word boundary
        const lastSpace = quote.lastIndexOf(' ');
        if (lastSpace > MAX_QUOTE_LENGTH - 50) {
          quote = quote.substring(0, lastSpace);
        }
        quote += '...';
      }

      if (quote) {
        const respondentName = response.respondentName || null;
        // Use "Henvendelse X" for unnamed/generic respondents (e.g. "Borger")
        const displayName = this.getDisplayName(respondentName, responseNumber);
        
        hybridReferences.push({
          id: `REF_NO_OPINION_${index + 1}`,
          label: displayName,
          respondents: [responseNumber],
          quotes: [{
            responseNumber: responseNumber,
            respondentName: displayName,
            quote: quote
          }],
          notes: null,
          confirmed: isConfirmed  // Track whether this is explicitly confirmed
        });
      }
    });

    return { hybridReferences, confirmedCount, unconfirmedCount };
  }

  /**
   * Get display name for a respondent, using "Henvendelse X" for generic names
   * Generic names include: "Borger", "Organisation", "Offentlig myndighed", "Lokaludvalg", etc.
   * @param {string|null} respondentName - The respondent's name from data
   * @param {number} responseNumber - The response number (henvendelse nummer)
   * @returns {string} Display name to use in output
   */
  getDisplayName(respondentName, responseNumber) {
    // If no name, use fallback
    if (!respondentName || !respondentName.trim()) {
      return `Henvendelse ${responseNumber}`;
    }

    const name = respondentName.trim();
    const lowerName = name.toLowerCase();

    // List of generic names that should be replaced with "Henvendelse X"
    const genericNames = [
      'borger',
      'organisation',
      'offentlig myndighed',
      'lokaludvalg',
      'myndighed',
      'privat',
      'privatperson',
      'anonym',
      'ukendt'
    ];

    // Check if the name is generic (exact match, case-insensitive)
    if (genericNames.includes(lowerName)) {
      return `Henvendelse ${responseNumber}`;
    }

    // Use actual name if it's not generic
    return name;
  }

  /**
   * Calculate semantic diversity from embeddings
   * Returns 0-1 where 0 = all same, 1 = very diverse
   */
  calculateSemanticDiversity(embeddings) {
    if (embeddings.length < 2) return 0.5; // Default for single response

    // Sample max 20 embeddings for performance
    const sample = embeddings.slice(0, Math.min(20, embeddings.length));

    let totalSimilarity = 0;
    let pairCount = 0;

    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        if (!sample[i].embedding || !sample[j].embedding) continue;

        // Calculate cosine similarity
        let dotProduct = 0;
        let mag1 = 0;
        let mag2 = 0;

        for (let k = 0; k < sample[i].embedding.length; k++) {
          dotProduct += sample[i].embedding[k] * sample[j].embedding[k];
          mag1 += sample[i].embedding[k] * sample[i].embedding[k];
          mag2 += sample[j].embedding[k] * sample[j].embedding[k];
        }

        const similarity = dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
        totalSimilarity += similarity;
        pairCount++;
      }
    }

    if (pairCount === 0) return 0.5;

    const avgSimilarity = totalSimilarity / pairCount;
    // Convert similarity to diversity: high similarity = low diversity
    return 1 - avgSimilarity;
  }

  /**
   * Get embedding usage statistics for cost calculation
   * Uses global registry to capture ALL embedding usage across all components
   * @returns {Object} Usage stats from all embedders
   */
  getEmbeddingUsage() {
    // Use global registry to capture ALL embedding usage (not just BatchEmbedder)
    return embeddingRegistry.getGlobalUsage();
  }

  /**
   * Get run metadata for summary generation
   * Includes inherited steps information for baseline checkpoint tracking
   * @returns {Object} Run metadata
   */
  getRunMetadata() {
    const metadata = {
      sourceCheckpointLabel: this.sourceCheckpointLabel,
      checkpointLabel: this.checkpointLabel,
      resumedFromStep: null,
      inheritedSteps: []
    };

    // If we resumed from a specific step, calculate inherited steps
    if (this.resumeFromIndex >= 0 && this.stepOrder) {
      const resumeStep = this.stepOrder[this.resumeFromIndex];
      metadata.resumedFromStep = resumeStep;
      // All steps before the resume point were inherited from baseline
      metadata.inheritedSteps = this.stepOrder.slice(0, this.resumeFromIndex);
    }

    return metadata;
  }

  /**
   * Update aggregation with new micro-summaries for patched responses.
   * Used in Light Patch Mode to preserve baseline position structure while
   * updating citation references for patched responses.
   *
   * @param {Array} aggregation - Baseline aggregation (themes with positions)
   * @param {Array} microSummaries - Merged micro-summaries (including patched)
   * @param {Set<number>} patchedIds - Set of response IDs that were patched
   * @returns {Array} Updated aggregation with new citations for patched responses
   * @private
   */
  _updateAggregationWithPatchedMicroSummaries(aggregation, microSummaries, patchedIds) {
    // Build lookup for new micro-summaries (only patched responses)
    const microSummaryLookup = new Map();
    for (const ms of microSummaries) {
      if (patchedIds.has(ms.responseNumber)) {
        // Map responseNumber to all arguments from that response
        microSummaryLookup.set(ms.responseNumber, ms);
      }
    }

    // Deep clone aggregation to avoid mutating baseline
    const updated = JSON.parse(JSON.stringify(aggregation));
    let updatedCount = 0;

    // Update sourceArgumentRefs in each position for patched responses
    for (const theme of updated) {
      for (const position of (theme.positions || [])) {
        if (!position.sourceArgumentRefs) continue;

        for (let i = 0; i < position.sourceArgumentRefs.length; i++) {
          const argRef = position.sourceArgumentRefs[i];
          if (patchedIds.has(argRef.responseNumber)) {
            const newMs = microSummaryLookup.get(argRef.responseNumber);
            if (newMs && newMs.arguments?.length > 0) {
              // Find matching argument by position or use first argument
              // Note: We can't match by content since it may have changed,
              // so we preserve the structure and update citations
              const newArg = newMs.arguments[0]; // Primary argument

              // Update citation reference to use new citation
              if (newArg.sourceQuoteRef) {
                position.sourceArgumentRefs[i] = {
                  ...argRef,
                  sourceQuoteRef: newArg.sourceQuoteRef,
                  what: newArg.what || argRef.what
                };
                updatedCount++;
              }
            }
          }
        }
      }
    }

    console.log(`[Pipeline] 🚀 LIGHT PATCH: Updated ${updatedCount} argument references for ${patchedIds.size} patched responses`);

    return updated;
  }

  /**
   * Close all connections
   */
  close() {
    this.dataLoader.close();
    this.jobTracker.close();
  }
}


