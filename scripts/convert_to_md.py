#!/usr/bin/env python3
"""Convert supported documents (currently PDF) to Markdown using PyMuPDF."""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, Optional, Tuple

# Ensure python_packages is on sys.path if PYTHONPATH is set
pythonpath = os.environ.get('PYTHONPATH', '')
if pythonpath:
    for p in pythonpath.split(os.pathsep):
        if p and p not in sys.path:
            sys.path.insert(0, p)
# Also check for python_packages relative to script location
script_dir = Path(__file__).parent.parent
local_packages = script_dir / 'python_packages'
if local_packages.exists() and str(local_packages) not in sys.path:
    sys.path.insert(0, str(local_packages))

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover - handled at runtime
    raise SystemExit(json.dumps({"error": f"PyMuPDF (fitz) not available: {exc}"}))


def pdf_to_markdown(path: Path, max_pages: Optional[int] = None) -> Tuple[str, int]:
    """Return markdown string and total page count for a PDF."""
    doc = fitz.open(path)
    try:
        lines: list[str] = []
        page_limit = max_pages if max_pages is not None and max_pages > 0 else None
        for idx, page in enumerate(doc):
            if page_limit is not None and idx >= page_limit:
                break
            # Try markdown format first (if supported), fall back to text
            text = ""
            try:
                text = page.get_text("markdown") or ""
            except (AssertionError, ValueError, TypeError):
                # markdown format not supported, use text instead
                pass
            text = text.strip()
            if not text:
                text = page.get_text("text") or ""
                text = text.strip()
            if text:
                lines.append(text)
        markdown = "\n\n".join(lines).strip()
        return markdown, doc.page_count
    finally:
        doc.close()


def convert_file(input_path: Path, max_pages: Optional[int] = None) -> Tuple[str, Dict[str, object]]:
    suffix = input_path.suffix.lower()
    # If no extension, try to detect PDF by file header
    if not suffix:
        try:
            with open(input_path, 'rb') as f:
                header = f.read(4)
                if header.startswith(b'%PDF'):
                    suffix = '.pdf'
        except Exception:
            pass
    if suffix == ".pdf":
        # Verify fitz is available before trying to convert
        try:
            import fitz
        except ImportError:
            raise ValueError("PyMuPDF (fitz) er ikke tilgængelig. PDF-konvertering kræver PyMuPDF.")
        markdown, page_count = pdf_to_markdown(input_path, max_pages=max_pages)
        meta = {"pages": page_count, "type": "pdf"}
        return markdown, meta
    if suffix in {".md", ".markdown"}:
        try:
            markdown = input_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # Try with error handling
            markdown = input_path.read_text(encoding="utf-8", errors="replace")
        return markdown, {"type": "markdown", "pages": None}
    if suffix in {".txt", ""}:
        try:
            markdown = input_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # Try with error handling
            markdown = input_path.read_text(encoding="utf-8", errors="replace")
        return markdown, {"type": "text", "pages": None}
    raise ValueError(f"Unsupported file extension: {suffix or 'unknown'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert documents to Markdown using PyMuPDF")
    parser.add_argument("--input", required=True, help="Path to the input file (PDF/Markdown/Text)")
    parser.add_argument("--output", help="Optional path to write the markdown output")
    parser.add_argument("--max-pages", type=int, default=None, help="Limit the number of pages converted")
    parser.add_argument("--format", choices=["json", "text"], default="json", help="Stdout output format")
    parser.add_argument("--metadata", action="store_true", help="Include metadata when using JSON output")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        parser.error(f"Input file not found: {input_path}")

    try:
        markdown, meta = convert_file(input_path, max_pages=args.max_pages)
    except Exception as exc:  # pragma: no cover - runtime conversion errors
        import traceback
        error_msg = str(exc) if exc else 'Ukendt fejl'
        if not error_msg:
            error_msg = f'{type(exc).__name__}: {traceback.format_exc()}'
        payload = {"error": error_msg}
        error_output = json.dumps(payload, ensure_ascii=False)
        sys.stdout.write(error_output)
        sys.stderr.write(f"Conversion error: {error_msg}\n")
        sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
        sys.exit(1)

    if args.output:
        Path(args.output).expanduser().resolve().write_text(markdown, encoding="utf-8")

    if args.format == "json":
        payload: Dict[str, object] = {"markdown": markdown}
        if args.metadata:
            payload["metadata"] = meta
        output = json.dumps(payload, ensure_ascii=False)
        sys.stdout.write(output)
        # Ensure output ends with newline
        if not output.endswith('\n'):
            sys.stdout.write('\n')
    else:
        sys.stdout.write(markdown)
        if not args.output:
            sys.stdout.write("\n")


if __name__ == "__main__":
    main()

