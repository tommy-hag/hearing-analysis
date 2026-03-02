#!/usr/bin/env node

/**
 * Flexible pipeline runner with checkpoint support.
 *
 * Examples:
 *   node scripts/run-pipeline.js 223 --save-checkpoints --checkpoint=baseline
 *   node scripts/run-pipeline.js --hearing=223 --resume=embedding --checkpoint=baseline --save-checkpoints --write
 *   node scripts/run-pipeline.js 223 --resume=aggregate --checkpoint=baseline --save-checkpoints --checkpoint-steps=aggregate,citations,quality-validation,considerations,format-output
 *
 * Checkpoint baseline feature (use source checkpoint as baseline for new test):
 *   node scripts/run-pipeline.js 223 --checkpoint=test01:test02 --resume=embedding --save-checkpoints
 *   This reads checkpoints from test01 and saves new checkpoints to test02.
 */

import { PipelineOrchestrator } from '../src/pipeline/pipeline-orchestrator.js';
import { RunDirectoryManager } from '../src/pipeline/run-directory-manager.js';
import { RunSummaryGenerator } from '../src/pipeline/run-summary-generator.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

/**
 * Setup terminal logging to capture all console output to a file
 * @param {string} logPath - Path to the log file
 * @returns {Function} Cleanup function to restore original console methods
 */
function setupTerminalLogging(logPath) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const writeToLog = (prefix, args) => {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logLine = `[${timestamp}] ${prefix} ${message}\n`;
    
    try {
      appendFileSync(logPath, logLine, 'utf-8');
    } catch (err) {
      // Silently fail if we can't write to log
    }
  };

  console.log = (...args) => {
    originalLog.apply(console, args);
    writeToLog('[INFO]', args);
  };

  console.warn = (...args) => {
    originalWarn.apply(console, args);
    writeToLog('[WARN]', args);
  };

  console.error = (...args) => {
    originalError.apply(console, args);
    writeToLog('[ERROR]', args);
  };

  // Write header to log file
  const header = `${'='.repeat(60)}\nPipeline Run Started: ${new Date().toISOString()}\n${'='.repeat(60)}\n\n`;
  try {
    writeFileSync(logPath, header, 'utf-8');
  } catch (err) {
    originalWarn('[run-pipeline] Could not create terminal log file:', err.message);
  }

  // Return cleanup function
  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

function parseArgs(argv) {
  const options = { positional: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      options.positional.push(arg);
      continue;
    }

    const [flag, value] = arg.includes('=') ? arg.split('=') : [arg, null];
    const key = flag.replace(/^--/, '');

    switch (key) {
      case 'save-checkpoints':
      case 'write':
      case 'use-checkpoint':
      case 'evaluate':
      case 'skip-citation-gate':
        options[key] = value !== null ? value !== 'false' : true;
        break;
      case 'no-checkpoint':
        options['use-checkpoint'] = false;
        break;
      default:
        if (value !== null) {
          options[key] = value;
        } else {
          const next = argv[i + 1];
          if (next && !next.startsWith('--')) {
            options[key] = next;
            i++;
          } else {
            options[key] = true;
          }
        }
        break;
    }
  }

  return options;
}

function coerceInt(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer for ${name}, received "${value}"`);
  }
  return parsed;
}

function loadJsonIfPath(value, description) {
  if (!value) return undefined;
  const resolved = resolve(value);
  const raw = readFileSync(resolved, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${description} at ${resolved}: ${error.message}`);
  }
}

