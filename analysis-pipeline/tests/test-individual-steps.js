#!/usr/bin/env node

/**
 * Test Individual Pipeline Steps
 * 
 * Allows testing specific pipeline steps using checkpoints
 * 
 * Usage:
 *   node tests/test-individual-steps.js <hearingId> <step> [checkpoint-label]
 * 
 * Examples:
 *   node tests/test-individual-steps.js 168 material-summary optimized
 *   node tests/test-individual-steps.js 168 edge-case-screening optimized
 *   node tests/test-individual-steps.js 168 micro-summarize optimized
 */

import { CheckpointManager } from '../src/pipeline/checkpoint-manager.js';
import { MaterialSummarizer } from '../src/utils/material-summarizer.js';
import { EdgeCaseDetector } from '../src/analysis/edge-case-detector.js';
// ResponseEnricher removed
import { MicroSummarizer } from '../src/analysis/micro-summarizer.js';

import { ThemeMapper } from '../src/analysis/theme-mapper.js';
import { PositionConsolidator } from '../src/analysis/position-consolidator.js';
import { PositionWriter } from '../src/analysis/position-writer.js';

const [, , hearingIdArg, stepName, checkpointLabel = 'default'] = process.argv;

if (!hearingIdArg || !stepName) {
  console.error('Usage: node tests/test-individual-steps.js <hearingId> <step> [checkpoint-label]');
  console.error('\nAvailable steps:');
  console.error('  - material-summary');
  console.error('  - edge-case-screening');
  console.error('  - micro-summarize');
  console.error('  - theme-mapping');
  console.error('  - aggregate');
  console.error('  - consolidate-positions');
  console.error('  - hybrid-position-writing');
  process.exit(1);
}

const hearingId = parseInt(hearingIdArg, 10);
const checkpointManager = new CheckpointManager();

