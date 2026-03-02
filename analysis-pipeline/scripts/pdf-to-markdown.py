#!/usr/bin/env python3
"""
PDF → Markdown konverterings-pipeline med GUI-dialog, dynamisk overskriftssættelse,
forbedret paragraph-joining og footer/header-filtrering.

Workflow:
  1. GUI: Vælg PDF-fil (eller mappe) hvis -i ikke angivet
  2. PyMuPDF `page.get_text("dict")` for at få blokke (tekst, billeder, spans, positions)
  3. Sortér blokke efter side, y- og x-koordinater for kolonnelæsning
  4. Dynamisk overskrift-niveauer: find body-text fontstørrelse (mode), overskriftsstørrelser > body, op til 12 niveauer
  5. Eksportér billeder som separate filer og genkend captions
  6. Filtrér header/footer: skip blokke inden for top/bund margin eller gentaget tekst
  7. Paragraph-joining: rejoin linjer i samme blok, fjerne hyfener og midt-linje brud
  8. Slå blokke sammen til Markdown: overskrifter (##… op til 12 #), lister, afsnit, billeder med captions

Dependencies:
  - PyMuPDF (fitz)

Installér med:
  pip install PyMuPDF
"""
import sys, os, argparse, re, json
from collections import Counter
import fitz  # PyMuPDF


def extract_blocks(pdf_path):
    doc = fitz.open(pdf_path)
    blocks = []
    for pagenr, page in enumerate(doc, start=1):
        data = page.get_text("dict")
        height = page.rect.height
        for b in data.get("blocks", []):
            b['page'] = pagenr
            b['page_height'] = height
            # find xref
            xref = b.get('xref') if isinstance(b, dict) else None
            img_info = b.get('image') if isinstance(b, dict) else None
            if xref is None and isinstance(img_info, dict):
                xref = img_info.get('xref')
            b['xref'] = xref
            blocks.append((page, b))
    return doc, blocks


def detect_heading_levels(blocks):
    sizes = [span['size'] for _,b in blocks if b['type']==0 
             for line in b.get('lines',[]) for span in line.get('spans',[])]
    if not sizes: return {}, None
    body = Counter(sizes).most_common(1)[0][0]
    unique = sorted(set(sizes), reverse=True)
    headings = [s for s in unique if s>body]
    return {s:idx for idx,s in enumerate(headings,1) if idx<=12}, body


def save_image(doc, b, img_dir):
    xref = b.get('xref')
    if not xref: return None
    img = doc.extract_image(xref)
    ext = img.get('ext','png'); name=f"page{b['page']}_img{xref}.{ext}"
    os.makedirs(img_dir,exist_ok=True)
    with open(os.path.join(img_dir,name),'wb') as f: f.write(img['image'])
    return name


def is_footer_or_header(b):
    bbox = b.get('bbox', [0,0,0,0])
    y0, y1 = bbox[1], bbox[3]
    h = b.get('page_height',0)
    # skip top 5% and bottom 5% of page
    if y0 < 0.05*h or y1 > 0.95*h:
        return True
    text = ''.join(span['text'] for line in b.get('lines',[]) for span in line.get('spans',[])).strip()
    # skip common footer patterns: page numbers, repeated titles
    if re.fullmatch(r"\d+", text): return True
    if len(text)>0 and text.lower().startswith('forslag til tillæg'): return True
    return False


def blocks_to_markdown(doc, blocks, size_to_level, body_size, img_dir="images"):
    md=[]; prev_img=None
    sorted_blocks = sorted(blocks, key=lambda pb:(pb[0].number,pb[1].get('bbox',[0,0])[1],pb[1].get('bbox',[0,0])[0]))
    for page, b in sorted_blocks:
        if is_footer_or_header(b): continue
        if b['type']==1:
            prev_img = save_image(doc,b,img_dir); continue
        if b['type']==0:
            # assemble lines
            lines=[]; sizes=[]
            for line in b.get('lines',[]):
                text=''.join(span.get('text','') for span in line.get('spans',[])).strip()
                if text: lines.append(text)
                sizes += [span['size'] for span in line.get('spans',[])]
            if not lines: continue
            # image caption
            if prev_img and re.match(r'^(?:Tegning|Figur)\b',lines[0]):
                md.append(f"![{lines[0]}]({img_dir}/{prev_img})"); prev_img=None; continue
            if prev_img: md.append(f"![]({img_dir}/{prev_img})"); prev_img=None
            # heading?
            maxs = max(sizes) if sizes else body_size
            lvl = size_to_level.get(maxs)
            if lvl:
                joined = ' '.join(lines)
                # Skip TOC entries (have dots/periods followed by page numbers)
                # Pattern: "§ 5. Bil- og cykelparkering .......................................... 26"
                if re.search(r'\.{3,}|\. \. \.|\.+ *\d+\s*$', joined):
                    # TOC entry - demote to paragraph (no heading markup)
                    md.append(joined)
                else:
                    md.append(f"{'#'*lvl} {joined}")
            else:
                # paragraph joining
                para=''
                for ln in lines:
                    para += ln[:-1] if ln.endswith('-') else ln+' '
                para=para.strip()
                if re.match(r'^[-*]\s+|^\d+\.\s+',para): md.extend(ln.strip() for ln in para.split('\n'))
                else: md.append(para)
    if prev_img: md.append(f"![]({img_dir}/{prev_img})")
    return '\n\n'.join(md)


