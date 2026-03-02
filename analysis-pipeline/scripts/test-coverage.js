#!/usr/bin/env node
/**
 * Test script to verify respondent coverage in run summary
 */
import { RunSummaryGenerator } from '../src/pipeline/run-summary-generator.js';

const gen = new RunSummaryGenerator({
  runDir: './output/runs/168/test01',
  hearingId: 168,
  label: 'test01'
});

try {
  const stats = gen.collectDataStats();
  console.log('\n=== RESPONDENT COVERAGE TEST ===\n');
  console.log('Response count:', stats.responseCount);
  console.log('Position count:', stats.positionCount);
  
  const coverage = stats.respondentCoverage;
  if (coverage) {
    console.log('\n--- Coverage Details ---');
    console.log('All Response IDs:', coverage.allResponseIds?.join(', '));
    console.log('Represented IDs:', coverage.representedResponseIds?.join(', '));
    console.log('Missing IDs:', coverage.missingResponseIds?.join(', ') || 'None');
    console.log('All represented:', coverage.allRepresented);
    console.log('Represented count:', coverage.representedCount);
    console.log('Multi-position count:', coverage.multiPositionCount);
    
    if (coverage.multiPositionRespondents?.length > 0) {
      console.log('\n--- Respondents in Multiple Positions ---');
      for (const resp of coverage.multiPositionRespondents) {
        console.log(`  Henvendelse ${resp.responseId}: ${resp.positionCount} positions`);
      }
    } else {
      console.log('\nNo respondents appear in multiple positions.');
    }
  } else {
    console.log('ERROR: respondentCoverage is null/undefined');
  }
} catch (e) {
  console.error('Error:', e.message);
  console.error(e.stack);
}

