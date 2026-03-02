# Hybrid position stitcher

Du modtager JSON med fælles positionsdata samt en liste af delvise udkast:

```
{{INPUT_JSON}}
```

Hvert deludkast er et **del-sammendrag** med felter som typisk inkluderer:
- `summary` (del-tekst)
- `responseNumbers` (hvilke respondenter deludkastet dækker)
- `respondentCount`
- `_subPositionTitle` (hvis deludkastet repræsenterer en sub-position)
- `_isMasterOnly` (hvis deludkastet er "master-only" og skal nævnes først)

Deludkastene indeholder **ikke nødvendigvis** `references`/`quotes`. Din opgave er at kombinere dem til ét samlet udkast i JSON-formatet nedenfor.

## KRITISK: Deterministiske Labels (GROUP Placeholder System)

**⚠️ DU MÅ ALDRIG TÆLLE RESPONDENTER SELV!**

Når `positionInput._useGroupPlaceholders` er `true`, modtager du præ-beregnede labels i `_groupMetadata`. Disse er 100% korrekte og SKAL bruges.

**Sådan fungerer det:**

1. **Deludkastene er ALLEREDE sorteret efter hierarki** (Lokaludvalg → Organisationer → Store grupper → Små grupper)
2. **Bevar denne rækkefølge** - du må IKKE ændre rækkefølgen af sub-positions
3. **Brug GROUP placeholders** i stedet for at skrive tal:
   - ✅ KORREKT: `<<GROUP_2>> fremhæver...` (vil blive erstattet med "Indre By Lokaludvalg og 291 borgere<<REF_2>>")
   - ❌ FORKERT: `292 borgere<<REF_2>> fremhæver...` (tal du selv har skrevet kan være forkert!)

**Eksempel på input med `_groupMetadata`:**
```json
{
  "_useGroupPlaceholders": true,
  "_groupMetadata": [
    { "id": "GROUP_2", "type": "plural_citizens", "description": "navngiven aktør (Indre By Lokaludvalg og 291 borgere) - brug FLERTAL verb", "respondentCount": 292 },
    { "id": "GROUP_3", "type": "plural_citizens", "description": "263 respondenter - brug FLERTAL verb", "respondentCount": 263 },
    { "id": "GROUP_4", "type": "singular_citizen", "description": "én borger - brug ENTAL verb", "respondentCount": 1 }
  ]
}
```

**Sådan skriver du med GROUP placeholders:**
```
Der<<REF_1>> fremhæves overordnet ønske om bevaring. <<GROUP_2>> fremhæver facadens kulturhistoriske værdi og anfører, at farverne er ikoniske. <<GROUP_3>> fokuserer på foyerens bevaringsværdi. <<GROUP_4>> anfører bekymring for trafik.
```

**Systemet vil automatisk erstatte:**
- `<<GROUP_2>>` → `Indre By Lokaludvalg og 291 borgere<<REF_2>>`
- `<<GROUP_3>>` → `263 borgere<<REF_3>>`
- `<<GROUP_4>>` → `Én borger<<REF_4>>`

**REGLER FOR VERB-BØJNING (brug `_groupMetadata.type`):**
| Type | Verb-bøjning | Eksempel |
|------|--------------|----------|
| `singular_citizen` | ENTAL | `<<GROUP_X>> anfører...` |
| `named_singular` | ENTAL | `<<GROUP_X>> anbefaler...` |
| `plural_citizens` | FLERTAL | `<<GROUP_X>> fremhæver...` |
| `named_plural` | FLERTAL | `<<GROUP_X>> påpeger...` |

**KRITISKE REGLER:**
- **ALDRIG skriv tal selv** - brug altid GROUP placeholders
- **ALDRIG ændre rækkefølgen** - grupperne er sorteret efter vigtighed
- **ALTID tjek `type`** for korrekt verb-bøjning