def convert_file(input_path, output_path=None):
    """Convert PDF to markdown. Returns (markdown, metadata) tuple."""
    doc, blocks = extract_blocks(input_path)
    size_map, body = detect_heading_levels(blocks)
    markdown = blocks_to_markdown(doc, blocks, size_map, body)
    page_count = doc.page_count
    doc.close()

    metadata = {
        "pages": page_count,
        "type": "pdf",
        "converter": "pdf-to-markdown-advanced"
    }

    if output_path:
        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        open(output_path, 'w', encoding='utf-8').write(markdown)
        print(f"Converted: {input_path} → {output_path}", file=sys.stderr)

    return markdown, metadata


def main():
    p = argparse.ArgumentParser(description="PDF→Markdown med footer/header filtrering og dynamisk overskriftsdetektion")
    p.add_argument('-i', '--input', required=True, help='Input PDF file or directory')
    p.add_argument('-o', '--output', required=False, help='Output markdown file or directory')
    p.add_argument('--format', choices=['json', 'text'], default='text', help='Output format (json returns {"markdown": ...})')
    p.add_argument('--metadata', action='store_true', help='Include metadata in JSON output')
    p.add_argument('--max-pages', type=int, default=None, help='Limit number of pages (ignored, for compatibility)')
    a = p.parse_args()
    inp = a.input

    if not inp:
        print("Ingen PDF valgt. Afslutter.", file=sys.stderr)
        sys.exit(1)

    # Handle directory input
    if os.path.isdir(inp):
        od = a.output or os.path.join(inp, 'md_output')
        os.makedirs(od, exist_ok=True)
        for f in os.listdir(inp):
            if f.lower().endswith('.pdf'):
                convert_file(os.path.join(inp, f), os.path.join(od, os.path.splitext(f)[0] + '.md'))
        return

    # Single file
    if not inp.lower().endswith('.pdf'):
        error_payload = {"error": "Fejl: ikke en PDF-fil."}
        if a.format == 'json':
            print(json.dumps(error_payload, ensure_ascii=False))
        else:
            print(error_payload["error"], file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(inp):
        error_payload = {"error": f"Fil ikke fundet: {inp}"}
        if a.format == 'json':
            print(json.dumps(error_payload, ensure_ascii=False))
        else:
            print(error_payload["error"], file=sys.stderr)
        sys.exit(1)

    try:
        # Convert - only write to file if output path specified AND format is text
        output_path = a.output if a.format == 'text' else None
        markdown, metadata = convert_file(inp, output_path)

        if a.format == 'json':
            payload = {"markdown": markdown}
            if a.metadata:
                payload["metadata"] = metadata
            output = json.dumps(payload, ensure_ascii=False)
            sys.stdout.write(output)
            if not output.endswith('\n'):
                sys.stdout.write('\n')
        else:
            # Text format - write to file if not already done
            if not a.output:
                default_output = os.path.splitext(inp)[0] + '.md'
                open(default_output, 'w', encoding='utf-8').write(markdown)
                print(f"Converted: {inp} → {default_output}", file=sys.stderr)
            sys.stdout.write(markdown)
            if not markdown.endswith('\n'):
                sys.stdout.write('\n')

    except Exception as exc:
        import traceback
        error_msg = str(exc) if exc else 'Ukendt fejl'
        if not error_msg:
            error_msg = f'{type(exc).__name__}: {traceback.format_exc()}'
        if a.format == 'json':
            print(json.dumps({"error": error_msg}, ensure_ascii=False))
        else:
            print(f"Fejl: {error_msg}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