async function runEvaluation(hearingId, checkpointLabel, runDir = null) {
  return new Promise((resolvePromise, reject) => {
    console.log('\n=== Running DeepEval Evaluation ===\n');
    
    // Check if venv exists and use it, otherwise try system python
    const pythonCmd = 'python3';
    
    // Determine script path
    // Try standard file first, then simplified
    let relativeScriptPath = `tests/evaluation/test_hearing_${hearingId}.py`;
    if (!existsSync(resolve(relativeScriptPath))) {
       relativeScriptPath = `tests/evaluation/test_hearing_${hearingId}_simplified.py`;
    }
    
    const scriptPath = resolve(relativeScriptPath);
    console.log(`Using evaluation script: ${scriptPath}`);
    
    const args = [scriptPath];
    
    // If run directory is provided, use it; otherwise fallback to old structure
    if (runDir) {
        args.push(runDir);
        console.log(`Using run directory: ${runDir}`);
    } else if (checkpointLabel) {
        // Legacy fallback for old checkpoint structure
        const checkpointPath = resolve(`output/checkpoints/${hearingId}/${checkpointLabel}`);
        args.push(checkpointPath);
        console.log(`Using checkpoint: ${checkpointPath}`);
    }
    
    const evalProcess = spawn(pythonCmd, args, {
      stdio: 'inherit',
      cwd: resolve('.'),
      env: { ...process.env }
    });

    evalProcess.on('close', (code) => {
      if (code === 0) {
        console.log('\n=== Evaluation Complete ===\n');
        resolvePromise();
      } else {
        console.warn(`\n=== Evaluation exited with code ${code} ===\n`);
        // Don't reject - evaluation failure shouldn't fail the whole pipeline
        resolvePromise();
      }
    });

    evalProcess.on('error', (error) => {
      console.warn('\n=== Evaluation Error ===');
      console.warn('Could not run evaluation script. Make sure Python environment is set up:');
      console.warn('  source venv/bin/activate');
      console.warn('  pip install -r requirements.txt');
      console.warn(`Error: ${error.message}\n`);
      // Don't reject - evaluation failure shouldn't fail the whole pipeline
      resolvePromise();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hearingArg = args.hearing ?? args.positional[0];

  if (!hearingArg) {
    console.error('Usage: node scripts/run-pipeline.js <hearingId> [options]');
    console.error('Options:');
    console.error('  --resume=<step>          Resume from specific step');
    console.error('  --checkpoint=<label>     Checkpoint label to use (or source:target for baseline)');
    console.error('  --save-checkpoints       Save step outputs');
    console.error('  --write                  Write final JSON/Markdown output');
    console.error('  --evaluate               Run DeepEval evaluation after completion');
    console.error('  --limit-responses=<n>    Limit number of responses to process');
    console.error('');
    console.error('Response filtering (for iterative testing):');
    console.error('  --response-ids=<ids>       Comma-separated list of specific response IDs');
    console.error('  --response-pattern=<regex> Filter responses by respondent name (regex)');
    console.error('  --sample-strategy=<type>   Sampling: random, diverse, representative');
    console.error('  --no-auto-name             Disable auto-generated timestamp suffix');
    console.error('  Note: Auto-naming (checkpoint_MMDD-HHMM) is ON by default to prevent overwrites');
    console.error('');
    console.error('Incremental mode (only process new/changed responses):');
    console.error('  --incremental=<baseline> Use baseline checkpoint, process only new/modified responses');
    console.error('  Example: --incremental=test04 --checkpoint=test05 --save-checkpoints --write');
    console.error('  This reuses materials, taxonomy, and unchanged responses from test04,');
    console.error('  only processing new responses, and saves results to test05.');
    console.error('');
    console.error('Patch mode (re-process specific respondents and merge with baseline):');
    console.error('  --patch-baseline=<label>     Patch mode: use baseline, re-process only specified responses');
    console.error('  --force-reaggregate          Force full re-aggregation even for small patches (<1%)');
    console.error('  Example: --patch-baseline=baseline --response-ids=6,7,42 --save-checkpoints --write');
    console.error('');
    console.error('Preview mode (for interactive editing):');
    console.error('  --preview                    Pause after sort-positions for interactive editing');
    console.error('  Example: --preview --checkpoint=baseline --save-checkpoints');
    console.error('  This re-processes responses 6,7,42, merges with baseline micro-summaries,');
    console.error('  re-aggregates only touched themes, and re-writes only affected positions.');
    console.error('  Note: For small patches (<1% of responses), aggregation is skipped automatically');
    console.error('  (Light Patch Mode). Use --force-reaggregate to override this behavior.');
    console.error('');
    console.error('Checkpoint baseline (use existing checkpoint as starting point):');
    console.error('  --checkpoint=source:target   Read from source, write to target');
    console.error('  Example: --checkpoint=test01:test02 --resume=embedding');
    console.error('');
    console.error('Material cache (reuse material analysis across different respondent scopes):');
    console.error('  --no-material-cache          Disable automatic material caching');
    console.error('  --material-baseline=<label>  Use materials from a specific run (overrides cache)');
    console.error('  --clear-material-cache       Clear material cache before running');
    console.error('  Note: Material cache stores taxonomy, substance, embeddings at hearing level.');
    console.error('  Example: First run with --limit-responses=10, second run with --limit-responses=50');
    console.error('  The second run will automatically reuse cached material analysis (~$0.35 saved).');
    process.exit(1);
  }

  const hearingId = coerceInt(hearingArg, 'hearingId');
  const resumeFromStep = args.resume ?? args['resume-from'] ?? null;
  
  // Parse checkpoint argument for source:target syntax
  const checkpointArg = args.checkpoint ?? 'default';
  let sourceCheckpointLabel = checkpointArg;
  let targetCheckpointLabel = checkpointArg;
  
  if (checkpointArg.includes(':')) {
    const parts = checkpointArg.split(':');
    if (parts.length === 2 && parts[0] && parts[1]) {
      sourceCheckpointLabel = parts[0];
      targetCheckpointLabel = parts[1];
    } else {
      console.error(`Invalid checkpoint format "${checkpointArg}". Use "source:target" or just "label".`);
      process.exit(1);
    }
  }
  
  // For backward compatibility, keep checkpointLabel as the target
  const checkpointLabel = targetCheckpointLabel;
  const useCheckpoint = args['use-checkpoint'] ?? (resumeFromStep ? true : false);
  const saveCheckpoints = Boolean(args['save-checkpoints']);
  const limitResponses = coerceInt(args.limit ?? args['limit-responses'], 'limit-responses');
  const checkpointSteps = args['checkpoint-steps']
    ? String(args['checkpoint-steps']).split(',').map(step => step.trim()).filter(Boolean)
    : null;
  const initialArtifacts = loadJsonIfPath(args['initial-artifacts'], 'initial artifacts JSON');
  
  // Incremental mode: reuse unchanged data from a baseline checkpoint
  const incrementalBaseline = args.incremental ?? null;
  const incrementalMode = Boolean(incrementalBaseline);

  // Patch mode: re-process specific respondents and merge with baseline
  // Requires --response-ids to specify which responses to patch
  const patchBaseline = args['patch-baseline'] ?? null;
  const patchMode = Boolean(patchBaseline);

  // Validate patch mode requirements
  if (patchMode && !args['response-ids']) {
    console.error('ERROR: --patch-baseline requires --response-ids to specify which responses to re-process');
    console.error('Example: --patch-baseline=baseline --response-ids=6,7,42');
    process.exit(1);
  }

  // Response filtering options (for iterative testing)
  const responseIds = args['response-ids']
    ? String(args['response-ids']).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !Number.isNaN(id))
    : null;
  const responsePattern = args['response-pattern'] ?? null;
  const sampleStrategy = args['sample-strategy'] ?? null;

  // Material cache options
  // Cache is enabled by default; --no-material-cache disables it
  const useMaterialCache = args['no-material-cache'] !== true;
  const clearMaterialCache = args['clear-material-cache'] === true;
  const materialBaseline = args['material-baseline'] ?? null;

  // Auto-generate checkpoint label suffix to prevent overwrites
  // Always enabled unless --no-auto-name is specified
  let finalCheckpointLabel = targetCheckpointLabel;
  const disableAutoName = args['no-auto-name'] === true;

  if (!disableAutoName) {
    const now = new Date();

    // YYYYMMDD-HHMM format (sorterer kronologisk)
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const time = now.toTimeString().slice(0, 5).replace(':', '');

    // 2-char random suffix (sikrer unikhed ved parallelle kørsler)
    const random = Math.random().toString(36).slice(2, 4);

    // Build: YYYYMMDD-HHMM-xx[-label]
    const baseName = targetCheckpointLabel !== 'default' ? targetCheckpointLabel : null;
    const parts = [`${date}-${time}-${random}`];
    if (baseName) parts.push(baseName);

    finalCheckpointLabel = parts.join('-');
    console.log(`Auto-generated run label: ${finalCheckpointLabel}`);
  }

  // Create run directory manager for consolidated output
  const runDirManager = new RunDirectoryManager({
    hearingId,
    label: finalCheckpointLabel
  });

  // Initialize directories if we're saving checkpoints or writing output
  let cleanupLogging = null;
  if (saveCheckpoints || args.write) {
    runDirManager.init();
    runDirManager.logPaths();
    
    // Setup terminal logging to capture all output
    cleanupLogging = setupTerminalLogging(runDirManager.getTerminalLogPath());
    console.log(`Terminal log: ${runDirManager.getTerminalLogPath()}`);
  }

  // Preview mode - pause after sort-positions for interactive editing
  const previewMode = Boolean(args.preview);

  const orchestrator = new PipelineOrchestrator({
    previewMode
  });

  try {
    console.log(`Running pipeline for hearing ${hearingId}...`);
    if (previewMode) {
      console.log('🔍 PREVIEW MODE: Will pause after sort-positions for interactive editing');
    }
    
    // Log mode information
    if (patchMode) {
      console.log(`🔧 PATCH MODE: Using "${patchBaseline}" as baseline`);
      console.log(`  → Re-processing ${responseIds.length} responses: ${responseIds.join(', ')}`);
      console.log(`  → Merging with baseline micro-summaries`);
      console.log(`  → Re-aggregating only touched themes`);
      console.log(`  → Re-writing only affected positions`);
      console.log(`  → Results will be saved to "${finalCheckpointLabel}"\n`);
    } else if (incrementalMode) {
      console.log(`🔄 INCREMENTAL MODE: Using "${incrementalBaseline}" as baseline`);
      console.log(`  → Only new/modified responses will be processed`);
      console.log(`  → Materials, taxonomy, and unchanged responses will be reused`);
      console.log(`  → Results will be saved to "${finalCheckpointLabel}"\n`);
    } else if (resumeFromStep) {
      if (sourceCheckpointLabel !== finalCheckpointLabel) {
        console.log(`→ Resuming from step "${resumeFromStep}"`);
        console.log(`  📥 Reading checkpoints from: "${sourceCheckpointLabel}"`);
        console.log(`  📤 Writing checkpoints to: "${finalCheckpointLabel}"`);
      } else {
        console.log(`→ Resuming from step "${resumeFromStep}" (checkpoint label: "${finalCheckpointLabel}")`);
      }
    }

    const result = await orchestrator.run(hearingId, {
      resumeFromStep,
      checkpointLabel: finalCheckpointLabel,
      sourceCheckpointLabel, // Source checkpoint for reading during resume
      useCheckpoint,
      saveCheckpoints,
      checkpointSteps,
      initialArtifacts,
      limitResponses,
      responseIds,         // Response filtering: specific IDs
      responsePattern,     // Response filtering: regex pattern
      sampleStrategy,      // Response filtering: sampling strategy
      runDirManager, // Pass run directory manager to orchestrator
      incrementalMode,
      incrementalBaseline,
      patchMode,
      patchBaseline,
      forceReaggregate: Boolean(args['force-reaggregate']),
      skipCitationGate: Boolean(args['skip-citation-gate']),
      // Material cache options
      useMaterialCache,
      clearMaterialCache,
      materialBaseline
    });

    // Handle preview mode result
    if (result.status === 'preview') {
      console.log('\n✅ Preview mode: Pipeline paused for interactive editing');
      console.log(`   Label: ${result.label}`);
      console.log(`   Responses: ${result.responseCount}`);
      console.log(`   Themes: ${result.themeCount}`);
      console.log(`   Positions: ${result.positionCount}`);
      console.log(`   Resume from: ${result.resumeFrom}`);
      console.log('\nUse /analysis.html to review and edit groupings.');
      console.log(`To continue: npm run pipeline:run -- ${hearingId} --checkpoint=${result.label} --resume=${result.resumeFrom} --save-checkpoints --write`);

      if (cleanupLogging) cleanupLogging();
      process.exit(0);
    }

    console.log('Pipeline completed successfully.');
    console.log(`Topics generated: ${result.json?.topics?.length || 0}`);

    if (args.write) {
      // Write output to consolidated run directory
      const jsonPath = runDirManager.getFinalJsonPath();
      const markdownPath = runDirManager.getFinalMarkdownPath();

      writeFileSync(jsonPath, JSON.stringify(result.json, null, 2), 'utf-8');
      writeFileSync(markdownPath, result.markdown, 'utf-8');

      console.log(`\nArtifacts written to run directory:\n- ${jsonPath}\n- ${markdownPath}`);
    }

    if (saveCheckpoints) {
      console.log(`Checkpoints saved in: ${runDirManager.getCheckpointsDir()}`);
    }

    // Run evaluation if requested
    if (args.evaluate) {
      await runEvaluation(hearingId, checkpointLabel, runDirManager.getRunDir());
    }

    // Generate run summary with LLM costs, embedding costs, and timing
    if (saveCheckpoints || args.write) {
      console.log('\n--- Generating Run Summary ---');

      // Get embedding usage and run metadata from orchestrator
      const embeddingUsage = orchestrator.getEmbeddingUsage();
      const runMetadata = orchestrator.getRunMetadata();

      const summaryGenerator = new RunSummaryGenerator({
        runDir: runDirManager.getRunDir(),
        hearingId,
        label: checkpointLabel,
        embeddingUsage,
        // Pass baseline/inherited information
        sourceCheckpointLabel: runMetadata.sourceCheckpointLabel,
        resumedFromStep: runMetadata.resumedFromStep,
        inheritedSteps: runMetadata.inheritedSteps
      });
      
      const { jsonPath, mdPath, summary } = await summaryGenerator.saveToFiles();
      
      // Print summary to console with clear quality gate status
      const gradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴', 'F': '⛔' }[summary.quality.grade] || '⚪';
      const hasQualityIssues = summary.quality.score < 80;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`PIPELINE COMPLETED`);
      console.log(`${'='.repeat(60)}`);

      // Process status (technical completion)
      console.log(`\nProcess Status: ✅ Completed`);
      console.log(`Duration: ${summary.timing.totalDurationFormatted || 'N/A'}`);
      console.log(`Data: ${summary.dataStats.summary}`);

      // Quality status (separate from process status)
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`QUALITY STATUS`);
      console.log(`${'─'.repeat(60)}`);
      console.log(`Quality Score: ${gradeEmoji} ${summary.quality.score}/100 (Grade: ${summary.quality.grade})`);

      // Show validation results prominently
      if (Object.keys(summary.validation).length > 0) {
        console.log(`\nValidation Results:`);
        const failedValidations = [];
        for (const [key, result] of Object.entries(summary.validation)) {
          const status = result.valid ? '✅ Pass' : '❌ FAIL';
          const details = [];
          if (result.errorCount > 0) details.push(`${result.errorCount} errors`);
          if (result.warningCount > 0) details.push(`${result.warningCount} warnings`);
          const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
          console.log(`  ${key}: ${status}${detailStr}`);
          if (!result.valid) {
            failedValidations.push(key);
          }
        }

        // Highlight failed validations
        if (failedValidations.length > 0) {
          console.log(`\n⚠️  QUALITY ISSUES DETECTED:`);
          console.log(`   Failed validations: ${failedValidations.join(', ')}`);
          console.log(`   Review required before using output`);
        }
      }

      // Show respondent coverage
      const coverage = summary.dataStats.respondentCoverage;
      if (coverage) {
        if (coverage.allRepresented) {
          console.log(`\nRespondent Coverage: ✅ All ${coverage.representedCount} respondents represented`);
        } else {
          console.log(`\nRespondent Coverage: ⚠️ ${coverage.representedCount}/${coverage.allResponseIds?.length || 0} respondents represented`);
          if (coverage.missingResponseIds?.length > 0) {
            console.log(`  Missing: ${coverage.missingResponseIds.slice(0, 10).join(', ')}${coverage.missingResponseIds.length > 10 ? ` (+${coverage.missingResponseIds.length - 10} more)` : ''}`);
          }
        }
        if (coverage.multiPositionCount > 0) {
          console.log(`  Multi-position respondents: ${coverage.multiPositionCount}`);
          const top3 = coverage.multiPositionRespondents?.slice(0, 3) || [];
          if (top3.length > 0) {
            const examples = top3.map(r => `#${r.responseId}(${r.positionCount})`).join(', ');
            console.log(`    Top: ${examples}`);
          }
        }
      }

      // Show deductions if quality score is less than A
      if (summary.quality.deductions?.length > 0 && summary.quality.score < 90) {
        console.log(`\nScore Deductions:`);
        for (const d of summary.quality.deductions) {
          console.log(`  - ${d.reason}: -${d.deduction} points`);
        }
      }

      // Cost summary
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`COST SUMMARY`);
      console.log(`${'─'.repeat(60)}`);
      console.log(`LLM Calls: ${summary.usage.totals.calls}`);
      console.log(`Total Tokens: ${(summary.usage.totals.totalTokens + (summary.usage.totals.embeddingTokens || 0)).toLocaleString()}`);
      console.log(`This Run Cost: ${summary.usage.totals.totalCostFormatted} (LLM: ${summary.usage.totals.llmCostFormatted}, Embeddings: ${summary.usage.totals.embeddingCostFormatted})`);

      // Show inherited costs if using baseline checkpoint
      if (summary.usage.inherited) {
        const inherited = summary.usage.inherited;
        console.log(`\nInherited from Baseline (${inherited.sourceLabel}):`);
        console.log(`  Steps: ${inherited.stepCount} (${inherited.steps.slice(0, 3).join(', ')}${inherited.steps.length > 3 ? '...' : ''})`);
        console.log(`  Inherited Cost: ${inherited.totalCostFormatted}`);
        if (summary.usage.combined) {
          console.log(`\n  *** Combined Total: ${summary.usage.combined.totalCostFormatted} ***`);
        }
      }

      if (summary.usage.byModel?.length > 0) {
        console.log('\nCost by Model:');
        for (const m of summary.usage.byModel) {
          console.log(`  ${m.model}: ${m.costFormatted} (${m.calls} calls, ${m.totalTokens.toLocaleString()} tokens)`);
        }
        if (summary.usage.embedding) {
          console.log(`  ${summary.usage.embedding.model}: ${summary.usage.embedding.costFormatted} (${summary.usage.embedding.tokens.toLocaleString()} tokens)`);
        }
      }

      console.log(`\nSummary saved to:`);
      console.log(`  - ${mdPath}`);
    }

    // Write success footer to log
    if (cleanupLogging) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Pipeline Run Completed Successfully: ${new Date().toISOString()}`);
      console.log(`${'='.repeat(60)}`);
      cleanupLogging();
    }

    process.exit(0);
  } catch (error) {
    console.error('Pipeline run failed:', error.message);
    if (process.env.VERBOSE) {
      console.error(error);
    }
    
    // Write failure footer to log
    if (cleanupLogging) {
      console.error(`\n${'='.repeat(60)}`);
      console.error(`Pipeline Run FAILED: ${new Date().toISOString()}`);
      console.error(`Error: ${error.message}`);
      console.error(`${'='.repeat(60)}`);
      cleanupLogging();
    }
    
    process.exit(1);
  } finally {
    orchestrator.close();
  }
}

main();