**KRITISK: ALDRIG BRUG SUB-POSITION TITLER SOM TEKST FØR REFERENCE**
- Sub-position titler (fra `_subPositionTitle`) er KUN til intern struktur
- Tekst UMIDDELBART FØR `<<REF_X>>` eller `<<GROUP_X>>` SKAL være en label (antal + type) ELLER "Der"
- ❌ FORKERT: `Bevare træerne foran Palads<<REF_2>> anses som afgørende` (bruger sub-position titel!)
- ❌ FORKERT: `Nænsom renovering<<REF_3>> fremhæves` (bruger sub-position titel!)
- ✅ KORREKT: `Én borger<<REF_2>> anser, at træerne bør bevares`
- ✅ KORREKT: `<<GROUP_3>> fremhæver nænsom renovering`
- **REGEL:** Tekst før reference SKAL være: tal+borger, navngiven aktør, pronomen, eller GROUP placeholder

## Outputformat

Returnér gyldig JSON (ingen code fence) med felterne:

```json
{
  "summary": "... <<REF_1>> ... <<GROUP_2>> fremhæver...",
  "references": [
    {
      "id": "REF_1",
      "label": "Der",
      "respondents": [1, 2, 3, ...],
      "quotes": [],
      "notes": ""
    }
  ],
  "warnings": []
}
```

**BEMÆRK:** Når `_useGroupPlaceholders: true`:
- Du behøver IKKE bygge references for sub-positions - systemet gør det automatisk
- Fokusér på at skrive god prosa med korrekte GROUP placeholders
- REF_1 (master-holdning) skal du stadig inkludere med `"label": "Der"`

### Regler

#### 0. DANSK SPROGKRAV (KRITISK)
- **ALDRIG ENGELSK** - Alle tal og tekst SKAL være på dansk. Aldrig "Fifteen borgere", "Twenty respondents" osv.
- **Tal 1-12 skrives med bogstaver:** én, to, tre, fire, fem, seks, syv, otte, ni, ti, elleve, tolv
- **Tal over 12 skrives med cifre:** 13, 14, 15, 16, etc.
- **GRAMMATISK BØJNING (KRITISK):** Ental bruger "borger", flertal bruger "borgere"
  - ✅ KORREKT: "Én borger", "to borgere", "femten borgere", "107 borgere"
  - ❌ FORKERT: "1 borgere" (tal med forkert bøjning)
  - ❌ FORKERT: "Fifteen borgere" (engelsk tal)
  - ❌ FORKERT: "en borger" (forkert køn - skal være "én")

**0.2 GRAMMATIK: AKTØR-SUBJEKT OG PASSIV (-S) (KRITISK)**
- **FORBUDT:** Konstruktioner som `Én borger<<REF_2>> fremhæves ...`, `to borgere<<REF_3>> udtrykkes ...`, `Organisationen<<REF_4>> kritiseres ...`
- **REGEL:** Når subjektet er en aktør (tal+borgere eller navngiven aktør), skal verbet være **aktivt**:
  - ✅ `Én borger<<REF_2>> fremhæver ...`
  - ✅ `To borgere<<REF_3>> udtrykker ...`
  - ✅ `Valby Lokaludvalg<<REF_4>> kritiserer ...`
- **UNDTAGELSE:** Når subjektet er `Der<<REF_1>>`, er passiv/impersonal konstruktion tilladt.

**VARIATION I LABELS FOR ENKELT-RESPONDENTER (VIGTIGT FOR LEVENDE SPROG)**
- **UNDGÅ MONOTONI:** Brug IKKE "én borger" overalt. Variér med alternativer!
- **ALTERNATIVE LABELS FOR 1 RESPONDENT:**
  - "Én borger", "Vedkommende", "Borgeren", "Én respondent", "En enkelt borger"
  - **NAVNGIVNE AKTØRER:** Brug ALTID navnet: "Valby Lokaludvalg", "Brug Folkeskolen"
- **KOMBINATION MED NAVNGIVNE:**
  - ✅ KORREKT: "Vanløse Lokaludvalg og 26 borgere<<REF_1>> mener..."
  - ❌ FORKERT: "27 borgere<<REF_1>>" (ignorerer navngiven organisation!)

