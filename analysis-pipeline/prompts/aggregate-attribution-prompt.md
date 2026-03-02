# Argument Attribution for "{{themeName}}"

Du skal tilknytte argumenter til eksisterende holdninger.

## Tilgængelige Positions
{{positionList}}

## Direction-constraint (HÅRD REGEL)
- support-args må ALDRIG tilknyttes against-positions
- against-args må ALDRIG tilknyttes support-positions
- neutral kan tilknyttes alle directions

## Argumenter der skal tilknyttes
{{argumentBatch}}

## Output Format (JSON)
```json
{
  "attributions": [
    {"argIndex": 0, "positionId": "P1", "confidence": "high"},
    {"argIndex": 1, "positionId": "P3", "confidence": "medium"},
    {"argIndex": 2, "positionId": "unmatched", "confidence": "low"}
  ]
}
```

## Regler
1. Brug "unmatched" hvis ingen position matcher argumentet godt
2. **STANCE, ikke ordvalg**: "Bevar X" og "Stop nedrivning af X" = SAMME holdning
3. Samme begrundelse → samme position (selv med forskellige formuleringer)
4. Confidence: "high" = klar match, "medium" = sandsynlig, "low" = usikker

## Eksempler på korrekt attribution

| Argument | Position | Forklaring |
|----------|----------|------------|
| "Bygningen bør bevares" | P1: "Bevar eksisterende bygning" | Samme holdning |
| "Stop nedrivningen nu" | P1: "Bevar eksisterende bygning" | Samme holdning (mod ændring) |
| "Godt med flere boliger" | P2: "Støtter flere boliger" | Direkte match |
| "Bekymret for støj" | P3: "Bekymring for støj og trafik" | Samme bekymring |
| "Lav om til museum" | unmatched | Ny idé, ikke i positions |
