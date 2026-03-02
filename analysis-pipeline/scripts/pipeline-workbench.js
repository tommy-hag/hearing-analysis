#!/usr/bin/env node
/**
 * Pipeline Workbench
 *
 * Lightweight CLI to execute a subset of the analysis pipeline using
 * checkpointed artifacts – intended to mimic an iterative "notebook"
 * workflow during development.
 *
 * Example usages:
 *   node scripts/pipeline-workbench.js 223 --step=theme-mapping --checkpoint=dev
 *   node scripts/pipeline-workbench.js 223 --from=chunking --to=micro-summarize --checkpoint=baseline --print
 *   node scripts/pipeline-workbench.js 223 --list --checkpoint=baseline
 *
 * Flags:
 *   --hearing / positional    Hearing ID
 *   --from / --resume         Step to resume from
 *   --to / --stop             Step to stop after executing
 *   --step                    Convenience for running a single step (sets both --from and --to)
 *   --checkpoint              Checkpoint label (default: "default")
 *   --list                    List available checkpointed steps for the hearing/label
 *   --save-checkpoints        Persist artifacts for executed steps
 *   --checkpoint-steps        Comma-separated list of steps to checkpoint
 *   --limit                   Limit number of responses (dev/testing)
 *   --use-checkpoint / --no-checkpoint  Force checkpoint usage on/off
 *   --artifact                Artifact step name/key to inspect (default: last executed step)
 *   --print                   Print selected artifact to stdout (JSON, pretty-printed)
 *   --output                  Write selected artifact JSON to provided path
 *   --summary-only            Skip artifact printing/writing, show summary only
 *   --help                    Show usage
 */

import { PipelineOrchestrator } from '../src/pipeline/pipeline-orchestrator.js';
import { CheckpointManager } from '../src/pipeline/checkpoint-manager.js';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function printUsage() {
  const steps = PipelineOrchestrator.getStepDefinitions().map(step => `  - ${step.name}`).join('\n');
  console.log(`
Pipeline Workbench
------------------
Interactive helper for running targeted portions of the hearing analysis pipeline.

Usage:
  node scripts/pipeline-workbench.js <hearingId> [options]

Key options:
  --from=<step> / --resume=<step>    Step to resume from (requires checkpointed artifacts for prior steps)
  --to=<step> / --stop=<step>        Step to stop after executing
  --step=<step>                      Run a single step (sets both --from and --to). Implies checkpoint usage.
  --checkpoint=<label>               Checkpoint label to read/write artifacts (default: "default")
  --list                             List available checkpoint steps for the hearing/label and exit
  --save-checkpoints                 Persist executed steps under the given checkpoint label
  --artifact=<step|key>              Artifact to inspect (defaults to last executed step)
  --print                            Print the selected artifact as JSON
  --output=<path>                    Write the selected artifact to JSON file
  --summary-only                     Only show summary metadata (skip artifact printing/writing)
  --limit=<n>                        Limit number of responses loaded (dev/testing)

Available steps:
${steps}
`);
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
      case 'print':
      case 'list':
      case 'summary-only':
        options[key] = value !== null ? value !== 'false' : true;
        break;
      case 'use-checkpoint':
        options[key] = value !== null ? value !== 'false' : true;
        break;
      case 'no-checkpoint':
        options['use-checkpoint'] = false;
        break;
      case 'help':
        options.help = true;
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

function normalizeCheckpointSteps(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map(step => step.trim())
    .filter(Boolean);
}

function resolveArtifactDescriptor(identifier, stepDefinitions) {
  if (!identifier) return null;

  const match = stepDefinitions.find(
    step => step.name === identifier || step.key === identifier
  );

  if (match) {
    return { stepName: match.name, key: match.key };
  }

  return { stepName: null, key: identifier };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const hearingArg = args.hearing ?? args.positional[0];
  if (!hearingArg) {
    printUsage();
    process.exit(1);
  }

  const hearingId = coerceInt(hearingArg, 'hearingId');
  const checkpointLabel = args.checkpoint ?? 'default';
  const stepDefinitions = PipelineOrchestrator.getStepDefinitions();
  const checkpointSteps = normalizeCheckpointSteps(args['checkpoint-steps']);
  const limitResponses = coerceInt(args.limit, 'limit');

  const manager = new CheckpointManager();

  if (args.list) {
    const available = manager.listAvailableSteps(hearingId, checkpointLabel);
    if (available.length === 0) {
      console.log(`No checkpointed steps found for hearing ${hearingId} (label: "${checkpointLabel}").`);
    } else {
      console.log(`Checkpointed steps for hearing ${hearingId} (label: "${checkpointLabel}"):\n- ${available.join('\n- ')}`);
    }
    process.exit(0);
  }

  let resumeFromStep = args.from ?? args.resume ?? null;
  let stopAfterStep = args.to ?? args.stop ?? null;

  if (args.step) {
    resumeFromStep = resumeFromStep ?? args.step;
    stopAfterStep = args.step;
  }

  const artifactDescriptor = resolveArtifactDescriptor(
    args.artifact ?? stopAfterStep ?? resumeFromStep,
    stepDefinitions
  );

  const orchestrator = new PipelineOrchestrator();
  const useCheckpoint =
    args['use-checkpoint'] !== undefined
      ? Boolean(args['use-checkpoint'])
      : (resumeFromStep ? true : false);

  try {
    const artifacts = await orchestrator.run(hearingId, {
      resumeFromStep,
      stopAfterStep,
      checkpointLabel,
      useCheckpoint,
      saveCheckpoints: Boolean(args['save-checkpoints']),
      checkpointSteps,
      limitResponses,
      returnArtifacts: true
    });

    const summary = {
      hearingId,
      checkpointLabel,
      resumeFromStep: resumeFromStep ?? 'load-data',
      stopAfterStep: stopAfterStep ?? 'format-output',
      lastExecutedStep: artifacts.lastExecutedStep ?? null,
      availableArtifacts: artifacts.availableArtifacts ?? Object.keys(artifacts),
      usedCheckpoint: useCheckpoint
    };

    console.log('Pipeline workbench run summary:');
    console.table([summary]);

    if (args['summary-only']) {
      return;
    }

    const targetArtifactKey = artifactDescriptor?.key;
    const artifactData = targetArtifactKey ? artifacts[targetArtifactKey] : undefined;

    if (!targetArtifactKey) {
      console.warn('No artifact identifier resolved. Use --artifact=<step|key> to select an artifact to inspect.');
      return;
    }

    if (artifactData === undefined) {
      console.warn(`Artifact "${targetArtifactKey}" is not available on this run.`);
      return;
    }

    if (args.print) {
      console.log(`\nArtifact "${targetArtifactKey}":`);
      console.log(JSON.stringify(artifactData, null, 2));
    }

    if (args.output) {
      const outputPath = resolve(args.output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(artifactData, null, 2), 'utf-8');
      console.log(`Artifact written to ${outputPath}`);
    }
  } catch (error) {
    console.error('Pipeline workbench failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    orchestrator.close();
  }
}

main();