**STORE BEGYNDELSESBOGSTAVER**
- **EFTER PUNKTUM:** Labels SKAL starte med stort bogstav.
  - ✅ KORREKT: "...bygningen. Én borger<<REF_1>> anfører..."
  - ❌ FORKERT: "...bygningen. én borger<<REF_1>>..." (lille begyndelsesbogstav!)
  - ❌ FORKERT: "tre borger" (mangler flertalsbøjning)

#### 0.1 FLYDENDE PROSA (KRITISK FOR LÆSBARHED)
Teksten skal læses let og naturligt - som professionel forvaltningsprosa, ikke som maskinsprog eller talesprog. Undlad brug af semikolon og indskudte sætninger. 

- **KORTE SÆTNINGER:** Prioritér korte, klare sætninger. Lange sætninger med mange led er svære at læse.
  - ❌ FORKERT: "Borgeren anfører bekymring for, at bygningens højde vil reducere lysindfald, blokere udsyn og påvirke boligkvaliteten, hvilket kan have negativ indflydelse på ejendomsværdien."
  - ✅ KORREKT: "Borgeren mener, at bygningens højde vil reducere lysindfaldet og blokere udsynet. Denne vurderer, at det kan påvirke både boligkvalitet og ejendomsværdi."

- **UNDGÅ "HVILKET"-KONSTRUKTIONER:** Erstat med punktum og ny sætning.
  - ❌ FORKERT: "...hvilket kan påvirke boligkvaliteten"
  - ✅ KORREKT: Punktum og ny sætning i stedet

- **OPDEL OPREMSNINGER:** Lange opremsninger skal ofte deles i flere sætninger.
  - ❌ FORKERT: "De foreslår at omplacere bygningen, bytte placering, reducere højden eller placere den andetsteds."
  - ✅ KORREKT: "De foreslår at omplacere bygningen eller bytte dens placering. Alternativt anbefaler de at reducere højden."

- **VARIÉR VERBERNE:** Brug forskellige verber gennem teksten: "anfører", "vurderer", "påpeger", "fremhæver", "anbefaler", "foreslår", "mener", "peger på", "bemærker", "henstiller til".

- **VARIÉR PRONOMENER OG BRUG PASSIV FORM:** Undgå at bruge samme pronomen mere end 2 gange i træk:
  - Ental (anonyme): "Vedkommende", "Personen", "Denne", "Borgeren"
  - Flertal: "De", "Disse", "Borgerne", "Gruppen"
  - Navngivne aktører: "Foreningen vurderer...", "Udvalget anbefaler...", "De"
  - Myndigheder: "Myndigheden påpeger...", "Forvaltningen anfører..."
  - **PASSIV FORM (universel og elegant):** Brug passiv konstruktion til at undgå pronomen-gentagelse:
    - "Der peges også på...", "Der fremhæves desuden...", "Derudover anføres..."
    - "Det vurderes, at...", "Det anbefales, at...", "Der foreslås..."
    - ✅ EKSEMPEL: "Én borger<<REF_1>> anfører bekymring for støj. Der peges desuden på trafikale udfordringer og fremhæves behovet for grønne arealer."
  - **VIGTIGT:** "Vedkommende" passer til anonyme borgere, IKKE til organisationer eller myndigheder.

**TILBAGEHVISNINGER I FLERSÆTNINGSOPSUMMERINGER (KRITISK):**
- **HVER sætning efter den første SKAL have en sproglig forbindelse til gruppen**
- Uden tilbagehvisninger ved læseren ikke, hvem sætningerne handler om
- **Brug:** "De", "Disse borgere", "Gruppen", "Der peges på...", "Der anføres...", "Derudover..."
- **EKSEMPEL:**
  ```
  Der<<REF_1>> fremhæves en grundlæggende holdning om bevaring. 
  De peger på kulturhistoriske værdier. 
  Der anføres også klimahensyn. 
  Gruppen efterlyser en bevarende lokalplan.
  ```
- **❌ UNDGÅ:** Sætninger uden forbindelse: "Lokalplanen muliggør nybyggeri." (← Hvem siger dette?)

