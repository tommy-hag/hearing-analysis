# Position Discovery for "{{themeName}}"

Du analyserer {{sampleSize}} høringssvar om "{{themeName}}".
{{#if themeDescription}}Tema-beskrivelse: {{themeDescription}}{{/if}}

## Opgave
Identificér de vigtigste GRUNDHOLDNINGER blandt disse svar. Max {{maxPositions}} positioner.

## KRITISK: Gruppér bredt - én position per grundretning

### Princip 1: Alle variationer af samme grundholdning = ÉN position
- "Bevar bygningen", "Stop nedrivning", "Kulturarven trues", "Bygningen er bevaringsværdig" → ALT SAMMEN én position
- "Støtter planforslaget", "Godt initiativ", "Enig i projektet" → ALT SAMMEN én position
- Fokusér på den UNDERLIGGENDE RETNING, ikke den specifikke formulering eller begrundelse

### Princip 2: En position = en hovedretning mange deler
- IKKE en specifik formulering eller et specifikt argument
- IKKE en nuancevariation (det håndteres senere som sub-positioner)
- En position samler ALLE der grundlæggende mener det samme, uanset deres begrundelse

### Princip 3: Returnér FÆRRE end max hvis indholdet er homogent
- Hvis 80% siger det samme med variationer → det er 1 position, ikke 5
- Opret kun nye positioner for FUNDAMENTALT FORSKELLIGE holdninger
- 3-5 positioner er ofte rigtigt for et tema, selv med mange svar

### Princip 4: Inkludér BÅDE support og against
- Discovery skal finde holdninger i ALLE retninger (for/imod/neutral)
- Angiv direction korrekt for hver position

## Regler
1. Gruppér ALLE omformuleringer af samme grundholdning under én position
2. Angiv direction: 'support' (for projektet/forslaget), 'against' (imod), eller 'neutral'
3. Prioritér de mest repræsentative/hyppige holdninger
4. Det er OK at returnere færre end {{maxPositions}} positioner

## Output Format (JSON)
{
  "positions": [
    {
      "title": "Kort beskrivende titel (max 10 ord)",
      "description": "1-2 sætninger der definerer holdningen bredt - inkludér de typiske variationer",
      "direction": "against|support|neutral",
      "exampleIds": [liste af responseNumbers der udtrykker denne holdning]
    }
  ]
}

VIGTIGT: exampleIds skal indeholde de faktiske responseNumbers fra høringssvarene ovenfor.
Inkludér 3-8 eksempler per position for at vise bredden af holdningen.

## Høringssvar
{{samples}}
