#!/usr/bin/env python3
"""
Persistent BGE Reranker Server

Loads the model once and serves reranking requests via HTTP.
This eliminates the ~40s startup overhead per request.

Usage:
    python reranker-server.py [--port 5050] [--model BAAI/bge-reranker-v2-m3]
    
API:
    POST /rerank
    Body: {"query": "...", "passages": ["...", "..."]}
    Response: {"success": true, "scores": [0.9, 0.7, ...]}
    
    GET /health
    Response: {"status": "ready", "model": "..."}
"""

import os
import sys
import json
import argparse
import signal
import atexit
from flask import Flask, request, jsonify

# Force CPU mode for compatibility
os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ['TORCH_DEVICE'] = 'cpu'

app = Flask(__name__)

# Global reranker instance - loaded once at startup
reranker = None
model_name = None

def load_model(model: str, use_fp16: bool = False):
    """Load the reranker model."""
    global reranker, model_name
    
    try:
        from FlagEmbedding import FlagReranker
        print(f"[RerankerServer] Loading model: {model}...")
        reranker = FlagReranker(model, use_fp16=use_fp16, devices='cpu')
        model_name = model
        print(f"[RerankerServer] ✅ Model loaded successfully")
        return True
    except Exception as e:
        print(f"[RerankerServer] ❌ Failed to load model: {e}", file=sys.stderr)
        return False

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    if reranker is None:
        return jsonify({
            "status": "not_ready",
            "error": "Model not loaded"
        }), 503
    
    return jsonify({
        "status": "ready",
        "model": model_name
    })

@app.route('/rerank', methods=['POST'])
def rerank():
    """Rerank passages for a query."""
    if reranker is None:
        return jsonify({
            "success": False,
            "error": "Model not loaded"
        }), 503
    
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({
                "success": False,
                "error": "No JSON body provided"
            }), 400
        
        query = data.get('query', '')
        passages = data.get('passages', [])
        
        if not query or not passages:
            return jsonify({
                "success": False,
                "error": "Missing 'query' or 'passages'"
            }), 400
        
        # Create query-passage pairs
        pairs = [[query, passage] for passage in passages]
        
        # Compute scores
        scores = reranker.compute_score(pairs, normalize=True)
        
        # Handle single score
        if isinstance(scores, (int, float)):
            scores = [float(scores)]
        else:
            scores = [float(s) for s in scores]
        
        return jsonify({
            "success": True,
            "scores": scores,
            "count": len(scores)
        })
    
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Gracefully shutdown the server."""
    func = request.environ.get('werkzeug.server.shutdown')
    if func is None:
        # For newer Flask versions, use os._exit
        print("[RerankerServer] Shutting down...")
        os._exit(0)
    func()
    return jsonify({"status": "shutting_down"})

def write_pid_file(port):
    """Write PID file for process management."""
    pid_file = f"/tmp/reranker-server-{port}.pid"
    with open(pid_file, 'w') as f:
        f.write(str(os.getpid()))
    
    def cleanup():
        try:
            os.remove(pid_file)
        except:
            pass
    
    atexit.register(cleanup)
    return pid_file

def main():
    parser = argparse.ArgumentParser(description="Persistent BGE Reranker Server")
    parser.add_argument("--port", type=int, default=5050, help="Port to listen on")
    parser.add_argument("--model", default="BAAI/bge-reranker-v2-m3", help="Model name")
    parser.add_argument("--no-fp16", action="store_true", help="Disable FP16 (use FP32)")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    
    args = parser.parse_args()
    
    # Load model before starting server
    if not load_model(args.model, use_fp16=not args.no_fp16):
        sys.exit(1)
    
    # Write PID file
    pid_file = write_pid_file(args.port)
    print(f"[RerankerServer] PID file: {pid_file}")
    
    # Handle signals gracefully
    def signal_handler(signum, frame):
        print(f"\n[RerankerServer] Received signal {signum}, shutting down...")
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Start server
    print(f"[RerankerServer] Starting server on {args.host}:{args.port}")
    app.run(host=args.host, port=args.port, threaded=True)

if __name__ == "__main__":
    main()