- **SEMIKOLON FORBUDT:** Brug ALDRIG semikolon (;) - heller ikke i opremsninger eller lister.
  - ❌ FORKERT: "De fremfører tre krav: matteret glas; korrektion; og friareal."
  - ✅ KORREKT: "De fremfører tre krav: matteret glas, korrektion og friareal."

#### 1. Bevar Detaljeringsgraden (DETAIL PRESERVATION)
- **DU MÅ IKKE GENERALISERE**: Det er kritisk, at du bevarer den detaljerede opdeling fra deludkastene.
- ❌ FORKERT: At samle "3 borgere om støj" og "4 borgere om støj" til bare "Flere borgere om støj".
- ✅ KORREKT: "Syv borgere<<REF_1>> anfører støjgener." (Hvis de mener præcis det samme)
- ✅ KORREKT: "Tre borgere<<REF_1>> anfører støj fra trafik, mens fire borgere<<REF_2>> fokuserer på støj fra nattelivet." (Hvis der er nuancer)
- **Målet er harmonisering, ikke simplificering.** Den endelige tekst skal være lige så rig på detaljer som de små tekster.

#### 1.1 DYNAMISK VERBOSITET (TILPASSET HIERARKI)

**🔴 BRUG `_targetSentences` FRA DELUDKAST (HVIS TILGÆNGELIG):**
Hvert deludkast kan indeholde `_targetSentences: { min: X, max: Y, requiresBranching: true/false }`.
Dette angiver præcis hvor mange sætninger den pågældende gruppe SKAL have.
- Skriv MINDST `min` sætninger og HØJST `max` sætninger for den gruppe
- Hvis `requiresBranching: true`, SKAL du bruge intern forgrening ("Blandt disse...", "Andre i gruppen...")

**NÅR DER ER SUB-POSITIONS (`_subPositionContext` er ikke tom):**

Master-holdningen skal være **KORT og overordnet** - detaljerne ligger i sub-positionerne:

| Respondenter | Master-holdning verbositet |
|--------------|---------------------------|
| Alle størrelser | 2-4 sætninger (kun det FÆLLES/overordnede) |

Sub-positionernes verbositet skalerer med deres størrelse (brug `_targetSentences` hvis angivet):

| Respondenter i sub-position | Sub-position verbositet |
|-----------------------------|------------------------|
| 1-15 | 1-2 sætninger |
| 16-40 | 2-3 sætninger |
| 41-100 | 4-5 sætninger |
| 100-300 | 5-7 sætninger |
| 300-800 | 7-10 sætninger + forgrening |
| 800+ | 10-16 sætninger + forgrening |

**NÅR DER IKKE ER SUB-POSITIONS (simpel position):**

| Respondenter | Verbositet |
|--------------|------------|
| 1-15 | 1-2 sætninger |
| 16-40 | 2-3 sætninger |
| 41-100 | 4-5 sætninger |
| 100-300 | 5-7 sætninger |
| 300+ | 7-16 sætninger + forgrening |

#### 2. Syntaks og Struktur (KRITISK)
- **INGEN Overskrifter, underoverskrifter, bullets eller lister.** Kun ren brødtekst.
- **INGEN Meta-kommentarer** om datagrundlag, metode eller proces-noter (fx "(>15)").
- **INGEN Konkluderende Afsnit** ("Sammenfattende...", "Overordnet set...").
- **Minimer parenteser.** Integrer info i sætninger.
- **Brug pladsholder-konceptet `<<REF_X>>` præcis som i write-prompten.**
- **RENT CLEANUP:** Sørg for at fjerne alle JSON-artefakter som `}>>`, `*<<}`, eller lignende fra teksten. Teksten skal være ren prosa.

#### 3. Referencer og Citater (STRICT RULES)

**🔴 FUNDAMENTAL REGEL: Reference SKAL komme LIGE EFTER label**
- Referencen `<<REF_X>>` SKAL placeres UMIDDELBART efter labellet - ALDRIG midt i eller efter sætningen.
- Der må IKKE være tekst mellem label og reference.
- **STRUKTUR:** `[label]<<REF_X>> [verbum] [indhold]...`

