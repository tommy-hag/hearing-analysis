"""
DeepEval Test Cases for Hearing 223

This module contains test cases for evaluating the quality of hearing 223 outputs.
Note: Unlike hearing 168, we don't have a golden dataset, so we evaluate actual output quality only.
"""

import json
import sys
import os
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from tests.evaluation.deepeval_config import (
    POSITION_WRITING_METRICS,
    AGGREGATION_METRICS,
    CONSIDERATIONS_METRICS,
    create_position_writing_test_case,
    create_aggregation_test_case,
    create_considerations_test_case,
    evaluate_pipeline_step
)
from deepeval import assert_test
from deepeval.test_case import LLMTestCase

# Try to find the latest checkpoint directory
# Look for test-med-docx-* directories
CHECKPOINT_BASE = project_root / "output" / "checkpoints" / "223"

def find_latest_checkpoint():
    """Find the latest test-med-docx checkpoint directory."""
    if not CHECKPOINT_BASE.exists():
        return None
    
    # Find all test-med-docx-* directories
    checkpoints = []
    for item in CHECKPOINT_BASE.iterdir():
        if item.is_dir() and item.name.startswith("test-med-docx-"):
            checkpoints.append(item)
    
    if not checkpoints:
        # Fallback: use fixed-stitching if available
        fallback = CHECKPOINT_BASE / "fixed-stitching"
        if fallback.exists():
            print(f"⚠️  No test-med-docx checkpoint found, using fixed-stitching as fallback")
            return fallback
        return None
    
    # Sort by modification time, newest first
    checkpoints.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    return checkpoints[0]

if len(sys.argv) > 1:
    # Checkpoint provided as argument
    arg_path = Path(sys.argv[1])
    if arg_path.is_absolute():
        CHECKPOINT_DIR = arg_path
    else:
        # Try relative to project root, or relative to checkpoints dir
        maybe_path = project_root / arg_path
        if maybe_path.exists():
            CHECKPOINT_DIR = maybe_path
        else:
             # Try relative to checkpoints/223
             CHECKPOINT_DIR = CHECKPOINT_BASE / arg_path

    if not CHECKPOINT_DIR.exists():
         print(f"❌ ERROR: Checkpoint directory not found at {CHECKPOINT_DIR}")
         sys.exit(1)
else:
    CHECKPOINT_DIR = find_latest_checkpoint()

if CHECKPOINT_DIR is None:
    print(f"❌ ERROR: No checkpoint directory found in {CHECKPOINT_BASE}")
    print("   Please run the pipeline first with --save-checkpoints --checkpoint=test-med-docx-<timestamp>")
    sys.exit(1)

print(f"📁 Using checkpoint: {CHECKPOINT_DIR}")

def load_json(filename):
    """Load JSON file from checkpoint directory."""
    filepath = CHECKPOINT_DIR / filename
    if not filepath.exists():
        print(f"⚠️  Warning: {filename} not found in checkpoint directory")
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"❌ Error loading {filename}: {e}")
        return None

# Load outputs
print("\n📊 Loading checkpoint data...")
micro_summaries = load_json("micro-summarize.json")
theme_mapping = load_json("theme-mapping.json")
aggregate_output = load_json("aggregate.json")
position_writing = load_json("hybrid-position-writing.json")
considerations = load_json("considerations.json")

if not all([micro_summaries, theme_mapping, aggregate_output, position_writing]):
    print("❌ ERROR: Missing required checkpoint files")
    print("   Required: micro-summarize.json, theme-mapping.json, aggregate.json, hybrid-position-writing.json")
    sys.exit(1)

print("✅ Checkpoint data loaded successfully\n")

def test_position_writing_coherence():
    """Test language coherence in position writing for a sample position."""
    if not position_writing or len(position_writing) == 0:
        print("⚠️  No position writing data available")
        return None
    
    # Select first available position
    theme = position_writing[0] if isinstance(position_writing[0], dict) else None
    if not theme or "positions" not in theme or len(theme["positions"]) == 0:
        print("⚠️  No positions found in first theme")
        return None
    
    position = theme["positions"][0]
    
    # Get the micro-summaries for these responses
    response_nums = position.get("responseNumbers", [])
    if not response_nums:
        print("⚠️  Position has no response numbers")
        return None
    
    input_args = []
    if micro_summaries:
        for ms in micro_summaries:
            if ms.get("responseNumber") in response_nums:
                for arg in ms.get("arguments", []):
                    input_args.append(arg)
    
    if not input_args:
        print("⚠️  No input arguments found for position")
        return None
    
    test_case = create_position_writing_test_case(
        input_arguments=input_args,
        actual_summary=position.get("summary", "")
    )
    
    # Test only coherence metric for this specific test
    from tests.evaluation.deepeval_config import get_coherence_metric
    assert_test(test_case, [get_coherence_metric()])
    return test_case

def test_position_writing_full():
    """Test full position writing quality for multiple positions."""
    if not position_writing:
        print("⚠️  No position writing data available")
        return None
    
    test_cases = []
    count = 0
    max_positions = 5  # Limit to 5 positions for cost control
    
    # Iterate through themes and positions
    for theme_data in position_writing[:3]:  # First 3 themes
        if not isinstance(theme_data, dict) or "positions" not in theme_data:
            continue
            
        for position in theme_data["positions"][:2]:  # First 2 positions per theme
            if count >= max_positions:
                break
            
            response_nums = position.get("responseNumbers", [])
            if not response_nums:
                continue
            
            input_args = []
            if micro_summaries:
                for ms in micro_summaries:
                    if ms.get("responseNumber") in response_nums:
                        for arg in ms.get("arguments", []):
                            input_args.append(arg)
            
            if input_args:
                test_case = create_position_writing_test_case(
                    input_arguments=input_args,
                    actual_summary=position.get("summary", "")
                )
                test_cases.append(test_case)
                count += 1
    
    if test_cases:
        results = evaluate_pipeline_step(
            test_cases,
            POSITION_WRITING_METRICS,
            "Position Writing (Hearing 223)"
        )
        return results
    else:
        print("⚠️  No test cases generated for position writing")
        return None

