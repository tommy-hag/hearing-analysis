/**
 * Quick test of consolidation on existing aggregate.json
 */

import { readFileSync } from 'fs';
import { PositionConsolidator } from '../src/analysis/position-consolidator.js';
import { PositionQualityValidator } from '../src/analysis/position-quality-validator.js';
import { DynamicParameterCalculator } from '../src/utils/dynamic-parameter-calculator.js';

async function test() {
  console.log('Loading aggregate.json from baseline checkpoint...\n');
  
  // Load existing aggregate
  const aggregate = JSON.parse(readFileSync('output/checkpoints/223/baseline/aggregate.json', 'utf-8'));
  const loadData = JSON.parse(readFileSync('output/checkpoints/223/baseline/load-data.json', 'utf-8'));
  const embeddings = JSON.parse(readFileSync('output/checkpoints/223/baseline/embedding.json', 'utf-8'));
  
  const responseCount = loadData.responses.length;
  const positionCount = aggregate.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
  
  console.log(`Dataset: ${responseCount} responses, ${positionCount} positions\n`);
  
  // Calculate metrics
  const totalWords = loadData.responses.reduce((sum, r) => sum + (r.text || '').split(/\s+/).length, 0);
  const avgResponseLength = Math.round(totalWords / responseCount);
  
  // Calculate diversity
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
  
  console.log(`Metrics:`);
  console.log(`  - Avg response length: ${avgResponseLength} words`);
  console.log(`  - Semantic diversity: ${semanticDiversity.toFixed(3)}\n`);
  
  // Calculate dynamic parameters
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
  
  // Run consolidation
  console.log('Running PositionConsolidator...\n');
  const consolidator = new PositionConsolidator({
    enabled: true,
    similarityThreshold: params.consolidation.similarityThreshold
  });
  
  if (consolidator.setDynamicThreshold) {
    consolidator.setDynamicThreshold(params.consolidation.similarityThreshold);
  }
  
  const consolidated = await consolidator.consolidate(
    aggregate,
    { responseCount, positionCount, complexity: params._complexity.category },
    params.consolidation.mergeAcrossThemes
  );
  
  const newPositionCount = consolidated.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
  
  console.log('\n' + '='.repeat(80));
  console.log(`CONSOLIDATION RESULT: ${positionCount} → ${newPositionCount} positions`);
  console.log('='.repeat(80) + '\n');
  
  // Show positions per theme
  for (const theme of consolidated) {
    if (theme.positions && theme.positions.length > 0) {
      console.log(`\n📁 ${theme.name} (${theme.positions.length} positions):`);
      theme.positions.forEach((pos, idx) => {
        console.log(`   ${idx + 1}. ${pos.title} (${pos.responseNumbers.length} respondents: ${pos.responseNumbers.join(', ')})`);
      });
    }
  }
  
  // Run quality validation
  console.log('\n' + '='.repeat(80));
  console.log('Running PositionQualityValidator...\n');
  
  const validator = new PositionQualityValidator({ enabled: true });
  const validation = await validator.validate(consolidated, {
    responseCount,
    avgResponseLength,
    complexity: params._complexity.category
  });
  
  const report = validator.formatReport(validation);
  console.log(report);
  
  console.log('✅ Test complete!');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
