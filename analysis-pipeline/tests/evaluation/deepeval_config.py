"""
DeepEval Configuration for Hearing Analysis Pipeline

This module configures deepeval for evaluating LLM outputs in the hearing analysis pipeline.
"""

import os
from deepeval import evaluate
from deepeval.metrics import (
    AnswerRelevancyMetric,
    FaithfulnessMetric,
    ContextualPrecisionMetric,
    HallucinationMetric,
    GEval
)
from deepeval.test_case import LLMTestCase, LLMTestCaseParams

# Configure OpenAI for deepeval
# Using gpt-5-mini as default evaluation model (cost-effective, within budget)
# You can override with environment variables:
# OPENAI_API_KEY - your API key (required)
# DEEPEVAL_MODEL - model to use for evaluation (default: gpt-5-mini)

# Set default model for all metrics
DEFAULT_EVAL_MODEL = "gpt-5-mini"

def get_coherence_metric():
    """
    Custom G-Eval metric for language coherence in Danish.
    
    Evaluates:
    - Natural language flow
    - Proper conjunctions
    - Sentence structure
    - Danish grammar correctness
    """
    return GEval(
        name="Language Coherence",
        criteria="Evaluate the coherence and naturalness of the Danish text. "
                "Check for: 1) Natural sentence flow without choppy transitions, "
                "2) Proper use of conjunctions (not excessive semicolons), "
                "3) Grammatically correct Danish, "
                "4) Clear and professional tone suitable for municipal documents.",
        evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
        threshold=0.7,
        model=DEFAULT_EVAL_MODEL
    )

def get_completeness_metric():
    """
    Custom G-Eval metric for argument completeness.
    
    Evaluates whether all key arguments from input are captured in output.
    """
    return GEval(
        name="Argument Completeness",
        criteria="Evaluate whether the summary captures all key arguments and concerns "
                "from the input responses. Check that no significant points are omitted "
                "and that the summary represents the full scope of input.",
        evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
        threshold=0.8,
        model=DEFAULT_EVAL_MODEL
    )

def get_aggregation_quality_metric():
    """
    Custom G-Eval metric for aggregation quality.
    
    Evaluates whether arguments are appropriately grouped.
    """
    return GEval(
        name="Aggregation Quality",
        criteria="Evaluate whether the arguments are appropriately grouped. "
                "Check: 1) Similar concerns are grouped together, "
                "2) Distinct concerns are kept separate, "
                "3) Grouping makes logical sense, "
                "4) No over-merging of different issues, "
                "5) No under-merging of identical issues.",
        evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT, LLMTestCaseParams.EXPECTED_OUTPUT],
        threshold=0.75,
        model=DEFAULT_EVAL_MODEL
    )

def get_verbosity_metric():
    """
    Custom G-Eval metric for appropriate verbosity.
    
    Evaluates whether output has sufficient detail without being redundant.
    """
    return GEval(
        name="Appropriate Verbosity",
        criteria="Evaluate whether the output has appropriate verbosity. "
                "It should: 1) Provide sufficient detail and context, "
                "2) Include analytical insights not just facts, "
                "3) Avoid redundancy and repetition, "
                "4) Be neither too terse nor too verbose.",
        evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
        threshold=0.7,
        model=DEFAULT_EVAL_MODEL
    )

# Standard metrics
def get_faithfulness_metric():
    """
    Faithfulness metric - ensures output is grounded in input without hallucinations.
    """
    return FaithfulnessMetric(
        threshold=0.8,
        model=DEFAULT_EVAL_MODEL,
        include_reason=True
    )

def get_answer_relevancy_metric():
    """
    Answer relevancy metric - ensures output addresses the input.
    """
    return AnswerRelevancyMetric(
        threshold=0.7,
        model=DEFAULT_EVAL_MODEL,
        include_reason=True
    )

def get_hallucination_metric():
    """
    Hallucination metric - detects fabricated information.
    """
    return HallucinationMetric(
        threshold=0.3,  # Lower is better (less hallucination)
        model=DEFAULT_EVAL_MODEL,
        include_reason=True
    )

def get_citation_precision_metric():
    """
    Contextual precision for citation accuracy.
    """
    return ContextualPrecisionMetric(
        threshold=0.8,
        model=DEFAULT_EVAL_MODEL,
        include_reason=True
    )

# Metric sets for different pipeline steps
POSITION_WRITING_METRICS = [
    get_coherence_metric(),
    get_faithfulness_metric(),
    get_completeness_metric(),
    get_answer_relevancy_metric(),
]

AGGREGATION_METRICS = [
    get_aggregation_quality_metric(),
    get_faithfulness_metric(),
    get_completeness_metric(),
]

CONSIDERATIONS_METRICS = [
    get_coherence_metric(),
    get_verbosity_metric(),
    get_faithfulness_metric(),
]

