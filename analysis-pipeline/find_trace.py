
import sys
import json

filename = '/home/laqzww/gdpr/analysis-pipeline/output/llm-traces/job_223_1764543521228.jsonl'
search_term = 'Modstand mod ændringer af Palads'

try:
    with open(filename, 'r', encoding='utf-8') as f:
        for i, line in enumerate(f):
            if search_term in line:
                print(f"Line {i}")
                # Print the JSON if possible
                try:
                    data = json.loads(line)
                    # Only print payload content if it exists
                    if 'payload' in data and 'content' in data['payload']:
                         print(f"Content snippet: {data['payload']['content'][:200]}")
                except:
                    pass
except Exception as e:
    print(f"Error: {e}")
