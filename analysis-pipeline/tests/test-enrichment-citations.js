/**
 * Test script for enrichment and citation extraction
 * 
 * Tests the new simplified enrichment logic and citation extraction
 * using checkpoints from hearing 168.
 */

import { CheckpointManager } from '../src/pipeline/checkpoint-manager.js';
import { CitationExtractor } from '../src/citation/citation-extractor.js';

const checkpoint = new CheckpointManager();
const extractor = new CitationExtractor();

console.log('=== Test 1: Edge Case Screening Output ===');
const edgeCases = checkpoint.load(168, 'edge-case-screening', 'final-test');
console.log(`Total edge cases: ${edgeCases.length}`);

// Check structure - should only have essential fields
const sampleEdgeCase = edgeCases[0];
console.log('Sample edge case structure:', Object.keys(sampleEdgeCase));
console.log('Sample edge case:', JSON.stringify(sampleEdgeCase, null, 2));

// Find edge cases with references
const edgeCasesWithRefs = edgeCases.filter(ec => ec.referencedNumbers?.length > 0);
console.log(`\nEdge cases with references: ${edgeCasesWithRefs.length}`);
if (edgeCasesWithRefs.length > 0) {
  console.log('Example:', JSON.stringify(edgeCasesWithRefs[0], null, 2));
}

console.log('\n=== Test 2: Enrichment ===');
const loadData = checkpoint.load(168, 'load-data', 'final-test');
const responses = loadData.responses;

// Simulate enrichment
let enrichedCount = 0;
edgeCases.forEach(ec => {
  if (ec.referencedNumbers?.length > 0 && ec.action === 'analyze-with-context') {
    enrichedCount++;
    const response = responses.find(r => r.id === ec.responseNumber);
    console.log(`\nResponse ${ec.responseNumber} would be enriched with context from: ${ec.referencedNumbers.join(', ')}`);
    if (response) {
      console.log(`Original length: ${response.text?.length || 0} chars`);
      // Calculate how much would be added
      let addedLength = 0;
      ec.referencedNumbers.forEach(num => {
        const ref = responses.find(r => r.id === num);
        if (ref) addedLength += (ref.text?.length || 0);
      });
      console.log(`Context added: ~${addedLength} chars`);
    }
  }
});
console.log(`\nTotal responses that would be enriched: ${enrichedCount}`);

console.log('\n=== Test 3: Citation Extraction ===');
const hybridPositions = checkpoint.load(168, 'hybrid-position-writing', 'final-test');

// Analyze reference format
let totalRefs = 0;
let oldFormatRefs = 0;
let newFormatRefs = 0;

hybridPositions.forEach(theme => {
  theme.positions.forEach(pos => {
    (pos.hybridReferences || []).forEach(ref => {
      totalRefs++;
      if (ref.responseNumber !== undefined && ref.citation !== undefined) {
        oldFormatRefs++;
      }
      if (ref.id !== undefined && ref.label !== undefined && ref.respondents !== undefined) {
        newFormatRefs++;
      }
    });
  });
});

console.log(`\nTotal hybrid references: ${totalRefs}`);
console.log(`Old format (responseNumber, citation): ${oldFormatRefs}`);
console.log(`New format (id, label, respondents, quotes): ${newFormatRefs}`);

if (newFormatRefs === 0) {
  console.log('\n⚠️  Checkpoint uses OLD format. Run pipeline with new code to generate NEW format.');
  console.log('The citation extraction step will convert empty quotes[] to actual citations.');
} else {
  // Test with new format
  const testTheme = hybridPositions.find(t => t.positions?.length > 0);
  if (!testTheme) {
    console.log('No themes with positions found!');
    process.exit(0);
  }

  const testPosition = testTheme.positions.find(p => p.hybridReferences?.length > 0);
  if (!testPosition) {
    console.log('No positions with hybrid references found!');
    process.exit(0);
  }

  console.log(`\nTest theme: ${testTheme.name}`);
  console.log(`Test position: ${testPosition.title}`);
  console.log(`Hybrid references: ${testPosition.hybridReferences.length}`);

  // Test extraction on first reference with ≤15 respondents
  const testRef = testPosition.hybridReferences.find(ref => 
    ref.respondents?.length > 0 && ref.respondents.length <= 15
  );

  if (testRef) {
    console.log(`\nTesting reference: ${testRef.label}`);
    console.log(`Respondents: ${testRef.respondents.join(', ')}`);
    console.log(`Current quotes: ${testRef.quotes?.length || 0}`);
    
    // Test extraction for first respondent
    const testResponseNum = testRef.respondents[0];
    const testResponse = responses.find(r => r.id === testResponseNum);
    
    if (testResponse) {
      console.log(`\nExtracting citation for response ${testResponseNum}...`);
      console.log(`Response length: ${testResponse.text?.length || 0} chars`);
      console.log(`Query (summary): ${testPosition.summary.substring(0, 200)}...`);
      console.log(`Label: ${testRef.label}`);
      
      try {
        const result = await extractor.extractCitation(
          testResponseNum,
          testPosition.summary,
          testResponse.text,
          testRef.label,
          [] // No embeddings for this test
        );
        
        console.log('\n--- Extraction Result ---');
        console.log(`Found: ${result.found}`);
        console.log(`Method: ${result.method}`);
        console.log(`Confidence: ${result.confidence}`);
        if (result.found) {
          console.log(`Citation (formatted):\n${result.citation}`);
          // Extract just the quote
          const quoteText = result.citation
            .replace(/\*\*Henvendelse \d+\*\*\s*\n?\s*\*?"?/gi, '')
            .replace(/\*"?\s*$/g, '')
            .trim();
          console.log(`\nQuote (extracted):\n${quoteText}`);
        }
      } catch (error) {
        console.error('Citation extraction failed:', error.message);
      }
    } else {
      console.log(`Response ${testResponseNum} not found!`);
    }
  } else {
    console.log('No suitable reference found for testing (need ≤15 respondents)');
  }
}

console.log('\n=== Test Complete ===');

