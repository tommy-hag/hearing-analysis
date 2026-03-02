# Substans-ekstraktion fra høringsmateriale

## Dokumenttype: {documentType}
{documentDescription}

## Din opgave
Find SUBSTANSEN i materialet - det der faktisk reguleres, ændres eller foreslås.
Dette er det høringssvarene skal matches mod.

{typeInstructions}

{learnedPatterns}

## Materiale
{materialText}

## Output format
Returnér JSON:
```json
{
  "items": [
    {
      "id": "unik_id",
      "reference": "§ 6" eller "Afsnit 3.2" eller "Mål 1",
      "title": "Kort titel",
      "content": "Konkret indhold/bestemmelse/forslag",
      "keywords": ["nøgleord", "for", "matching"],
      "category": "regulation|proposal|goal|condition|other"
    }
  ],
  "documentType": "{documentType}",
  "confidence": 0.0-1.0,
  "suggestedNewPatterns": []
}
```

## Regler
1. Fokusér på KONKRET indhold, ikke generelle beskrivelser
2. Inkludér de faktiske værdier (højder, procenter, grænser)
3. Hver item skal kunne stå alene som reference for høringssvar
4. Hvis dokumenttypen er ukendt, find det der ligner regulering/forslag
5. Hvis du opdager nye mønstre der ikke er dækket, tilføj dem til `suggestedNewPatterns`

## Type-specifikke instruktioner

### For lokalplaner:

**KRITISK: Fokusér KUN på BESTEMMELSER-sektionen (§§), IKKE redegørelsen!**

Lokalplaner har to hoveddele:
1. **REDEGØRELSE** (beskrivende tekst, baggrund) - SKAL IGNORERES
2. **BESTEMMELSER** (§ 1-13, juridisk bindende) - DETTE SKAL EKSTRAHERES

**Regler:**
- Find ALLE § bestemmelser (§ 1, § 2, ... § 13 osv.)
- Ekstraher det KONKRETE indhold af hver paragraf
- Inkludér tal: højder (m), procenter, antal, grænser
- IGNORER redegørelsestekst som "Fremtidige trafikforhold", "Baggrund", "Eksisterende forhold"

**ID FORMAT (KRITISK):**
- Brug formatet `LP-§{nummer}` for hvert § afsnit
- Eksempler: `LP-§1`, `LP-§2`, `LP-§5`, `LP-§6`
- For stykker: `LP-§5-stk2` (stykke 2 i § 5)
- For generelle bestemmelser uden §: `LP-GEN`

**Eksempel output:**
```json
{
  "id": "LP-§6",
  "reference": "§ 6 Bebyggelsens omfang og placering",
  "title": "Bebyggelsens omfang",
  "content": "Bebyggelsesprocent maks 150. Bygningshøjde maks 22m i delområde I, 12m i delområde II.",
  "keywords": ["bebyggelsesprocent", "højde", "22m", "12m"],
  "category": "regulation"
}
```

### For dispensationer:
- Find hvad der dispenseres FRA (den oprindelige regel)
- Find hvad der dispenseres TIL (den nye tilladelse)
- Identificér betingelser og vilkår
- Eksempel: "Dispensation fra § 6.2 om maks højde 8m. Tillades 10,5m mod at facade tilbagerykkes 2m."

### For partshøringer:
- Find de faktiske forhold i sagen
- Identificér hvad der skal træffes afgørelse om
- Find relevante oplysninger og dokumentation

### For politikker/strategier:
- Find konkrete mål og ambitioner
- Identificér foreslåede tiltag og prioriteringer
- Find målbare indikatorer hvis de findes

### For ukendt dokumenttype:
- Find alt der ligner regulering, bestemmelser eller forslag
- Se efter strukturerede afsnit med nummerering
- Identificér konkrete krav, grænser eller mål
- Beskriv eventuelle nye mønstre i `suggestedNewPatterns`
