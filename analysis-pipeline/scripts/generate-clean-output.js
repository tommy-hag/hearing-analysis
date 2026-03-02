#!/usr/bin/env node

/**
 * Generate clean output directly from checkpoint data
 * Bypasses problematic pipeline steps
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function generateCleanOutput() {
  console.log('Generating clean output...');
  
  // Load the fixed hybrid position data
  const hybridPath = 'output/checkpoints/223/test13-final-fixed/hybrid-position-writing.json';
  const microSummariesPath = 'output/checkpoints/223/test13-final-fixed/micro-summarize.json';
  const responsesPath = 'output/checkpoints/223/test13-final-fixed/load-data.json';
  
  const hybridData = JSON.parse(readFileSync(hybridPath, 'utf-8'));
  const microSummaries = JSON.parse(readFileSync(microSummariesPath, 'utf-8'));
  const { responses } = JSON.parse(readFileSync(responsesPath, 'utf-8'));
  
  // Build citation map from responses
  const responseMap = new Map();
  responses.forEach(r => {
    responseMap.set(r.id, r.text || r.textMd || '');
  });
  
  // Build citation map from micro-summaries
  const citationMap = new Map();
  microSummaries.forEach(ms => {
    ms.arguments?.forEach((arg, idx) => {
      if (arg.sourceQuoteRef) {
        // Extract representative quote from response text
        const responseText = responseMap.get(ms.responseNumber) || '';
        // Take first 150 chars as quote (simplified)
        const quote = responseText.substring(0, 150).trim() + (responseText.length > 150 ? '...' : '');
        citationMap.set(arg.sourceQuoteRef, quote);
      }
    });
  });
  
  // Process each theme
  let markdown = '# Analyse af høringssvar\n\n';
  
  hybridData.forEach(theme => {
    if (!theme.positions || theme.positions.length === 0) return;
    
    markdown += `## ${theme.name}\n\n`;
    
    theme.positions.forEach(position => {
      // Format response count and title
      const count = position.responseNumbers?.length || 0;
      markdown += `### (${count}) ${position.title}\n\n`;
      
      // Add response numbers
      if (position.responseNumbers && position.responseNumbers.length > 0) {
        const nums = [...position.responseNumbers].sort((a, b) => a - b);
        markdown += `Henvendelse ${nums.join(', ')}\n\n`;
      }
      
      // Process summary and resolve CITE references
      let summary = position.summary || '';
      
      // Remove any existing CriticMarkup syntax
      summary = summary.replace(/\{==([^=]+)==\}/g, '$1');
      summary = summary.replace(/\{>>([^<]+)<<\}/g, '');
      
      // Replace <<REF_X>> with clean text
      if (position.hybridReferences) {
        position.hybridReferences.forEach(ref => {
          const placeholder = new RegExp(`${ref.label}<<${ref.id}>>`, 'g');
          const replacement = ref.label; // Just use the label without duplication
          summary = summary.replace(placeholder, replacement);
        });
      }
      
      markdown += summary + '\n\n';
      
      // Add citations section
      if (position.hybridReferences && position.hybridReferences.length > 0) {
        markdown += '**Citater:**\n\n';
        
        position.hybridReferences.forEach(ref => {
          ref.quotes?.forEach(q => {
            let quote = q.quote;
            
            // Resolve CITE_XXX references
            if (quote.startsWith('CITE_')) {
              quote = citationMap.get(quote) || '[Citat ikke fundet]';
            }
            
            markdown += `*Henvendelse ${q.responseNumber}:* "${quote}"\n\n`;
          });
        });
      }
      
      markdown += '---\n\n';
    });
  });
  
  // Save clean output
  const outputPath = 'output/hearing-223-clean.md';
  writeFileSync(outputPath, markdown);
  console.log(`Clean output saved to: ${outputPath}`);
}

// Run
generateCleanOutput();
