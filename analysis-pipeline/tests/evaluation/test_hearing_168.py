"""
DeepEval Test Cases for Hearing 168 Baseline

This module contains test cases for evaluating the quality of hearing 168 outputs
using the implementation-test checkpoint as baseline.
"""

import json
import sys
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

# Load test data
CHECKPOINT_DIR = project_root / "output" / "checkpoints" / "168" / "implementation-test"

def load_json(filename):
    """Load JSON file from checkpoint directory."""
    filepath = CHECKPOINT_DIR / filename
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)

# Load baseline outputs
micro_summaries = load_json("micro-summarize.json")
theme_mapping = load_json("theme-mapping.json")
aggregate_output = load_json("aggregate.json")
position_writing = load_json("hybrid-position-writing.json")
considerations = load_json("considerations.json")

def test_position_writing_coherence():
    """Test language coherence in position writing for a sample position."""
    # Select a sample position (first one from "Anvendelse" theme)
    position = position_writing[0]["positions"][0]
    
    # Get the micro-summaries for these responses
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
    
    # Test only coherence metric for this specific test
    from tests.evaluation.deepeval_config import get_coherence_metric
    assert_test(test_case, [get_coherence_metric()])

def test_position_writing_full():
    """Test full position writing quality for multiple positions."""
    test_cases = []
    
    # Test first 3 positions
    count = 0
    for theme in position_writing[:2]:  # First 2 themes
        for position in theme["positions"][:2]:  # First 2 positions per theme
            if count >= 3:
                break
            
            response_nums = position["responseNumbers"]
            input_args = []
            for ms in micro_summaries:
                if ms["responseNumber"] in response_nums:
                    for arg in ms.get("arguments", []):
                        input_args.append(arg)
            
            if input_args:  # Only if we have input
                test_case = create_position_writing_test_case(
                    input_arguments=input_args,
                    actual_summary=position["summary"]
                )
                test_cases.append(test_case)
                count += 1
    
    if test_cases:
        results = evaluate_pipeline_step(
            test_cases,
            POSITION_WRITING_METRICS,
            "Position Writing (Hearing 168)"
        )
        return results
    else:
        print("No test cases generated for position writing")
        return None

def test_aggregation_quality():
    """Test aggregation quality for grouping arguments."""
    # Test aggregation for one theme
    theme = aggregate_output[0]  # First theme
    
    # Get all arguments for this theme from theme mapping
    theme_data = None
    for t in theme_mapping.get("themes", []):
        if t["name"] == theme["name"]:
            theme_data = t
            break
    
    if theme_data:
        input_arguments = theme_data.get("arguments", [])
        actual_positions = theme["positions"]
        
        test_case = create_aggregation_test_case(
            input_arguments=input_arguments,
            actual_positions=actual_positions
        )
        
        results = evaluate_pipeline_step(
            [test_case],
            AGGREGATION_METRICS,
            f"Aggregation - {theme['name']} (Hearing 168)"
        )
        return results
    else:
        print(f"Theme {theme['name']} not found in theme mapping")
        return None

def test_considerations_quality():
    """Test considerations generation quality."""
    # Extract statistics from the outputs
    input_stats = {
        "responseCount": len(micro_summaries),
        "positionCount": sum(len(t["positions"]) for t in aggregate_output),
        "themeCount": len(theme_mapping.get("themes", [])),
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
    
    results = evaluate_pipeline_step(
        [test_case],
        CONSIDERATIONS_METRICS,
        "Considerations Generation (Hearing 168)"
    )
    return results

def run_all_tests():
    """Run all evaluation tests for hearing 168."""
    print("\n" + "="*80)
    print("HEARING 168 BASELINE EVALUATION")
    print("="*80 + "\n")
    
    results = {}
    
    print("\n[1/3] Testing Position Writing...")
    results["position_writing"] = test_position_writing_full()
    
    print("\n[2/3] Testing Aggregation...")
    results["aggregation"] = test_aggregation_quality()
    
    print("\n[3/3] Testing Considerations...")
    results["considerations"] = test_considerations_quality()
    
    print("\n" + "="*80)
    print("EVALUATION COMPLETE")
    print("="*80 + "\n")
    
    return results

if __name__ == "__main__":
    # Run evaluation
    run_all_tests()

