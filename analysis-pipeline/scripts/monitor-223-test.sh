#!/bin/bash

# Monitor script for Hearing 223 test run
# Shows pipeline progress, log tail, and checkpoint status

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HEARING_ID=223

# Find latest log file
LATEST_LOG=$(ls -t "$PROJECT_ROOT"/pipeline-223-test-*.log 2>/dev/null | head -1)

echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  HEARING 223 TEST MONITOR"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""

# Check if pipeline process is running
PIPELINE_PID=$(pgrep -f "run-pipeline.js.*223" || true)
if [ -n "$PIPELINE_PID" ]; then
    echo "✅ Pipeline process running (PID: $PIPELINE_PID)"
else
    echo "⚠️  No pipeline process found"
fi
echo ""

# Show latest checkpoint directory
CHECKPOINT_BASE="$PROJECT_ROOT/output/checkpoints/$HEARING_ID"
if [ -d "$CHECKPOINT_BASE" ]; then
    LATEST_CHECKPOINT=$(ls -td "$CHECKPOINT_BASE"/test-med-docx-* 2>/dev/null | head -1)
    if [ -n "$LATEST_CHECKPOINT" ]; then
        echo "📁 Latest checkpoint: $(basename "$LATEST_CHECKPOINT")"
        echo ""
        echo "Checkpoint files:"
        ls -lh "$LATEST_CHECKPOINT"/*.json 2>/dev/null | tail -5 | awk '{print "  " $9 " (" $5 ")"}'
    else
        echo "⚠️  No test-med-docx checkpoint found"
    fi
else
    echo "⚠️  Checkpoint directory not found"
fi
echo ""

# Show log tail
if [ -n "$LATEST_LOG" ] && [ -f "$LATEST_LOG" ]; then
    echo "📄 Latest log: $(basename "$LATEST_LOG")"
    echo "═══════════════════════════════════════════════════════════════════════════════"
    echo "Last 20 lines:"
    echo ""
    tail -20 "$LATEST_LOG"
    echo ""
    echo "═══════════════════════════════════════════════════════════════════════════════"
    echo ""
    echo "To follow log in real-time:"
    echo "  tail -f $LATEST_LOG"
else
    echo "⚠️  No log file found"
fi
echo ""

# Show summary if available
SUMMARY_FILE="$PROJECT_ROOT/output/pipeline-223-test-summary.md"
if [ -f "$SUMMARY_FILE" ]; then
    echo "📊 Summary file exists: $(basename "$SUMMARY_FILE")"
    echo ""
fi

echo "═══════════════════════════════════════════════════════════════════════════════"

