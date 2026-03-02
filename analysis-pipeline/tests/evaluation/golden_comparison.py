"""
Comparison of Generated Output vs Golden Output for Hearing 168
Provides insights for prompt tuning
"""

import re
from pathlib import Path

project_root = Path(__file__).parent.parent.parent

# Load files
generated_file = project_root / "output" / "hearing-168-analysis.md"
golden_file = project_root / "golden-output" / "168.md"

generated = generated_file.read_text('utf-8')
golden = golden_file.read_text('utf-8')

print("="*80)
print("GOLDEN OUTPUT COMPARISON - Hearing 168")
print("="*80)

# Extract position titles from both
def extract_positions(text):
    """Extract all position titles (## lines)"""
    positions = []
    for line in text.split('\n'):
        if line.startswith('## '):
            # Extract title (remove (N, LU) prefix)
            title = re.sub(r'##\s*\([^)]+\)\s*', '', line).strip()
            positions.append(title)
    return positions

generated_positions = extract_positions(generated)
golden_positions = extract_positions(golden)

print(f"\n📊 POSITION COUNT:")
print(f"  Generated: {len(generated_positions)} positions")
print(f"  Golden:    {len(golden_positions)} positions")
print(f"  Difference: {len(generated_positions) - len(golden_positions):+d}")

print(f"\n📝 POSITION TITLE COMPARISON:\n")

# Compare titles
print("GOLDEN TITLES:")
print("-" * 80)
for i, title in enumerate(golden_positions[:10], 1):
    print(f"{i:2d}. {title}")
if len(golden_positions) > 10:
    print(f"    ... and {len(golden_positions) - 10} more")

print("\nGENERATED TITLES:")
print("-" * 80)
for i, title in enumerate(generated_positions[:10], 1):
    print(f"{i:2d}. {title}")
if len(generated_positions) > 10:
    print(f"    ... and {len(generated_positions) - 10} more")

# Find similar/different titles
print("\n🔍 TITLE ANALYSIS:\n")

# Find titles in golden but not in generated
golden_set = set(t.lower() for t in golden_positions)
generated_set = set(t.lower() for t in generated_positions)

missing_from_generated = [t for t in golden_positions if t.lower() not in generated_set]
extra_in_generated = [t for t in generated_positions if t.lower() not in golden_set]

if missing_from_generated:
    print(f"❌ MISSING from generated ({len(missing_from_generated)}):")
    for title in missing_from_generated[:5]:
        print(f"  - {title}")
    if len(missing_from_generated) > 5:
        print(f"    ... and {len(missing_from_generated) - 5} more")
else:
    print("✅ All golden titles present in generated")

print()

if extra_in_generated:
    print(f"➕ EXTRA in generated ({len(extra_in_generated)}):")
    for title in extra_in_generated[:5]:
        print(f"  - {title}")
    if len(extra_in_generated) > 5:
        print(f"    ... and {len(extra_in_generated) - 5} more")
else:
    print("✅ No extra positions in generated")

# Extract considerations from both
print("\n" + "="*80)
print("CONSIDERATIONS COMPARISON")
print("="*80)

def extract_considerations(text):
    """Extract considerations section"""
    # Find content between "Analytiske overvejelser" and first "## "
    match = re.search(r'(\*\*Analytiske overvejelser\*\*.*?)(?=\n## )', text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return None

generated_considerations = extract_considerations(generated)
golden_considerations = extract_considerations(golden)

print("\nGOLDEN CONSIDERATIONS:")
print("-" * 80)
if golden_considerations:
    print(golden_considerations[:500])
    if len(golden_considerations) > 500:
        print(f"... (total: {len(golden_considerations)} chars)")
else:
    print("(No considerations found in golden output)")

print("\nGENERATED CONSIDERATIONS:")
print("-" * 80)
if generated_considerations:
    print(generated_considerations[:500])
    if len(generated_considerations) > 500:
        print(f"... (total: {len(generated_considerations)} chars)")
else:
    print("(No considerations found in generated output)")

# Extract one sample position from each
print("\n" + "="*80)
print("SAMPLE POSITION COMPARISON")
print("="*80)

def extract_first_position_content(text):
    """Extract content of first position"""
    lines = text.split('\n')
    content_lines = []
    in_position = False
    for line in lines:
        if line.startswith('## ') and not in_position:
            in_position = True
            content_lines.append(line)
        elif in_position:
            if line.startswith('## '):  # Next position
                break
            content_lines.append(line)
    return '\n'.join(content_lines)

golden_sample = extract_first_position_content(golden)
generated_sample = extract_first_position_content(generated)

print("\nGOLDEN - First Position:")
print("-" * 80)
print(golden_sample[:600])

print("\n\nGENERATED - First Position:")
print("-" * 80)
print(generated_sample[:600])

print("\n" + "="*80)
print("📊 SUMMARY")
print("="*80)

print(f"""
Position Count:
  Golden:    {len(golden_positions)}
  Generated: {len(generated_positions)}
  Match:     {'✅ Yes' if len(golden_positions) == len(generated_positions) else f'❌ No ({len(generated_positions) - len(golden_positions):+d})'}

Title Quality:
  Missing:   {len(missing_from_generated)} positions
  Extra:     {len(extra_in_generated)} positions
  
Considerations:
  Golden:    {'Present' if golden_considerations else 'None'}
  Generated: {len(generated_considerations) if generated_considerations else 0} chars
  
Next Steps:
  1. Review title differences above
  2. Check if missing positions are critical
  3. Evaluate if extra positions are valid
  4. Use insights to tune prompts
""")

print("="*80)
print("💡 Use this analysis to guide prompt improvements!")
print("="*80)

