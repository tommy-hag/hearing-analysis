/**
 * Isoleret test: Kan en LLM vælge "Ubebyggede arealer og byrum" for boldbane-casen?
 * 
 * Kør med: node scripts/test-theme-verification.js
 */

import { OpenAIClientWrapper as OpenAIClient } from '../src/utils/openai-client.js';

// Test-data: Boldbane-argumentet fra response 6
const testArgument = {
  what: "Boldburet bør placeres så tæt på Gl. Køge Landevej som muligt",
  why: "For at undgå støjgener for beboere i Dahlia Hus og omkringliggende bygninger; offentlig adgang kan give støj døgnet rundt",
  how: "Placere anlægget tættere på Gl. Køge Landevej",
  concern: "Fortsat støjgener for nabobeboelser, mulig nat- og aftenstøj fra offentligt adgangsareal",
  currentTheme: "Støj og anden forurening"  // Det tema LLM'en valgte
};

// Taksonomien fra analyze-material.json
const themes = [
  { name: "Generel holdning til forslaget", description: "Overordnet vurdering af projektets fortolkning og acceptabilitet af lokalplanens formål og konsekvenser, herunder støj, trafik og byrum." },
  { name: "Bebyggelsens omfang og placering", description: "Maksimal højde og omfang af nybyggeri samt fordeling af etageantal og placering i delområderne. Refererer til § 6 (Bebyggelsens omfang og placering)." },
  { name: "Støj og anden forurening", description: "Overtrædelse af støjgrænser, støjafskærmning og akustiske tiltag for at overholde indendørs grænseværdier. Refererer til § 9 (Støj og anden forurening) og detaljer om støjisolering og støjskærm." },
  { name: "Trafik og vejintegration", description: "Krav til veje, stier, adgangsforhold og trafikbalance i området, herunder to overkørsler, ensrettet bøjlevej og cykelstier. Refererer til § 4 (Veje) og § 5 (Bil- og cykelparkering)." },
  { name: "Ubebyggede arealer og byrum", description: "Plads til friarealer, byrum, kantzoner og beplantning, herunder hvordan ubebyggede arealer skal bruges til ophold og rekreation. Refererer til § 8 (Ubebyggede arealer) og til afsnit om byrum og kantzoner." },
];

// RAG-kontekst: Relevant materiale om hvad der reguleres HVOR
const ragContext = [
  {
    reference: "§ 8",
    title: "Ubebyggede arealer",
    content: "REGULERER: Friarealer, byrum, rekreative anlæg (herunder boldbaner, legepladser), beplantning, belægning, kantzoner. Fysiske elementer som boldbaner, boldburet og lignende udendørs faciliteter hører under denne paragraf."
  },
  {
    reference: "Afsnit: Byrum",
    title: "Plint, byrum og kantzoner",
    content: "REGULERER: Skolens friareal, byrum, kantzoner, beplantningsprocenter. Fysiske elementer i byrummet og ubebyggede arealer."
  },
  {
    reference: "§ 9",
    title: "Støj og anden forurening",
    content: "REGULERER: Støjafskærmning, indendørs støjniveauer, støjgrænser. NB: Regulerer AFSKÆRMNING mod støj, ikke placeringen af støjkilder."
  },
  {
    reference: "§ 6",
    title: "Bebyggelsens omfang og placering", 
    content: "REGULERER: Bygningshøjde, etageantal, placering af bygninger i delområder."
  }
];

