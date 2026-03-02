/**
 * Example script for analyzing documents and updating theme templates
 * 
 * Usage:
 *   node scripts/analyze-theme-template.js <hearingId> [options]
 * 
 * Options:
 *   --dry-run: Don't save changes, just show what would be updated
 *   --batch: Analyze multiple hearings of same type
 */

import { ThemeTemplateAnalyzer } from '../src/analysis/theme-template-analyzer.js';
import { DataLoader } from '../src/utils/data-loader.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function analyzeSingleDocument(hearingId, options = {}) {
  console.log(`\n📄 Analyzing hearing ${hearingId}...\n`);

  // Load data
  const dataLoader = new DataLoader();
  const loadData = await dataLoader.loadPublishedData(hearingId);
  
  if (!loadData.materials || loadData.materials.length === 0) {
    console.error('❌ No materials found for this hearing');
    return;
  }

  // Analyze document
  const analyzer = new ThemeTemplateAnalyzer();
  const result = await analyzer.analyzeAndUpdate(loadData.materials, options);

  if (!result.success) {
    console.error('❌ Analysis failed:', result.error);
    return;
  }

  console.log('✅ Analysis complete!\n');
  console.log('📊 Document Type:', result.analysis.documentType);
  console.log('📋 Purpose:', result.analysis.documentPurpose);
  
  if (result.analysis.legalBasis) {
    console.log('\n⚖️  Legal Basis:');
    console.log('  Primary Law:', result.analysis.legalBasis.primaryLaw);
    console.log('  Legal Purpose:', result.analysis.legalBasis.legalPurpose);
    console.log('  Authorities:', result.analysis.legalBasis.authorities?.join(', ') || 'N/A');
    console.log('  Limitations:', result.analysis.legalBasis.limitations?.join(', ') || 'N/A');
    console.log('  Related Laws:', result.analysis.legalBasis.relatedLaws?.join(', ') || 'N/A');
  }

  console.log('\n🎯 Themes found:', result.analysis.themes?.length || 0);
  if (result.analysis.themes) {
    result.analysis.themes.forEach(theme => {
      console.log(`  - ${theme.name} (${theme.category})`);
    });
  }

  if (result.updateResult.changes) {
    console.log('\n📝 Template Updates:');
    if (result.updateResult.changes.added.length > 0) {
      console.log('  Added:', result.updateResult.changes.added.join(', '));
    }
    if (result.updateResult.changes.updated.length > 0) {
      console.log('  Updated:', result.updateResult.changes.updated.join(', '));
    }
    if (result.updateResult.changes.removed.length > 0) {
      console.log('  Removed:', result.updateResult.changes.removed.join(', '));
    }
  }

  if (options.dryRun) {
    console.log('\n⚠️  DRY RUN - No changes saved');
  } else {
    console.log('\n💾 Changes saved to theme-templates.json');
  }
}

async function analyzeBatch(hearingIds, documentType, options = {}) {
  console.log(`\n📚 Analyzing ${hearingIds.length} hearings of type "${documentType}"...\n`);

  // Load all documents
  const dataLoader = new DataLoader();
  const documents = [];
  
  for (const hearingId of hearingIds) {
    try {
      const loadData = await dataLoader.loadPublishedData(hearingId);
      if (loadData.materials && loadData.materials.length > 0) {
        documents.push(loadData.materials);
        console.log(`✓ Loaded hearing ${hearingId}`);
      }
    } catch (error) {
      console.warn(`⚠️  Failed to load hearing ${hearingId}:`, error.message);
    }
  }

  if (documents.length === 0) {
    console.error('❌ No documents loaded');
    return;
  }

  // Analyze batch
  const analyzer = new ThemeTemplateAnalyzer();
  const result = await analyzer.analyzeBatchAndUpdate(documents, documentType, options);

  if (!result.success) {
    console.error('❌ Batch analysis failed:', result.error);
    return;
  }

  console.log('\n✅ Batch analysis complete!\n');
  
  if (result.analysis.analysis) {
    const analysis = result.analysis.analysis;
    console.log('📊 Common Themes:', analysis.commonThemes?.length || 0);
    if (analysis.commonThemes) {
      analysis.commonThemes.forEach(theme => {
        console.log(`  - ${theme.name} (frequency: ${theme.frequency}/${analysis.totalDocuments}, confidence: ${theme.confidence})`);
      });
    }

    if (analysis.variationThemes && analysis.variationThemes.length > 0) {
      console.log('\n📊 Variation Themes:', analysis.variationThemes.length);
      analysis.variationThemes.forEach(theme => {
        console.log(`  - ${theme.name} (frequency: ${theme.frequency}/${analysis.totalDocuments}, confidence: ${theme.confidence})`);
      });
    }
  }

  if (result.updateResult.changes) {
    console.log('\n📝 Template Updates:');
    if (result.updateResult.changes.added.length > 0) {
      console.log('  Added:', result.updateResult.changes.added.join(', '));
    }
    if (result.updateResult.changes.updated.length > 0) {
      console.log('  Updated:', result.updateResult.changes.updated.join(', '));
    }
  }

  if (options.dryRun) {
    console.log('\n⚠️  DRY RUN - No changes saved');
  } else {
    console.log('\n💾 Changes saved to theme-templates.json');
  }
}

// Main
const args = process.argv.slice(2);
const hearingId = args[0];
const options = {
  dryRun: args.includes('--dry-run'),
  mergeStrategy: args.includes('--replace') ? 'replace' : 'merge'
};

if (!hearingId) {
  console.log(`
Usage:
  node scripts/analyze-theme-template.js <hearingId> [options]
  node scripts/analyze-theme-template.js --batch <documentType> <hearingId1> <hearingId2> ... [options]

Options:
  --dry-run     Don't save changes, just show what would be updated
  --replace     Replace existing themes instead of merging
  --batch       Analyze multiple hearings of same type

Examples:
  # Analyze single document
  node scripts/analyze-theme-template.js 168 --dry-run

  # Analyze multiple lokalplaner
  node scripts/analyze-theme-template.js --batch lokalplan 168 223 456 --dry-run
`);
  process.exit(1);
}

if (args.includes('--batch')) {
  const documentType = args[1];
  const hearingIds = args.slice(2).filter(arg => !arg.startsWith('--'));
  
  if (!documentType || hearingIds.length === 0) {
    console.error('❌ Batch mode requires document type and at least one hearing ID');
    process.exit(1);
  }

  analyzeBatch(hearingIds, documentType, options).catch(console.error);
} else {
  analyzeSingleDocument(hearingId, options).catch(console.error);
}



