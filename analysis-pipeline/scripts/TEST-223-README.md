# Test og Evaluering af Høring 223

Dette dokument beskriver hvordan man kører en fuld test af pipeline for høring 223 med logging, timing, cost tracking og deepeval evaluering.

## Oversigt

Test-suiten kører:
1. **Pipeline execution** - Fuld pipeline kørsel med checkpoints (`test-med-docx-<timestamp>`)
2. **Comprehensive logging** - Alle outputs logges til timestamped log fil
3. **Timing tracking** - Hver step trackes med start/slut tid
4. **Cost estimation** - Estimerede API costs baseret på token usage
5. **Deepeval evaluation** - Automatisk kvalitetsevaluering af outputs

## Kørsel

### Start test

```bash
cd analysis-pipeline
bash scripts/run-223-test.sh
```

Dette starter testen i baggrunden og viser monitoring kommandoer.

### Monitor progress

I en separat terminal:

```bash
bash scripts/monitor-223-test.sh
```

Eller følg loggen direkte:

```bash
tail -f pipeline-223-test-*.log
```

### Manuel kørsel

Hvis du vil køre testen manuelt (ikke i baggrunden):

```bash
node scripts/test-223-with-eval.js
```

## Output Filer

Efter completion findes følgende filer:

### 1. Log File
**Sti:** `pipeline-223-test-<timestamp>.log`

Indeholder alle console outputs fra pipeline kørsel med timestamps.

### 2. Summary Report
**Sti:** `output/pipeline-223-test-summary.md`

Indeholder:
- Test metadata (timestamp, checkpoint label)
- Step timings (hver step med varighed)
- Cost estimation (hvis checkpoints er tilgængelige)
- Error log (hvis nogen fejl opstod)
- Next steps

### 3. Deepeval Report
**Sti:** `output/evaluation-223-deepeval-report.md`

Indeholder evalueringsresultater fra deepeval:
- Position writing quality metrics
- Aggregation quality metrics
- Considerations quality metrics

### 4. Checkpoints
**Sti:** `output/checkpoints/223/test-med-docx-<timestamp>/`

Alle pipeline steps gemmes som JSON checkpoints:
- `load-data.json`
- `micro-summarize.json`
- `aggregate.json`
- `hybrid-position-writing.json`
- osv.

### 5. Final Outputs
**Stier:**
- `output/hearing-223-analysis.json`
- `output/hearing-223-analysis.md`
- `output/checkpoints/223/test-med-docx-<timestamp>/hearing-223-analysis.docx`

## Checkpoint Struktur

Checkpoint mappen bruger formatet `test-med-docx-<timestamp>` for at:
- Undgå at overskrive eksisterende `fixed-stitching` checkpoints
- Gøre det nemt at identificere test runs
- Tillade flere test runs uden konflikter

## Fejlhåndtering

Hvis pipeline fejler:

1. **Tjek log filen** for detaljer:
   ```bash
   tail -100 pipeline-223-test-*.log
   ```

2. **Find sidste successful checkpoint**:
   ```bash
   ls -lt output/checkpoints/223/test-med-docx-*/ | head -10
   ```

3. **Resume fra checkpoint**:
   ```bash
   npm run pipeline:run -- 223 --resume=<step-name> --checkpoint=test-med-docx-<timestamp> --save-checkpoints --write
   ```

## Cost Tracking

Cost estimation baserer sig på:
- Token estimering fra checkpoint artifacts
- Model pricing (gpt-5-mini, text-embedding-3-large)
- Input/output token counts

**Note:** Dette er estimater - faktiske costs kan variere baseret på:
- Faktisk token counts (vs estimerede)
- OpenAI API pricing changes
- Rate limiting og retries

## Deepeval Evaluering

Deepeval evaluerer kvaliteten af:
- **Position Writing**: Coherence, faithfulness, completeness, relevancy
- **Aggregation**: Grouping quality, faithfulness, completeness
- **Considerations**: Coherence, verbosity, faithfulness

Evalueringen bruger `gpt-5-mini` som default evaluation model (cost-effective).

Hvis evaluering fejler, fortsætter testen - evaluering er ikke kritisk for pipeline completion.

## Timing

Forventet varighed: **~2 timer**

Breakdown (estimater):
- Load data: <1s
- Edge case screening: ~20s
- Embedding: ~15s
- Micro-summarize: ~2-3 min
- Theme mapping: ~3-4 min
- Aggregate: ~15-20 min
- Position writing: ~20-30 min
- Format output: ~1 min
- Build DOCX: ~1 min

## Troubleshooting

### Test script ikke fundet
```bash
chmod +x scripts/test-223-with-eval.js
chmod +x scripts/monitor-223-test.sh
chmod +x scripts/run-223-test.sh
```

### Python/venv issues
```bash
source venv/bin/activate
pip install deepeval
```

### Checkpoint ikke fundet
Sørg for at pipeline kører med `--save-checkpoints --checkpoint=test-med-docx-<timestamp>`

### Cost estimation fejler
Dette er ikke kritisk - testen fortsætter uden cost estimates.

## Next Steps Efter Test

1. **Review summary report** - `output/pipeline-223-test-summary.md`
2. **Review deepeval report** - `output/evaluation-223-deepeval-report.md`
3. **Compare outputs** - Sammenlign med `fixed-stitching` checkpoint hvis relevant
4. **Check quality** - Review final markdown/DOCX outputs
5. **Analyze costs** - Review cost estimates i summary

## Scripts Oversigt

- **`test-223-with-eval.js`** - Main test runner med logging og evaluation
- **`monitor-223-test.sh`** - Progress monitor script
- **`run-223-test.sh`** - Wrapper script til at starte test i baggrunden
- **`cost-tracker.js`** - Cost estimation utility
- **`test_hearing_223.py`** - Deepeval evaluation script