CITATION_METRICS = [
    get_citation_precision_metric(),
    get_faithfulness_metric(),
    get_hallucination_metric(),
]

MICRO_SUMMARY_METRICS = [
    get_faithfulness_metric(),
    get_completeness_metric(),
    get_answer_relevancy_metric(),
]

def evaluate_pipeline_step(test_cases, metrics, step_name="Unknown"):
    """
    Evaluate a pipeline step with the given test cases and metrics.
    
    Args:
        test_cases: List of LLMTestCase objects
        metrics: List of metric objects
        step_name: Name of the pipeline step being evaluated
    
    Returns:
        dict: Evaluation results
    """
    print(f"\n{'='*60}")
    print(f"Evaluating: {step_name}")
    print(f"{'='*60}")
    print(f"Test cases: {len(test_cases)}")
    # Get metric names safely (some metrics have .name, others have .__class__.__name__)
    metric_names = []
    for m in metrics:
        if hasattr(m, 'name'):
            metric_names.append(m.name)
        elif hasattr(m, '__class__'):
            metric_names.append(m.__class__.__name__)
        else:
            metric_names.append("Unknown")
    print(f"Metrics: {metric_names}")
    print()
    
    # Run evaluation - deepeval will print results automatically
    results = evaluate(
        test_cases=test_cases,
        metrics=metrics
    )
    
    return results

def create_position_writing_test_case(
    input_arguments,
    actual_summary,
    expected_summary=None,
    retrieval_context=None
):
    """
    Create a test case for position writing evaluation.
    
    Args:
        input_arguments: List of argument dicts or concatenated string
        actual_summary: The generated position summary
        expected_summary: Optional golden/expected summary
        retrieval_context: Optional retrieved chunks used
    
    Returns:
        LLMTestCase
    """
    if isinstance(input_arguments, list):
        input_str = "\n\n".join([
            f"Argument {i+1}:\n{arg.get('coreContent', '')}\n{arg.get('concern', '')}"
            for i, arg in enumerate(input_arguments)
        ])
    else:
        input_str = input_arguments
    
    return LLMTestCase(
        input=input_str,
        actual_output=actual_summary,
        expected_output=expected_summary,
        retrieval_context=retrieval_context or []
    )

def create_aggregation_test_case(
    input_arguments,
    actual_positions,
    expected_positions=None
):
    """
    Create a test case for aggregation evaluation.
    
    Args:
        input_arguments: List of arguments to be aggregated
        actual_positions: The generated positions (list of dicts with title, summary, responseNumbers)
        expected_positions: Optional golden positions
    
    Returns:
        LLMTestCase
    """
    if isinstance(input_arguments, list):
        input_str = "\n\n".join([
            f"Response {arg.get('responseNumber', '?')}: {arg.get('coreContent', '')}"
            for arg in input_arguments
        ])
    else:
        input_str = input_arguments
    
    if isinstance(actual_positions, list):
        actual_str = "\n\n".join([
            f"Position: {pos.get('title', 'Untitled')}\n"
            f"Responses: {pos.get('responseNumbers', [])}\n"
            f"Summary: {pos.get('summary', '')}"
            for pos in actual_positions
        ])
    else:
        actual_str = actual_positions
    
    if expected_positions and isinstance(expected_positions, list):
        expected_str = "\n\n".join([
            f"Position: {pos.get('title', 'Untitled')}\n"
            f"Responses: {pos.get('responseNumbers', [])}\n"
            f"Summary: {pos.get('summary', '')}"
            for pos in expected_positions
        ])
    else:
        expected_str = expected_positions
    
    return LLMTestCase(
        input=input_str,
        actual_output=actual_str,
        expected_output=expected_str
    )

def create_considerations_test_case(
    input_statistics,
    actual_considerations,
    expected_considerations=None
):
    """
    Create a test case for considerations generation evaluation.
    
    Args:
        input_statistics: Stats about the hearing (dict or string)
        actual_considerations: The generated considerations text
        expected_considerations: Optional golden considerations
    
    Returns:
        LLMTestCase
    """
    if isinstance(input_statistics, dict):
        input_str = f"""
Hearing Statistics:
- Total responses: {input_statistics.get('responseCount', 'N/A')}
- Total positions: {input_statistics.get('positionCount', 'N/A')}
- Themes: {input_statistics.get('themeCount', 'N/A')}
- Multi-theme arguments: {input_statistics.get('multiThemeArgs', 'N/A')}
- Large positions: {input_statistics.get('largePositions', 'N/A')}
"""
    else:
        input_str = input_statistics
    
    return LLMTestCase(
        input=input_str,
        actual_output=actual_considerations,
        expected_output=expected_considerations,
        retrieval_context=[input_str]  # Provide context for Faithfulness metric
    )

