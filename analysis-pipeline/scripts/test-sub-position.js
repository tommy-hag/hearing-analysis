#!/usr/bin/env node

/**
 * Test SubPositionExtractor directly
 */

import { SubPositionExtractor } from '../src/analysis/sub-position-extractor.js';

async function testSubPosition() {
  console.log('Testing SubPositionExtractor...');
  
  const extractor = new SubPositionExtractor({
    timeout: 30000 // 30 second timeout
  });
  
  // Test position that triggers extraction
  const testPosition = {
    title: "Test mega-position",
    responseNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    summary: "A test position with many respondents",
    _mergeCount: 10,
    _mergedFrom: ["Title 1", "Title 2", "Title 3"],
    _originalSummaries: [
      { title: "Title 1", summary: "Summary 1" },
      { title: "Title 2", summary: "Summary 2" }
    ]
  };
  
  const context = {
    massAgreementDetected: false,
    objectConcentration: { concentration: 0.5 }
  };
  
  try {
    console.log('Calling extractSubPositions...');
    const startTime = Date.now();
    
    const result = await extractor.extractSubPositions(
      testPosition,
      [], // microSummaries
      [], // allResponses
      context
    );
    
    const elapsed = Date.now() - startTime;
    console.log(`✓ Completed in ${elapsed}ms`);
    console.log(`Result: ${JSON.stringify(result, null, 2)}`);
    
  } catch (error) {
    console.error('✗ Error:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run test
testSubPosition().catch(console.error);
