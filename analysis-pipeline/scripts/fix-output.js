#!/usr/bin/env node

/**
 * Fix output issues:
 * 1. Remove fake sub-positions from fallback
 * 2. Resolve CITE_XXX references
 * 3. Clean up hybrid references that refer to fake groups
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function fixHybridPositions(checkpointPath) {
  console.log('Fixing hybrid positions...');
  
  const data = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
  
  let fixedCount = 0;
  
  data.forEach(theme => {
    if (!theme.positions) return;
    
    theme.positions.forEach(position => {
      // Remove fallback sub-positions
      if (position.subPositions && position._hasSubPositions) {
        const hasFallback = position.subPositions.some(sp => 
          sp._extractionMethod === 'fallback' || 
          sp.title.includes('Gruppe')
        );
        
        if (hasFallback) {
          console.log(`  Removing ${position.subPositions.length} fallback sub-positions from "${position.title}"`);
          position.subPositions = [];
          position._hasSubPositions = false;
          fixedCount++;
        }
      }
      
      // Fix summary that references "første gruppe", "anden gruppe"
      if (position.summary) {
        const originalSummary = position.summary;
        position.summary = position.summary
          .replace(/Fem borgere fra første gruppe/g, 'Fem borgere')
          .replace(/Fem borgere fra anden gruppe/g, 'Fem andre borgere')
          .replace(/fra første gruppe/g, '')
          .replace(/fra anden gruppe/g, '')
          .replace(/fra tredje gruppe/g, '');
          
        if (position.summary !== originalSummary) {
          console.log(`  Fixed summary references for "${position.title}"`);
          fixedCount++;
        }
      }
      
      // Clean hybrid references that use sub-position grouping
      if (position.hybridReferences) {
        position.hybridReferences.forEach(ref => {
          // Fix label that might reference groups
          if (ref.label) {
            ref.label = ref.label
              .replace(/fra første gruppe/g, '')
              .replace(/fra anden gruppe/g, '')
              .replace(/fra tredje gruppe/g, '');
          }
          
          // Note: CITE_XXX will be resolved by citation registry in pipeline
        });
      }
    });
  });
  
  console.log(`Fixed ${fixedCount} issues`);
  
  // Save fixed version
  const fixedPath = checkpointPath.replace('.json', '-fixed.json');
  writeFileSync(fixedPath, JSON.stringify(data, null, 2));
  console.log(`Saved fixed version to: ${fixedPath}`);
  
  return fixedPath;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const checkpointPath = process.argv[2];
  if (!checkpointPath) {
    console.error('Usage: node fix-output.js <checkpoint-file>');
    process.exit(1);
  }
  
  fixHybridPositions(checkpointPath);
}

export { fixHybridPositions };