**KORREKT PLACERING:**
- ✅ `Der<<REF_1>> fremhæves en grundlæggende holdning om bevaring...`
- ✅ `23 borgere<<REF_2>> mener, at det kulturhistoriske tæller højt...`
- ✅ `Én borger<<REF_3>> anfører bekymring for støj...`

**FORKERT PLACERING:**
- ❌ `Der fremhæves et ønske om bevaring<<REF_1>>.` (reference midt i sætning!)
- ❌ `Der fremhæves at bygningen skal bevares<<REF_1>> og at...` (reference efter indhold!)

**REGEL FOR REF_1 (MASTER-HOLDNING) - BRUG ALTID "Der":**
Når du har sub-positions (`_subPositionTitle`), skal REF_1 ALTID:
- I summary teksten: Starte med `Der<<REF_1>> fremhæver...` (reference LIGE EFTER "Der"!)
- I JSON: `"label": "Der"` (IKKE tallet!)
- ❌ FORBUDT: `"label": "466 borgere"` eller `"label": "467 respondenter"`
- ✅ KORREKT: `"label": "Der"`
- Grunden: Respondentlisten står lige over teksten, så "Der" refererer til alle.

- **Unikke Labels:** Hver `<<REF_X>>` skal have et unikt label (fx "tre borgere", "Valby Lokaludvalg").
  - **KRITISK - Label SKAL matche teksten i summary:** 
    - Hvis summary siger: `"...en stor gruppe borgere<<REF_1>>..."`
    - SKAL label være: `"label": "en stor gruppe borgere"`
    - ❌ FORKERT label: `"Fuld bevarelse af Palads"` (Dette er et emne, ikke et label!)
    - **Label må ALDRIG beskrive holdningen - KUN hvem afsenderen er.**
  - **UNDTAGELSE FOR REF_1:** Hvis REF_1 dækker ALLE respondenter, brug `"label": "Der"`
  - **KRITISK - PRÆCISION I LABELS (ALDRIG "NOGLE" ELLER "FLERE"):**
    - **ALDRIG** brug vage betegnelser som "nogle borgere", "flere respondenter", "en række høringssvar", "en gruppe".
    - **ALTID** brug præcise tal eller navne i teksten før referencen.
    - ❌ FORKERT: "Nogle borgere<<REF_1>> mener..."
    - ❌ FORKERT: "En gruppe respondenter<<REF_2>> anfører..."
    - ❌ FORKERT: "Flere<<REF_3>> peger på..."
    - ✅ KORREKT: "Tre borgere<<REF_1>> mener..."
    - ✅ KORREKT: "12 respondenter<<REF_2>> anfører..."
    - ✅ KORREKT: "Valby Lokaludvalg og to borgere<<REF_3>> peger på..."
    - Hvis gruppen er meget stor (over 50), er det tilladt at skrive "En stor gruppe på 54 borgere<<REF_1>>", men tallet SKAL nævnes.
- **>15 Respondenter:** Hvis en gruppe bliver meget stor (fx 50 borgere), skal de samles under ét label ("50 borgere<<REF_1>>") med 3-5 repræsentative citater.
- **CITATER (VIGTIG ÆNDRING):** Det er OK at returnere `"quotes": []` for alle referencer. Systemet tilføjer citater automatisk når det er relevant.
- **Notes Feltet:** SKAL ALTID VÆRE TOMT (`"notes": ""`). Ingen forklaringer her.
- **KOMPLET RESPONDENT-LISTE (VIGTIGT):** 
  - Når du merger grupper, SKAL `respondents`-arrayet i JSON indeholde ALLE ID'er fra de oprindelige grupper.
  - ❌ FORBUDT: `[1, 2, 3, "...", 100]` eller at stoppe ved 30.
  - ✅ KORREKT: `[1, 2, 3, 4, 5, ..., 100]` (alle 100 tal skal stå der).
  - Dette er nødvendigt for validering. Udeladelse medfører fejl.
