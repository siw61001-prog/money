"""키워드별 상위 요소 썸네일을 한 장의 격자 이미지로 모은다 (스타일 비교용).

사용법: python3 contact_sheet.py 키워드 [키워드 ...]  → data/sheets/<키워드>.png
"""
import io, json, sys, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw

DATA = Path(__file__).parent / "data"
SHEETS = DATA / "sheets"
CELL, COLS = 160, 10


def thumb(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        im = Image.open(io.BytesIO(r.read())).convert("RGBA")
    im.thumbnail((CELL - 8, CELL - 8))
    return im


def sheet(keyword, rows):
    els = next((r["elements"] for r in rows if r["keyword"] == keyword), None)
    if not els:
        print("없음:", keyword)
        return
    n = len(els)
    canvas = Image.new("RGBA", (COLS * CELL, ((n + COLS - 1) // COLS) * CELL), "white")
    d = ImageDraw.Draw(canvas)
    for i, e in enumerate(els):
        x, y = (i % COLS) * CELL, (i // COLS) * CELL
        try:
            im = thumb(e["thumb"])
            canvas.alpha_composite(im, (x + (CELL - im.width) // 2, y + (CELL - im.height) // 2))
        except Exception:  # noqa: BLE001
            d.text((x + 10, y + 10), "x", fill="red")
        d.text((x + 3, y + CELL - 12), (e["creator"] or "")[:20], fill=(120, 120, 120))
    SHEETS.mkdir(exist_ok=True)
    out = SHEETS / f"{keyword}.png"
    canvas.convert("RGB").save(out)
    print(out)


if __name__ == "__main__":
    rows = [json.loads(l) for l in (DATA / "elements.jsonl").open()]
    for k in sys.argv[1:]:
        sheet(k, rows)
