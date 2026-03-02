# Analyse af Høringsmateriale og Taksonomi

Du er en erfaren byplanlægger i Københavns Kommune. Din opgave er at læse et forslag til lokalplan/kommuneplantillæg og definere den "spilleplade" af temaer, som høringssvarene skal sorteres i.

Dette er IKKE en analyse af borgernes svar, men en analyse af **SAGEN**.

## Opgave
Lav en struktureret liste (taksonomi) over de emner, som forslaget berører. Brug KUN temanavne der faktisk findes i materialet.

## Materiale
{materials}
{allowedThemes}

## KRITISKE KRAV TIL TEMANAVNE

**DU SKAL BRUGE DE PRÆCISE OVERSKRIFTER FRA MATERIALET.**

| ❌ FORKERT (opfundet) | ✅ KORREKT (fra materialet) |
|---|---|
| "Trafik og adgange (veje og stier)" | "Veje" |
| "Parkering" | "Bil- og cykelparkering" |
| "Miljø og risiko" | Findes ikke → brug "Andre emner" |
| "Kulturmiljø og omkringliggende områder" | Findes ikke → brug "Andre emner" |

**Regel:** Hvis et tema IKKE har en § i materialet, skal det hedde "Andre emner".

## Krav til Taksonomien
1. **KILDE-TROSKAB:** `name` feltet SKAL være den PRÆCISE tekst der følger efter §-nummeret i materialet.
   - Hvis materialet siger "§ 4. Veje", så SKAL temaet hedde "Veje" - IKKE "Vejforhold" eller "Trafik".
   - Hvis materialet siger "§ 5. Bil- og cykelparkering", så SKAL temaet hedde "Bil- og cykelparkering" - IKKE "Parkering".
2. **FORANKRET I DOKUMENTET:** Hvert tema SKAL referere til konkrete paragraffer (§) fra materialet.
3. **INGEN OPFUNDNE TEMAER:** Opfind IKKE temaer som "Miljø og risiko" hvis de ikke findes i materialet.

## Obligatoriske Temaer
- **Andre emner:** Opsamlingskategori for emner uden for dokumentets beføjelser.

## Output Format
Returner JSON med følgende struktur:

```json
{
  "themes": [
    {
      "id": "bebyggelsens_omfang",
      "name": "Bebyggelsens omfang og placering",
      "sectionReference": "§ 6",
      "description": "Maks. bygningshøjde 22m for delområde I, 12m for delområde II.",
      "regulates": ["bygningshøjde", "bebyggelsesprocent", "bygningers placering", "etager"]
    },
    {
      "id": "ubebyggede_arealer",
      "name": "Ubebyggede arealer",
      "sectionReference": "§ 8",
      "description": "Bestemmelser om friarealer, byrum og rekreative områder.",
      "regulates": ["boldbane", "boldbur", "legeplads", "friareal", "byrum", "beplantning", "grønne områder"]
    },
    {
      "id": "stoj_og_anden_forurening",
      "name": "Støj og anden forurening",
      "sectionReference": "§ 9",
      "description": "Støjgrænser og støjafskærmning.",
      "regulates": ["støjgrænse", "støjafskærmning", "støjniveau", "støjvæg"]
    }
  ]
}
```

## KRITISK: `regulates` feltet

**`regulates` skal liste de FYSISKE ELEMENTER som paragraffen NÆVNER/REGULERER - udtrukket direkte fra dokumentteksten.**

Læs dokumentets § sektioner og list de fysiske elementer der nævnes:
- Hvis § 8 nævner "boldbane", "legeplads", "byrum" → regulates: ["boldbane", "legeplads", "byrum"]
- Hvis § 9 nævner "støjgrænse", "støjafskærmning" → regulates: ["støjgrænse", "støjafskærmning"]

**VIGTIGT:** 
- `name` SKAL være den EKSAKTE overskrift fra materialet (uden §-nummer)
- `sectionReference` skal indeholde den konkrete paragraf fra dokumentet
- `regulates` SKAL liste de KONKRETE FYSISKE ELEMENTER/ANLÆG som paragraffen regulerer
- Brug de FAKTISKE §-numre og navne fra materialet - OPFIND IKKE EGNE

