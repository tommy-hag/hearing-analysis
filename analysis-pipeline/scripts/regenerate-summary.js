#!/usr/bin/env node
/**
 * Regenerate run summary for an existing run
 */
import { RunSummaryGenerator } from '../src/pipeline/run-summary-generator.js';
import { writeFileSync } from 'fs';

const runDir = process.argv[2] || './output/runs/168/test01';
const hearingId = 168;
const label = runDir.split('/').pop();

console.log(`Regenerating run summary for: ${runDir}`);

const gen = new RunSummaryGenerator({
  runDir,
  hearingId,
  label
});

try {
  const { jsonPath, mdPath, summary } = await gen.saveToFiles();
  
  console.log('\n=== REGENERATED RUN SUMMARY ===\n');
  console.log(`Quality Score: ${summary.quality.score}/100 (${summary.quality.grade})`);
  console.log(`Data: ${summary.dataStats.summary}`);
  
  // Show respondent coverage
  const coverage = summary.dataStats.respondentCoverage;
  if (coverage) {
    if (coverage.allRepresented) {
      console.log(`\nRespondent Coverage: ✅ All ${coverage.representedCount} respondents represented`);
    } else {
      console.log(`\nRespondent Coverage: ⚠️ ${coverage.representedCount}/${coverage.allResponseIds?.length || 0} respondents represented`);
      if (coverage.missingResponseIds?.length > 0) {
        console.log(`  Missing: ${coverage.missingResponseIds.join(', ')}`);
      }
    }
    if (coverage.multiPositionCount > 0) {
      console.log(`  Multi-position respondents: ${coverage.multiPositionCount}`);
      const top3 = coverage.multiPositionRespondents?.slice(0, 5) || [];
      if (top3.length > 0) {
        for (const r of top3) {
          console.log(`    - Henvendelse ${r.responseId}: ${r.positionCount} positions`);
        }
      }
    }
  }
  
  console.log(`\nSummary saved to:`);
  console.log(`  - ${jsonPath}`);
  console.log(`  - ${mdPath}`);
  
} catch (e) {
  console.error('Error:', e.message);
  console.error(e.stack);
}

