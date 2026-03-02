#!/usr/bin/env python3
"""
BGE Reranker Service
Uses BAAI/bge-reranker-v2-m3 for cross-encoder reranking
"""

import os
import sys
import json
import argparse
from typing import List, Dict, Any, Optional

try:
    from FlagEmbedding import FlagReranker
except ImportError:
    print(json.dumps({
        "error": "FlagEmbedding not installed. Install with: pip install -U FlagEmbedding",
        "success": False
    }))
    sys.exit(1)


class BGEReranker:
    def __init__(self, model_name: str = "BAAI/bge-reranker-v2-m3", use_fp16: bool = True, device: Optional[str] = None):
        """
        Initialize the BGE reranker model.
        
        Args:
            model_name: HuggingFace model identifier
            use_fp16: Use half precision for faster inference
            device: Device to use ('cpu', 'cuda', etc.). If None, auto-detect.
        """
        try:
            # Check for forced CPU mode via environment variable
            forced_device = device or os.environ.get('TORCH_DEVICE')
            
            # Initialize with explicit device if specified
            if forced_device:
                self.reranker = FlagReranker(model_name, use_fp16=use_fp16, devices=forced_device)
            else:
                self.reranker = FlagReranker(model_name, use_fp16=use_fp16)
            
            self.model_name = model_name
        except Exception as e:
            raise RuntimeError(f"Failed to load model {model_name}: {e}")
    
    def rerank(self, query: str, passages: List[str]) -> List[float]:
        """
        Rerank passages for a given query.
        
        Args:
            query: The search query
            passages: List of passage texts to rerank
            
        Returns:
            List of relevance scores (one per passage)
        """
        if not passages:
            return []
        
        # Create query-passage pairs
        pairs = [[query, passage] for passage in passages]
        
        # Compute scores
        try:
            scores = self.reranker.compute_score(pairs, normalize=True)
            
            # Handle single score (not a list)
            if isinstance(scores, (int, float)):
                return [float(scores)]
            
            # Convert to list of floats
            return [float(score) for score in scores]
        except Exception as e:
            # Fallback: return neutral scores
            print(f"Warning: Reranking failed: {e}", file=sys.stderr)
            return [0.5] * len(passages)


def main():
    parser = argparse.ArgumentParser(description="BGE Reranker Service")
    parser.add_argument("--model", default="BAAI/bge-reranker-v2-m3", help="Model name")
    parser.add_argument("--no-fp16", action="store_true", help="Disable FP16")
    parser.add_argument("--batch", action="store_true", help="Batch mode (read JSON from stdin)")
    parser.add_argument("--query", type=str, help="Query string (single mode)")
    parser.add_argument("--passages", type=str, nargs="+", help="Passages (single mode)")
    
    args = parser.parse_args()
    
    try:
        # Initialize model
        reranker = BGEReranker(model_name=args.model, use_fp16=not args.no_fp16)
        
        if args.batch:
            # Batch mode: read JSON from stdin
            input_data = json.load(sys.stdin)
            query = input_data.get("query", "")
            passages = input_data.get("passages", [])
            
            if not query or not passages:
                print(json.dumps({
                    "error": "Missing 'query' or 'passages' in input",
                    "success": False
                }))
                sys.exit(1)
            
            scores = reranker.rerank(query, passages)
            
            print(json.dumps({
                "success": True,
                "scores": scores,
                "count": len(scores)
            }))
        
        else:
            # Single mode: use command line arguments
            if not args.query or not args.passages:
                parser.print_help()
                sys.exit(1)
            
            scores = reranker.rerank(args.query, args.passages)
            
            print(json.dumps({
                "success": True,
                "scores": scores,
                "count": len(scores)
            }))
    
    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "success": False
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()







