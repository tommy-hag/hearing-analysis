#!/usr/bin/env node
/**
 * Quick test script to verify _targetSentences calculation
 * Run with: node test-target-sentences.js
 */

// Copy of the function from position-writer.js (to test in isolation)
function calculateTargetSentences(respondentCount) {
  if (respondentCount <= 15) {
    return { min: 1, max: 2, requiresBranching: false };
  }
  if (respondentCount <= 40) {
    return { min: 2, max: 3, requiresBranching: false };
  }
  if (respondentCount <= 100) {
    return { min: 4, max: 5, requiresBranching: false };
  }
  if (respondentCount <= 300) {
    return { min: 5, max: 7, requiresBranching: false };
  }
  if (respondentCount <= 800) {
    return { min: 7, max: 10, requiresBranching: true };
  }
  // 800+ respondents: mega-group with internal branching
  return { min: 10, max: 16, requiresBranching: true };
}

// Test cases matching the mega-position from test07
const testCases = [
  // Overall mega-position
  { name: 'Mega-position (alle)', count: 2338 },
  
  // Sub-positions from test07
  { name: 'Sub 1: Fuld bevaring', count: 1116 },
  { name: 'Sub 2: Indre kulturmiljø', count: 1015 },
  { name: 'Sub 3: Ydre arkitektur', count: 1015 },
  
  // Smaller positions for comparison
  { name: 'Mellem position', count: 150 },
  { name: 'Lille position', count: 25 },
  { name: 'Enkelt borger', count: 1 },
  
  // Edge cases
  { name: 'Edge: 15', count: 15 },
  { name: 'Edge: 16', count: 16 },
  { name: 'Edge: 100', count: 100 },
  { name: 'Edge: 300', count: 300 },
  { name: 'Edge: 800', count: 800 },
  { name: 'Edge: 801', count: 801 },
];

console.log('='.repeat(70));
console.log('🧪 Testing _targetSentences calculation');
console.log('='.repeat(70));
console.log();

testCases.forEach(tc => {
  const result = calculateTargetSentences(tc.count);
  const branchingIndicator = result.requiresBranching ? '🌿 FORGRENING' : '';
  
  console.log(`📊 ${tc.name} (${tc.count} respondenter)`);
  console.log(`   → _targetSentences: { min: ${result.min}, max: ${result.max}, requiresBranching: ${result.requiresBranching} }`);
  console.log(`   → LLM skal skrive: ${result.min}-${result.max} sætninger ${branchingIndicator}`);
  console.log();
});

console.log('='.repeat(70));
console.log('📝 Sammenligning med test07 faktisk output:');
console.log('='.repeat(70));
console.log();

// What test07 actually produced vs what it should produce
const comparisons = [
  { 
    name: 'Sub 1 (1116 resp)', 
    actual: 3, 
    expected: calculateTargetSentences(1116)
  },
  { 
    name: 'Sub 2 (1015 resp)', 
    actual: 3, 
    expected: calculateTargetSentences(1015)
  },
  { 
    name: 'Sub 3 (1015 resp)', 
    actual: 3, 
    expected: calculateTargetSentences(1015)
  },
];

comparisons.forEach(c => {
  const status = c.actual >= c.expected.min ? '✅' : '❌';
  console.log(`${status} ${c.name}:`);
  console.log(`   Faktisk output (test07): ${c.actual} sætninger`);
  console.log(`   Ny forventet minimum:    ${c.expected.min} sætninger`);
  console.log(`   Ny forventet maximum:    ${c.expected.max} sætninger`);
  console.log(`   Kræver forgrening:       ${c.expected.requiresBranching ? 'JA' : 'Nej'}`);
  console.log();
});

console.log('='.repeat(70));
console.log('✨ Eksempel på hvordan input JSON vil se ud for LLM:');
console.log('='.repeat(70));
console.log();

const exampleSubPosition = {
  title: "Ønske om fuld bevaring af bygningens ydre",
  respondentCount: 1116,
  _targetSentences: calculateTargetSentences(1116),
  _availableEvidenceCount: 45,
  representativeArguments: [
    { what: "Facade skal bevares", why: "Kulturhistorisk værdi" },
    { what: "Silhuet skal bevares", why: "Byens identitet" },
    // ... more arguments
  ]
};

console.log('subPosition:');
console.log(JSON.stringify(exampleSubPosition, null, 2));
console.log();

console.log('='.repeat(70));
console.log('🎯 Konklusion:');
console.log('='.repeat(70));
console.log();
console.log('Med den nye implementering vil LLM\'en modtage eksplicitte targets:');
console.log('- 1116 respondenter → min 10, max 16 sætninger + forgrening');
console.log('- 1015 respondenter → min 10, max 16 sætninger + forgrening');
console.log();
console.log('Dette er en STOR forbedring fra de 3 sætninger test07 producerede!');
console.log();