async function testStep() {
  console.log(`\n=== Testing Step: ${stepName} ===`);
  console.log(`Hearing: ${hearingId}`);
  console.log(`Checkpoint Label: ${checkpointLabel}\n`);

  // List available checkpoints
  const available = checkpointManager.listAvailableSteps(hearingId, checkpointLabel);
  console.log(`Available checkpoints: ${available.join(', ')}\n`);

  try {
    switch (stepName) {
      case 'material-summary':
        await testMaterialSummary();
        break;
      case 'edge-case-screening':
        await testEdgeCaseScreening();
        break;
      // enrich-responses removed (inline in pipeline)
      case 'micro-summarize':
        await testMicroSummarize();
        break;
      case 'theme-mapping':
        await testThemeMapping();
        break;
      case 'aggregate':
        await testAggregate();
        break;
      case 'consolidate-positions':
        await testConsolidatePositions();
        break;
      case 'hybrid-position-writing':
        await testHybridPositionWriting();
        break;
      default:
        console.error(`Unknown step: ${stepName}`);
        process.exit(1);
    }

    console.log('\n✅ Step test completed successfully!');
  } catch (error) {
    console.error('\n❌ Step test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

async function testMicroSummarize() {
  const enrichedResponses = checkpointManager.load(hearingId, 'enrich-responses', checkpointLabel);
  const materials = checkpointManager.load(hearingId, 'load-data', checkpointLabel)?.materials;
  if (!enrichedResponses) throw new Error('enrich-responses checkpoint not found');

  console.log(`Enriched responses: ${enrichedResponses?.length || 0}`);
  console.log(`Materials: ${materials?.length || 0}\n`);

  const summarizer = new MicroSummarizer();
  const startTime = Date.now();
  const summaries = await summarizer.summarizeBatch(enrichedResponses, materials, enrichedResponses);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const stats = {
    total: summaries.length,
    analyzable: summaries.filter(s => s.analyzable).length,
    totalArguments: summaries.reduce((sum, s) => sum + (s.arguments?.length || 0), 0)
  };

  console.log('Micro summary stats:');
  console.log(`  Total: ${stats.total}`);
  console.log(`  Analyzable: ${stats.analyzable}`);
  console.log(`  Total arguments: ${stats.totalArguments}`);
  console.log(`  Avg arguments per response: ${(stats.totalArguments / stats.total).toFixed(1)}`);
  console.log(`\nDuration: ${duration}s`);

  checkpointManager.save(hearingId, 'micro-summarize', summaries, `${checkpointLabel}-test`);
  console.log(`\nSaved to: checkpoints/${hearingId}/${checkpointLabel}-test/micro-summarize.json`);
}

async function testThemeMapping() {
  const microSummaries = checkpointManager.load(hearingId, 'micro-summarize', checkpointLabel);
  const materials = checkpointManager.load(hearingId, 'load-data', checkpointLabel)?.materials;
  if (!microSummaries) throw new Error('micro-summarize checkpoint not found');

  console.log(`Micro summaries: ${microSummaries?.length || 0}`);
  console.log(`Materials: ${materials?.length || 0}\n`);

  const mapper = new ThemeMapper();
  const startTime = Date.now();
  const mapping = await mapper.mapToThemes(microSummaries, materials);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('Theme mapping stats:');
  console.log(`  Themes: ${mapping.themes?.length || 0}`);
  mapping.themes?.forEach(theme => {
    console.log(`    - ${theme.name}: ${theme.arguments?.length || 0} arguments`);
  });
  console.log(`\nDuration: ${duration}s`);

  checkpointManager.save(hearingId, 'theme-mapping', mapping, `${checkpointLabel}-test`);
  console.log(`\nSaved to: checkpoints/${hearingId}/${checkpointLabel}-test/theme-mapping.json`);
}

async function testAggregate() {
  console.log('Note: Aggregate requires embeddings - use full pipeline or provide embeddings checkpoint');
  // Implementation would require full context
}

async function testConsolidatePositions() {
  const aggregation = checkpointManager.load(hearingId, 'aggregate', checkpointLabel);
  const enrichedResponses = checkpointManager.load(hearingId, 'enrich-responses', checkpointLabel);
  if (!aggregation) throw new Error('aggregate checkpoint not found');

  console.log(`Themes: ${aggregation?.length || 0}`);
  const totalPositions = aggregation.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
  console.log(`Total positions before: ${totalPositions}\n`);

  const consolidator = new PositionConsolidator();
  consolidator.setDynamicThreshold(0.72);

  const startTime = Date.now();
  const consolidated = await consolidator.consolidate(
    aggregation,
    {
      responseCount: enrichedResponses?.length || 24,
      positionCount: totalPositions,
      complexity: 'complex'
    },
    false, // mergeAcrossThemes
    enrichedResponses || []
  );
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const newTotal = consolidated.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
  console.log(`Total positions after: ${newTotal}`);
  console.log(`Merged: ${totalPositions - newTotal} (${((totalPositions - newTotal) / totalPositions * 100).toFixed(1)}%)`);
  console.log(`\nDuration: ${duration}s`);

  checkpointManager.save(hearingId, 'consolidate-positions', consolidated, `${checkpointLabel}-test`);
  console.log(`\nSaved to: checkpoints/${hearingId}/${checkpointLabel}-test/consolidate-positions.json`);
}

async function testHybridPositionWriting() {
  const validatedPositions = checkpointManager.load(hearingId, 'validate-positions', checkpointLabel);
  const microSummaries = checkpointManager.load(hearingId, 'micro-summarize', checkpointLabel);
  const embeddings = checkpointManager.load(hearingId, 'embedding', checkpointLabel);
  const enrichedResponses = checkpointManager.load(hearingId, 'enrich-responses', checkpointLabel);

  if (!validatedPositions) throw new Error('validate-positions checkpoint not found');
  if (!microSummaries) throw new Error('micro-summarize checkpoint not found');
  if (!embeddings) throw new Error('embedding checkpoint not found');
  if (!enrichedResponses) throw new Error('enrich-responses checkpoint not found');

  const totalPositions = validatedPositions.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
  console.log(`Processing ${totalPositions} positions\n`);

  const writer = new PositionWriter();
  const startTime = Date.now();
  const hybrid = await writer.writePositions({
    aggregatedThemes: validatedPositions,
    microSummaries,
    embeddings,
    rawResponses: enrichedResponses
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`Generated hybrid outputs for ${hybrid.length} themes`);
  console.log(`\nDuration: ${duration}s`);
  console.log(`Avg per position: ${(duration / totalPositions).toFixed(1)}s`);

  checkpointManager.save(hearingId, 'hybrid-position-writing', hybrid, `${checkpointLabel}-test`);
  console.log(`\nSaved to: checkpoints/${hearingId}/${checkpointLabel}-test/hybrid-position-writing.json`);
}

testStep();

