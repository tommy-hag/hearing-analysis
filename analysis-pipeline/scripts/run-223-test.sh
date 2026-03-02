#!/bin/bash

# Wrapper script to run Hearing 223 test with monitoring
# Runs pipeline in background and provides monitoring commands

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  HEARING 223 TEST RUNNER"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""

# Check if already running
PIPELINE_PID=$(pgrep -f "test-223-with-eval.js" || true)
if [ -n "$PIPELINE_PID" ]; then
    echo "⚠️  Test already running (PID: $PIPELINE_PID)"
    echo "   Use monitor script to check progress:"
    echo "   bash scripts/monitor-223-test.sh"
    exit 1
fi

# Run test script
echo "🚀 Starting test run..."
echo ""

cd "$PROJECT_ROOT"

# Run in background and capture PID
nohup node scripts/test-223-with-eval.js > /dev/null 2>&1 &
TEST_PID=$!

echo "✅ Test started (PID: $TEST_PID)"
echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "Monitoring commands:"
echo ""
echo "  # View progress"
echo "  bash scripts/monitor-223-test.sh"
echo ""
echo "  # Follow log in real-time"
echo "  tail -f pipeline-223-test-*.log"
echo ""
echo "  # Check if still running"
echo "  ps aux | grep test-223-with-eval"
echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "Test will:"
echo "  1. Run full pipeline with checkpoints (test-med-docx-*)"
echo "  2. Generate comprehensive log file"
echo "  3. Run deepeval evaluation"
echo "  4. Generate summary report"
echo ""
echo "Expected duration: ~2 hours"
echo ""
echo "Output files:"
echo "  - pipeline-223-test-<timestamp>.log"
echo "  - output/pipeline-223-test-summary.md"
echo "  - output/evaluation-223-deepeval-report.md"
echo "  - output/checkpoints/223/test-med-docx-<timestamp>/"
echo ""