- **Ingen Lazy Referencing:** 
  - ❌ FORBUDT: `"notes": "Se høringssvar nr. 1–50 for individuelle begrundelser..."`
  - ❌ FORBUDT: `"notes": "Citater kan ses i deludkast..."`
  - ✅ KORREKT: `"notes": ""` OG `"quotes": [{...}, {...}, ...]`

#### 4. Metode: Fra Del-udkast til Helhed (SYNTESE)
Du må IKKE bare lægge del-udkastene efter hinanden. Du skal **omstrukturere og flette** indholdet totalt:

**🚨 KRITISK: MASTER-HOLDNING VS SUB-POSITIONS (HIERARKISK STRUKTUR):**

Når du har sub-positions, skal teksten følge denne struktur:

**TRIN 1: MASTER-HOLDNING (ALLE respondenter)**
- Start ALTID med én reference der dækker ALLE respondenter i positionen
- **🔴 KRITISK: Label SKAL være "Der" - ALDRIG tallet!**
  - Brug ubestemt pronomen "Der" som label: `"label": "Der"`
  - I summary-teksten: `Der<<REF_1>> ønsker...`
  - ❌ FORKERT: `"label": "466 borgere"` eller `"label": "467 respondenter"`
  - ✅ KORREKT: `"label": "Der"`
- Denne reference skal have ALLE respondent-numre fra `positionInput._allRespondentNumbers`
- I JSON output: `"respondents": [positionInput._allRespondentNumbers]` (ALLE numre!)
- **VIGTIGT:** REF_1 respondents SKAL matche `_totalRespondentCount` (fx 467 for 467 respondenter)

**🚨 SELV-CHECK (SKAL GØRES FØR DU RETURNERER JSON):**
1. Starter `summary` med `Der<<REF_1>>` (efter evt. whitespace)?
   - Hvis nej: RET DET. Master-holdningen skal starte med `Der<<REF_1>>`.
2. Find reference med `id: "REF_1"`:
   - Er `label` præcis `"Der"`?
   - Har `respondents` LIGE SÅ MANGE elementer som `positionInput._totalRespondentCount`?
   - Indeholder `respondents` ALLE elementer i `positionInput._allRespondentNumbers`?
   - Hvis nej til nogen af disse: RET DET. Master-holdningen må aldrig være en delmængde.
3. Forbudt mønster:
   - ❌ `116 borgere<<REF_1>> ...` (master må ikke være en delmængde)
   - ✅ `Der<<REF_1>> ...` (master = alle)

**🚨 KRITISK: MASTER-HOLDNING SKAL EKSKLUDERE SUB-POSITIONS ARGUMENTER**
- Master-holdningen skal KUN beskrive det FÆLLES/OVERORDNEDE for alle respondenter
- **TJEK `_subPositionContext`:** Denne liste viser hvad sub-positionerne dækker
- **EKSKLUDER disse argumenter fra master-holdningen** - de uddybes i sub-positionerne
- Master-holdningen skal være **KORT og overordnet** (2-4 sætninger typisk)
- Undgå at gentage specifikke argumenter der allerede nævnes i sub-positions

**EKSEMPEL på korrekt adskillelse:**
- ❌ FORKERT master: "Der ønsker bevaring. De peger på kulturhistorie, klimahensyn, og foyerens arkitektur..."
  (Gentager sub-positionernes argumenter!)
- ✅ KORREKT master: "Der ønsker bevaring af Palads som en del af byens kulturarv og bybillede."
  (Kort, overordnet - detaljerne kommer i sub-positions)

**TRIN 2: SUB-POSITIONS (specifikke nuancer)**
- EFTER master-holdningen kommer sub-positions som specifikke nuancer
- Hver sub-position får sin egen reference med sit specifikke antal

**🚨 KRITISK: UNDGÅ "HERAF" - BRUG EKSPLICITTE OVERGANGE**
- **ALDRIG brug "Heraf"** - det skaber tvetydige tilbagehenvisninger
- Sub-positions kan selv have nuancer ("nogen siger X"), og "heraf" gør det uklart hvem der refereres til

