#!/bin/bash

# Continuous monitor for Hearing 223 test
# Runs monitor script every 30 seconds and watches for errors

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  HEARING 223 CONTINUOUS MONITOR"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "Monitoring every 30 seconds. Press Ctrl+C to stop."
echo ""

cd "$PROJECT_ROOT"

LAST_ERROR_COUNT=0

while true; do
    # Run monitor
    node scripts/monitor-and-fix-223.js
    
    # Check if process is still running
    RUNNING=$(pgrep -f "test-223-with-eval" | wc -l)
    if [ "$RUNNING" -eq 0 ]; then
        echo ""
        echo "⚠️  Pipeline process stopped!"
        echo "   Check the log file and resume if needed."
        break
    fi
    
    echo ""
    echo "───────────────────────────────────────────────────────────────────────────"
    echo "Next check in 30 seconds... (Press Ctrl+C to stop)"
    echo ""
    
    sleep 30
done

