#!/bin/bash
# Post-edit hook: Foreslår test efter prompt ændringer
#
# Modtager JSON via stdin med tool_input information
# Returnerer JSON med message hvis relevant

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Check om det er en prompt-fil der blev ændret
if [[ "$FILE" == *"prompts/"*".md" ]]; then
  echo '{"message": "Prompt ændret - overvej at køre /prompt-test for at verificere ændringen"}'
  exit 0
fi

# Check om det er pipeline kode
if [[ "$FILE" == *"analysis-pipeline/src/"* ]]; then
  echo '{"message": "Pipeline kode ændret - overvej at køre /pipeline-run for at teste"}'
  exit 0
fi

# Ingen besked for andre filer
exit 0
