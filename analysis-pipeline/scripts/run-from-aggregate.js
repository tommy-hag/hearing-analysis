/**
 * Run pipeline from existing aggregate.json checkpoint
 * Skips aggregation step and runs: consolidation → validation → hybrid-writing → output
 */

import { readFileSync, writeFileSync } from 'fs';
import { PositionConsolidator } from '../src/analysis/position-consolidator.js';
import { PositionQualityValidator } from '../src/analysis/position-quality-validator.js';
import { PositionWriter } from '../src/analysis/position-writer.js';
import { OutputFormatter } from '../src/utils/output-formatter.js';
import { DynamicParameterCalculator } from '../src/utils/dynamic-parameter-calculator.js';

async function run() {
  console.log('='.repeat(80));
  console.log('RUNNING PIPELINE FROM AGGREGATE CHECKPOINT');
  console.log('='.repeat(80) + '\n');
  
  // Load checkpoints
  const checkpointLabel = process.argv[2] || 'test24';
  console.log(`Loading checkpoints from ${checkpointLabel}...`);
  const aggregate = JSON.parse(readFileSync(`output/checkpoints/223/${checkpointLabel}/aggregate.json`, 'utf-8'));
  const loadData = JSON.parse(readFileSync(`output/checkpoints/223/${checkpointLabel}/load-data.json`, 'utf-8'));
  const embeddings = JSON.parse(readFileSync(`output/checkpoints/223/${checkpointLabel}/embedding.json`, 'utf-8'));
  const microSummaries = JSON.parse(readFileSync(`output/checkpoints/223/${checkpointLabel}/micro-summarize.json`, 'utf-8'));
  
  const responseCount = loadData.responses.length;
  const positionCount = aggregate.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
  
  console.log(`✓ Loaded: ${responseCount} responses, ${positionCount} positions across ${aggregate.length} themes\n`);
  
  // Show breakdown per theme
  aggregate.forEach(theme => {
    const count = theme.positions?.length || 0;
    if (count > 0) {
      console.log(`  - ${theme.name}: ${count} positions`);
    }
  })
  console.log('');
  
  // Calculate complexity
  const totalWords = loadData.responses.reduce((sum, r) => sum + (r.text || '').split(/\s+/).length, 0);
  const avgResponseLength = Math.round(totalWords / responseCount);
  
  const responseEmbeddings = embeddings.filter(e => e.metadata?.documentType === 'response');
  let semanticDiversity = 0.5;
  if (responseEmbeddings.length >= 2) {
    let totalSim = 0, pairs = 0;
    for (let i = 0; i < Math.min(responseEmbeddings.length, 10); i++) {
      for (let j = i + 1; j < Math.min(responseEmbeddings.length, 10); j++) {
        if (!responseEmbeddings[i].embedding || !responseEmbeddings[j].embedding) continue;
        let dot = 0, mag1 = 0, mag2 = 0;
        for (let k = 0; k < responseEmbeddings[i].embedding.length; k++) {
          dot += responseEmbeddings[i].embedding[k] * responseEmbeddings[j].embedding[k];
          mag1 += responseEmbeddings[i].embedding[k] ** 2;
          mag2 += responseEmbeddings[j].embedding[k] ** 2;
        }
        totalSim += dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
        pairs++;
      }
    }
    semanticDiversity = pairs > 0 ? 1 - (totalSim / pairs) : 0.5;
  }
  
  const params = DynamicParameterCalculator.getParametersForHearing({
    responseCount,
    chunkCount: embeddings.length,
    avgResponseLength,
    semanticDiversity,
    positionCount,
    themeCount: aggregate.length
  });
  
  console.log('='.repeat(80));
  DynamicParameterCalculator.logParameters(params, console);
  console.log('='.repeat(80) + '\n');
  
  // STEP 1: Consolidation
  console.log('[STEP 1] Position Consolidation...\n');
  const consolidator = new PositionConsolidator({ enabled: true });
  consolidator.setDynamicThreshold(params.consolidation.similarityThreshold);
  
  const consolidated = await consolidator.consolidate(
    aggregate,
    { responseCount, positionCount, complexity: params._complexity.category },
    params.consolidation.mergeAcrossThemes
  );
  
  const newPositionCount = consolidated.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
  console.log(`\n✓ Consolidation complete: ${positionCount} → ${newPositionCount} positions\n`);
  
  // Show result
  for (const theme of consolidated) {
    if (theme.positions && theme.positions.length > 0) {
      console.log(`📁 ${theme.name} (${theme.positions.length} positions):`);
      theme.positions.forEach((pos, idx) => {
        console.log(`   ${idx + 1}. ${pos.title} (${pos.responseNumbers.join(', ')})`);
      });
    }
  }
  
  // STEP 2: Quality Validation
  console.log('\n' + '='.repeat(80));
  console.log('[STEP 2] Position Quality Validation...\n');
  
  const validator = new PositionQualityValidator({ enabled: true });
  const validation = await validator.validate(consolidated, {
    responseCount,
    avgResponseLength,
    complexity: params._complexity.category
  });
  
  const report = validator.formatReport(validation);
  console.log(report);
  
  const validatedPositions = validation.fixedThemes || consolidated;
  
  // STEP 3: Hybrid Position Writing
  console.log('[STEP 3] Hybrid Position Writing...\n');
  const positionWriter = new PositionWriter();
  
  const hybridPositions = await positionWriter.writePositions({
    aggregatedThemes: validatedPositions,
    microSummaries,
    embeddings,
    rawResponses: loadData.responses
  });
  
  console.log(`✓ Hybrid positions written for ${hybridPositions.length} themes\n`);
  
  // STEP 4: Format Output
  console.log('[STEP 4] Format Output...\n');
  const formatter = new OutputFormatter();
  
  // Load or generate considerations
  let considerations = 'Ingen særlige overvejelser.';
  try {
    const consid = readFileSync(`output/checkpoints/223/${checkpointLabel}/considerations.json`, 'utf-8');
    considerations = JSON.parse(consid) || considerations;
  } catch (e) {
    console.log('Note: Considerations not found in checkpoint, using default');
  }
  
  const result = {
    hearingId: 223,
    title: loadData.hearing?.title || 'Høring 223',
    topics: hybridPositions,
    considerations
  };
  
  const markdown = formatter.formatForDocx(result);
  
  // Save outputs
  const outputLabel = checkpointLabel;
  writeFileSync(`output/hearing-223-analysis-${outputLabel}.json`, JSON.stringify(result, null, 2), 'utf-8');
  writeFileSync(`output/hearing-223-analysis-${outputLabel}.md`, markdown, 'utf-8');
  
  console.log(`✓ Saved outputs to:`);
  console.log(`  - output/hearing-223-analysis-${outputLabel}.json`);
  console.log(`  - output/hearing-223-analysis-${outputLabel}.md\n`);
  
  console.log('='.repeat(80));
  console.log('✅ PIPELINE COMPLETE!');
  console.log('='.repeat(80));
  
  const finalPositionCount = hybridPositions.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
  console.log(`\nFINAL RESULT: ${positionCount} → ${newPositionCount} → ${finalPositionCount} positions`);
  console.log(`Reduction: ${((1 - finalPositionCount/positionCount) * 100).toFixed(1)}%`);
}

run().catch(err => {
  console.error('Pipeline failed:', err);
  console.error(err.stack);
  process.exit(1);
});

