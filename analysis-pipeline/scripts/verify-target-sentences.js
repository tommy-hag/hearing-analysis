#!/usr/bin/env node
/**
 * Verification script that tests _targetSentences calculation directly.
 * 
 * This simulates what happens in position-writer.js without running the full pipeline.
 * 
 * Run: node scripts/verify-target-sentences.js
 */

// Copy of the calculateTargetSentences function from position-writer.js
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
  return { min: 10, max: 16, requiresBranching: true };
}

console.log('='.repeat(70));
console.log('🔍 Verifying _targetSentences implementation');
console.log('='.repeat(70));
console.log();

// Simulate the mega-position from test07 (based on hearing-223-analysis.md)
// The mega-position "Ønske om bevaring af Palads" had 2338 respondents
// with sub-positions of 1116, 1015, and 1015 respondents
const megaPosition = {
  title: "Ønske om bevaring af Palads",
  totalRespondents: 2338,
  subPositions: [
    { title: "Fuld bevaring uden ombygninger", respondentCount: 1116 },
    { title: "Indre kulturmiljø og foyer", respondentCount: 1015 },
    { title: "Ydre arkitektur og facade", respondentCount: 1015 }
  ]
};

console.log(`📊 MEGA-POSITION: "${megaPosition.title}"`);
console.log(`   Total respondents: ${megaPosition.totalRespondents}`);
console.log();

// Overall position target
const overallTarget = calculateTargetSentences(megaPosition.totalRespondents);
console.log('📊 OVERALL POSITION TARGET:');
console.log(`   _targetSentences: { min: ${overallTarget.min}, max: ${overallTarget.max}, requiresBranching: ${overallTarget.requiresBranching} }`);
console.log(`   → Master-holdning skal have: ${overallTarget.min}-${overallTarget.max} sætninger`);
console.log();

// Sub-position targets
console.log('📊 SUB-POSITION TARGETS:');
console.log();

megaPosition.subPositions.forEach((sub, idx) => {
  const target = calculateTargetSentences(sub.respondentCount);
  
  console.log(`   [${idx + 1}] "${sub.title}"`);
  console.log(`       Respondents: ${sub.respondentCount}`);
  console.log(`       _targetSentences: { min: ${target.min}, max: ${target.max}, requiresBranching: ${target.requiresBranching} }`);
  console.log(`       → LLM skal skrive: ${target.min}-${target.max} sætninger ${target.requiresBranching ? '+ FORGRENING 🌿' : ''}`);
  console.log();
});

console.log('='.repeat(70));
console.log('📝 EKSEMPEL PÅ JSON DER SENDES TIL LLM:');
console.log('='.repeat(70));
console.log();

// Show example of what the JSON input will look like
const exampleSubPosInput = {
  position: {
    title: "Fuld bevaring uden ombygninger",
    respondentCount: 1116,
    _targetSentences: calculateTargetSentences(1116),
    _availableEvidenceCount: 45,
    _subPositionContext: { what: "Facade og silhuet skal bevares", why: "Kulturhistorisk værdi" }
  }
};

console.log('position.position (sub-position input):');
console.log(JSON.stringify(exampleSubPosInput.position, null, 2));
console.log();

console.log('='.repeat(70));
console.log('📊 SAMMENLIGNING MED TEST07 OUTPUT:');
console.log('='.repeat(70));
console.log();

const comparisons = [
  { name: 'Sub 1 (1116 respondenter)', actual: 3, expected: calculateTargetSentences(1116) },
  { name: 'Sub 2 (1015 respondenter)', actual: 3, expected: calculateTargetSentences(1015) },
  { name: 'Sub 3 (1015 respondenter)', actual: 3, expected: calculateTargetSentences(1015) },
];

comparisons.forEach(c => {
  const improvement = c.expected.min - c.actual;
  const status = improvement > 0 ? '❌ FOR KORT' : '✅ OK';
  
  console.log(`${status} ${c.name}:`);
  console.log(`   test07 faktisk output: ${c.actual} sætninger`);
  console.log(`   nyt minimum med fix:   ${c.expected.min} sætninger (+${improvement} forbedring)`);
  console.log(`   nyt maximum:           ${c.expected.max} sætninger`);
  console.log(`   kræver forgrening:     ${c.expected.requiresBranching ? 'JA 🌿' : 'Nej'}`);
  console.log();
});

console.log('='.repeat(70));
console.log('✅ KONKLUSION');
console.log('='.repeat(70));
console.log();
console.log('Med den nye implementering vil LLM\'en modtage eksplicitte targets:');
console.log();
console.log('  position._targetSentences: { min: 10, max: 16, requiresBranching: true }');
console.log();
console.log('Dette giver LLM\'en et KONKRET mål i stedet for at skulle');
console.log('huske og anvende en logaritmisk formel fra prompten.');
console.log();
console.log('Forventet forbedring: ~3 sætninger → 10-16 sætninger per sub-position');
console.log();

