"""미리캔버스 공개 일러스트 검색 페이지 수집기.

sitemap-search-illust.xml 의 한국어 키워드(= 사람들이 많이 찾는 검색어)마다
/ko/illust/<키워드>/ 페이지의 상위 요소(최대 30개) 메타데이터를 저장한다.
공개 페이지만, 1초 간격으로 요청한다.

사용법: python3 crawl_miricanvas.py [최대키워드수]
결과:   data/keywords.json, data/elements.jsonl
"""
import json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path

BASE = "https://www.miricanvas.com"
UA = "Mozilla/5.0 (research script)"
OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def keywords():
    xml = get(BASE + "/sitemap-search-illust.xml")
    ks = re.findall(r"/ko/illust/([^<]+?)/?</loc>", xml)
    return [urllib.parse.unquote(k) for k in ks if k]


def elements(html):
    dec = json.JSONDecoder()
    seen, out = set(), []
    for m in re.finditer(r'\{"idx":\d+,"typeList"', html):
        try:
            obj, _ = dec.raw_decode(html, m.start())
        except ValueError:
            continue
        if obj["idx"] in seen:
            continue
        seen.add(obj["idx"])
        out.append({
            "idx": obj["idx"],
            "type": obj.get("type"),
            "name": obj.get("name"),
            "creator": obj.get("licenseName"),
            "tier": obj.get("tier"),
            "keywords": (obj.get("keywords") or "").split("|"),
            "colors": [c["color"] for c in obj.get("colorDtoList") or []],
            "thumb": obj.get("thumbnailUrl"),
        })
    return out


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    ks = keywords()[:limit]
    (OUT / "keywords.json").write_text(json.dumps(ks, ensure_ascii=False, indent=1))
    done = set()
    ep = OUT / "elements.jsonl"
    if ep.exists():
        done = {json.loads(l)["keyword"] for l in ep.open()}
    with ep.open("a") as f:
        for rank, k in enumerate(ks, 1):
            if k in done:
                continue
            try:
                els = elements(get(f"{BASE}/ko/illust/{urllib.parse.quote(k)}/"))
            except Exception as e:  # noqa: BLE001
                print("fail", k, e, flush=True)
                els = None
            f.write(json.dumps({"keyword": k, "rank": rank, "elements": els}, ensure_ascii=False) + "\n")
            f.flush()
            print(rank, k, None if els is None else len(els), flush=True)
            time.sleep(1)


if __name__ == "__main__":
    main()
