#!/bin/bash

# Run test13 pipeline with enhanced monitoring
echo "Starting test13 pipeline run with enhanced monitoring..."
echo "Timestamp: $(date)"
echo "Hearing: 223"
echo "Checkpoint: test13"
echo "Expected respondents: 13"
echo "----------------------------------------"

# Set up log file
LOG_FILE="logs/test13-$(date +%Y%m%d-%H%M%S).log"
mkdir -p logs

# Export debug environment variables
export NODE_ENV=development
export DEBUG=*
export LOG_LEVEL=debug

# Start the LLM call monitor in background
echo "Starting LLM call monitor..."
node scripts/monitor-llm-calls.js "$LOG_FILE" &
MONITOR_PID=$!
echo "Monitor PID: $MONITOR_PID"

# Function to cleanup on exit
cleanup() {
    echo -e "\n\nCleaning up..."
    kill $MONITOR_PID 2>/dev/null
    echo "Test13 run finished or interrupted"
    echo "Log file: $LOG_FILE"
    echo "----------------------------------------"
    
    # Show summary of LLM calls
    echo -e "\nLLM Call Summary:"
    grep -E "\[.*\].*(?:Processing|Transforming|Generating|Screening|batch)" "$LOG_FILE" | tail -20
    
    # Check for errors
    echo -e "\nErrors/Warnings:"
    grep -iE "error|warning|failed|timeout|hanging" "$LOG_FILE" | tail -10
}

trap cleanup EXIT INT TERM

# Run the pipeline with verbose logging
echo -e "\nStarting pipeline..."
npm run pipeline:run -- 223 --save-checkpoints --checkpoint test13 2>&1 | tee "$LOG_FILE" &
PIPELINE_PID=$!

echo "Pipeline PID: $PIPELINE_PID"
echo -e "\nMonitoring pipeline execution..."
echo "Press Ctrl+C to stop"
echo "----------------------------------------"

# Monitor the pipeline process
while kill -0 $PIPELINE_PID 2>/dev/null; do
    # Check if process seems to be hanging (no new output for 30 seconds)
    LAST_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    sleep 30
    NEW_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    
    if [ "$LAST_SIZE" -eq "$NEW_SIZE" ] && [ "$NEW_SIZE" -gt 0 ]; then
        echo -e "\n⚠️  WARNING: No new output for 30 seconds - pipeline might be hanging!"
        echo "Last log entries:"
        tail -5 "$LOG_FILE"
        echo -e "\nConsider killing the process (PID: $PIPELINE_PID) if it doesn't recover soon."
    fi
done

wait $PIPELINE_PID
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo -e "\n✅ Pipeline completed successfully!"
else
    echo -e "\n❌ Pipeline failed with exit code: $EXIT_CODE"
fi

exit $EXIT_CODE
