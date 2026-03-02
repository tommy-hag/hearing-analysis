# DeepEval Evaluation Framework for Hearing Analysis Pipeline

This directory contains the DeepEval evaluation framework for assessing LLM output quality in the hearing analysis pipeline.

## Setup

### 1. Install DeepEval

```bash
# Activate virtual environment
source venv/bin/activate

# Install deepeval
pip install deepeval
```

### 2. Configure Environment

DeepEval uses **gpt-5-mini** for evaluation by default (cost-effective, within budget). Set your API key:

```bash
export OPENAI_API_KEY="your-api-key"

# Optional: Use a different model for evaluation
export DEEPEVAL_MODEL="gpt-5-mini"  # Default, recommended
# export DEEPEVAL_MODEL="gpt-4"      # More expensive alternative
```

## Usage

### Running Tests

#### Run all tests for hearing 168:

```bash
# Activate venv first
source venv/bin/activate

# Run evaluation
python tests/evaluation/test_hearing_168.py
```

#### Run specific test with pytest:

```bash
pytest tests/evaluation/test_hearing_168.py::test_position_writing_coherence -v
```

#### Run all tests with pytest:

```bash
pytest tests/evaluation/ -v
```

### Understanding Metrics

#### Standard Metrics

1. **Faithfulness** (0-1, higher is better)
   - Measures if output is grounded in input without hallucinations
   - Threshold: 0.8
   - Used for: All steps

2. **Answer Relevancy** (0-1, higher is better)
   - Measures if output addresses the input
   - Threshold: 0.7
   - Used for: Position writing, micro-summarization

3. **Hallucination** (0-1, lower is better)
   - Detects fabricated information
   - Threshold: 0.3 (maximum acceptable)
   - Used for: Citations

4. **Contextual Precision** (0-1, higher is better)
   - Measures accuracy of cited information
   - Threshold: 0.8
   - Used for: Citations

#### Custom G-Eval Metrics

1. **Language Coherence** (0-1, higher is better)
   - Evaluates natural Danish language flow
   - Checks: sentence structure, conjunctions, grammar
   - Threshold: 0.7
   - Used for: Position writing, considerations

2. **Argument Completeness** (0-1, higher is better)
   - Checks if all key arguments are captured
   - Threshold: 0.8
   - Used for: Position writing, micro-summarization, aggregation

3. **Aggregation Quality** (0-1, higher is better)
   - Evaluates grouping appropriateness
   - Checks: similar items grouped, distinct items separated
   - Threshold: 0.75
   - Used for: Aggregation

4. **Appropriate Verbosity** (0-1, higher is better)
   - Checks detail level and analytical depth
   - Threshold: 0.7
   - Used for: Considerations

## Metric Sets by Pipeline Step

### Position Writing
- Language Coherence
- Faithfulness
- Argument Completeness
- Answer Relevancy

### Aggregation
- Aggregation Quality
- Faithfulness
- Argument Completeness

### Considerations Generation
- Language Coherence
- Appropriate Verbosity
- Faithfulness

### Citation Extraction
- Contextual Precision
- Faithfulness
- Hallucination

### Micro-Summarization
- Faithfulness
- Argument Completeness
- Answer Relevancy

## Creating Custom Test Cases

### Position Writing Test Case

```python
from tests.evaluation.deepeval_config import (
    create_position_writing_test_case,
    POSITION_WRITING_METRICS
)
from deepeval import assert_test

# Your data
input_arguments = [
    {"coreContent": "...", "concern": "..."},
    {"coreContent": "...", "concern": "..."}
]
actual_summary = "Your generated summary..."

# Create test case
test_case = create_position_writing_test_case(
    input_arguments=input_arguments,
    actual_summary=actual_summary
)

# Evaluate
assert_test(test_case, POSITION_WRITING_METRICS)
```

### Aggregation Test Case

```python
from tests.evaluation.deepeval_config import (
    create_aggregation_test_case,
    AGGREGATION_METRICS
)

# Your data
input_arguments = [...]  # List of arguments
actual_positions = [...]  # List of positions with title, summary, responseNumbers

# Create and evaluate
test_case = create_aggregation_test_case(
    input_arguments=input_arguments,
    actual_positions=actual_positions
)
assert_test(test_case, AGGREGATION_METRICS)
```

## Interpreting Results

DeepEval outputs:
- **Score**: Metric value (0-1 for most metrics)
- **Pass/Fail**: Based on threshold
- **Reason**: Explanation from GPT-4 about the score

Example output:
```
Test Case: Position Writing
- Language Coherence: 0.85 ✓ (threshold: 0.7)
  Reason: Text flows naturally with proper Danish grammar...
- Faithfulness: 0.92 ✓ (threshold: 0.8)
  Reason: All claims are grounded in input...
```

## Cost Considerations

DeepEval uses **gpt-5-mini** for evaluation by default:
- Each test case makes multiple API calls (one per metric)
- Estimate: ~$0.005-0.02 per test case (cheaper than gpt-4)
- Within budget constraint (max gpt-5-mini)
- Good balance of quality and cost
- Consider using smaller sample sizes for frequent tests

**Note:** To use gpt-4 instead (more expensive):
```python
# In deepeval_config.py, change:
DEFAULT_EVAL_MODEL = "gpt-4"
```

## Integration with Pipeline

### Evaluating After Model Changes

1. Run pipeline with old config → checkpoint A
2. Update models per recommendations
3. Run pipeline with new config → checkpoint B
4. Run deepeval on both checkpoints
5. Compare scores to validate improvements

### Continuous Evaluation

Consider adding deepeval tests to CI/CD:
```bash
# In your CI script
pytest tests/evaluation/ --maxfail=1
```

## Troubleshooting

### Import Errors
```bash
# Make sure you're in the venv
source venv/bin/activate

# Install deepeval
pip install deepeval
```

### API Key Issues
```bash
# Check if key is set
echo $OPENAI_API_KEY

# Set it if missing
export OPENAI_API_KEY="sk-..."
```

### Model Configuration
The default evaluation model is gpt-5-mini (set in `deepeval_config.py`):
```python
DEFAULT_EVAL_MODEL = "gpt-5-mini"
```

To change globally, edit this constant. Or override per test:
```bash
export DEEPEVAL_MODEL="gpt-4"  # More expensive but potentially better
```

## Golden Outputs

For best results, create "golden" expected outputs for comparison:

1. Manually review and correct a subset of outputs
2. Save as golden standards in `tests/evaluation/golden/`
3. Use `expected_output` parameter in test cases
4. This enables more accurate comparison metrics

Example:
```python
test_case = create_position_writing_test_case(
    input_arguments=input_args,
    actual_summary=actual_summary,
    expected_summary=golden_summary  # Your manually corrected version
)
```

