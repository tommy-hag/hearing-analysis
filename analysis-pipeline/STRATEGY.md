# STRATEGY.md - Høringsanalyse Strategidokument

> **Dette dokument beskriver de dybere strategiske principper bag systemet.**
> CLAUDE.md fokuserer på HOW (implementering), dette dokument fokuserer på WHY (formål og afvejninger).
> Dette er et levende dokument der opdateres løbende når nye heuristikker opdages.

---

## 1. Mission (Kerneopgave)

Systemet har to ligeværdige mål:

1. **Fair repræsentation**: Sikre at ALLE borgerstemmer bliver hørt og repræsenteret sandfærdigt uden forvrængning
2. **Beslutningsstøtte**: Strukturere output så kommunale sagsbehandlere og politikere kan træffe informerede beslutninger

Regulatorisk/juridisk mapping er den **implicitte struktur** - borgerne skriver frit i deres eget sprog, men output organiseres efter hvor i høringsmaterialet deres bekymringer håndteres. Dette gør det nemt for kommunen at vide hvor de skal handle.

Systemet ofrer bevidst kortfattethed til fordel for **sporbarhed og ansvarlighed**. Enhver påstand skal kunne føres tilbage til en konkret borger og et eksakt citat.

---

## 2. Fundamentale Principper

| Princip | Hvorfor | Konsekvens |
|---------|---------|------------|
| **100% respondent-dækning** | Demokratisk legitimitet - ingen stemme må tabes | Pipeline fejler hvis en respondent mangler |
| **Citatintegritet** | Troværdighed - alle påstande kan verificeres, høringsnotater kan påklages | 1:1 copy-paste, aldrig parafrasering |
| **Ydmyg inferens** | Bevar autenticitet - gæt aldrig hvad borgeren mente | "Ikke specificeret" > opfundet begrundelse |
| **Dynamisk adaptation** | Hvert høringsmateriale er unikt - ingen hardcoding | System tilpasser sig automatisk |
| **Nuance i enighed** | Vis demokratisk vægt OG bevar granularitet | Mange enige = vigtigt, men find nuancer |

---

## 3. Regulatorisk Mapping (Kerneprincip)

### Princip: "Reguleringssted > Bekymring"

Argumenter grupperes efter **HVOR i dokumentet det fysiske element reguleres**, ikke efter hvad borgeren bekymrer sig om.

### Hvorfor?

Kommunen behandler høringssvar under den paragraf der regulerer det fysiske element. Hvis en borger bekymrer sig om støj fra en boldbane, skal argumentet placeres under "Ubebyggede arealer" (hvor boldbaner reguleres), IKKE under "Støj" - fordi det er under arealer at kommunen kan handle på boldbanen.

### Beslutningsregel

1. Identificer det **fysiske element** (boldbane, bygning, vej, træer, etc.)
2. Find hvilken **§ i høringsmaterialet** der nævner dette element
3. Temaet = den paragraf, **uanset bekymringstype**

### Eksempler

| Borgerens bekymring | Fysisk element | Reguleres under | Korrekt tema |
|---------------------|----------------|-----------------|--------------|
| "Boldbanen støjer for meget" | Boldbane | § 8 Ubebyggede arealer | Ubebyggede arealer |
| "Bygningen skygger for min have" | Bygning | § 6 Bebyggelsens omfang | Bebyggelsens omfang |
| "Trafikken ved den nye butik er farlig" | Butik/anvendelse | § 3 Anvendelse | Anvendelse |

### Undtagelse: Eksplicit §-reference

Hvis borgeren nævner en eksplicit paragraf ("jf. § 6 om bebyggelsens omfang"), så har den paragraf forrang - borgeren har selv identificeret reguleringsstedet.

---

## 4. Dynamisk Dokumenttype-Adaptation

### Princip

Systemet skal intelligent tilpasse sig **ENHVER høringstype** uden hardcoding for specifikke dokumenttyper.

### Hvorfor?

- Lokalplaner, dispensationer, politikker, strategier, bygningsreglement - alle har forskellig struktur
- Nye dokumenttyper kan opstå
- Hardcoding skaber vedligeholdelsesbelastning og fejlrisiko

### Implementering