def test_aggregation_quality():
    """Test aggregation quality for grouping arguments."""
    if not aggregate_output or len(aggregate_output) == 0:
        print("⚠️  No aggregation data available")
        return None
    
    # Test aggregation for first theme
    theme = aggregate_output[0]
    
    # Get all arguments for this theme from theme mapping
    theme_data = None
    if theme_mapping and "themes" in theme_mapping:
        for t in theme_mapping["themes"]:
            if t.get("name") == theme.get("name"):
                theme_data = t
                break
    
    if not theme_data:
        print(f"⚠️  Theme {theme.get('name')} not found in theme mapping")
        return None
    
    input_arguments = theme_data.get("arguments", [])
    actual_positions = theme.get("positions", [])
    
    if not input_arguments or not actual_positions:
        print("⚠️  Missing input arguments or positions")
        return None
    
    test_case = create_aggregation_test_case(
        input_arguments=input_arguments,
        actual_positions=actual_positions
    )
    
    results = evaluate_pipeline_step(
        [test_case],
        AGGREGATION_METRICS,
        f"Aggregation - {theme.get('name', 'Unknown')} (Hearing 223)"
    )
    return results

def test_considerations_quality():
    """Test considerations generation quality."""
    if not considerations:
        print("⚠️  No considerations data available")
        return None
    
    # Extract statistics from the outputs
    input_stats = {
        "responseCount": len(micro_summaries) if micro_summaries else 0,
        "positionCount": sum(len(t.get("positions", [])) for t in aggregate_output) if aggregate_output else 0,
        "themeCount": len(theme_mapping.get("themes", [])) if theme_mapping else 0,
        "multiThemeArgs": sum(
            1 for ms in (micro_summaries or [])
            for arg in ms.get("arguments", [])
            if len(arg.get("relevantThemes", [])) > 1
        ) if micro_summaries else 0,
        "largePositions": sum(
            1 for t in (aggregate_output or [])
            for p in t.get("positions", [])
            if len(p.get("responseNumbers", [])) >= 5
        ) if aggregate_output else 0
    }
    
    actual_considerations = considerations if isinstance(considerations, str) else json.dumps(considerations)
    
    test_case = create_considerations_test_case(
        input_statistics=input_stats,
        actual_considerations=actual_considerations
    )
    
    results = evaluate_pipeline_step(
        [test_case],
        CONSIDERATIONS_METRICS,
        "Considerations Generation (Hearing 223)"
    )
    return results

def generate_report(results):
    """Generate a markdown report from evaluation results."""
    report_lines = []
    report_lines.append("# DeepEval Evaluation Report: Hearing 223")
    report_lines.append("")
    report_lines.append(f"**Checkpoint:** `{CHECKPOINT_DIR.name}`")
    report_lines.append(f"**Generated:** {json.dumps({'timestamp': __import__('datetime').datetime.now().isoformat()})}")
    report_lines.append("")
    
    if results.get("position_writing"):
        report_lines.append("## Position Writing Evaluation")
        report_lines.append("")
        report_lines.append("Results from position writing quality tests.")
        report_lines.append("")
    
    if results.get("aggregation"):
        report_lines.append("## Aggregation Evaluation")
        report_lines.append("")
        report_lines.append("Results from aggregation quality tests.")
        report_lines.append("")
    
    if results.get("considerations"):
        report_lines.append("## Considerations Evaluation")
        report_lines.append("")
        report_lines.append("Results from considerations generation tests.")
        report_lines.append("")
    
    report_lines.append("---")
    report_lines.append("")
    report_lines.append("*Note: Detailed metrics are printed during test execution.*")
    report_lines.append("")
    
    return "\n".join(report_lines)

def run_all_tests():
    """Run all evaluation tests for hearing 223."""
    print("\n" + "="*80)
    print("HEARING 223 EVALUATION")
    print("="*80)
    print(f"Checkpoint: {CHECKPOINT_DIR.name}")
    print("="*80 + "\n")
    
    results = {}
    
    print("\n[1/3] Testing Position Writing...")
    try:
        results["position_writing"] = test_position_writing_full()
    except Exception as e:
        print(f"❌ Error in position writing test: {e}")
        import traceback
        traceback.print_exc()
        results["position_writing"] = None
    
    print("\n[2/3] Testing Aggregation...")
    try:
        results["aggregation"] = test_aggregation_quality()
    except Exception as e:
        print(f"❌ Error in aggregation test: {e}")
        import traceback
        traceback.print_exc()
        results["aggregation"] = None
    
    print("\n[3/3] Testing Considerations...")
    try:
        results["considerations"] = test_considerations_quality()
    except Exception as e:
        print(f"❌ Error in considerations test: {e}")
        import traceback
        traceback.print_exc()
        results["considerations"] = None
    
    print("\n" + "="*80)
    print("EVALUATION COMPLETE")
    print("="*80 + "\n")
    
    # Generate report
    report = generate_report(results)
    report_path = project_root / "output" / "evaluation-223-deepeval-report.md"
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(report)
    print(f"📄 Report saved to: {report_path}")
    print()
    
    return results

if __name__ == "__main__":
    # Run evaluation
    run_all_tests()