async function runTest() {
  console.log('=== TEST: LLM Theme Verification ===\n');
  
  const client = new OpenAIClient({
    model: 'gpt-5-nano'  // Samme model som pipeline
  });
  
  // Formatér temaer til prompt
  const themesText = themes.map(t => `- ${t.name}: ${t.description}`).join('\n');
  
  // Formatér RAG-kontekst til prompt
  const ragText = ragContext.map(r => `- [${r.reference}] ${r.title}: ${r.content}`).join('\n');
  
  const prompt = `Du er en erfaren kommunal planlægger. Din opgave er at finde det KORREKTE tema for et høringssvar-argument.

## KRITISK PRINCIP
Temaet bestemmes af HVOR I LOKALPLANEN det fysiske element REGULERES - IKKE hvad borgeren er bekymret for.

Eksempel på korrekt tænkning:
- Argument handler om "parkeringsplads støjgener" 
- Fysisk element = parkeringsplads
- Parkeringspladser reguleres i § 5 (Parkering)
- Korrekt tema = det tema der dækker § 5, IKKE "Støj"

## ARGUMENT FRA HØRINGSSVAR
- HVAD: ${testArgument.what}
- HVORFOR: ${testArgument.why}
- HVORDAN: ${testArgument.how}
- BEKYMRING: ${testArgument.concern}

## HØRINGSMATERIALETS STRUKTUR (hvad reguleres hvor)
${ragText}

## TILGÆNGELIGE TEMAER
${themesText}

## DIN OPGAVE - FØLG DISSE TRIN:

**TRIN 1: Identificer det FYSISKE ELEMENT**
Hvad er det konkrete, fysiske element argumentet handler om? (bygning, vej, boldbane, parkeringsplads, etc.)

**TRIN 2: Find hvor elementet REGULERES**
Søg i høringsmaterialets struktur ovenfor. Under hvilken paragraf (§) eller afsnit reguleres dette fysiske element?

**TRIN 3: Match til tema**
Hvilket tema i taksonomien svarer til den paragraf/afsnit der regulerer elementet?

Svar i JSON:
{
  "fysiskElement": "Det identificerede fysiske element",
  "reguleresUnder": "Den paragraf/afsnit hvor elementet reguleres",
  "reasoning": "Din analyse",
  "correctTheme": "Det korrekte tema-navn baseret på regulering",
  "currentThemeWasCorrect": true/false
}`;

  console.log('Sender prompt til LLM...');
  console.log('(gpt-5-nano bruger Responses API - kan tage 1-3 minutter)\n');
  
  const startTime = Date.now();
  
  try {
    const response = await client.createCompletion({
      messages: [
        { role: 'system', content: 'Du er en præcis og analytisk assistent. Svar kun i valid JSON.' },
        { role: 'user', content: prompt }
      ]
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`LLM svarede efter ${duration}s\n`);
    
    // Debug: Log full response structure
    console.log('=== RAW RESPONSE STRUCTURE ===');
    console.log('response keys:', Object.keys(response));
    console.log('has choices:', !!response.choices);
    if (response.choices) {
      console.log('choices[0] keys:', Object.keys(response.choices[0] || {}));
    }
    
    // Extract content from OpenAI response structure
    const content = response.choices?.[0]?.message?.content;
    
    console.log('\n=== LLM RESPONS ===');
    console.log(content);
    
    if (!content) {
      console.error('\n❌ FEJL: Ingen content i response!');
      console.log('Full response:', JSON.stringify(response, null, 2).slice(0, 2000));
      return;
    }
    
    const result = JSON.parse(content);
    console.log('\n=== PARSED RESULTAT ===');
    console.log('Fysisk element:', result.fysiskElement);
    console.log('Reguleres under:', result.reguleresUnder);
    console.log('Reasoning:', result.reasoning);
    console.log('Correct Theme:', result.correctTheme);
    console.log('Current theme was correct:', result.currentThemeWasCorrect);
    
    if (result.correctTheme === 'Ubebyggede arealer og byrum') {
      console.log('\n✅ SUCCESS: LLM identificerede korrekt tema baseret på REGULERING!');
    } else if (!result.currentThemeWasCorrect) {
      console.log('\n⚠️ LLM sagde temaet er forkert, anbefaler:', result.correctTheme);
    } else {
      console.log('\n❌ LLM mente det nuværende tema var korrekt');
    }
    
  } catch (error) {
    console.error('Fejl:', error.message);
    console.error(error.stack);
  }
}

runTest();