1. **Material-analyse først**: Læs høringsmaterialet og udtræk dets faktiske struktur
2. **Tema-ekstraktion fra materialet**: Brug materialets egne overskrifter/paragraffer som temaer
3. **Theme-templates som fallback**: Kun til out-of-scope validering, ikke som primær tema-kilde
4. **"Andre emner" som eneste catch-all**: Ingen "Generelt", "Diverse", eller lignende vage kategorier

### Signaler på fejl

- Temaer der ikke matcher materialets struktur
- Mange argumenter i "Andre emner" (indikerer manglende tema-ekstraktion)
- Hardcodede tema-navne i koden

---

## 5. Nuance vs. Aggregering

### Kerneprincip

Når mange er enige, **ER det demokratisk vigtigt at vise** - det demonstrerer bred opbakning. Men vi leder OGSÅ efter nuancer og splitter positioner baseret på **reguleringssted**.

### Splitting-regler

**SPLIT når:**
1. Forskellige **regulatoriske lokationer** - palads + træer = 2 positioner (reguleres forskellige steder)
2. Forskellige **begrundelser** - bevar pga. kulturarv vs. bevar pga. klima
3. Forskellige **forslag** - fuld bevaring vs. delvis bevaring
4. **Konflikt** - for og imod samme ting

**BEHOLD SAMMEN når:**
- Samme fysiske objekt
- Samme retning (alle for eller alle imod)
- Samme reguleringssted
- (Med nuance-sub-positioner ved mange respondenter)

### Beslutningsdiagram

```
Samme fysiske objekt?
├─ NEJ → SEPARATE positioner
└─ JA → Samme retning (for/imod)?
        ├─ NEJ → SEPARATE positioner (konfliktreglen)
        └─ JA → Reguleres samme sted i materialet?
                ├─ NEJ → SEPARATE positioner
                └─ JA → GRUPPER SAMMEN
                        └─ Ved >10 respondenter: Udtræk nuance-sub-positioner
```

### Sub-position Integritetskrav (HÅRD CONSTRAINT)

**Princip:** Sub-positioner SKAL understøtte master-positionens retning og emne.

**Hvorfor:** Uden denne regel ender konflikter og urelaterede emner som sub-positioner, hvilket skaber forvirring om hvad positionen faktisk handler om. En "Bevar Palads"-position med sub-position "Støtter modernisering" er selvmodsigende og ubrugelig for sagsbehandleren.

**Gyldige sub-positioner:**
- ✅ "Bevar Palads" → sub: "Bevar pga. klimahensyn" (samme retning, specifik begrundelse)
- ✅ "Bevar Palads" → sub: "Bevar pga. kulturarv" (samme retning, specifik begrundelse)
- ✅ "Bevar Palads" → sub: "Bevar pga. æstetik/identitet" (samme retning, specifik begrundelse)

**Ugyldige sub-positioner → skal være SEPARATE positioner:**
- ❌ "Bevar Palads" → sub: "Støtter modernisering" (KONFLIKT - modsat retning)
- ❌ "Bevar Palads" → sub: "Bekymring for parkering" (ANDET EMNE - ikke begrundelse for bevarelse)
- ❌ "Bevar Palads" → sub: "Træer skal bevares" (ANDET OBJEKT - træer ≠ bygning)

**Beslutningsregel:** Stil spørgsmålet: *"Understøtter sub-positionen master-positionens konklusion?"*
- JA → Gyldig sub-position (varianter af HVORFOR/HVORDAN master-positionen er rigtig)
- NEJ (konflikt) → SEPARAT position med modsat holdning
- NEJ (andet emne/objekt) → SEPARAT position om det nye emne/objekt

**Konsekvens for implementering:**
1. Sub-position extraction skal validere retningsoverensstemmelse
2. Konflikter detekteres og udskilles til egne positioner
3. Andre emner/objekter detekteres og udskilles til egne positioner

### Multi-position Respondenter

**Princip:** En respondent KAN og SKAL være i flere positioner hvis de har flere argumenter.

**Hvorfor:** Borgere har ofte nuancerede holdninger. En respondent kan være imod et projekt OG have bekymringer om parkering OG støtte kulturbevarelse. Disse er separate argumenter der hører til separate positioner.

