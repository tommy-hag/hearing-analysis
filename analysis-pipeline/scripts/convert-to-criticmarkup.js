/**
 * Quick script to convert hybrid-position JSON to CriticMarkup markdown
 */

import { readFileSync, writeFileSync } from 'fs';

const inputFile = process.argv[2] || 'output/debug-reports/job_223_1762875010096_hybrid-position-writing.json';
const outputFile = process.argv[3] || 'output/test-criticmarkup.md';

const data = JSON.parse(readFileSync(inputFile, 'utf-8'));

let markdown = '';

for (const theme of data.result) {
  markdown += `# ${theme.name}\n\n`;
  
  for (const position of theme.positions) {
    const count = position.responseNumbers?.length || 0;
    const breakdown = position.respondentBreakdown || {};
    const hasLU = breakdown.localCommittees && breakdown.localCommittees.length > 0;
    const hasO = breakdown.organizations && breakdown.organizations.length > 0;
    const hasPublicAuth = breakdown.publicAuthorities && breakdown.publicAuthorities.length > 0;
    
    let titlePrefix = `(${count}`;
    if (hasLU) titlePrefix += ', LU';
    if (hasO) titlePrefix += ', O';
    if (hasPublicAuth && !hasLU && !hasO) titlePrefix += ', O';
    titlePrefix += ')';
    
    markdown += `## ${titlePrefix} ${position.title}\n\n`;
    
    // Add response numbers
    if (position.responseNumbers && position.responseNumbers.length > 0) {
      const nums = position.responseNumbers.sort((a, b) => a - b);
      if (nums.length === 1) {
        markdown += `Henvendelse ${nums[0]}\n\n`;
      } else if (nums.length === 2) {
        markdown += `Henvendelse ${nums[0]} og ${nums[1]}\n\n`;
      } else {
        const last = nums.pop();
        markdown += `Henvendelse ${nums.join(', ')} og ${last}\n\n`;
      }
    }
    
    // Convert summary with placeholders to CriticMarkup
    let summary = position.summary;
    const references = position.hybridReferences || [];
    
    // Process references in reverse order to maintain string positions
    for (let i = references.length - 1; i >= 0; i--) {
      const ref = references[i];
      const placeholder = `<<${ref.id}>>`;
      
      // Build CriticMarkup comment
      let comment = '';
      for (const quote of ref.quotes) {
        if (comment) comment += '\n';
        comment += `**Henvendelse ${quote.responseNumber}**\\n*"${quote.quote}"*`;
      }
      
      // Replace "label<<REF_N>>" with "{==label==}{>>comment<<}"
      const searchPattern = `${ref.label}${placeholder}`;
      const replacement = `{==${ref.label}==}{>>${comment}<<}`;
      
      summary = summary.replace(searchPattern, replacement);
    }
    
    markdown += `${summary}\n\n`;
  }
}

writeFileSync(outputFile, markdown, 'utf-8');
console.log(`Converted to ${outputFile}`);

