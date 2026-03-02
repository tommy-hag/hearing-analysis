/**
 * Isolated test of PositionQualityValidator with performance measurement
 * 
 * Tests conditional validation and batching optimizations
 */

import { PositionQualityValidator } from '../src/analysis/position-quality-validator.js';
import { CheckpointManager } from '../src/pipeline/checkpoint-manager.js';

async function test() {
  console.log('=== Testing PositionQualityValidator Performance ===\n');
  
  const hearingId = 168;
  const checkpointLabel = 'test';
  
  // Load checkpoints
  const checkpointManager = new CheckpointManager();
  
  console.log('Loading checkpoints...');
  const consolidatedPositions = checkpointManager.load(hearingId, 'consolidate-positions', checkpointLabel);
  const dynamicParams = checkpointManager.load(hearingId, 'calculate-dynamic-parameters', checkpointLabel);
  const themes = checkpointManager.load(hearingId, 'theme-mapping', checkpointLabel);
  const enrichedResponses = checkpointManager.load(hearingId, 'enrich-responses', checkpointLabel);
  
  if (!consolidatedPositions) {
    console.error('❌ Failed to load consolidate-positions checkpoint');
    process.exit(1);
  }
  
  console.log('✅ Checkpoints loaded successfully\n');
  
  // Calculate context
  const responseCount = enrichedResponses?.length || 24;
  const avgResponseLength = dynamicParams?._stats?.avgResponseLength || 228;
  const complexityObj = dynamicParams?._complexity || {};
  const complexity = complexityObj.subCategory 
    ? `${complexityObj.category}-${complexityObj.subCategory}` 
    : complexityObj.category || 'unknown';
  
  // Calculate explosion ratio
  const totalArguments = themes?.themes?.reduce((sum, theme) => sum + (theme.arguments?.length || 0), 0) || 0;
  const positionCount = consolidatedPositions.reduce((sum, theme) => sum + (theme.positions?.length || 0), 0);
  const explosionRatio = totalArguments > 0 ? positionCount / totalArguments : 0;
  
  console.log('Context for validation:');
  console.log(`  - Responses: ${responseCount}`);
  console.log(`  - Complexity: ${complexity}`);
  console.log(`  - Arguments: ${totalArguments}`);
  console.log(`  - Positions: ${positionCount}`);
  console.log(`  - Explosion ratio: ${(explosionRatio * 100).toFixed(1)}%`);
  console.log('');
  
  // Test with different configurations
  const configs = [
    {
      name: 'Default (conditional + batching)',
      options: {
        conditionalValidation: true,
        batchSize: 10
      }
    },
    {
      name: 'Force validation (no conditional skip)',
      options: {
        conditionalValidation: false,
        batchSize: 10
      }
    },
    {
      name: 'Original (no batching)',
      options: {
        conditionalValidation: false,
        batchSize: 999 // Effectively no batching
      }
    }
  ];
  
  for (const config of configs) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${config.name}`);
    console.log('='.repeat(60));
    
    const validator = new PositionQualityValidator(config.options);
    
    const startTime = Date.now();
    
    const validation = await validator.validate(
      consolidatedPositions,
      { responseCount, avgResponseLength, complexity, complexityObj, explosionRatio }
    );
    
    const duration = Date.now() - startTime;
    const durationSec = (duration / 1000).toFixed(1);
    
    console.log(`\n⏱️  Duration: ${durationSec}s`);
    console.log(`✅ Valid: ${validation.valid}`);
    console.log(`📊 Skipped: ${validation.skipped || false}`);
    if (validation.skipReason) {
      console.log(`   Reason: ${validation.skipReason}`);
    }
    console.log(`⚠️  Issues: ${validation.issues?.length || 0}`);
    console.log(`💡 Recommendations: ${validation.recommendations?.length || 0}`);
    
    if (validation.issues && validation.issues.length > 0) {
      console.log('\nIssues found:');
      validation.issues.forEach((issue, idx) => {
        console.log(`  ${idx + 1}. [${issue.severity}] ${issue.type}: ${issue.description}`);
      });
    }
    
    // Performance summary
    console.log(`\n📈 Performance: ${config.name} = ${durationSec}s`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ Test Complete');
  console.log('='.repeat(60));
}

test().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});

