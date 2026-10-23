// 기존 구글 스프레드시트/엑셀 가계부(.xlsx)를 앱 데이터로 변환한다.
// 시트 구성: 수입(날짜·금액·분류·메모), 소비지출/고정비용(날짜·금액·분류·결제 수단·메모), 자산.
const SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

let sheetjs;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  sheetjs = sheetjs || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SHEETJS_URL;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('엑셀 처리 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.'));
    document.head.appendChild(s);
  });
  return sheetjs;
}

const SHEET_TYPES = { '수입': 'income', '소비지출': 'variable', '고정비용': 'fixed' };

const ymd = (y, m, d) => {
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (dt.getMonth() !== Number(m) - 1) return null; // 2월 30일 같은 잘못된 날짜
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

// fallbackYear가 있으면 '10/3', '10월 3일', 903·1002(월일 숫자)처럼 연도 없는 날짜도 받는다.
function toISODate(v, fallbackYear) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && Number.isInteger(v)) v = String(v);
  if (typeof v === 'string' && /^\d{3,4}$/.test(v.trim())) {
    const n = Number(v);
    return fallbackYear && n >= 101 && n <= 1231 ? ymd(fallbackYear, Math.floor(n / 100), n % 100) : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    let m = s.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    if (m) return ymd(m[1], m[2], m[3]);
    m = s.match(/^(20\d{2})(\d{2})(\d{2})(?!\d)/);
    if (m) return ymd(m[1], m[2], m[3]);
    m = s.match(/^(\d{2})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/);
    if (m) return ymd(`20${m[1]}`, m[2], m[3]);
    m = s.match(/^(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    if (m && fallbackYear) return ymd(fallbackYear, m[1], m[2]);
  }
  return null;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,\s원₩]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

const str = (v) => (v == null ? '' : String(v).trim());

function columnIndex(header, names) {
  for (const n of names) {
    const i = header.findIndex((h) => str(h) === n);
    if (i >= 0) return i;
  }
  return -1;
}

export function guessOwner(filename, members) {
  return members.find((m) => filename.includes(m)) || '';
}

export async function parseWorkbook(file) {
  const XLSX = await loadSheetJS();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const tx = [];
  const assets = [];

  for (const [sheetName, type] of Object.entries(SHEET_TYPES)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const header = rows[0] || [];
    const c = {
      date: columnIndex(header, ['날짜']),
      amount: columnIndex(header, ['금액']),
      category: columnIndex(header, ['분류']),
      method: columnIndex(header, ['결제 수단', '결제수단']),
      memo: columnIndex(header, ['메모']),
    };
    if (c.date < 0 || c.amount < 0) continue;
    for (const r of rows.slice(1)) {
      const date = toISODate(r[c.date]);
      const amount = toNumber(r[c.amount]);
      if (!date || !Number.isFinite(amount) || amount === 0) continue;
      tx.push({
        type,
        date,
        amount: Math.round(amount),
        category: str(r[c.category]) || '기타',
        method: type === 'income' ? '' : str(r[c.method]),
        memo: str(r[c.memo]),
      });
    }
  }

  const ws = wb.Sheets['자산'];
  if (ws) {
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const header = rows[0] || [];
    const c = {
      kind: columnIndex(header, ['구분']),
      group: columnIndex(header, ['분류']),
      name: columnIndex(header, ['상세 항목']),
      place: columnIndex(header, ['금융기관/보관처']),
      amount: columnIndex(header, ['평가 금액 (원)', '평가 금액']),
      who: columnIndex(header, ['WHO']),
      note: columnIndex(header, ['비고']),
    };
    if (c.kind >= 0 && c.amount >= 0) {
      for (const r of rows.slice(1)) {
        const kind = str(r[c.kind]);
        const amount = toNumber(r[c.amount]);
        if ((kind !== '자산' && kind !== '부채') || !Number.isFinite(amount)) continue;
        assets.push({
          kind,
          group: str(r[c.group]) || '기타',
          name: str(r[c.name]),
          place: c.place >= 0 ? str(r[c.place]) : '',
          amount: Math.round(amount),
          note: c.note >= 0 ? str(r[c.note]) : '',
          who: c.who >= 0 ? str(r[c.who]) : '',
        });
      }
    }
  }

  return { tx, assets };
}

/* ---------- 일괄 등록 양식 ---------- */
export const TEMPLATE_HEADER = ['날짜', '누구', '구분', '분류', '결제 수단', '금액', '메모'];
const TYPE_ALIASES = {
  variable: ['소비지출', '소비', '지출', '변동지출', '변동비'],
  fixed: ['고정비용', '고정', '고정비', '고정지출'],
  income: ['수입', '입금', '소득'],
};
const typeOf = (s) => {
  const v = str(s).replace(/\s/g, '');
  if (!v) return 'variable';
  return Object.keys(TYPE_ALIASES).find((k) => TYPE_ALIASES[k].includes(v)) || null;
};

export async function downloadTemplate(settings, members) {
  const XLSX = await loadSheetJS();
  const wb = XLSX.utils.book_new();

  const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADER]);
  sheet['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 11 }, { wch: 12 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, sheet, '내역');

  const c = settings.categories;
  const m = settings.methods;
  const guide = [
    ['우리 가계부 일괄 등록 양식'],
    [],
    ['‘내역’ 시트에 한 줄에 하나씩 입력하고 저장한 뒤, 가계부 > 내역 > 엑셀 일괄 등록에서 올리세요.'],
    ['이 ‘안내’ 시트는 읽지 않습니다. 아래 예시를 ‘내역’ 시트로 복사해 써도 됩니다.'],
    [],
    ['열', '필수', '입력 방법'],
    ['날짜', '필수', '2026-10-22, 2026.10.22, 10/22 (연도 생략 시 등록 화면의 연도)'],
    ['누구', '선택', `${members.join(' 또는 ')}. 비우면 등록 화면에서 고른 사람으로 들어갑니다.`],
    ['구분', '선택', '소비지출 / 고정비용 / 수입. 비우면 소비지출.'],
    ['분류', '선택', '아래 목록 중 하나. 목록에 없는 이름도 그대로 저장됩니다. 비우면 기타.'],
    ['결제 수단', '선택', '수입은 비워 두세요.'],
    ['금액', '필수', '숫자만 (쉼표·원 표시는 있어도 괜찮음)'],
    ['메모', '선택', '가게 이름이나 내용'],
    [],
    ['소비지출 분류', c.variable.join(', ')],
    ['고정비용 분류', `${c.fixed.join(', ')}  (저축·단기 적금은 정기 저축으로 집계)`],
    ['수입 분류', c.income.join(', ')],
    ['결제 수단', [...new Set([...m.variable, ...m.fixed])].join(', ')],
    [],
    ['예시'],
    TEMPLATE_HEADER,
    ['2026-10-01', members[0], '소비지출', '식비', '신용카드', 32000, '이마트 장보기'],
    ['2026-10-01', members[1], '고정비용', '통신/구독', '자동이체', 13990, '유튜브 프리미엄'],
    ['2026-10-10', members[0], '수입', '월급', '', 3000000, '10월 급여'],
  ];
  const gs = XLSX.utils.aoa_to_sheet(guide);
  gs['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, gs, '안내');

  XLSX.writeFile(wb, '가계부_일괄등록_양식.xlsx');
}

// 카드사 '.xls' 상당수는 실제로 HTML 표다. 현대카드처럼 `</td   >` 같은 깨진 닫는 태그가 있으면
// 칸이 합쳐져 읽히므로, HTML이면 태그를 바로잡은 뒤 문자열로 읽는다.
async function readBook(XLSX, file) {
  const buf = await file.arrayBuffer();
  const head = new TextDecoder('utf-8').decode(buf.slice(0, 2048)).trimStart().toLowerCase();
  if (head.startsWith('<')) {
    const charset = head.match(/charset=["']?([\w-]+)/)?.[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(buf); } catch { html = new TextDecoder('utf-8').decode(buf); }
    html = html.replace(/<\/\s*(td|th|tr)\s+>/gi, '</$1>');
    return XLSX.read(html, { type: 'string', raw: true });
  }
  return XLSX.read(buf, { type: 'array' });
}

/* ---------- 카드사 이용내역 ---------- */
// 카드사마다 열 이름과 위치가 달라서, 위쪽 몇십 줄에서 '날짜·금액·가맹점' 열이 모두 있는 줄을 머리글로 찾는다.
const CARD_COLS = {
  date: ['이용일', '이용일자', '이용일시', '거래일', '거래일자', '거래일시', '승인일', '승인일자', '승인일시',
    '사용일', '사용일자', '사용일시', '매출일', '매출일자', '이용날짜', '거래날짜', '날짜'],
  amount: ['이용금액', '승인금액', '거래금액', '사용금액', '매출금액', '국내이용금액', '원화이용금액', '원화사용금액',
    '이용금액(원)', '승인금액(원)', '결제금액', '금액'],
  merchant: ['가맹점명', '이용가맹점', '이용가맹점명', '가맹점', '이용하신곳', '이용처', '사용처', '거래처', '상호', '적요', '내용', '메모'],
  status: ['취소여부', '취소구분', '승인구분', '매출구분', '거래구분', '상태', '구분'],
  card: ['카드명', '이용카드', '카드구분', '카드종류', '카드번호', '카드'],
  // 직접 정리한 내역표에만 있는 열
  category: ['분류', '카테고리'],
  method: ['결제수단', '결제 수단'],
};

// 개인 내역표에서 쓰던 분류 이름을 가계부 분류로 맞춘다 (없는 이름은 그대로 둔다)
const CATEGORY_ALIASES = {
  '마트장': '식비', '장보기': '식비', '배달음식': '식비', '배달': '식비', '화장품': '미용',
  '옷/쇼핑': '쇼핑', '옷': '쇼핑', '구독료': '통신/구독', '구독': '통신/구독', '병원': '의료/건강', '간식': '카페/간식',
};
const normHead = (h) => str(h).replace(/\s/g, '').replace(/\((원|KRW)\)$/i, '');

function findCol(header, names) {
  const hs = header.map(normHead);
  for (const n of names) {
    const i = hs.indexOf(normHead(n));
    if (i >= 0) return i;
  }
  return -1;
}

function detectCardSheet(data) {
  for (let i = 0; i < Math.min(data.length, 40); i++) {
    const h = data[i] || [];
    const c = Object.fromEntries(Object.entries(CARD_COLS).map(([k, names]) => [k, findCol(h, names)]));
    if (c.date >= 0 && c.amount >= 0 && c.merchant >= 0) return { headerRow: i, c };
  }
  return null;
}

function parseCardSheet(XLSX, wb, { defaultOwner, year, classify }) {
  for (const name of wb.SheetNames) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const found = detectCardSheet(data);
    if (!found) continue;
    const { headerRow, c } = found;
    const rows = [];
    const errors = [];
    const skipped = { cancel: 0, other: 0 };
    data.slice(headerRow + 1).forEach((r, i) => {
      const line = headerRow + i + 2;
      if (!r || r.every((v) => v == null || str(v) === '')) return;
      const date = toISODate(r[c.date], year);
      const amount = Math.round(toNumber(r[c.amount]));
      const memo = str(r[c.merchant]);
      // 합계·소계·안내 문구 줄은 날짜가 없으니 조용히 건너뛴다
      if (!date) { if (Number.isFinite(amount) && memo) skipped.other += 1; return; }
      const status = c.status >= 0 ? str(r[c.status]) : '';
      if (/취소|거절|실패/.test(status) || amount < 0) { skipped.cancel += 1; return; }
      if (amount === 0) return; // 연회비 0원 같은 안내 줄
      if (!Number.isFinite(amount)) {
        errors.push({ sheet: name, line, msg: `금액 ‘${str(r[c.amount])}’을 읽을 수 없음` });
        return;
      }
      const cardName = c.card >= 0 ? str(r[c.card]) : '';
      const ownCat = c.category >= 0 ? str(r[c.category]) : '';
      const guess = ownCat ? { type: 'variable', category: CATEGORY_ALIASES[ownCat] || ownCat, source: '파일 분류' } : classify(memo);
      const ownMethod = c.method >= 0 ? str(r[c.method]) : '';
      rows.push({
        line, sheet: name, owner: defaultOwner, type: guess.type || 'variable', date, amount, memo,
        category: guess.category, guessed: guess.source,
        method: ownMethod || (/체크/.test(cardName) ? '체크카드' : '신용카드'),
      });
    });
    if (!defaultOwner) {
      errors.unshift({ sheet: '', line: 0, msg: '카드사 파일에는 ‘누구’ 열이 없습니다. 위에서 이 카드의 주인을 고르세요.' });
      return { format: 'card', rows: [], errors, skipped };
    }
    return { format: 'card', rows, errors, skipped };
  }
  return null;
}

// 일괄 등록 파일 읽기: '내역' 양식, 예전 가계부(수입/소비지출/고정비용 시트), 카드사 이용내역.
// 반환: { format, rows: [{line, sheet, ...tx}], errors: [{sheet, line, msg}], skipped? }
export async function parseUpload(file, { members, defaultOwner, year, classify = () => ({ category: '기타', source: '' }) }) {
  const XLSX = await loadSheetJS();
  const wb = await readBook(XLSX, file);
  const rows = [];
  const errors = [];

  const sheetName = wb.SheetNames.find((n) => {
    if (n === '안내') return false;
    const head = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null })[0] || [];
    return columnIndex(head, ['날짜']) >= 0 && columnIndex(head, ['금액']) >= 0 && columnIndex(head, ['구분', '누구']) >= 0;
  });

  if (!sheetName && wb.SheetNames.some((n) => n in SHEET_TYPES)) {
    const legacy = await parseWorkbook(file);
    if (!defaultOwner) {
      errors.push({ sheet: '', line: 0, msg: '예전 가계부 형식에는 ‘누구’ 열이 없습니다. 위에서 사람을 고르세요.' });
    }
    legacy.tx.forEach((t, i) => rows.push({ line: i + 2, sheet: TYPE_LABEL_KO[t.type], ...t, owner: defaultOwner }));
    return { format: 'legacy', rows: defaultOwner ? rows : [], errors };
  }

  if (!sheetName) {
    const card = parseCardSheet(XLSX, wb, { defaultOwner, year, classify });
    if (card) return card;
    errors.push({ sheet: '', line: 0, msg: '날짜·금액·가맹점(또는 메모) 열을 찾지 못했습니다. 양식 파일을 받아 그 형식으로 입력하세요.' });
    return { format: 'unknown', rows: [], errors };
  }

  const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
  const h = data[0];
  const c = {
    date: columnIndex(h, ['날짜']),
    owner: columnIndex(h, ['누구', '사람', '이름']),
    type: columnIndex(h, ['구분']),
    category: columnIndex(h, ['분류', '카테고리']),
    method: columnIndex(h, ['결제 수단', '결제수단']),
    amount: columnIndex(h, ['금액']),
    memo: columnIndex(h, ['메모', '내용']),
  };
  const cell = (r, k) => (c[k] >= 0 ? r[c[k]] : null);

  data.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (!r || r.every((v) => v == null || str(v) === '')) return;
    const problems = [];
    const date = toISODate(cell(r, 'date'), year);
    if (!date) problems.push(`날짜 ‘${str(cell(r, 'date'))}’를 읽을 수 없음`);
    const amount = Math.abs(Math.round(toNumber(cell(r, 'amount'))));
    if (!amount) problems.push(`금액 ‘${str(cell(r, 'amount'))}’이 올바르지 않음`);
    const type = typeOf(cell(r, 'type'));
    if (!type) problems.push(`구분 ‘${str(cell(r, 'type'))}’은 소비지출/고정비용/수입 중 하나여야 함`);
    const owner = str(cell(r, 'owner')) || defaultOwner;
    if (!owner) problems.push('누구 칸이 비어 있음 (위에서 기본 사람을 고르면 해결)');
    else if (!members.includes(owner)) problems.push(`누구 ‘${owner}’는 ${members.join('/')} 중 하나여야 함`);
    if (problems.length) { errors.push({ sheet: sheetName, line, msg: problems.join(', ') }); return; }
    const memo = str(cell(r, 'memo'));
    const guess = type !== 'income' && memo ? classify(memo) : null;
    rows.push({
      line, sheet: sheetName, owner, type, date, amount,
      category: str(cell(r, 'category')) || (guess?.type === type ? guess.category : '기타'),
      method: type === 'income' ? '' : str(cell(r, 'method')),
      memo,
    });
  });
  return { format: 'template', rows, errors };
}

const TYPE_LABEL_KO = { variable: '소비지출', fixed: '고정비용', income: '수입' };