**KORREKTE OVERGANGE til sub-positions:**
- ✅ "Blandt disse fremhæver X borgere..." (eksplicit reference til master-gruppen)
- ✅ "X borgere peger særligt på..." (neutral, ingen tvetydig tilbagehenvisning)
- ✅ "En delgruppe på X borgere anfører..." (eksplicit at de er en del)
- ❌ FORBUDT: "Heraf fremhæver X borgere..." (tvetydig - del af hvem?)

**TRIN 0: MASTER-ONLY (FØRST, hvis tilgængelig)**
- Hvis `_isMasterOnly=true` gruppe findes, nævn dem FØRST (lige efter master-holdningen)
- Disse tilslutter sig kun master-holdningen uden specifik nuance
- Eksempel: "X borgere tilslutter sig i kortere tilkendegivelser."

**🚨 KRITISK: BRUG IKKE MASTER-ONLY ANTAL I SUB-POSITION TEKST**
- `_totalRespondentCount` og `_allRespondentNumbers` er KUN til REF_1 (master-holdningen)
- **ALDRIG** brug disse tal i sub-position summaries
- Hver sub-position skal bruge sit EGET `respondentCount` fra deludkastet
- ❌ FORKERT: "292 borgere tilslutter sig..." (i en sub-position med kun 50 respondenter)
- ✅ KORREKT: "50 borgere anfører..." (brug det faktiske antal fra sub-positionen)

**EKSEMPEL (467 respondenter, 3 sub-positions + master-only):**

**Summary tekst:**
```
Der<<REF_1>> ønsker bevaring af Palads som et særligt arkitektonisk og kulturelt vartegn. 52 borgere<<REF_2>> tilslutter sig i kortere tilkendegivelser. 258 borgere<<REF_3>> fremhæver særligt bygningen som ikonisk vartegn og anfører, at både facaden og foyeren bidrager til byens identitet. 140 borgere<<REF_4>> efterlyser nænsom renovering som alternativ til nedrivning og peger på klimamæssige fordele.
```

**JSON references:**
```json
{
  "id": "REF_1",
  "label": "Der",  // ← ALTID "Der" for master-holdning!
  "respondents": [1, 2, 3, ... 467]  // ALLE respondenter
}
```

1. **GLOBAL REORDERING (ALLEREDE GJORT - BEVAR RÆKKEFØLGEN!):**

   **⚠️ KRITISK: Når `_useGroupPlaceholders: true`, er grupperne ALLEREDE sorteret korrekt!**

   Systemet har pre-sorteret deludkastene efter hierarki:
   1. Lokaludvalg (hvis til stede)
   2. Organisationer/Foreninger (hvis til stede)
   3. Offentlige Myndigheder (hvis til stede)
   4. Store borgergrupper (>50 respondenter)
   5. Mellem grupper (15-50 respondenter)
   6. Små grupper (<15 respondenter)

   **DU SKAL:**
   - ✅ BEVARE den rækkefølge deludkastene kommer i
   - ✅ Bruge GROUP placeholders i den rækkefølge de er angivet

   **DU MÅ IKKE:**
   - ❌ Omrokere grupper efter egen logik
   - ❌ Flytte "større" grupper frem for "mindre"

   **Når `_useGroupPlaceholders: false` (legacy mode):**
   - Scan ALLE del-udkast for VIP-aktører: **Lokaludvalg** og **Offentlige Myndigheder**
   - Disse SKAL flyttes op og nævnes **først** i den samlede tekst

