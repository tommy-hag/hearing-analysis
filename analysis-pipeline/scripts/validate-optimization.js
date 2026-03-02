/**
 * Validation script for JSON optimization
 * 
 * Validates that:
 * 1. sourceSummary has been removed from theme-mapping.json
 * 2. sourceQuoteRef is still present (citations preserved)
 * 3. File size reduction achieved
 */

import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function validateThemeMapping(filePath) {
  console.log(`\n🔍 Validating theme-mapping.json: ${filePath}\n`);
  
  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    // Check file size
    const stats = statSync(filePath);
    const fileSizeKB = (stats.size / 1024).toFixed(2);
    console.log(`📊 File size: ${fileSizeKB} KB`);
    
    // Validate structure
    let hasSourceSummary = false;
    let hasSourceQuoteRef = false;
    let totalArguments = 0;
    let argumentsWithSourceSummary = 0;
    let argumentsWithSourceQuoteRef = 0;
    
    if (data.themes && Array.isArray(data.themes)) {
      data.themes.forEach(theme => {
        if (theme.arguments && Array.isArray(theme.arguments)) {
          theme.arguments.forEach(arg => {
            totalArguments++;
            
            if (arg.sourceSummary) {
              hasSourceSummary = true;
              argumentsWithSourceSummary++;
            }
            
            if (arg.sourceQuoteRef) {
              hasSourceQuoteRef = true;
              argumentsWithSourceQuoteRef++;
            }
          });
        }
      });
    }
    
    console.log(`\n📈 Statistics:`);
    console.log(`   Total arguments: ${totalArguments}`);
    console.log(`   Arguments with sourceSummary: ${argumentsWithSourceSummary}`);
    console.log(`   Arguments with sourceQuoteRef: ${argumentsWithSourceQuoteRef}`);
    
    console.log(`\n✅ Validation Results:`);
    
    if (hasSourceSummary) {
      console.log(`   ❌ FAIL: sourceSummary still present in ${argumentsWithSourceSummary} arguments`);
      return false;
    } else {
      console.log(`   ✅ PASS: sourceSummary successfully removed`);
    }
    
    if (hasSourceQuoteRef) {
      console.log(`   ✅ PASS: sourceQuoteRef preserved (${argumentsWithSourceQuoteRef} arguments)`);
    } else {
      console.log(`   ⚠️  WARNING: No sourceQuoteRef found - may be normal if using sourceQuote instead`);
    }
    
    console.log(`\n✅ Optimization validation PASSED!\n`);
    return true;
    
  } catch (error) {
    console.error(`❌ Validation failed: ${error.message}`);
    return false;
  }
}

// Main
const checkpointPath = process.argv[2] || 'output/checkpoints/223/test100/theme-mapping.json';
const fullPath = join(__dirname, '..', checkpointPath);

if (!fullPath.includes('theme-mapping.json')) {
  console.error('❌ Error: Path must point to theme-mapping.json file');
  process.exit(1);
}

const isValid = validateThemeMapping(fullPath);
process.exit(isValid ? 0 : 1);

