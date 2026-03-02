/**
 * Theme Optimization Script ("The Theme Harvester")
 * 
 * Dette script "lærer" fra tidligere pipeline-kørsler for at forbedre theme-templates.json.
 * 
 * FUNKTION:
 * 1. Scanner output-mappen for tidligere kørsler.
 * 2. Finder 'Generelt' (usorterede) argumenter fra theme-mapping.json.
 * 3. Finder faktiske dokument-strukturer fra analyze-material.json.
 * 4. Sender det hele til LLM for at få forslag til nye keywords og temaer.
 * 5. Gemmer forslagene i 'theme-optimization-report.json'.
 * 
 * BRUG:
 * node scripts/optimize-themes.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { OpenAIClientWrapper, getComplexityConfig } from '../src/utils/openai-client.js';

// Setup stier
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

// Load environment variables
dotenv.config({ path: path.join(PROJECT_ROOT, 'config/.env') });

// Konfiguration
const CONFIG = {
    outputDir: path.join(PROJECT_ROOT, 'output'),
    templatePath: path.join(PROJECT_ROOT, 'config/theme-templates.json'),
    promptPath: path.join(PROJECT_ROOT, 'prompts/theme-optimization-prompt.md'),
    reportPath: path.join(PROJECT_ROOT, 'theme-optimization-report.json'),
    maxArgumentsToAnalyze: 150, // Begrænsning for at spare tokens
    sampleSizePerFile: 20 // Hvor mange argumenter vi tager fra hver fil
};

/**
 * Rekursiv funktion til at finde filer i undermapper
 */
async function findFiles(dir, filenamePattern) {
    let results = [];
    try {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const file of list) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                const subResults = await findFiles(fullPath, filenamePattern);
                results = results.concat(subResults);
            } else if (file.name === filenamePattern) {
                results.push(fullPath);
            }
        }
    } catch (err) {
        // Ignorer fejl ved læsning af mapper (fx permissions)
    }
    return results;
}

/**
 * Hovedfunktion
 */