**Eksempler:**
- ✅ Respondent 42 i "Bevar Palads" OG "Bekymring for parkering" (to separate emner)
- ✅ Respondent 100 i "Modstand mod nedrivning" OG "Ønske om kulturhus" (to separate holdninger)
- ✅ Respondent 7 i "Støtte til projektet" (én klar holdning)

**Konsekvens for implementation:**
- Respondent-coverage validering tæller at respondenten er repræsenteret (mindst én position)
- Men en respondent kan optræde i flere positioner - dette er KORREKT opførsel
- Konflikt-flags (`hasConflict`) advarer når samme respondent er i modstridende positioner

### Demokratisk vægt

Vis tydeligt HVOR MANGE der mener det samme:
- "(163 borgere, Valby Lokaludvalg)" - ikke "mange borgere"
- Præcise tal, ikke vage kvantifikatorer
- Navngiv alle organisationer og lokaludvalg

---

## 6. Citathåndtering (Integritetskrav)

### Absolut regel

Citater skal være **100% eksakte** - copy-paste fra kilden, karakter for karakter.

### Hvorfor?

- **Troværdighed**: Sagsbehandleren skal kunne stole på citater
- **Juridisk holdbarhed**: Høringsnotater kan blive påklaget
- **Anti-hallucination**: LLM'er er tilbøjelige til at "forbedre" citater

### Krav til citater

| Krav | Forklaring |
|------|------------|
| 1:1 eksakt match | Alle tegn, mellemrum, stavefejl, store/små bogstaver bevares |
| Tilstrækkelig længde | Citat skal indeholde ALLE detaljer nævnt i sammenfatningen |
| Ingen metatekst | Fjern hilsner, signaturer, administrative framer |
| Typisk længde | 1-3 sammenhængende sætninger; op til 5-7 for komplekse argumenter |

### Fejlhåndtering

- Hvis citat ikke kan findes i kildetekst via fuzzy matching → argumentet **afvises**
- Aldrig "tæt på" citater - det er 100% eller ingenting

---

## 7. Out-of-Scope Håndtering

### Princip

Ekstrahér ALT hvad borgeren siger, markér out-of-scope, placer i "Andre emner".

### Hvorfor ikke ignorere?

- Borgeren har stadig ytret sig - det skal dokumenteres
- Kan informere andre processer (byggesag, driftsplan, anden høring)
- Kommunen kan svare: "Dette kan [dokumenttypen] ikke regulere"

### Dokumenttype-specifik scope

Scope afhænger af dokumenttypen - ikke hardcodet til lokalplaner:

| Dokumenttype | Typisk out-of-scope |
|--------------|---------------------|
| Lokalplan | Indretning, drift, åbningstider, priser, personale, brandsikkerhed |
| Dispensation | Principielle ændringer, formålsændringer |
| Politik/strategi | Juridiske krav, konkrete afgørelser |
| Partshøring | Generelle politiske holdninger |

### Markering

- `outOfScope: true` i datastruktur
- Placér i "Andre emner" tema
- Analysér stadig argumentet (hvad, hvorfor, hvordan)

---

## 8. Edge Cases

| Edge Case | Strategi | Rationale |
|-----------|----------|-----------|
| Tom/uforståelig respons | Markér som `incomprehensible`, bevar i coverage | Respondenten har indsendt - det dokumenteres |
| "Enig med svar #X" | Detektér reference, link til originalt svar | Berig med kontekst fra det refererede svar |
| Kort svar (<50 tegn) | `why: "Ikke specificeret"` | Opfind ALDRIG begrundelse |
| Mange respondenter (>10) | Aktiver sub-position splitting | Find nuancer i enigheden |
| Ingen holdning fundet | Separat position "Ingen holdning fundet" | 100% coverage kræver også disse |
| Anaforer uden referent | Ignorer som argument | "dette" og "det" er meningsløse uden kontekst |

---

## 9. Beslutningsguide for AI-Assistenter

Brug disse spørgsmål ved designvalg og implementering:

### Ved tema-tvivl

1. "Hvilket **FYSISK ELEMENT** handler argumentet om?"
2. "Hvilken **§ i materialet** regulerer dette element?"
3. → Det er temaet

### Ved splitting/grouping-tvivl

1. "Hvis kommunen opfylder A's ønske, modarbejdes B's ønske så?"
   - JA → SEPARATE positioner
   - NEJ → Kan potentielt grupperes
