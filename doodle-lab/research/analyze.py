"""수집한 미리캔버스 데이터로 '그릴 만한 주제'를 찾는다.

지표 (키워드별 상위 요소 기준)
- demand    : sitemap 순서 기반 수요 점수 (앞쪽일수록 많이 찾는다고 가정)
- hand      : 손그림 계열(색연필/크레파스/낙서/수채화...) 요소 비율 → 높으면 우리 스타일 경쟁 치열
- getty     : 게티 등 대형 스톡 비율 → 높으면 개인 작가 콘텐츠가 얇다는 뜻
- creators  : 서로 다른 작가 수
- opportunity = demand × (1 - hand) × (0.5 + 0.5 × getty)

사용법: python3 analyze.py  → report.json (통계만, 작가명 없음), 콘솔 요약
원본(data/)은 분석 후 삭제한다.
"""
import json, re
from collections import Counter
from pathlib import Path

DATA = Path(__file__).parent / "data"

HAND = ["색연필", "크레파스", "크레용", "손그림", "낙서", "수채화", "드로잉", "연필", "파스텔",
        "손글씨", "핸드드로잉", "스케치", "doodle", "hand drawn", "watercolor", "crayon"]
BIG_STOCK = {"Gettyimage", "GETTY", "Shutterstock", "Freepik", "iclickart", "Pixabay", "Unsplash"}
# 그리기 부적합(지도·국기·로고·사진성·민감 주제 등)
SKIP = re.compile(r"지도|map|국기|flag|logo|로고|배경화면|wallpaper|4k|ppt|font|폰트|달력|calendar|"
                  r"템플릿|template|목업|성인|납치|학대|폭력|핵|구속|십자가|예수|성경|tiktok|instagram|"
                  r"facebook|유튜브|png$|^png|svg|3d|gradient|그라데이션|텍스처|텍스쳐|질감|패턴|pattern|"
                  r"배경$|background|표지|레이아웃|layout|디자인$|도표|graph|그래프|다이어그램|조직도|표-디자인|"
                  r"자막바|text-box|바코드|alphabet|알파벳|number|한글|색상표|고화질|하얀-화면|예쁜$")
ASCII = re.compile(r"^[a-z0-9\- ]+$")


def is_hand(el):
    text = " ".join(el["keywords"] + [el.get("name") or ""]).lower()
    return any(h in text for h in HAND)


def main():
    rows = [json.loads(l) for l in (DATA / "elements.jsonl").open()]
    n = max(r["rank"] for r in rows)
    report, style_counter, hand_creators = [], Counter(), Counter()
    for r in rows:
        els = r["elements"] or []
        if not els:
            continue
        for e in els:
            if is_hand(e):
                hand_creators[e["creator"]] += 1
            for k in e["keywords"]:
                if any(h in k.lower() for h in HAND):
                    style_counter[k] += 1
        k = r["keyword"]
        if SKIP.search(k) or ASCII.match(k):
            continue
        hand = sum(map(is_hand, els)) / len(els)
        getty = sum(e["creator"] in BIG_STOCK for e in els) / len(els)
        creators = len({e["creator"] for e in els})
        demand = 1 - (r["rank"] - 1) / n
        tags = Counter(t for e in els for t in e["keywords"] if t and t != k.replace("-", ""))
        report.append({
            "keyword": k, "rank": r["rank"], "n": len(els),
            "demand": round(demand, 3), "hand": round(hand, 2), "getty": round(getty, 2),
            "creators": creators,
            "opportunity": round(demand * (1 - hand) * (0.5 + 0.5 * getty), 3),
            "top_tags": [t for t, _ in tags.most_common(12)],
        })
    report.sort(key=lambda x: -x["opportunity"])
    out = {
        "keywords_analyzed": len(report),
        "style_keywords": style_counter.most_common(20),
        # 작가 이름은 남기지 않고 규모만 기록
        "hand_creator_count": len(hand_creators),
        "hand_top10_share": round(sum(c for _, c in hand_creators.most_common(10)) / max(1, sum(hand_creators.values())), 3),
        "avg_hand_share": round(sum(x["hand"] for x in report) / len(report), 3),
        "ranking": report,
    }
    (Path(__file__).parent / "report.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("분석 키워드:", len(report), "| 평균 손그림 비율:", out["avg_hand_share"])
    print("손그림 스타일 태그:", out["style_keywords"][:12])
    print("손그림 작가 수:", out["hand_creator_count"], "| 상위10명 점유:", out["hand_top10_share"])
    print("\n기회 상위 40")
    for x in report[:40]:
        print(f'{x["rank"]:>4} {x["keyword"]:<14} opp={x["opportunity"]:.2f} hand={x["hand"]:.2f} '
              f'getty={x["getty"]:.2f} cr={x["creators"]} | {", ".join(x["top_tags"][:6])}')
    print("\n손그림 경쟁 치열 (수요 상위 200 중 hand 높은 순)")
    for x in sorted([x for x in report if x["rank"] <= 200], key=lambda x: -x["hand"])[:15]:
        print(f'{x["rank"]:>4} {x["keyword"]:<14} hand={x["hand"]:.2f}')


if __name__ == "__main__":
    main()