async function main() {
    console.log('🚀 Starter Theme Optimization Script...');

    // 1. Indlæs nuværende template
    console.log(`📖 Indlæser template fra: ${CONFIG.templatePath}`);
    let currentTemplate;
    try {
        currentTemplate = JSON.parse(fs.readFileSync(CONFIG.templatePath, 'utf-8'));
    } catch (error) {
        console.error(`Fejl: Kunne ikke læse template fil: ${error.message}`);
        return;
    }

    // 2. Find "orphan" argumenter (fra Generelt/Andet temaer i tidligere kørsler)
    console.log(`🔍 Scanner output-mappe for 'theme-mapping.json'...`);
    const mappingFiles = await findFiles(CONFIG.outputDir, 'theme-mapping.json');
    console.log(`   Fandt ${mappingFiles.length} filer.`);

    let orphanArguments = [];
    for (const file of mappingFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            // Find "Generelt" eller "Andet" temaer
            const generalThemes = data.themes?.filter(t => 
                ['Generelt', 'Andet', 'General', 'Other'].includes(t.name)
            ) || [];

            for (const theme of generalThemes) {
                if (theme.arguments && Array.isArray(theme.arguments)) {
                    // Tag en stikprøve for at undgå dubletter og for meget data
                    const sample = theme.arguments
                        .slice(0, CONFIG.sampleSizePerFile)
                        .map(arg => ({
                            content: arg.coreContent || arg.concern || arg.what,
                            originalContext: arg.relevantThemes ? arg.relevantThemes.join(', ') : 'None'
                        }));
                    orphanArguments.push(...sample);
                }
            }
        } catch (e) {
            console.warn(`   Kunne ikke læse ${file}: ${e.message}`);
        }
    }

    // Begræns mængden af argumenter
    if (orphanArguments.length > CONFIG.maxArgumentsToAnalyze) {
        console.log(`   Sampler ${CONFIG.maxArgumentsToAnalyze} argumenter ud af ${orphanArguments.length}...`);
        orphanArguments = orphanArguments.sort(() => 0.5 - Math.random()).slice(0, CONFIG.maxArgumentsToAnalyze);
    } else {
        console.log(`   Fandt ${orphanArguments.length} usorterede argumenter at lære fra.`);
    }

    // 3. Find observerede strukturer (fra analyze-material.json)
    console.log(`🔍 Scanner output-mappe for 'analyze-material.json' (dokumentstrukturer)...`);
    const structureFiles = await findFiles(CONFIG.outputDir, 'analyze-material.json');
    let observedStructures = [];
    
    for (const file of structureFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (data.themes) {
                const themeNames = data.themes.map(t => t.name);
                // Brug mappens navn som kilde-ID (fx job_223_timestamp)
                const sourceName = path.basename(path.dirname(file));
                observedStructures.push({ source: sourceName, themes: themeNames });
            }
        } catch (e) {}
    }
    console.log(`   Fandt ${observedStructures.length} dokumentstrukturer.`);

    if (orphanArguments.length === 0 && observedStructures.length === 0) {
        console.log('❌ Ingen data fundet at lære fra. Kør pipelinen mindst én gang først.');
        return;
    }

    // 4. Klargør prompt til LLM
    console.log('🧠 Forbereder analyse med LLM...');
    
    const promptTemplate = fs.readFileSync(CONFIG.promptPath, 'utf-8');
    const filledPrompt = promptTemplate
        .replace('{templateContext}', JSON.stringify(currentTemplate.documentTypes.lokalplan || {}, null, 2))
        .replace('{argumentContext}', JSON.stringify(orphanArguments, null, 2))
        .replace('{structureContext}', JSON.stringify(observedStructures.slice(0, 5), null, 2)); // Tag kun de 5 nyeste strukturer

    // 5. Kald OpenAI
    // Hent konfiguration baseret på miljøvariabler og ønsket kompleksitet
    const complexityConfig = getComplexityConfig('heavy'); // Brug 'heavy' profil fra env (fx gpt-5-mini med high verbosity)
    
    const client = new OpenAIClientWrapper({
        model: complexityConfig.model,
        verbosity: complexityConfig.verbosity,
        reasoningEffort: complexityConfig.reasoningEffort
    });

    console.log('🤖 Sender forespørgsel til OpenAI (dette kan tage lidt tid)...');
    
    try {
        const response = await client.createCompletion({
            messages: [
                { role: 'system', content: 'Du er en ekspert i optimering af NLP-pipelines.' },
                { role: 'user', content: filledPrompt }
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "theme_optimization_report",
                    strict: true,
                    schema: {
                        type: "object",
                        properties: {
                            summary: { type: "string", description: "Kort sammenfatning af analysen" },
                            keywordSuggestions: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        targetTheme: { type: "string", description: "Navnet på temaet i templaten" },
                                        addKeywords: { type: "array", items: { type: "string" }, description: "Nye keywords der bør tilføjes" },
                                        reasoning: { type: "string", description: "Hvorfor disse ord skal mappes her (fx håndtering af 'herlighedsværdi')" }
                                    },
                                    required: ["targetTheme", "addKeywords", "reasoning"],
                                    additionalProperties: false
                                }
                            },
                            newThemeSuggestions: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        description: { type: "string" },
                                        keywords: { type: "array", items: { type: "string" } },
                                        category: { type: "string", enum: ["regulation", "general"] }
                                    },
                                    required: ["name", "description", "keywords", "category"],
                                    additionalProperties: false
                                }
                            }
                        },
                        required: ["summary", "keywordSuggestions", "newThemeSuggestions"],
                        additionalProperties: false
                    }
                }
            }
        });

        // 6. Gem rapporten
        const content = response.choices[0].message.content;
        const report = JSON.parse(content);
        
        console.log('✅ Analyse færdig!');
        console.log(`📝 Gemmer rapport til: ${CONFIG.reportPath}`);
        
        fs.writeFileSync(CONFIG.reportPath, JSON.stringify(report, null, 2), 'utf-8');

        // 7. Vis resultat i konsollen
        console.log('\n--- RESUMÉ AF FORSLAG ---');
        console.log(report.summary);
        console.log('\nEKSEMPLER PÅ KEYWORD-FORBEDRINGER:');
        if (report.keywordSuggestions.length > 0) {
            report.keywordSuggestions.slice(0, 3).forEach(s => {
                console.log(`- Tema: "${s.targetTheme}" -> Tilføj: [${s.addKeywords.join(', ')}]`);
                console.log(`  Grund: ${s.reasoning}`);
            });
        } else {
            console.log("(Ingen keyword forbedringer fundet)");
        }

        if (report.newThemeSuggestions.length > 0) {
            console.log('\nFORSLAG TIL NYE TEMAER:');
            report.newThemeSuggestions.forEach(t => {
                console.log(`- ${t.name}: ${t.description}`);
            });
        }

        console.log(`\nSe den fulde rapport i ${CONFIG.reportPath} for at implementere ændringerne.`);

    } catch (error) {
        console.error("Fejl under OpenAI kald eller parsing:", error);
    }
}

main().catch(console.error);
