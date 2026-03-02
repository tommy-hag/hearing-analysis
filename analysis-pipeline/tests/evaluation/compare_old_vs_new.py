"""
Compare OLD (nano) vs NEW (gpt-5-mini) outputs for Hearing 168
"""

import json
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from tests.evaluation.deepeval_config import (
    get_coherence_metric,
    get_verbosity_metric,
    get_faithfulness_metric,
    create_considerations_test_case,
    evaluate_pipeline_step
)
from deepeval.test_case import LLMTestCase

# Load OLD output (implementation-test)
OLD_DIR = project_root / "output" / "checkpoints" / "168" / "implementation-test"
old_considerations = (OLD_DIR / "considerations.json").read_text('utf-8')

# Load NEW output (latest run)
NEW_OUTPUT = project_root / "output" / "hearing-168-analysis.md"
new_content = NEW_OUTPUT.read_text('utf-8')

# Extract NEW considerations from markdown
# They appear between "**Analytiske overvejelser**" and the first "## " position
import re
match = re.search(r'\{>>(\*\*Analytiske overvejelser\*\*.*?)<<\}', new_content, re.DOTALL)
if match:
    new_considerations = match.group(1)
else:
    # Try without the markers
    match = re.search(r'(\*\*Analytiske overvejelser\*\*.*?)(?=\n## )', new_content, re.DOTALL)
    if match:
        new_considerations = match.group(1)
    else:
        # Just get first part
        lines = new_content.split('\n')
        consider_lines = []
        in_considerations = False
        for line in lines:
            if '**Analytiske overvejelser**' in line or '*Grupperingsstrategi' in line:
                in_considerations = True
            if in_considerations:
                if line.startswith('## '):  # Stop at first position
                    break
                consider_lines.append(line)
        new_considerations = '\n'.join(consider_lines)

print("="*80)
print("COMPARISON: OLD (nano) vs NEW (gpt-5-mini)")
print("="*80)

print("\n📄 OLD Considerations (gpt-5-nano, rule-based):")
print("-" * 80)
print(old_considerations[:500])
print("..." if len(old_considerations) > 500 else "")
print(f"\nLength: {len(old_considerations)} chars")

print("\n📄 NEW Considerations (gpt-5-mini ULTRA, LLM-based):")
print("-" * 80)
print(new_considerations[:500])
print("..." if len(new_considerations) > 500 else "")
print(f"\nLength: {len(new_considerations)} chars")

# Evaluate both
input_stats = {
    "responseCount": 24,
    "positionCount": 31,
    "themeCount": 8,
    "multiThemeArgs": 42,
    "largePositions": 1
}

print("\n" + "="*80)
print("EVALUATING OLD CONSIDERATIONS (baseline)")
print("="*80)

old_test_case = create_considerations_test_case(
    input_statistics=input_stats,
    actual_considerations=old_considerations
)

old_results = evaluate_pipeline_step(
    [old_test_case],
    [get_coherence_metric(), get_verbosity_metric(), get_faithfulness_metric()],
    "OLD Considerations (gpt-5-nano, rule-based)"
)

print("\n" + "="*80)
print("EVALUATING NEW CONSIDERATIONS (improved)")
print("="*80)

new_test_case = create_considerations_test_case(
    input_statistics=input_stats,
    actual_considerations=new_considerations
)

new_results = evaluate_pipeline_step(
    [new_test_case],
    [get_coherence_metric(), get_verbosity_metric(), get_faithfulness_metric()],
    "NEW Considerations (gpt-5-mini ULTRA, LLM-based)"
)

print("\n" + "="*80)
print("📊 COMPARISON SUMMARY")
print("="*80)

print("\nOLD (nano, rule-based):")
print(f"  - Length: {len(old_considerations)} chars")
print(f"  - Language Coherence: Check results above")
print(f"  - Appropriate Verbosity: Check results above")

print("\nNEW (gpt-5-mini ULTRA, LLM-based):")
print(f"  - Length: {len(new_considerations)} chars")
print(f"  - Language Coherence: Check results above")
print(f"  - Appropriate Verbosity: Check results above")

improvement_pct = ((len(new_considerations) - len(old_considerations)) / len(old_considerations) * 100)
print(f"\n📈 Length improvement: {improvement_pct:+.1f}%")