2. "Reguleres de to ting samme sted i materialet?"
   - NEJ → SEPARATE positioner
   - JA → GRUPPER (med nuancer)

### Ved citat-tvivl

1. "Er det 100% copy-paste fra kilden?"
   - NEJ → Find det korrekte citat ELLER skriv "Ikke specificeret"
   - ALDRIG opfind eller parafrasér

### Ved out-of-scope-tvivl

1. "Er der en eksplicit §-reference?" → In-scope (borgeren har identificeret stedet)
2. "Handler det om noget dokumentet ikke kan regulere?" → Out-of-scope
3. Ved tvivl: Markér IKKE out-of-scope - behold i hovedtema

### Ved model/complexity-valg

1. "Er dette en simpel klassifikation?" → Light tier
2. "Kræver det syntese af flere kilder?" → Heavy tier
3. "Er det kritisk for output-kvalitet?" → Højere tier

---

## 10. Kvalitetsgates (Invarianter)

Disse krav må **ALDRIG** brydes - de er systemiske invarianter:

- [ ] **Alle respondenter** skal forekomme i mindst én position (100% coverage)
- [ ] **Citater** skal være 1:1 match med kildetekst (ingen parafrasering)
- [ ] **citationMap.responseNumbers** ⊆ position.responseNumbers (konsistens)
- [ ] **Store positioner** uden sub-struktur skal have nuance-analyse
- [ ] **"to borgere"** i tekst = præcis 2 responseNumbers (tal-konsistens)
- [ ] **Hvert argument** har præcis ét tema (aldrig 0, aldrig 2+)

### Validering

Pipeline inkluderer automatiske valideringer:
- `validateRespondentCoverage()` - kører ALTID
- `validateCitationMap()` - renser LLM-output
- Quality gates kan stoppe pipeline ved kritiske fejl

---

## 11. Vedligeholdelse af Dette Dokument

**STRATEGY.md er et levende dokument.** Nye heuristikker opdages løbende under udvikling.

### Proces for nye heuristikker

1. **Opdagelse**: Under udvikling/debugging opdages et mønster eller en implicit regel
2. **Formulering**: Beskriv heuristikken med rationale (HVORFOR, ikke bare HVAD)
3. **Test**: Verificér at heuristikken holder på tværs af forskellige høringstyper
4. **Dokumentation**: Tilføj til relevant sektion med eksempler
5. **Kode-alignment**: Sikr at koden afspejler den dokumenterede heuristik

### Signaler på manglende heuristikker

- Gentagne designbeslutninger der kræver menneskelig vurdering
- Inkonsistens i output på tværs af kørsler
- "Magic numbers" i koden uden forklaring
- Svære at forklare trade-offs
- Tilbagevendende bugs med samme rod-årsag

### Format for nye heuristikker

```markdown
### [Heuristik-navn]

**Princip:** [Kort beskrivelse - én sætning]

**Hvorfor:** [Rationale - hvad går galt uden denne regel?]

**Beslutningsregel:** [Konkret test/spørgsmål man kan stille]

**Eksempel:** [Specifikt case der illustrerer heuristikken]
```

### Ansvar

Enhver der arbejder på kodebasen (menneske eller AI) bør:
- Læse dette dokument før større ændringer
- Tilføje nye heuristikker når de opdages
- Opdatere eksisterende heuristikker hvis de viser sig forkerte
- Sikre kode-dokumentation alignment

---

## Appendiks: Ordliste

| Begreb | Betydning |
|--------|-----------|
| **Høringssvar** | Formel borgerinput på kommunalt dokument |
| **Lokalplan** | Kommunal reguleringsplan for arealanvendelse |
| **Dispensation** | Undtagelse fra planregler |
| **Høringsmateriale** | Det officielle dokument der høres om |
| **Position** | Grupperet holdning fra én eller flere respondenter |
| **Sub-position** | Nuanceret underholdning inden for en position |
| **Mega-position** | Position med mange respondenter (kræver nuance-analyse) |
| **Out-of-scope** | Emne dokumentet ikke kan regulere |
| **Reguleringssted** | Hvor i dokumentet et emne håndteres |
| **Citation Registry** | System til at spore citater gennem pipeline |
