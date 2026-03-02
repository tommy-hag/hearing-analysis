/**
 * Considerations Generator
 *
 * Generates analytical and strategic considerations about the analysis process.
 * Identifies key grouping decisions, thematic challenges, and analytical choices.
 *
 * Uses ULTRA complexity LLM for high-verbosity analytical narrative.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { StepLogger } from '../utils/step-logger.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ConsiderationsGenerator {
  constructor(options = {}) {
    this.log = new StepLogger('ConsiderationsGenerator');
    // Use HEAVY complexity for analytical text with moderate detail
    // (gpt-5-mini with medium verbosity and reasoning)
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'heavy');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    
    this.useLLM = options.useLLM !== false; // Enable LLM by default
    this._jobId = options.jobId || null;

    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/comprehensive-considerations-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[ConsiderationsGenerator] Could not load prompt template');
      this.promptTemplate = null;
    }
  }

  /**
   * Set job ID for LLM tracing
   * @param {string} jobId - Job ID for tracing
   */
  setJobId(jobId) {
    this._jobId = jobId;
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
  }

  /**
   * Set run directory for LLM call logging
   * @param {string} llmCallsDir - Directory for LLM call logs
   */
  setRunDirectory(llmCallsDir) {
    this._llmCallsDir = llmCallsDir;
    if (this.client?.tracer?.setRunDirectory) {
      this.client.tracer.setRunDirectory(llmCallsDir);
    }
  }

  /**
   * Generate comprehensive considerations about the analysis
   * @param {Object} artifacts - Pipeline artifacts (microSummaries, themes, aggregation)
   * @returns {Promise<string>} Formatted considerations text
   */
  async generateConsiderations(artifacts) {
    const responseCount = artifacts.microSummaries?.length || 0;
    const themeCount = artifacts.themes?.themes?.length || 0;
    const positionCount = (artifacts.aggregation || []).reduce((sum, t) => sum + (t.positions?.length || 0), 0);

    this.log.start({ responses: responseCount, themes: themeCount, positions: positionCount });

    // If LLM is enabled and we have a prompt template, use LLM-based generation
    if (this.useLLM && this.promptTemplate && this.client) {
      try {
        this.log.info('Using LLM-based generation');
        const result = await this.generateWithLLM(artifacts);
        this.log.complete({ method: 'LLM', chars: result.length });
        return result;
      } catch (error) {
        this.log.warn('LLM generation failed, falling back to rule-based', { error: error.message });
        // Fall back to rule-based if LLM fails
      }
    }

    // Fall back to rule-based generation
    this.log.info('Using rule-based generation');
    const result = this.generateRuleBased(artifacts);
    this.log.complete({ method: 'rule-based', chars: result.length });
    return result;
  }
  
  /**
   * Generate considerations using LLM with high verbosity
   * @private
   */
  async generateWithLLM(artifacts) {
    // Extract key statistics for the prompt
    const stats = this.extractStatistics(artifacts);
    
    // Build prompt
    const prompt = this.buildPrompt(stats, artifacts);
    
    // Call LLM
    const response = await this.client.createCompletion({
      messages: [
        {
          role: 'system',
          content: 'Du er en erfaren analytiker, der specialiserer dig i at evaluere og beskrive analytiske processer og beslutninger i høringsanalyser. Du giver dybdegående, nuancerede analyser med høj detaljegrad.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });
    
    const considerations = response.choices[0]?.message?.content || '';
    
    // Ensure we have content
    if (!considerations.trim()) {
      throw new Error('Empty considerations from LLM');
    }
    
    return considerations;
  }
  
  /**
   * Extract statistics from artifacts for LLM prompt
   * @private
   */
  extractStatistics(artifacts) {
    const microSummaries = artifacts.microSummaries || [];
    const themes = artifacts.themes?.themes || [];
    const aggregation = artifacts.aggregation || [];
    
    // Calculate key statistics
    const stats = {
      responseCount: microSummaries.length,
      themeCount: themes.length,
      positionCount: aggregation.reduce((sum, t) => sum + (t.positions?.length || 0), 0),
      
      // Multi-type positions
      mixedTypePositions: 0,
      citizenOnlyPositions: 0,
      officialOnlyPositions: 0,
      
      // Large positions
      largePositions: [],
      
      // Theme distribution
      themeStats: [],
      
      // Multi-theme arguments
      multiThemeArguments: 0,
      totalArguments: 0,
      
      // Respondent breakdown
      totalCitizens: 0,
      totalLocalCommittees: 0,
      totalOrganizations: 0,
      totalPublicAuth: 0
    };
    
    // Analyze positions
    aggregation.forEach(theme => {
      const themeData = { name: theme.name, positions: theme.positions?.length || 0, largestPosition: 0 };
      
      theme.positions?.forEach(position => {
        const breakdown = position.respondentBreakdown || {};
        const responseCount = position.responseNumbers?.length || 0;
        
        // Track largest position in theme
        if (responseCount > themeData.largestPosition) {
          themeData.largestPosition = responseCount;
        }
        
        // Count large positions
        if (responseCount >= 5) {
          stats.largePositions.push({
            theme: theme.name,
            title: position.title,
            count: responseCount
          });
        }
        
        // Count mixed type positions
        const hasMultipleTypes = [
          (breakdown.publicAuthorities?.length || 0) > 0,
          (breakdown.localCommittees?.length || 0) > 0,
          (breakdown.organizations?.length || 0) > 0,
          (breakdown.citizens || 0) > 0
        ].filter(Boolean).length > 1;
        
        if (hasMultipleTypes) {
          stats.mixedTypePositions++;
        } else if ((breakdown.publicAuthorities?.length || 0) > 0 || 
                   (breakdown.localCommittees?.length || 0) > 0 || 
                   (breakdown.organizations?.length || 0) > 0) {
          stats.officialOnlyPositions++;
        } else {
          stats.citizenOnlyPositions++;
        }
        
        // Aggregate respondent counts
        stats.totalCitizens += breakdown.citizens || 0;
        stats.totalLocalCommittees += breakdown.localCommittees?.length || 0;
        stats.totalOrganizations += breakdown.organizations?.length || 0;
        stats.totalPublicAuth += breakdown.publicAuthorities?.length || 0;
      });
      
      stats.themeStats.push(themeData);
    });
    
    // Analyze arguments
    microSummaries.forEach(summary => {
      const args = summary.arguments || [];
      stats.totalArguments += args.length;
      
      args.forEach(arg => {
        if (arg.relevantThemes && arg.relevantThemes.length > 1) {
          stats.multiThemeArguments++;
        }
      });
    });
    
    // Theme distribution
    themes.forEach(theme => {
      stats.themeStats.forEach(ts => {
        if (ts.name === theme.name) {
          ts.argumentCount = theme.arguments?.length || 0;
        }
      });
    });
    
    return stats;
  }
  
  /**
   * Build prompt for LLM generation
   * @private
   */
  buildPrompt(stats, artifacts) {
    const largestPosition = stats.largePositions.length > 0 ? 
      stats.largePositions.sort((a, b) => b.count - a.count)[0] : null;
    
    const sparseThemes = stats.themeStats.filter(t => 
      t.argumentCount <= 2 && t.argumentCount > 0 && t.name !== 'Andre emner'
    );
    
    const andreEmnerTheme = stats.themeStats.find(t => t.name === 'Andre emner');
    const andreEmnerPercentage = andreEmnerTheme && stats.totalArguments > 0 ?
      Math.round((andreEmnerTheme.argumentCount / stats.totalArguments) * 100) : 0;
    
    const totalRespondents = stats.totalCitizens + stats.totalLocalCommittees + 
                            stats.totalOrganizations + stats.totalPublicAuth;
    const citizenPct = totalRespondents > 0 ? 
      Math.round((stats.totalCitizens / totalRespondents) * 100) : 0;
    const officialPct = 100 - citizenPct;
    
    return `# Analytisk opgave: Skriv ÉT kort, kvalitativt afsnit om høringssvarene

Du skal skrive ÉT ENKELT afsnit (3-5 sætninger) der giver læseren en fornemmelse 
af hvad der kendetegner høringssvarene.

KRITISK:
- KUN ét afsnit - ikke flere sektioner
- KVALITATIVT (ikke kvantitativt) - undgå tal og procenter
- Giv en "fornemmelse" af hvad folk bekymrer sig om
- Skriv som om du fortæller en kollega: "Høringssvarene handler primært om..."
- Max 5 sætninger

## Statistik fra høringssvarene:

**Grundlæggende:**
- ${stats.responseCount} høringssvar analyseret
- ${stats.positionCount} holdninger identificeret på tværs af ${stats.themeCount} temaer
- ${stats.totalArguments} argumenter i alt

**Grupperingsstrategi:**
- ${stats.mixedTypePositions} holdninger grupperer argumenter fra flere respondent-typer (borgere, organisationer, myndigheder)
- ${stats.citizenOnlyPositions} holdninger kun fra borgere
- ${stats.officialOnlyPositions} holdninger kun fra officielle aktører
${largestPosition ? `- Største holdning: "${largestPosition.title}" (${largestPosition.count} respondenter, tema: "${largestPosition.theme}")` : ''}

**Tematisk fordeling:**
${stats.themeStats.map(t => `- ${t.name}: ${t.argumentCount || 0} argumenter → ${t.positions} holdninger`).join('\n')}
${sparseThemes.length > 0 ? `- Temaer med få argumenter: ${sparseThemes.map(t => t.name).join(', ')}` : ''}
${andreEmnerPercentage > 20 ? `- ${andreEmnerPercentage}% af argumenter placeret i "Andre emner"-temaet` : ''}

**Kompleksitet:**
- ${stats.multiThemeArguments} argumenter relevant for flere temaer
- ${((stats.multiThemeArguments / stats.totalArguments) * 100).toFixed(0)}% tværgående argumenter

**Respondent-diversitet:**
- Borgere: ${stats.totalCitizens} (${citizenPct}%)
- Lokaludvalg: ${stats.totalLocalCommittees}
- Organisationer: ${stats.totalOrganizations}
- Offentlige myndigheder: ${stats.totalPublicAuth}
- Officielle aktører i alt: ${officialPct}%

## Din opgave:

Skriv ÉT ENKELT, sammenhængende afsnit (3-5 sætninger) der beskriver:

**Hvad kendetegner høringssvarene?**
- Hvad bekymrer folk sig primært om? (kvalitativt - ikke tal!)
- Hvilke emner dominerer, hvilke får mindre opmærksomhed?
- Er der bred enighed eller forskellige synspunkter?

**VIGTIGT:** Fokusér på SUBSTANSEN af bekymringerne, ikke på hvem der giver input (undgå "77% borgere" osv.)

**Eksempel på god stil:**
"Høringssvarene er primært præget af borgeres bekymringer om boldbanen og 
skolebygningens placering nær eksisterende boliger. Der er bred enighed blandt 
naboer om støjgener, mens lokaludvalg og myndigheder fokuserer mere på 
trafiksikkerhed og boligsammensætning. Overordnet set handler høringen om 
balancen mellem områdets udvikling og hensynet til de nuværende beboere."

## Krav:

- ÉT afsnit kun (3-5 sætninger max)
- KVALITATIVT sprog - undgå tal, procenter, præcise counts
- Fortæl HVAD folk bekymrer sig om, ikke statistik
- Blød, neutral tone som til en kollega
- Format som:

**Analytiske overvejelser**
[ét sammenhængende afsnit på 3-5 sætninger]
`;
  }
  
  /**
   * Generate considerations using rule-based approach (fallback)
   * @private
   */
  generateRuleBased(artifacts) {
    const sections = [];
    
    // 1. Grouping strategy considerations
    const groupingConsiderations = this.analyzeGroupingStrategy(artifacts);
    if (groupingConsiderations) {
      sections.push(`*Grupperingsstrategi og -overvejelser*\n${groupingConsiderations}`);
    }
    
    // 2. Thematic decisions
    const thematicConsiderations = this.analyzeThematicDecisions(artifacts);
    if (thematicConsiderations) {
      sections.push(`*Tematiske beslutninger*\n${thematicConsiderations}`);
    }
    
    // 3. Important nuances and simplifications
    const nuances = this.analyzeNuancesAndSimplifications(artifacts);
    if (nuances) {
      sections.push(`*Væsentlige nuancer og forenklinger*\n${nuances}`);
    }
    
    // 4. Diversity of perspectives
    const diversityAnalysis = this.analyzeDiversity(artifacts);
    if (diversityAnalysis) {
      sections.push(`*Perspektiv-diversitet*\n${diversityAnalysis}`);
    }
    
    return sections.length > 0 
      ? sections.join('\n\n')
      : 'Analysen fulgte standardprocessen uden særlige analytiske dilemmaer.';
  }
  
  /**
   * Analyze grouping strategy and key decisions
   */
  analyzeGroupingStrategy(artifacts) {
    const considerations = [];
    const aggregation = artifacts.aggregation || [];
    
    // Analyze positions with diverse respondent types
    let mixedTypePositions = 0;
    let citizenOnlyPositions = 0;
    let officialOnlyPositions = 0;
    
    aggregation.forEach(theme => {
      theme.positions?.forEach(position => {
        const breakdown = position.respondentBreakdown || {};
        const hasMultipleTypes = [
          (breakdown.publicAuthorities?.length || 0) > 0,
          (breakdown.localCommittees?.length || 0) > 0,
          (breakdown.organizations?.length || 0) > 0,
          (breakdown.citizens || 0) > 0
        ].filter(Boolean).length > 1;
        
        if (hasMultipleTypes) {
          mixedTypePositions++;
        } else if ((breakdown.publicAuthorities?.length || 0) > 0 || 
                   (breakdown.localCommittees?.length || 0) > 0 || 
                   (breakdown.organizations?.length || 0) > 0) {
          officialOnlyPositions++;
        } else {
          citizenOnlyPositions++;
        }
      });
    });
    
    if (mixedTypePositions > 0) {
      considerations.push(
        `${mixedTypePositions} holdning${mixedTypePositions > 1 ? 'er' : ''} grupperer argumenter fra flere respondent-typer (borgere, organisationer, myndigheder), hvilket indikerer bred enighed på tværs af interessegrupper.`
      );
    }
    
    // Analyze large groupings
    const largePositions = [];
    aggregation.forEach(theme => {
      theme.positions?.forEach(position => {
        const count = position.responseNumbers?.length || 0;
        if (count >= 5) {
          largePositions.push({ theme: theme.name, count, title: position.title });
        }
      });
    });
    
    if (largePositions.length > 0) {
      const topPosition = largePositions.sort((a, b) => b.count - a.count)[0];
      considerations.push(
        `Størst e enkelt holdning samler ${topPosition.count} respondenter omkring "${topPosition.title}" under temaet "${topPosition.theme}", hvilket indikerer en central bekymring i høringssvarene.`
      );
    }
    
    return considerations.length > 0 ? considerations.join(' ') : null;
  }
  
  /**
   * Analyze thematic decisions and ambiguous cases
   */
  analyzeThematicDecisions(artifacts) {
    const considerations = [];
    const themes = artifacts.themes?.themes || [];
    const aggregation = artifacts.aggregation || [];
    
    // Count arguments per theme
    const themeStats = themes.map(theme => ({
      name: theme.name,
      argumentCount: theme.arguments?.length || 0
    })).filter(t => t.argumentCount > 0);
    
    // Check for themes with very few arguments
    const sparseThemes = themeStats.filter(t => t.argumentCount <= 2 && t.name !== 'Andre emner');
    if (sparseThemes.length > 0) {
      considerations.push(
        `${sparseThemes.length} tema${sparseThemes.length > 1 ? 'er' : ''} modtog få argumenter (${sparseThemes.map(t => `"${t.name}": ${t.argumentCount}`).join(', ')}), hvilket kan indikere enten begrænset interesse for disse emner eller tvetydighed i tematisk placering.`
      );
    }
    
    // Check for "Andre emner" theme concentration
    const andreEmnerThemeCheck = themeStats.find(t => t.name === 'Andre emner');
    if (andreEmnerThemeCheck && andreEmnerThemeCheck.argumentCount > 0) {
      const totalArguments = themeStats.reduce((sum, t) => sum + t.argumentCount, 0);
      const andreEmnerPercentageCheck = Math.round((andreEmnerThemeCheck.argumentCount / totalArguments) * 100);
      
      if (andreEmnerPercentageCheck > 20) {
        considerations.push(
          `${andreEmnerPercentageCheck}% af argumenterne blev placeret i "Andre emner"-temaet, hvilket indikerer enten tværgående bekymringer eller argumenter der ikke passer i den tematiske struktur.`
        );
      }
    }
    
    return considerations.length > 0 ? considerations.join(' ') : null;
  }
  
  /**
   * Analyze nuances and analytical simplifications
   */
  analyzeNuancesAndSimplifications(artifacts) {
    const considerations = [];
    const microSummaries = artifacts.microSummaries || [];
    
    // Analyze argument complexity
    let complexArguments = 0;
    let multiThemeArguments = 0;
    
    microSummaries.forEach(summary => {
      summary.arguments?.forEach(arg => {
        // Check for multi-theme arguments
        if (arg.relevantThemes && arg.relevantThemes.length > 1) {
          multiThemeArguments++;
        }
        
        // Check for complex arguments (long content, multiple concerns)
        const contentLength = (arg.coreContent || '').length + (arg.concern || '').length;
        if (contentLength > 400) {
          complexArguments++;
        }
      });
    });
    
    if (multiThemeArguments > 0) {
      considerations.push(
        `${multiThemeArguments} argument${multiThemeArguments > 1 ? 'er' : ''} er relevant for flere temaer og er derfor inkluderet under flere holdninger for at sikre fuldstændig dækning.`
      );
    }
    
    if (complexArguments > 5) {
      considerations.push(
        `${complexArguments} argument${complexArguments > 1 ? 'er' : ''} indeholder omfattende teknisk eller nuanceret indhold, som er komprimeret i opsummeringen for at passe i den strukturerede format.`
      );
    }
    
    return considerations.length > 0 ? considerations.join(' ') : null;
  }
  
  /**
   * Analyze diversity of perspectives
   */
  analyzeDiversity(artifacts) {
    const considerations = [];
    const aggregation = artifacts.aggregation || [];
    
    // Count respondent types
    const allBreakdowns = aggregation.flatMap(theme => 
      theme.positions?.map(p => p.respondentBreakdown) || []
    );
    
    const totalCitizens = allBreakdowns.reduce((sum, b) => sum + (b?.citizens || 0), 0);
    const totalLocalCommittees = allBreakdowns.reduce((sum, b) => 
      sum + (b?.localCommittees?.length || 0), 0);
    const totalOrganizations = allBreakdowns.reduce((sum, b) => 
      sum + (b?.organizations?.length || 0), 0);
    const totalPublicAuth = allBreakdowns.reduce((sum, b) => 
      sum + (b?.publicAuthorities?.length || 0), 0);
    
    const total = totalCitizens + totalLocalCommittees + totalOrganizations + totalPublicAuth;
    
    if (total > 0) {
      const citizenPct = Math.round((totalCitizens / total) * 100);
      const officialPct = Math.round(((totalLocalCommittees + totalOrganizations + totalPublicAuth) / total) * 100);
      
      if (officialPct > 30) {
        considerations.push(
          `Høringssvarene viser bred deltagelse med ${officialPct}% fra offentlige myndigheder, lokaludvalg og organisationer, hvilket indikerer institutionel interesse ud over borgernes individuelle bekymringer.`
        );
      } else if (citizenPct > 80) {
        considerations.push(
          `Høringssvarene er primært fra borgere (${citizenPct}%), hvilket giver et stærkt billede af lokalbefolkningens bekymringer men begrænset institutionel input.`
        );
      }
    }
    
    return considerations.length > 0 ? considerations.join(' ') : null;
  }
}

