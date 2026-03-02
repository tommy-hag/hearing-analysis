/**
 * Test complete flow from theme-mapping → aggregate → consolidate → validate → write
 * Uses checkpointed data for speed
 */

import { readFileSync, writeFileSync } from 'fs';
import { Aggregator } from '../src/analysis/aggregator.js';
import { PositionConsolidator } from '../src/analysis/position-consolidator.js';
import { PositionQualityValidator } from '../src/analysis/position-quality-validator.js';
import { PositionWriter } from '../src/analysis/position-writer.js';
import { OutputFormatter } from '../src/utils/output-formatter.js';
import { DynamicParameterCalculator } from '../src/utils/dynamic-parameter-calculator.js';

async function run() {
  const checkpointLabel = process.argv[2] || 'test24';
  const hearingId = process.argv[3] || '223';
  console.log('='.repeat(80));
  console.log(`FULL FLOW TEST FROM AGGREGATE (hearing ${hearingId}, checkpoint ${checkpointLabel})`);
  console.log('='.repeat(80) + '\n');
  
  // Load checkpoints
  console.log('Loading checkpoints...');
  const aggregate = JSON.parse(readFileSync(`output/checkpoints/${hearingId}/${checkpointLabel}/aggregate.json`, 'utf-8'));
  const loadData = JSON.parse(readFileSync(`output/checkpoints/${hearingId}/${checkpointLabel}/load-data.json`, 'utf-8'));
  const embeddings = JSON.parse(readFileSync(`output/checkpoints/${hearingId}/${checkpointLabel}/embedding.json`, 'utf-8'));
  const microSummaries = JSON.parse(readFileSync(`output/checkpoints/${hearingId}/${checkpointLabel}/micro-summarize.json`, 'utf-8'));
  
  const responseCount = loadData.responses.length;
  const positionCount = aggregate.reduce((s, t) => s + (t.positions?.length || 0), 0);
  
  console.log(`✓ ${responseCount} responses, ${positionCount} positions\n`);
  
  // Show positions per theme
  aggregate.forEach(theme => {
    const count = theme.positions?.length || 0;
    if (count > 0) {
      console.log(`  - ${theme.name}: ${count} positions`);
    }
  });
  console.log('');
  
  // STEP 1: Calculate complexity
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
  
  // STEP 2: Consolidation
  console.log('[STEP 2] Position Consolidation...\n');
  const consolidator = new PositionConsolidator({ enabled: true });
  consolidator.setDynamicThreshold(params.consolidation.similarityThreshold);
  
  const consolidated = await consolidator.consolidate(
    aggregate,
    { responseCount, positionCount, complexity: params._complexity.category },
    params.consolidation.mergeAcrossThemes,
    loadData.responses // Pass allResponses for correct breakdown recalculation
  );
  
  const newPositionCount = consolidated.reduce((s, t) => s + (t.positions?.length || 0), 0);
  console.log(`\n✓ Consolidation: ${positionCount} → ${newPositionCount} positions\n`);
  
  // STEP 3: Quality Validation
  console.log('[STEP 3] Quality Validation...\n');
  const validator = new PositionQualityValidator({ enabled: true });
  const validation = await validator.validate(consolidated, {
    responseCount,
    avgResponseLength,
    complexity: params._complexity.category
  });
  
  console.log(validator.formatReport(validation));
  const validatedPositions = validation.fixedThemes || consolidated;
  
  // STEP 4: Hybrid Position Writing
  console.log('[STEP 4] Hybrid Position Writing...\n');
  const positionWriter = new PositionWriter();
  
  const hybridPositions = await positionWriter.writePositions({
    aggregatedThemes: validatedPositions,
    microSummaries,
    embeddings,
    rawResponses: loadData.responses
  });
  
  console.log(`✓ Hybrid positions written\n`);
  
  // STEP 5: Format Output
  console.log('[STEP 5] Format Output...\n');
  const formatter = new OutputFormatter();
  
  const result = {
    hearingId: parseInt(hearingId),
    title: loadData.hearing?.title || `Høring ${hearingId}`,
    topics: hybridPositions,
    considerations: 'Test considerations'
  };
  
  const markdown = formatter.formatForDocx(result);
  
  // Save
  writeFileSync(`output/hearing-${hearingId}-analysis-${checkpointLabel}.json`, JSON.stringify(result, null, 2), 'utf-8');
  writeFileSync(`output/hearing-${hearingId}-analysis-${checkpointLabel}.md`, markdown, 'utf-8');
  
  console.log(`✓ Saved to:`);
  console.log(`  - output/hearing-${hearingId}-analysis-${checkpointLabel}.md\n`);
  
  console.log('='.repeat(80));
  console.log('✅ COMPLETE!');
  console.log('='.repeat(80));
  console.log(`\nRESULT: ${positionCount} positions → ${newPositionCount} final`);
  console.log(`Reduction: ${((1 - newPositionCount/positionCount) * 100).toFixed(1)}%`);
}

run().catch(err => {
  console.error('Test failed:', err);
  console.error(err.stack);
  process.exit(1);
});

