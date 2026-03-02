# Udtrækning af nuancerede underargumenter

## OPGAVE

Du skal identificere distinkte underargumenter inden for en samlet position fra en høring.

## DATAINPUT

**Position under analyse:**
- Titel: {{POSITION_TITLE}}
- Antal respondenter: {{RESPONDENT_COUNT}}
- Antal sammenlagte positioner: {{MERGE_COUNT}}
- Overordnet sammenfatning: {{POSITION_SUMMARY}}

**Oprindelige positionstitler (før samling):**
{{MERGED_TITLES}}

**Oprindelige positionssammenfatninger:**
{{ORIGINAL_SUMMARIES}}

**Korte sammendrag fra hver respondent:**
{{MICRO_SUMMARIES}}

## KONTEKST

Dette er en samlet position med {{RESPONDENT_COUNT}} respondenter, dannet ved at sammenlægge {{MERGE_COUNT}} oprindelige positioner.
{{MASS_AGREEMENT_NOTE}}
{{OBJECT_CONCENTRATION_NOTE}}

## DIN OPGAVE

Identificér **2-8 distinkte underargumenter** inden for denne position. Lad diversiteten i argumenterne bestemme antallet.

Underargumenter skal dele samme overordnede mål (derfor er de samlet), men have forskellige nuancer i hvad der ønskes, hvorfor det ønskes, eller hvordan det skal opnås.

Det er værdifuldt at identificere alle relevante nuancer - selv med få respondenter - frem for at overse vigtige argumenter.

## ANALYSERAMME

Udled dimensionerne direkte fra de faktiske argumenter. Led efter forskelle i tre dimensioner:

**1. HVAD der ønskes (mål):**
Hvilke konkrete ting ønsker respondenterne? Er der forskelle i omfang, fokusområde eller prioritering?

**2. HVORFOR det ønskes (begrundelse):**
Hvilke begrundelsestyper bruger respondenterne? Typiske dimensioner kan inkludere (men er ikke begrænset til):
- Miljø/klima-hensyn
- Kulturel/historisk værdi
- Æstetik/visuel kvalitet
- Funktionalitet/anvendelse
- Sociale/fællesskabshensyn
- Økonomiske argumenter
- Demokrati/proces-bekymringer
- Natur/biodiversitet
- Trafik/infrastruktur

Udled de faktiske dimensioner fra argumenterne - brug ikke en forudbestemt liste.

**3. HVORDAN det skal opnås (metode):**
Hvilke konkrete metoder eller handlinger foreslår respondenterne?

## VALIDITESKRITERIER

- Et underargument er gyldigt selv med kun én respondent, hvis argumentet er unikt
- Fokusér på indhold, ikke antal - 1 person med ét argument og 44 med et andet udgør begge gyldige underargumenter
{{OVERLAP_RULE}}

## TILDELING AF RESPONDENTER

**Kritisk proces for hvert underargument:**

1. Gennemgå hver respondents korte sammendrag individuelt
2. Vurdér om denne specifikke respondent nævner dette specifikke underargument
3. Inkludér kun respondentens nummer hvis de faktisk støtter dette underargument

**VIGTIG DISTINKTION - MASTER-ONLY vs. SUB-POSITION:**

Mange respondenter udtrykker KUN den overordnede holdning uden specifik nuance. Disse skal IKKE tvinges ind i et underargument.

**Sådan identificerer du master-only respondenter:**
1. Respondentens `why`-felt er "Ikke specificeret" → master-only
2. Respondentens originale tekst er meget kort (< 50 tegn) → master-only
3. Respondenten har ingen begrundelse eller nuance i deres argument → master-only

- **Master-only respondent:** Udtrykker kun den overordnede holdning uden begrundelse, `why: "Ikke specificeret"` → tilføj til `masterOnlyRespondents`
- **Sub-position respondent:** Udtrykker den overordnede holdning MED specifik begrundelse eller nuance → tilføj til relevant sub-position

**Aldrig antag at en respondent støtter et argument uden eksplicit belæg i deres sammendrag.**
**Aldrig opret et "Generel holdning" sub-argument - det er master-holdningen selv.**

## OUTPUT-FORMAT

Returnér JSON med følgende struktur:

```json
{
  "subPositions": [
    {
      "title": "Kort beskrivende titel for underargumentet",
      "what": "Hvad der konkret ønskes",
      "why": "Begrundelse for ønsket",
      "how": "Metode til at opnå det",
      "responseNumbers": [1, 4, 7, 12],
      "summary": "Kort sammenfatning af dette underargument"
    }
  ],
  "masterOnlyRespondents": [3, 8, 15],
  "confidence": 0.85
}
```

**FORKLARING AF FELTER:**

- **subPositions:** Respondenter med specifikke nuancer/begrundelser (IKKE "generel holdning")
- **masterOnlyRespondents:** Respondenter der KUN udtrykker den overordnede holdning uden specifik nuance. Disse har typisk korte svar uden yderligere argumentation.
```

## KVALITETSKRAV

- Alle {{RESPONDENT_COUNT}} respondentnumre skal være repræsenteret - enten i et underargument ELLER i `masterOnlyRespondents`
- Underargumenter må overlappe (samme respondent kan støtte flere underargumenter)
- Respondenter i `masterOnlyRespondents` må IKKE også være i et underargument (de har kun den generelle holdning)
- Basér fordelingen på de korte sammendrag og oprindelige positionstitler
- Opret IKKE et "Generel holdning" eller "Generel bevarelse" underargument - brug `masterOnlyRespondents` i stedet
