"""
Simplified DeepEval Test Cases for Hearing 168

This version evaluates against golden output without citations/comments.
Use this until you have a golden output with citations.
"""

import json
import sys
import re
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from tests.evaluation.deepeval_config import (
    get_coherence_metric,
    get_faithfulness_metric,
    get_completeness_metric,
    get_verbosity_metric,
    create_position_writing_test_case,
    create_considerations_test_case,
    evaluate_pipeline_step
)
from deepeval import assert_test
from deepeval.test_case import LLMTestCase

# Load test data
CHECKPOINT_DIR = project_root / "output" / "checkpoints" / "168" / "implementation-test"
GOLDEN_OUTPUT = project_root / "golden-output" / "168.md"

def load_json(filename):
    """Load JSON file from checkpoint directory."""
    filepath = CHECKPOINT_DIR / filename
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)

def load_golden_output():
    """Load and parse golden output markdown."""
    with open(GOLDEN_OUTPUT, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Parse golden output into positions by theme
    golden_positions = {}
    current_theme = None
    current_position = None
    
    lines = content.split('\n')
    for line in lines:
        # Theme header (# Theme)
        if line.startswith('# ') and not line.startswith('##'):
            current_theme = line[2:].strip()
            if current_theme not in golden_positions:
                golden_positions[current_theme] = []
        
        # Position header (## Title)
        elif line.startswith('## '):
            if current_theme:
                # Extract position info from header
                # Format: ## (count[, type]) Title
                match = re.match(r'##\s*\(([^)]+)\)\s*(.+)', line)
                if match:
                    meta = match.group(1)
                    title = match.group(2).strip()
                    current_position = {
                        'title': title,
                        'meta': meta,
                        'content_lines': []
                    }
                    golden_positions[current_theme].append(current_position)
        
        # Position content
        elif current_position is not None and line.strip():
            # Skip "Henvendelse X" lines as they're metadata
            if not line.startswith('Henvendelse'):
                current_position['content_lines'].append(line.strip())
    
    # Join content lines for each position
    for theme in golden_positions:
        for pos in golden_positions[theme]:
            pos['content'] = ' '.join(pos['content_lines'])
            del pos['content_lines']
    
    return golden_positions

# Load data
micro_summaries = load_json("micro-summarize.json")
aggregate_output = load_json("aggregate.json")
position_writing = load_json("hybrid-position-writing.json")
considerations = load_json("considerations.json")
golden_positions = load_golden_output()

print(f"\n📊 Golden output loaded: {len(golden_positions)} themes")
for theme, positions in golden_positions.items():
    print(f"  - {theme}: {len(positions)} positions")

def test_position_writing_against_golden():
    """
    Test position writing quality against golden output.
    Focuses on content quality, not citations.
    """
    test_cases = []
    
    # Map themes from generated output to golden output
    theme_mapping = {
        'Anvendelse': 'Anvendelse',
        'Veje': 'Trafik og mobilitet',
        'Bebyggelsens omfang og placering': 'Omfang og placering af bebyggelsen',
        'Ubebyggede arealer': 'Ubebyggede arealer',
        'Bebyggelsens ydre fremtræden': 'Bebyggelsens ydre fremtræden',
        'Bil- og cykelparkering': 'Bil- og Cykelparkering',
        'Generelt': 'Andre emner'
    }
    
    # Sample a few positions to test (to avoid too many API calls)
    positions_tested = 0
    max_positions = 5
    
    for theme in position_writing:
        theme_name = theme["name"]
        golden_theme = theme_mapping.get(theme_name, theme_name)
        
        if golden_theme not in golden_positions:
            print(f"⚠️  Theme '{theme_name}' not in golden output, skipping")
            continue
        
        # Test first position from each theme
        if theme["positions"] and positions_tested < max_positions:
            position = theme["positions"][0]
            
            # Get input arguments for this position
            response_nums = position["responseNumbers"]
            input_args = []
            for ms in micro_summaries:
                if ms["responseNumber"] in response_nums:
                    for arg in ms.get("arguments", []):
                        input_args.append(arg)
            
            # Get golden position (try to match by similar title or just use first)
            golden_pos = golden_positions[golden_theme][0] if golden_positions[golden_theme] else None
            
            if input_args and golden_pos:
                test_case = create_position_writing_test_case(
                    input_arguments=input_args,
                    actual_summary=position["summary"],
                    expected_summary=golden_pos["content"]
                )
                test_cases.append(test_case)
                positions_tested += 1
                print(f"✅ Added test case: {theme_name} - {position['title'][:50]}...")
    
    if test_cases:
        print(f"\n🧪 Running {len(test_cases)} position writing tests...")
        
        # Use simplified metrics (no citation metrics)
        metrics = [
            get_coherence_metric(),
            get_faithfulness_metric(),
            get_completeness_metric()
        ]
        
        results = evaluate_pipeline_step(
            test_cases,
            metrics,
            "Position Writing vs Golden Output (Hearing 168)"
        )
        return results
    else:
        print("❌ No test cases generated")
        return None

def test_considerations_verbosity():
    """
    Test considerations generation for verbosity and analytical depth.
    No golden output needed for this test.
    """
    # Extract statistics
    input_stats = {
        "responseCount": len(micro_summaries),
        "positionCount": sum(len(t["positions"]) for t in aggregate_output),
        "themeCount": len(aggregate_output),
        "multiThemeArgs": sum(
            1 for ms in micro_summaries
            for arg in ms.get("arguments", [])
            if len(arg.get("relevantThemes", [])) > 1
        ),
        "largePositions": sum(
            1 for t in aggregate_output
            for p in t["positions"]
            if len(p.get("responseNumbers", [])) >= 5
        )
    }
    
    actual_considerations = considerations if isinstance(considerations, str) else json.dumps(considerations)
    
    test_case = create_considerations_test_case(
        input_statistics=input_stats,
        actual_considerations=actual_considerations
    )
    
    # Test verbosity and coherence (no golden output needed)
    metrics = [
        get_coherence_metric(),
        get_verbosity_metric(),
        get_faithfulness_metric()
    ]
    
    print("\n🧪 Running considerations verbosity test...")
    results = evaluate_pipeline_step(
        [test_case],
        metrics,
        "Considerations Generation (Hearing 168)"
    )
    return results

def test_single_position_coherence():
    """
    Quick test of a single position for language coherence.
    Useful for fast iteration.
    """
    # Test first position from first theme
    position = position_writing[0]["positions"][0]
    
    # Get input arguments
    response_nums = position["responseNumbers"]
    input_args = []
    for ms in micro_summaries:
        if ms["responseNumber"] in response_nums:
            for arg in ms.get("arguments", []):
                input_args.append(arg)
    
    test_case = create_position_writing_test_case(
        input_arguments=input_args,
        actual_summary=position["summary"]
    )
    
    print(f"\n🧪 Testing single position: {position['title'][:50]}...")
    print(f"   Summary: {position['summary'][:100]}...")
    
    # Just test coherence
    assert_test(test_case, [get_coherence_metric()])

def run_simplified_evaluation():
    """
    Run simplified evaluation against golden output (no citations).
    """
    print("\n" + "="*80)
    print("HEARING 168 SIMPLIFIED EVALUATION (NO CITATIONS)")
    print("="*80 + "\n")
    
    results = {}
    
    print("\n[1/3] Testing Position Writing vs Golden Output...")
    try:
        results["position_writing"] = test_position_writing_against_golden()
    except Exception as e:
        print(f"❌ Error in position writing test: {e}")
        results["position_writing"] = None
    
    print("\n[2/3] Testing Considerations Verbosity...")
    try:
        results["considerations"] = test_considerations_verbosity()
    except Exception as e:
        print(f"❌ Error in considerations test: {e}")
        results["considerations"] = None
    
    print("\n[3/3] Quick Coherence Test (single position)...")
    try:
        test_single_position_coherence()
        results["quick_coherence"] = "Passed"
    except Exception as e:
        print(f"❌ Error in quick test: {e}")
        results["quick_coherence"] = "Failed"
    
    print("\n" + "="*80)
    print("SIMPLIFIED EVALUATION COMPLETE")
    print("="*80 + "\n")
    
    # Print summary
    print("📊 Summary:")
    for test_name, result in results.items():
        if result:
            print(f"  ✅ {test_name}: Completed")
        else:
            print(f"  ⚠️  {test_name}: No results")
    
    print("\n💡 Note: This is a simplified evaluation without citation checks.")
    print("   Once you have golden output with citations, use test_hearing_168.py")
    
    return results

if __name__ == "__main__":
    # Run simplified evaluation
    run_simplified_evaluation()