2. **EMNE-SYNTESE OG MERGING (CONTEXT-DEPENDENT):**
   
   **🔴 ABSOLUT KRITISK - LÆS DETTE FØRST:**
   Tjek om deludkastene har `_subPositionTitle` feltet. Dette afgør HELE din stitch-strategi.
   
   **HVIS deludkastene har `_subPositionTitle` → SEPARATE GRUPPER (ALDRIG MERGE!):**
   
   Du arbejder med PRE-GRUPPEREDE sub-positions. Disse ER ALLEREDE semantisk grupperet.
   
   **DU MÅ ABSOLUT IKKE:**
   - ❌ Lægge respondenter fra forskellige `_subPositionTitle` grupper sammen
   - ❌ Merge "258 borgere for vartegn" + "140 borgere mod nedrivning" → DETTE ER FORBUDT
   - ❌ Skabe én stor gruppe der dækker flere sub-positions
   
   **DU SKAL:**
   - ✅ Oprette EN separat reference (<<REF_X>>) for HVER `_subPositionTitle`
   - ✅ Bevare det PRÆCISE antal respondenter fra hver sub-position
   - ✅ Skrive hver sub-positions argument i sin egen sætning/afsnit
   
   **EKSEMPEL (med 3 sub-positions + master-only, total 467 respondenter):**
   Input:
   - partialDraft 1: _isMasterOnly=true, 52 respondenter (kun master, ingen specifik nuance)
   - partialDraft 2: _subPositionTitle="Vartegn", 258 respondenter  
   - partialDraft 3: _subPositionTitle="Nænsom renovering", 140 respondenter
   
   Output (KORREKT - master-holdning først for ALLE):
   "Der<<REF_1>> ønsker bevaring af Palads som et ikonisk og historisk vartegn. De anfører, at bygningens ydre facade og indre foyer har kulturhistorisk værdi, og at nedrivning bør undgås til fordel for nænsom renovering. Der peges på klimamæssige fordele ved genbrug af eksisterende bygningsmasse samt bygningens betydning for byens identitet. Heraf fremhæver 258 borgere<<REF_2>> særligt bygningen som ikonisk vartegn og kunstnerisk værdi. 140 borgere<<REF_3>> efterlyser specifikt nænsom renovering frem for nedrivning. 52 borgere<<REF_4>> tilslutter sig i kortere tilkendegivelser."
   
   REF_1 respondents: [ALLE 467 - union af alle sub-positions + master-only]
   REF_2 respondents: [258 fra sub-position "Vartegn"]
   REF_3 respondents: [140 fra sub-position "Nænsom renovering"]
   REF_4 respondents: [52 fra master-only]
   
   Output (FORKERT - ALDRIG GØR DETTE):
   "52 borgere<<REF_1>> tilslutter sig. 258 borgere<<REF_2>> fremhæver..." ← FORKERT! Master-only er IKKE master-holdningen!
   
   **HVIS deludkastene IKKE har `_subPositionTitle` (tilfældig token-chunking):**
   - Her MÅ du merge identiske holdninger fra forskellige chunks
   - Chunk 1: "50 borgere for bevaring" + Chunk 2: "50 borgere for bevaring" → "100 borgere<<REF_1>>"
   
   **GENERELT:**
   - **Bevar nuancer:** Forskellige begrundelser = forskellige referencer
   - **Antal SKAL matche:** Hvis input siger 258 respondenter, skal output også have 258 i den reference

3. **SAMMENHÆNGENDE NARRATIV:**
   - Start med den stærkeste fællesnævner på tværs af *alle* chunks.
   - Brug overgangsord ("Samtidig", "Derudover", "I tråd hermed") til at binde aktørerne sammen.
   - **Ingen løse ender:** Afslut ikke med "Hertil kommer..." for vigtige aktører - flet dem ind i hoved-narrativet.
   - **Ingen "Sammenfattende" slutning:** Teksten skal stoppe brat efter sidste pointe er leveret.
   - **Bevar organisk struktur:** Følg de temaer der naturligt opstår i del-udkastene, tving ikke teksten ind i en fast skabelon.

4. **TEKNISKE KRAV:**
   - Genbrug citater fra deludkast, men det er tilladt at vælge det mest præcise citat pr. respondent.
   - Sørg for, at **alle** respondenter i `positionInput.respondents` er dækket.
   - Fjern overflødige pladsholdere.

Outputtet skal være konsistent, struktureret og egnet til efterfølgende deterministisk CriticMarkup-indlejring.
