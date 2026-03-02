/**
 * StepLogGenerator
 * 
 * Generates human-readable markdown logs for each pipeline step.
 * Shows input/output data, statistics, samples, and LLM call summaries.
 */

import { writeFileSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';

export class StepLogGenerator {
  constructor(options = {}) {
    this.runDirManager = options.runDirManager;
    this.stepNumber = 0;
    this.llmCallsInStep = [];
  }

  /**
   * Reset LLM call tracking for a new step
   */
  startStep() {
    this.stepNumber++;
    this.llmCallsInStep = [];
  }

  /**
   * Generate and save a step log
   * @param {string} stepName - Name of the step
   * @param {Object} input - Input data for the step
   * @param {Object} output - Output data from the step
   * @param {number} duration - Duration in milliseconds
   * @param {Object} context - Additional context (artifacts, etc.)
   */
  async generateLog(stepName, input, output, duration, context = {}) {
    if (!this.runDirManager) return;

    const markdown = this._generateMarkdown(stepName, input, output, duration, context);
    const logPath = this.runDirManager.getStepLogPath(this.stepNumber, stepName);
    
    try {
      writeFileSync(logPath, markdown, 'utf-8');
    } catch (err) {
      console.warn(`[StepLogGenerator] Failed to write step log: ${err.message}`);
    }
  }

  /**
   * Generate markdown content for a step log
   * @private
   */
  _generateMarkdown(stepName, input, output, duration, context) {
    const lines = [];
    const displayName = this._formatStepName(stepName);
    const durationSec = (duration / 1000).toFixed(1);

    // Header
    lines.push(`# Step ${this.stepNumber}: ${displayName}`);
    lines.push('');
    lines.push(`**Tidspunkt:** ${new Date().toISOString()}`);
    lines.push(`**Varighed:** ${durationSec}s`);
    lines.push('');

    // Input section
    lines.push('---');
    lines.push('## 📥 Input');
    lines.push('');
    lines.push(this._formatInput(stepName, input, context));
    lines.push('');

    // Output section
    lines.push('---');
    lines.push('## 📤 Output');
    lines.push('');
    lines.push(this._formatOutput(stepName, output, context));
    lines.push('');

    // Statistics section
    const stats = this._generateStats(stepName, input, output, context);
    if (stats) {
      lines.push('---');
      lines.push('## 📊 Statistik');
      lines.push('');
      lines.push(stats);
      lines.push('');
    }

    // Patterns/insights section
    const patterns = this._analyzePatterns(stepName, output, context);
    if (patterns) {
      lines.push('---');
      lines.push('## 🔍 Mønstre & Indsigter');
      lines.push('');
      lines.push(patterns);
      lines.push('');
    }

    // LLM calls section
    const llmSummary = this._getLLMCallsSummary(stepName);
    if (llmSummary) {
      lines.push('---');
      lines.push('## 🤖 LLM Kald');
      lines.push('');
      lines.push(llmSummary);
      lines.push('');
    }

    // Sample data section
    const samples = this._generateSamples(stepName, output, context);
    if (samples) {
      lines.push('---');
      lines.push('## 📋 Eksempler');
      lines.push('');
      lines.push(samples);
    }

    return lines.join('\n');
  }

  /**
   * Format step name for display
   * @private
   */
  _formatStepName(stepName) {
    return stepName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Format input data based on step type
   * @private
   */
  _formatInput(stepName, input, context) {
    const lines = [];

    switch (stepName) {
      case 'load-data':
        lines.push('*Starter fra database*');
        lines.push('');
        lines.push(`- Hearing ID: ${context.hearingId || 'N/A'}`);
        break;

      case 'material-summary':
        lines.push(`- **Materialer:** ${input?.materials?.length || 0}`);
        if (input?.materials?.length > 0) {
          const totalChars = input.materials.reduce((sum, m) => 
            sum + (m.contentMd?.length || m.content?.length || 0), 0);
          lines.push(`- **Total tekst:** ${totalChars.toLocaleString()} tegn`);
        }
        break;

      case 'analyze-material':
        lines.push(`- **Materialer:** ${input?.materials?.length || 0}`);
        if (input?.materialSummary) {
          lines.push(`- **Opsummering:** ${input.materialSummary.length.toLocaleString()} tegn`);
        }
        break;

      case 'extract-substance':
        lines.push(`- **Materialer:** ${input?.materials?.length || 0}`);
        lines.push(`- **Dokument type:** ${input?.documentType || 'auto-detect'}`);
        break;

      case 'edge-case-screening':
        lines.push(`- **Høringssvar:** ${input?.responses?.length || 0}`);
        if (input?.responses?.length > 0) {
          const avgLen = Math.round(
            input.responses.reduce((sum, r) => sum + (r.text?.length || 0), 0) / input.responses.length
          );
          lines.push(`- **Gns. længde:** ${avgLen.toLocaleString()} tegn`);
        }
        break;

      case 'enrich-responses':
        lines.push(`- **Høringssvar:** ${input?.responses?.length || 0}`);
        lines.push(`- **Edge cases:** ${input?.edgeCases?.length || 0}`);
        const withContext = input?.edgeCases?.filter(ec => ec.action === 'analyze-with-context').length || 0;
        lines.push(`- **Behøver kontekst:** ${withContext}`);
        break;

      case 'chunking':
        lines.push(`- **Høringssvar:** ${input?.responses?.length || 0}`);
        lines.push(`- **Materialer:** ${input?.materials?.length || 0}`);
        break;

      case 'embedding':
        lines.push(`- **Chunks:** ${input?.chunks?.length || 0}`);
        if (input?.chunks?.length > 0) {
          const totalChars = input.chunks.reduce((sum, c) => sum + (c.content?.length || 0), 0);
          lines.push(`- **Total tekst:** ${totalChars.toLocaleString()} tegn`);
        }
        break;

      case 'micro-summarize':
        lines.push(`- **Høringssvar:** ${input?.responses?.length || 0}`);
        lines.push(`- **Materiale kontekst:** ${input?.materialContext?.length?.toLocaleString() || 0} tegn`);
        if (input?.taxonomy?.themes) {
          lines.push(`- **Temaer fra taksonomi:** ${input.taxonomy.themes.length}`);
        }
        break;

      case 'citation-registry':
        lines.push(`- **Micro-summaries:** ${input?.microSummaries?.length || 0}`);
        const citationArgs = input?.microSummaries?.reduce((sum, ms) => 
          sum + (ms.arguments?.length || 0), 0) || 0;
        lines.push(`- **Argumenter med citater:** ${citationArgs}`);
        break;
      
      case 'embed-arguments':
        lines.push(`- **Micro-summaries:** ${input?.microSummaries?.length || 0}`);
        const argsToEmbed = input?.microSummaries?.reduce((sum, ms) => 
          sum + (ms.arguments?.length || 0), 0) || 0;
        lines.push(`- **Argumenter at embedde:** ${argsToEmbed}`);
        break;
      
      case 'similarity-analysis':
        lines.push(`- **Høringssvar:** ${input?.responses?.length || 0}`);
        lines.push(`- **Micro-summaries:** ${input?.microSummaries?.length || 0}`);
        break;

      case 'theme-mapping':
        lines.push(`- **Micro-summaries:** ${input?.microSummaries?.length || 0}`);
        const totalArgs = input?.microSummaries?.reduce((sum, ms) => 
          sum + (ms.arguments?.length || 0), 0) || 0;
        lines.push(`- **Argumenter:** ${totalArgs}`);
        break;

      case 'aggregate':
        lines.push(`- **Temaer:** ${input?.themes?.themes?.length || 0}`);
        const argsInThemes = input?.themes?.themes?.reduce((sum, t) => 
          sum + (t.arguments?.length || 0), 0) || 0;
        lines.push(`- **Argumenter:** ${argsInThemes}`);
        break;

      case 'consolidate-positions':
        const posCount = input?.aggregation?.reduce((sum, t) => 
          sum + (t.positions?.length || 0), 0) || 0;
        lines.push(`- **Positioner før:** ${posCount}`);
        lines.push(`- **Temaer:** ${input?.aggregation?.length || 0}`);
        break;

      case 'extract-sub-positions':
        const mainPos = input?.positions?.reduce((sum, t) => 
          sum + (t.positions?.length || 0), 0) || 0;
        lines.push(`- **Positioner:** ${mainPos}`);
        break;

      case 'hybrid-position-writing':
        const positionsToWrite = input?.positions?.reduce((sum, t) => 
          sum + (t.positions?.length || 0), 0) || 0;
        lines.push(`- **Positioner:** ${positionsToWrite}`);
        lines.push(`- **Micro-summaries:** ${input?.microSummaries?.length || 0}`);
        break;

      default:
        // Generic input formatting
        if (input && typeof input === 'object') {
          for (const [key, value] of Object.entries(input)) {
            if (Array.isArray(value)) {
              lines.push(`- **${key}:** ${value.length} items`);
            } else if (typeof value === 'string') {
              lines.push(`- **${key}:** ${value.length.toLocaleString()} tegn`);
            } else if (typeof value === 'number') {
              lines.push(`- **${key}:** ${value}`);
            }
          }
        }
    }

    return lines.length > 0 ? lines.join('\n') : '*Ingen input data*';
  }

  /**
   * Format output data based on step type
   * @private
   */
  _formatOutput(stepName, output, context) {
    const lines = [];

    switch (stepName) {
      case 'load-data':
        lines.push(`- **Høringssvar:** ${output?.responses?.length || 0}`);
        lines.push(`- **Materialer:** ${output?.materials?.length || 0}`);
        if (output?.hearing) {
          lines.push(`- **Høring titel:** ${output.hearing.title || 'N/A'}`);
        }
        break;

      case 'material-summary':
        lines.push(`- **Opsummering længde:** ${output?.length?.toLocaleString() || 0} tegn`);
        // Show full content
        if (output && typeof output === 'string' && output.length > 0) {
          lines.push('');
          lines.push('**Opsummering:**');
          lines.push('```');
          lines.push(output);
          lines.push('```');
        }
        break;

      case 'analyze-material':
        lines.push(`- **Temaer:** ${output?.themes?.length || 0}`);
        lines.push(`- **Dokument type:** ${output?.documentType || 'N/A'}`);
        if (output?.themes?.length > 0) {
          lines.push('');
          lines.push('**Temaer:**');
          output.themes.forEach((t, i) => {
            lines.push(`${i + 1}. ${t.name}`);
          });
        }
        break;

      case 'extract-substance':
        lines.push(`- **Substans items:** ${output?.items?.length || 0}`);
        lines.push(`- **Dokument type:** ${output?.documentType || 'N/A'}`);
        lines.push(`- **Confidence:** ${((output?.confidence || 0) * 100).toFixed(0)}%`);
        break;

      case 'edge-case-screening':
        if (Array.isArray(output)) {
          const normal = output.filter(e => e.action === 'analyze-normally').length;
          const withContext = output.filter(e => e.action === 'analyze-with-context').length;
          const noOpinion = output.filter(e => e.action === 'no-opinion').length;
          lines.push(`- **Normale:** ${normal}`);
          lines.push(`- **Med kontekst:** ${withContext}`);
          lines.push(`- **Ingen holdning:** ${noOpinion}`);
        }
        break;

      case 'enrich-responses':
        lines.push(`- **Berigede svar:** ${output?.length || 0}`);
        break;

      case 'chunking':
        lines.push(`- **Chunks:** ${output?.length || 0}`);
        if (output?.length > 0) {
          const responseChunks = output.filter(c => c.metadata?.documentType === 'response').length;
          const materialChunks = output.filter(c => c.metadata?.documentType === 'material').length;
          lines.push(`  - Fra høringssvar: ${responseChunks}`);
          lines.push(`  - Fra materialer: ${materialChunks}`);
        }
        break;

      case 'embedding':
        const validEmbeddings = output?.filter(c => c.hasEmbedding || c.embedding)?.length || 0;
        lines.push(`- **Embeddede chunks:** ${validEmbeddings}/${output?.length || 0}`);
        break;

      case 'micro-summarize':
        lines.push(`- **Summaries:** ${output?.length || 0}`);
        const totalArguments = output?.reduce((sum, ms) => sum + (ms.arguments?.length || 0), 0) || 0;
        lines.push(`- **Argumenter:** ${totalArguments}`);
        
        // Show breakdown by analyzability
        if (output?.length > 0) {
          const analyzable = output.filter(ms => ms.analyzable !== false).length;
          const withArgs = output.filter(ms => ms.arguments?.length > 0).length;
          lines.push(`- **Analyserbare:** ${analyzable}/${output.length}`);
          lines.push(`- **Med argumenter:** ${withArgs}/${output.length}`);
        }
        break;
      
      case 'embed-arguments':
        const embeddedCount = output?.filter(a => a.embedding || a.hasEmbedding)?.length || 0;
        lines.push(`- **Argumenter embeddet:** ${embeddedCount}/${output?.length || 0}`);
        
        // Group by response
        if (output?.length > 0) {
          const byResponse = {};
          output.forEach(a => {
            const rn = a.responseNumber || a.metadata?.responseNumber || 'unknown';
            byResponse[rn] = (byResponse[rn] || 0) + 1;
          });
          lines.push('');
          lines.push('**Argumenter per svar:**');
          Object.entries(byResponse).forEach(([rn, count]) => {
            lines.push(`- Svar ${rn}: ${count} argumenter`);
          });
        }
        break;

      case 'citation-registry':
        const citationCount = output?.totalCitations || Object.keys(output?.citations || {}).length || 0;
        const responseCount = output?.totalResponses || (output?.citations ? new Set(Object.values(output.citations).map(c => c.responseNumber)).size : 0);
        lines.push(`- **Citater registreret:** ${citationCount}`);
        lines.push(`- **Svar med citater:** ${responseCount}`);
        
        // Show all citations
        if (output?.citations && Object.keys(output.citations).length > 0) {
          lines.push('');
          lines.push('**Alle citater:**');
          Object.values(output.citations).forEach((c, i) => {
            const quote = c.quote || c.sourceQuote || '';
            lines.push(`${i + 1}. Svar ${c.responseNumber}: "${quote}"`);
          });
        }
        break;

      case 'theme-mapping':
        lines.push(`- **Temaer:** ${output?.themes?.length || 0}`);
        if (output?.themes?.length > 0) {
          lines.push('');
          lines.push('**Temaer med argumenter:**');
          output.themes.forEach(t => {
            lines.push(`- ${t.name}: ${t.arguments?.length || 0} argumenter`);
          });
        }
        break;

      case 'aggregate':
        const positionsAfter = output?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0;
        lines.push(`- **Positioner:** ${positionsAfter}`);
        lines.push(`- **Temaer:** ${output?.length || 0}`);
        break;

      case 'consolidate-positions':
        const consolidatedPos = output?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0;
        lines.push(`- **Positioner efter:** ${consolidatedPos}`);
        
        // Calculate merges from metadata
        let totalMerges = 0;
        let crossThemeMerges = 0;
        output?.forEach(t => {
          if (t._consolidationMeta) {
            totalMerges += t._consolidationMeta.mergesPerformed || 0;
            crossThemeMerges += t._consolidationMeta.crossThemeRemoved || 0;
          }
        });
        if (totalMerges > 0 || crossThemeMerges > 0) {
          lines.push(`- **Interne merges:** ${totalMerges}`);
          lines.push(`- **Cross-theme merges:** ${crossThemeMerges}`);
        }
        
        // Show position distribution
        if (output?.length > 0) {
          lines.push('');
          lines.push('**Positioner per tema:**');
          output.forEach(t => {
            if (t.positions?.length > 0) {
              lines.push(`- ${t.name}: ${t.positions.length} positioner`);
            }
          });
        }
        break;

      case 'extract-sub-positions':
        let totalSubs = 0;
        output?.forEach(t => t.positions?.forEach(p => {
          if (p.subPositions?.length) totalSubs += p.subPositions.length;
        }));
        lines.push(`- **Sub-positioner:** ${totalSubs}`);
        break;

      case 'similarity-analysis':
        lines.push(`- **Mass agreement detected:** ${output?.massAgreementDetected?.detected ? 'Ja' : 'Nej'}`);
        if (output?.massAgreementDetected?.detected) {
          lines.push(`- **Confidence:** ${((output.massAgreementDetected.confidence || 0) * 100).toFixed(0)}%`);
        }
        if (output?.clusterAnalysis) {
          lines.push(`- **Diversity score:** ${(output.clusterAnalysis.diversityScore || 0).toFixed(2)}`);
          lines.push(`- **Clusters:** ${output.clusterAnalysis.clusterCount || 0}`);
        }
        if (output?.recommendations) {
          lines.push('');
          lines.push('**Anbefalinger:**');
          lines.push(`- Consolidation threshold: ${output.recommendations.consolidationThreshold?.toFixed(3) || 'N/A'}`);
          lines.push(`- Strategy: ${output.recommendations.consolidationStrategy || 'N/A'}`);
        }
        break;
      
      case 'validate-positions':
        const validatedCount = output?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0;
        lines.push(`- **Validerede positioner:** ${validatedCount}`);
        
        // Show validation results from context
        if (context?.artifacts?.validatedPositions?._validationMeta) {
          const meta = context.artifacts.validatedPositions._validationMeta;
          if (meta.issueCount > 0) {
            lines.push(`- **Issues fundet:** ${meta.issueCount}`);
          }
          if (meta.fixesApplied > 0) {
            lines.push(`- **Fixes anvendt:** ${meta.fixesApplied}`);
          }
        }
        break;

      case 'hybrid-position-writing':
        const writtenPos = output?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0;
        lines.push(`- **Skrevne positioner:** ${writtenPos}`);
        break;

      case 'format-output':
        lines.push(`- **Markdown længde:** ${output?.markdown?.length?.toLocaleString() || 0} tegn`);
        lines.push(`- **JSON topics:** ${output?.json?.topics?.length || 0}`);
        break;

      case 'build-docx':
        lines.push(`- **DOCX fil:** ${output || 'N/A'}`);
        break;

      default:
        // Generic output formatting
        if (output && typeof output === 'object') {
          if (Array.isArray(output)) {
            lines.push(`- **Items:** ${output.length}`);
          } else {
            for (const [key, value] of Object.entries(output).slice(0, 5)) {
              if (Array.isArray(value)) {
                lines.push(`- **${key}:** ${value.length} items`);
              } else if (typeof value === 'string') {
                lines.push(`- **${key}:** ${value.length.toLocaleString()} tegn`);
              } else if (typeof value === 'number') {
                lines.push(`- **${key}:** ${value}`);
              } else if (typeof value === 'boolean') {
                lines.push(`- **${key}:** ${value ? 'Ja' : 'Nej'}`);
              }
            }
          }
        } else if (typeof output === 'string') {
          lines.push(`- **Resultat:** ${output.length.toLocaleString()} tegn`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : '*Ingen output data*';
  }

  /**
   * Generate statistics for a step
   * @private
   */
  _generateStats(stepName, input, output, context) {
    const lines = [];

    switch (stepName) {
      case 'load-data':
        if (output?.responses?.length > 0) {
          const lengths = output.responses.map(r => r.text?.length || 0);
          const avg = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
          const min = Math.min(...lengths);
          const max = Math.max(...lengths);
          lines.push('| Metrik | Værdi |');
          lines.push('|--------|-------|');
          lines.push(`| Gns. svar længde | ${avg.toLocaleString()} tegn |`);
          lines.push(`| Korteste svar | ${min.toLocaleString()} tegn |`);
          lines.push(`| Længste svar | ${max.toLocaleString()} tegn |`);
        }
        break;

      case 'micro-summarize':
        if (output?.length > 0) {
          const argCounts = output.map(ms => ms.arguments?.length || 0);
          const avgArgs = (argCounts.reduce((a, b) => a + b, 0) / argCounts.length).toFixed(1);
          const maxArgs = Math.max(...argCounts);
          lines.push('| Metrik | Værdi |');
          lines.push('|--------|-------|');
          lines.push(`| Gns. argumenter/svar | ${avgArgs} |`);
          lines.push(`| Max argumenter | ${maxArgs} |`);
          lines.push(`| Svar uden argumenter | ${argCounts.filter(c => c === 0).length} |`);
        }
        break;

      case 'theme-mapping':
        if (output?.themes?.length > 0) {
          const argsByTheme = output.themes.map(t => t.arguments?.length || 0);
          lines.push('| Tema | Argumenter |');
          lines.push('|------|------------|');
          output.themes.forEach(t => {
            lines.push(`| ${t.name} | ${t.arguments?.length || 0} |`);
          });
        }
        break;

      case 'consolidate-positions':
        if (output) {
          const after = output.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
          const before = context?.preConsolidation || (context?.artifacts?.aggregation?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || after);
          const reduction = before - after;
          const percent = before > 0 ? ((reduction / before) * 100).toFixed(1) : '0';
          lines.push('| Metrik | Værdi |');
          lines.push('|--------|-------|');
          lines.push(`| Før konsolidering | ${before} |`);
          lines.push(`| Efter konsolidering | ${after} |`);
          lines.push(`| Reduceret med | ${reduction} (${percent}%) |`);
          
          // Response distribution
          const allResponses = new Set();
          output.forEach(t => t.positions?.forEach(p => p.responseNumbers?.forEach(r => allResponses.add(r))));
          lines.push(`| Svar repræsenteret | ${allResponses.size} |`);
        }
        break;
      
      case 'embed-arguments':
        if (output?.length > 0) {
          const embedded = output.filter(a => a.embedding || a.hasEmbedding).length;
          lines.push('| Metrik | Værdi |');
          lines.push('|--------|-------|');
          lines.push(`| Total argumenter | ${output.length} |`);
          lines.push(`| Embeddet | ${embedded} |`);
          lines.push(`| Success rate | ${((embedded / output.length) * 100).toFixed(0)}% |`);
        }
        break;
      
      case 'citation-registry':
        if (output?.citations) {
          const citations = Object.values(output.citations);
          const byResponse = {};
          citations.forEach(c => {
            byResponse[c.responseNumber] = (byResponse[c.responseNumber] || 0) + 1;
          });
          
          lines.push('| Metrik | Værdi |');
          lines.push('|--------|-------|');
          lines.push(`| Total citater | ${citations.length} |`);
          lines.push(`| Svar med citater | ${Object.keys(byResponse).length} |`);
          lines.push(`| Gns. citater per svar | ${(citations.length / Object.keys(byResponse).length).toFixed(1)} |`);
        }
        break;
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * Analyze patterns in the output
   * @private
   */
  _analyzePatterns(stepName, output, context) {
    const lines = [];

    switch (stepName) {
      case 'edge-case-screening':
        if (Array.isArray(output)) {
          const withRefs = output.filter(e => e.referencedNumbers?.length > 0);
          if (withRefs.length > 0) {
            lines.push('**Krydsreferencer fundet:**');
            withRefs.forEach(e => {
              lines.push(`- Svar ${e.responseNumber} → refererer til svar ${e.referencedNumbers.join(', ')}`);
            });
          }
        }
        break;

      case 'micro-summarize':
        if (output?.length > 0) {
          // Find common themes across arguments
          const themeCounts = {};
          output.forEach(ms => {
            ms.arguments?.forEach(arg => {
              arg.relevantThemes?.forEach(theme => {
                themeCounts[theme] = (themeCounts[theme] || 0) + 1;
              });
            });
          });
          
          const sorted = Object.entries(themeCounts).sort((a, b) => b[1] - a[1]);
          if (sorted.length > 0) {
            lines.push('**Hyppigste temaer i argumenter:**');
            sorted.slice(0, 5).forEach(([theme, count]) => {
              lines.push(`- ${theme}: ${count} forekomster`);
            });
          }
        }
        break;

      case 'aggregate':
        if (output?.length > 0) {
          // Find positions with most respondents
          const allPositions = output.flatMap(t => 
            (t.positions || []).map(p => ({ ...p, theme: t.name }))
          );
          const sorted = allPositions.sort((a, b) => 
            (b.responseNumbers?.length || 0) - (a.responseNumbers?.length || 0)
          );
          
          if (sorted.length > 0) {
            lines.push('**Positioner med flest respondenter:**');
            sorted.slice(0, 3).forEach((p, i) => {
              lines.push(`${i + 1}. "${p.title}" (${p.responseNumbers?.length || 0} respondenter) - ${p.theme}`);
            });
          }
        }
        break;

      case 'validate-positions':
        if (context?.validation?.issues?.length > 0) {
          lines.push('**Validerings-issues:**');
          context.validation.issues.forEach(issue => {
            lines.push(`- [${issue.severity}] ${issue.type}: ${issue.message || 'N/A'}`);
          });
        }
        break;
      
      case 'consolidate-positions':
        if (output?.length > 0) {
          // Find positions with most respondents after consolidation
          const allPositions = output.flatMap(t => 
            (t.positions || []).map(p => ({ ...p, theme: t.name }))
          );
          const sorted = allPositions.sort((a, b) => 
            (b.responseNumbers?.length || 0) - (a.responseNumbers?.length || 0)
          );
          
          if (sorted.length > 0 && sorted[0].responseNumbers?.length > 1) {
            lines.push('**Største positioner efter konsolidering:**');
            sorted.filter(p => (p.responseNumbers?.length || 0) > 1).forEach((p, i) => {
              const respondents = p.responseNumbers?.length || 0;
              lines.push(`${i + 1}. "${p.title}" (${respondents} respondenter) - ${p.theme}`);
            });
          }
          
          // Show cross-theme merges if any
          const crossThemePositions = allPositions.filter(p => p._mergedFrom?.length > 0);
          if (crossThemePositions.length > 0) {
            lines.push('');
            lines.push('**Cross-theme merges:**');
            crossThemePositions.forEach((p, i) => {
              lines.push(`${i + 1}. "${p.title}" ← merged from ${p._mergedFrom.length} positions`);
            });
          }
        }
        break;
      
      case 'embed-arguments':
        if (output?.length > 0) {
          // Show distribution of arguments across responses
          const byResponse = {};
          output.forEach(a => {
            const rn = a.responseNumber || 'unknown';
            byResponse[rn] = (byResponse[rn] || 0) + 1;
          });
          
          const maxArgs = Math.max(...Object.values(byResponse));
          const minArgs = Math.min(...Object.values(byResponse));
          const avgArgs = (output.length / Object.keys(byResponse).length).toFixed(1);
          
          lines.push('**Argument-fordeling:**');
          lines.push(`- Gns. per svar: ${avgArgs}`);
          lines.push(`- Min: ${minArgs}, Max: ${maxArgs}`);
        }
        break;
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * Get LLM calls summary for current step
   * @private
   */
  _getLLMCallsSummary(stepName) {
    if (!this.runDirManager) return null;

    const llmCallsDir = this.runDirManager.getLLMCallsDir();
    const lines = [];

    try {
      const files = readdirSync(llmCallsDir).filter(f => f.includes(stepName)).sort();
      
      if (files.length === 0) return null;

      // Group by request/response
      const requests = files.filter(f => f.includes('_request'));
      const responses = files.filter(f => f.includes('_response'));

      // Calculate total tokens if responses available
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      
      for (const respFile of responses) {
        try {
          const respPath = join(llmCallsDir, respFile);
          const respData = JSON.parse(readFileSync(respPath, 'utf-8'));
          const usage = respData.payload?.usage || respData.usage;
          if (usage) {
            totalInputTokens += usage.input_tokens || usage.prompt_tokens || 0;
            totalOutputTokens += usage.output_tokens || usage.completion_tokens || 0;
          }
        } catch (e) { /* ignore */ }
      }

      lines.push(`**Antal LLM kald:** ${requests.length}`);
      if (totalInputTokens > 0 || totalOutputTokens > 0) {
        lines.push(`**Tokens:** ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output`);
      }
      lines.push('');

      // Read and show all calls
      for (let i = 0; i < requests.length; i++) {
        const reqFile = requests[i];
        if (!reqFile) continue;

        try {
          const reqPath = join(llmCallsDir, reqFile);
          const reqData = JSON.parse(readFileSync(reqPath, 'utf-8'));
          
          // Model and messages are in payload
          const payload = reqData.payload || reqData;
          const model = payload.model || reqData.model || 'unknown';
          const messages = payload.messages || reqData.messages || [];
          const promptLen = messages.length > 0 
            ? messages.map(m => m.content?.length || 0).reduce((a, b) => a + b, 0)
            : 0;
          
          lines.push(`<details>`);
          lines.push(`<summary>Kald ${i + 1}: ${model} (${promptLen.toLocaleString()} tegn prompt)</summary>`);
          lines.push('');
          
          // Show full prompt (last user message)
          if (messages.length > 0) {
            const userMsgs = messages.filter(m => m.role === 'user');
            const lastMsg = userMsgs[userMsgs.length - 1] || messages[messages.length - 1];
            const content = lastMsg?.content || '';
            lines.push('**Prompt:**');
            lines.push('```');
            lines.push(content);
            lines.push('```');
          }

          // Find matching response by request ID or sequence number
          const reqNum = reqFile.match(/^(\d+)-/)?.[1];
          const respFile = responses.find(f => {
            const respNum = f.match(/^(\d+)-/)?.[1];
            // Match by sequence number (close enough)
            return respNum && reqNum && Math.abs(parseInt(respNum) - parseInt(reqNum)) <= 1;
          }) || responses.find(f => f.includes(stepName));
          
          if (respFile) {
            try {
              const respPath = join(llmCallsDir, respFile);
              const respData = JSON.parse(readFileSync(respPath, 'utf-8'));
              
              // Response content is in payload.content
              const respPayload = respData.payload || respData;
              const respContent = respPayload.content || 
                                  respData.choices?.[0]?.message?.content || 
                                  '';
              
              if (respContent) {
                lines.push('');
                lines.push('**Response:**');
                lines.push('```json');
                lines.push(respContent);
                lines.push('```');
                
                // Show token usage for this call
                const usage = respPayload.usage || respData.usage;
                if (usage) {
                  lines.push('');
                  lines.push(`*Tokens: ${usage.input_tokens || usage.prompt_tokens || 0} in, ${usage.output_tokens || usage.completion_tokens || 0} out*`);
                }
              }
            } catch (e) {
              // Ignore response read errors
            }
          }

          lines.push('</details>');
          lines.push('');
        } catch (e) {
          // Ignore individual file read errors
        }
      }


    } catch (err) {
      // Directory doesn't exist or can't be read
      return null;
    }

    return lines.length > 1 ? lines.join('\n') : null;
  }

  /**
   * Generate sample data from output
   * @private
   */
  _generateSamples(stepName, output, context) {
    const lines = [];

    switch (stepName) {
      case 'load-data':
        if (output?.responses?.length > 0) {
          lines.push('**Alle høringssvar:**');
          output.responses.forEach((r, i) => {
            lines.push('');
            lines.push(`<details>`);
            lines.push(`<summary>Svar ${r.id}: ${r.respondentName || 'Anonym'} (${(r.text?.length || 0).toLocaleString()} tegn)</summary>`);
            lines.push('');
            lines.push('```');
            lines.push(r.text || '');
            lines.push('```');
            lines.push('</details>');
          });
        }
        break;

      case 'micro-summarize':
        if (output?.length > 0) {
          lines.push('**Alle micro-summaries:**');
          output.forEach((sample) => {
            lines.push('');
            lines.push(`<details>`);
            lines.push(`<summary>Svar ${sample.responseNumber} (${sample.arguments?.length || 0} argumenter)</summary>`);
            lines.push('');
            if (sample.arguments?.length > 0) {
              sample.arguments.forEach((arg, i) => {
                lines.push(`**Argument ${i + 1}:**`);
                lines.push(`- **Hvad:** ${arg.what || 'N/A'}`);
                lines.push(`- **Hvorfor:** ${arg.why || 'N/A'}`);
                lines.push(`- **Hvordan:** ${arg.how || 'N/A'}`);
                if (arg.sourceQuote) {
                  lines.push(`- **Citat:** "${arg.sourceQuote}"`);
                }
                lines.push('');
              });
            } else {
              lines.push('*Ingen argumenter identificeret*');
            }
            lines.push('</details>');
          });
        }
        break;

      case 'aggregate':
      case 'consolidate-positions':
      case 'hybrid-position-writing':
        if (output?.length > 0) {
          lines.push('**Alle positioner:**');
          output.forEach(theme => {
            if (theme.positions?.length > 0) {
              lines.push('');
              lines.push(`### ${theme.name}`);
              theme.positions.forEach((pos, i) => {
                lines.push('');
                lines.push(`<details>`);
                lines.push(`<summary>${i + 1}. ${pos.title} (${pos.responseNumbers?.length || 0} respondenter)</summary>`);
                lines.push('');
                lines.push(`**Respondenter:** ${pos.responseNumbers?.join(', ') || 'N/A'}`);
                if (pos.summary) {
                  lines.push('');
                  lines.push('**Sammenfatning:**');
                  lines.push(pos.summary);
                }
                if (pos.subPositions?.length > 0) {
                  lines.push('');
                  lines.push('**Sub-positioner:**');
                  pos.subPositions.forEach((sub, j) => {
                    lines.push(`- ${sub.title || sub.summary || 'N/A'}`);
                  });
                }
                lines.push('</details>');
              });
            }
          });
        }
        break;

      case 'extract-substance':
        if (output?.items?.length > 0) {
          lines.push('**Alle substans items:**');
          output.items.forEach((item, i) => {
            lines.push('');
            lines.push(`<details>`);
            lines.push(`<summary>${i + 1}. ${item.title} (${item.reference || 'ingen ref'})</summary>`);
            lines.push('');
            if (item.description) {
              lines.push(item.description);
            }
            lines.push('</details>');
          });
        }
        break;
      
      case 'embed-arguments':
        if (output?.length > 0) {
          lines.push('**Alle argumenter:**');
          output.forEach((arg, i) => {
            const what = arg.metadata?.what || arg.text || 'N/A';
            lines.push(`${i + 1}. Svar ${arg.responseNumber}: "${what}"`);
          });
        }
        break;
      
      case 'citation-registry':
        if (output?.citations && Object.keys(output.citations).length > 0) {
          lines.push('**Alle citater:**');
          Object.values(output.citations).forEach((c, i) => {
            lines.push('');
            lines.push(`<details>`);
            lines.push(`<summary>${c.id}: Svar ${c.responseNumber}</summary>`);
            lines.push('');
            lines.push(`"${c.quote || c.sourceQuote || 'N/A'}"`);
            lines.push('</details>');
          });
        }
        break;
      
      case 'similarity-analysis':
        if (output?.similarPairs?.length > 0) {
          lines.push('**Alle lignende svar-par:**');
          output.similarPairs.forEach((pair, i) => {
            lines.push(`${i + 1}. Svar ${pair.response1} ↔ Svar ${pair.response2} (similarity: ${(pair.similarity * 100).toFixed(0)}%)`);
          });
        }
        break;
      
      case 'validate-positions':
        // Show validation issues if present
        if (Array.isArray(output)) {
          // Find positions that were split or merged
          const positionsWithMeta = output.flatMap(t => 
            (t.positions || []).filter(p => p._validationFix)
          );
          if (positionsWithMeta.length > 0) {
            lines.push('**Positioner med validerings-fixes:**');
            positionsWithMeta.forEach((p, i) => {
              lines.push(`${i + 1}. "${p.title}" - ${p._validationFix}`);
            });
          }
        }
        break;
      
      case 'validate-coverage':
        if (output?.length > 0) {
          // Find "Ingen holdning" positions
          const noOpinionTheme = output.find(t => 
            t.positions?.some(p => p.title?.includes('Ingen holdning'))
          );
          if (noOpinionTheme) {
            const noOpinionPos = noOpinionTheme.positions.find(p => p.title?.includes('Ingen holdning'));
            if (noOpinionPos?.responseNumbers?.length > 0) {
              lines.push(`**Svar uden identificeret holdning:**`);
              lines.push(`Svar ${noOpinionPos.responseNumbers.join(', ')} (${noOpinionPos.responseNumbers.length} svar)`);
            }
          }
        }
        break;
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }
}
