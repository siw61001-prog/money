// 데모 모드(?demo=1)용 샘플 데이터. 실제 정보가 아닌 가상의 두 사람 가계부를 만든다.
// 같은 날 같은 링크를 연 사람은 모두 같은 데이터를 보도록 날짜를 씨앗으로 한 난수를 쓴다.

export const SAMPLE_MEMBERS = ['지훈', '수아'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function buildSample(now = new Date()) {
  const [A, B] = SAMPLE_MEMBERS;
  const r = rng(now.getFullYear() * 100 + now.getMonth() + 1);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const round = (n, u = 100) => Math.round(n / u) * u;
  const todayIso = iso(now);
  const tx = [];

  // 지난 5달 + 이번 달(오늘까지)
  for (let back = 5; back >= 0; back--) {
    const first = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = first.getFullYear();
    const m = first.getMonth();
    const days = new Date(y, m + 1, 0).getDate();
    const ym = `${y}-${pad(m + 1)}`;
    const day = (d) => `${ym}-${pad(Math.min(d, days))}`;
    const add = (t) => { if (t.date <= todayIso) tx.push({ method: '', memo: '', sub: '', src: 'sample', ...t }); };

    // 수입
    add({ owner: A, type: 'income', category: '월급', amount: 3200000, date: day(25), memo: '급여' });
    add({ owner: B, type: 'income', category: '월급', amount: 2850000, date: day(10), memo: '급여' });
    if (r() < 0.5) add({ owner: B, type: 'income', category: '부업', amount: round(int(150000, 400000), 10000), date: day(int(15, 28)), memo: '디자인 외주' });
    if (back % 3 === 0) add({ owner: A, type: 'income', category: '금융', amount: int(18000, 32000), date: day(1), memo: '예금 이자' });

    // 고정비용
    const fixed = (owner, category, amount, d, memo, method = '자동이체') => add({ owner, type: 'fixed', category, amount, date: day(d), memo, method });
    fixed(A, '주거', 650000, 1, '월세');
    fixed(A, '공과금', round(int(110000, 160000), 10), 20, '관리비·전기·가스');
    fixed(A, '보험', 98000, 15, '실손·종합보험');
    fixed(B, '보험', 76000, 15, '실손보험');
    fixed(A, '통신/구독', 59000, 21, '휴대폰 요금');
    fixed(B, '통신/구독', 52000, 21, '휴대폰 요금');
    fixed(A, '통신/구독', 17000, 8, '넷플릭스', '신용카드');
    fixed(B, '통신/구독', 14900, 12, '유튜브 프리미엄', '신용카드');
    fixed(A, '저축', 500000, 26, '청약·적금');
    fixed(B, '저축', 600000, 11, '자유적금');
    fixed(B, '단기 적금', 200000, 11, '여행 적금');

    // 소비지출
    const spend = (owner, category, sub, n, lo, hi, memos, method = '신용카드') => {
      for (let i = 0; i < n; i++) add({ owner, type: 'variable', category, sub, amount: round(int(lo, hi)), date: day(int(1, days)), memo: pick(memos), method });
    };
    for (const p of [A, B]) {
      spend(p, '식비', '마트', int(2, 4), 18000, 72000, ['이마트', '홈플러스', '쿠팡 장보기', '컬리']);
      spend(p, '식비', '배달음식', int(2, 4), 17000, 34000, ['배달의민족 치킨', '쿠팡이츠 마라탕', '배달의민족 피자', '요기요 떡볶이']);
      spend(p, '식비', '외식', int(1, 4), 9000, 42000, ['김밥천국', '회사 앞 국밥', '파스타집', '돈까스', '고기집']);
      spend(p, '식비', '편의점', int(3, 6), 1800, 8900, ['GS25', 'CU', '세븐일레븐'], '체크카드');
      spend(p, '간식', '', int(3, 7), 3500, 6800, ['스타벅스', '메가커피', '투썸플레이스', '베이커리'], '체크카드');
      spend(p, '생활비', '', int(1, 2), 5000, 35000, ['다이소', '올리브영', '쿠팡 생필품']);
      spend(p, '교통비', '', int(1, 2), 10000, 25000, ['교통카드 충전', '카카오T 택시']);
      if (r() < 0.6) spend(p, '쇼핑', '', 1, 29000, 89000, ['무신사', '지그재그', '29CM']);
      if (r() < 0.4) spend(p, '미용', '', 1, 15000, 60000, ['미용실', '올리브영 화장품']);
      if (r() < 0.4) spend(p, '취미/여가', '', 1, 12000, 45000, ['CGV 영화', '보드게임 카페', '전시회']);
    }
    spend(A, '주유', '', int(2, 3), 45000, 60000, ['GS칼텍스', 'S-OIL']);
    spend(A, '용돈', '', 1, 200000, 200000, ['부모님 용돈'], '현금/송금');
    spend(B, '용돈', '', 1, 150000, 150000, ['부모님 용돈'], '현금/송금');
    if (r() < 0.5) spend(pick([A, B]), '경조사', '', 1, 50000, 100000, ['친구 결혼식 축의금', '동료 돌잔치'], '현금/송금');
  }

  const assets = [
    { owner: A, kind: '자산', group: '현금', name: '파킹통장', place: '토스뱅크', amount: 8400000, note: '' },
    { owner: A, kind: '자산', group: '저축', name: '주택청약', place: '국민은행', amount: 6200000, note: '' },
    { owner: A, kind: '자산', group: '투자', name: 'ISA', place: '미래에셋', amount: 11800000, note: 'ETF' },
    { owner: B, kind: '자산', group: '현금', name: '입출금통장', place: '카카오뱅크', amount: 2300000, note: '' },
    { owner: B, kind: '자산', group: '저축', name: '자유적금', place: '신한은행', amount: 7200000, note: '' },
    { owner: B, kind: '자산', group: '투자', name: '주식', place: '키움증권', amount: 5600000, note: '' },
    { owner: B, kind: '부채', group: '대출', name: '학자금대출', place: '한국장학재단', amount: 3100000, note: '' },
  ].map((a) => ({ ...a, src: 'sample' }));

  const budgets = {
    '식비|외식': 200000, '식비|마트': 250000, '식비|편의점': 60000, '식비|배달음식': 150000,
    '간식': 100000, '생활비': 100000, '용돈': 350000, '주유': 170000, '교통비': 80000, '경조사': 100000,
  };
  const settings = {
    categories: {
      variable: ['식비', '간식', '생활비', '용돈', '주유', '교통비', '쇼핑', '미용', '취미/여가', '의료/건강', '경조사', '기타'],
    },
    goals: { '통합': 2500000 },
    budgets: { '통합': budgets },
    budgetCounts: { '통합': { '식비|배달음식': 6 } },
    budgetOrder: { '통합': Object.keys(budgets) },
  };

  let id = 0;
  return {
    tx: tx.map((t) => ({ id: `s${++id}`, ...t })),
    assets: assets.map((a) => ({ id: `s${++id}`, ...a })),
    settings,
    assetHistory: {},
  };
}
