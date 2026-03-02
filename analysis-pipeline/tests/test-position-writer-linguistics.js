/**
 * Regression tests for PositionWriter linguistic correctness.
 *
 * Run manually:
 *   node tests/test-position-writer-linguistics.js
 */
import assert from 'node:assert/strict';

import { PositionWriter } from '../src/analysis/position-writer.js';
import { PositionWriterValidator } from '../src/utils/position-writer-validator.js';

function run() {
  console.log('Testing PositionWriter linguistic fixes...');

  // --- 1) Deterministic grammar fix: actor-subject + passive (-s) ---
  {
    const hybridSummary = {
      summary: 'én borger<<REF_1>> fremhæves et klart ønske om bevaring.',
      references: [{ id: 'REF_1', label: 'én borger', respondents: [1], quotes: [], notes: '' }],
      warnings: []
    };

    PositionWriter.prototype.fixActorSubjectPassiveVerbs.call({}, hybridSummary);

    assert.match(
      hybridSummary.summary,
      /én borger<<REF_1>> fremhæver\b/,
      'Expected "én borger<<REF_1>> fremhæves" to be rewritten to active form'
    );
  }

  // --- 2) Validator catches actor-subject + passive when unfixed ---
  {
    const validator = new PositionWriterValidator();
    const positionInput = {
      position: { subPositionsRequired: false },
      respondents: [{ responseNumber: 1 }]
    };
    const hybridOutput = {
      summary: 'Én borger<<REF_1>> fremhæves et klart ønske om X.',
      references: [{ id: 'REF_1', label: 'én borger', respondents: [1] }]
    };

    const res = validator.validateLinguisticConsistency(positionInput, hybridOutput);
    assert.equal(res.valid, false, 'Expected linguistic validation to fail on actor+passive');
    assert.ok(
      (res.errors || []).some(e => String(e).toLowerCase().includes('grammatikfejl')),
      'Expected grammar error to be reported'
    );
  }

  // --- 3) Mega-position master enforcement (Der + REF_1 covers all) ---
  {
    const hybridSummary = {
      summary:
        '116 borgere<<REF_1>> ønsker bevarelse af Palads. Tre borgere<<REF_2>> peger på X.',
      references: [
        { id: 'REF_1', label: '116 borgere', respondents: [1, 2], quotes: [], notes: '' },
        { id: 'REF_2', label: 'tre borgere', respondents: [3, 4], quotes: [], notes: '' }
      ],
      warnings: []
    };
    const writerInput = {
      position: {
        subPositionsRequired: true,
        subPositions: [{ title: 'Nuance A', responseNumbers: [3, 4] }]
      },
      respondents: [
        { responseNumber: 1 },
        { responseNumber: 2 },
        { responseNumber: 3 },
        { responseNumber: 4 }
      ]
    };

    PositionWriter.prototype.enforceMegaPositionMasterReference.call({}, hybridSummary, writerInput);

    assert.match(
      hybridSummary.summary,
      /^\s*Der<<REF_1>>/,
      'Expected mega master summary to start with "Der<<REF_1>>"'
    );

    const ref1 = hybridSummary.references.find(r => r.id === 'REF_1');
    assert.ok(ref1, 'Expected REF_1 to exist after enforcement');
    assert.equal(ref1.label, 'Der', 'Expected REF_1.label to be "Der"');
    assert.deepEqual(ref1.respondents, [1, 2, 3, 4], 'Expected REF_1 to cover all respondents');
  }

  // --- 4) Validator passes mega master invariants when correct ---
  {
    const validator = new PositionWriterValidator();
    const positionInput = {
      position: {
        subPositionsRequired: true,
        subPositions: [{ title: 'Nuance A', responseNumbers: [3, 4] }]
      },
      respondents: [
        { responseNumber: 1 },
        { responseNumber: 2 },
        { responseNumber: 3 },
        { responseNumber: 4 }
      ]
    };

    const hybridOutput = {
      summary: 'Der<<REF_1>> ønskes bevaring. To borgere<<REF_2>> peger på X.',
      references: [
        { id: 'REF_1', label: 'Der', respondents: [1, 2, 3, 4], quotes: [], notes: '' },
        { id: 'REF_2', label: 'to borgere', respondents: [3, 4], quotes: [], notes: '' }
      ]
    };

    const res = validator.validateLinguisticConsistency(positionInput, hybridOutput);
    assert.equal(res.valid, true, `Expected linguistic validation to pass, got errors: ${(res.errors || []).join('; ')}`);
  }

  console.log('✅ PositionWriter linguistic tests passed.');
}

try {
  run();
} catch (err) {
  console.error('❌ PositionWriter linguistic tests failed.');
  console.error(err);
  process.exitCode = 1;
}

