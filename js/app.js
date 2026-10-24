import { createStore, MEMBERS } from './store.js';
import { parseWorkbook, guessOwner, downloadTemplate, parseUpload } from './import.js';

// 고정비용 중 이 분류는 '지출'이 아니라 '정기 저축'으로 집계한다.
const SAVING_CATS = ['저축', '단기 적금'];
const TYPE_LABEL = { variable: '소비지출', fixed: '고정비용', income: '수입' };
const VIEWS = ['dashboard', 'list', 'assets', 'settings'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const local = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const S = {
  store: null,
  user: null,
  tx: [],
  assets: [],
  settings: null,
  ready: false,
  who: local.get('who', 'all'),
  view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard',
  ym: today().slice(0, 7),
  filter: { type: 'all', cat: '', q: '' },
  imports: [],
  budgetWho: '',
  history: {}, // 월별 자산 기록
  histForm: false,
};
if (S.who !== 'all' && !MEMBERS.includes(S.who)) S.who = 'all';

const charts = {};

/* ---------- 포맷 ---------- */
const fmt = (n) => Math.round(n || 0).toLocaleString('ko-KR');
const won = (n) => `${fmt(n)}원`;
const shortWon = (n) => {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(a >= 1e9 ? 0 : 1)}억`;
  if (a >= 1e4) return `${fmt(n / 1e4)}만`;
  return fmt(n);
};
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseAmount = (s) => Number(String(s).replace(/[^\d-]/g, '')) || 0;
const ymLabel = (ym) => `${ym.slice(0, 4)}년 ${Number(ym.slice(5))}월`;
const shiftYM = (ym, d) => {
  const dt = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1 + d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
};
const memberColor = (m) => (m === MEMBERS[0] ? 'var(--p1)' : 'var(--p2)');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- 집계 ---------- */
const isSaving = (t) => t.type === 'fixed' && SAVING_CATS.includes(t.category);
const scopedTx = (who = S.who) => (who === 'all' ? S.tx : S.tx.filter((t) => t.owner === who));

function stats(list) {
  const s = { income: 0, fixed: 0, variable: 0, saving: 0 };
  for (const t of list) {
    if (t.type === 'income') s.income += t.amount;
    else if (isSaving(t)) s.saving += t.amount;
    else if (t.type === 'fixed') s.fixed += t.amount;
    else s.variable += t.amount;
  }
  s.spend = s.fixed + s.variable;
  s.saved = s.income - s.spend; // 실제 저축 = 정기 저축 + 남은 돈
  s.left = s.saved - s.saving;
  s.rate = s.income > 0 ? s.saved / s.income : NaN;
  return s;
}
const inMonth = (list, ym) => list.filter((t) => t.date?.startsWith(ym));
const goalOf = (who) => (who === 'all'
  ? MEMBERS.reduce((a, m) => a + (Number(S.settings.goals[m]) || 0), 0)
  : Number(S.settings.goals[who]) || 0);

function categoryOptions(type) {
  const base = S.settings.categories[type] || [];
  const seen = new Set(base);
  const extra = [];
  for (const t of S.tx) if (t.type === type && t.category && !seen.has(t.category)) { seen.add(t.category); extra.push(t.category); }
  return [...base, ...extra];
}
function methodOptions(type) {
  const base = S.settings.methods[type] || [];
  const seen = new Set(base);
  const extra = [];
  for (const t of S.tx) if (t.type === type && t.method && !seen.has(t.method)) { seen.add(t.method); extra.push(t.method); }
  return [...base, ...extra];
}

/* ---------- 공통 UI ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function renderChrome() {
  $('#who-seg').innerHTML = [['all', '통합'], ...MEMBERS.map((m) => [m, m])].map(([v, l]) => `
    <button type="button" data-who="${esc(v)}" aria-pressed="${S.who === v}">
      ${v !== 'all' ? `<span class="dot" style="background:${memberColor(v)}"></span>` : ''}${esc(l)}
    </button>`).join('');
  $('#month-label').textContent = ymLabel(S.ym);
  $$('#tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === S.view ? 'page' : 'false'));
  VIEWS.forEach((v) => { $(`#view-${v}`).hidden = !(S.ready && S.user && v === S.view); });
  $('#fab').hidden = !(S.ready && S.user) || S.view === 'settings' || S.view === 'assets';
  $('#mode-badge').hidden = S.store?.mode !== 'demo';
  // 로그인 전에는 사람·월 선택과 탭을 숨긴다
  const signedIn = !!S.user;
  $('#who-seg').hidden = !signedIn;
  $('.month-nav').hidden = !signedIn;
  $('#tabs').hidden = !signedIn;
}

function render() {
  renderChrome();
  if (!S.ready || !S.user) return;
  if (S.view === 'dashboard') renderDashboard();
  else if (S.view === 'list') renderList();
  else if (S.view === 'assets') renderAssets();
  else renderSettings();
}

/* ---------- 대시보드 ---------- */
function deltaText(cur, prev, goodWhenDown) {
  if (!prev) return '';
  const d = cur - prev;
  if (Math.abs(d) < 1) return '전월과 같음';
  const cls = (d > 0) === goodWhenDown ? 'up' : 'down';
  return `<span class="${cls}">${d > 0 ? '▲' : '▼'} ${shortWon(Math.abs(d))}</span> 전월 대비`;
}

function renderDashboard() {
  const list = scopedTx();
  const cur = stats(inMonth(list, S.ym));
  const prev = stats(inMonth(list, shiftYM(S.ym, -1)));
  const year = S.ym.slice(0, 4);
  const monthNo = Number(S.ym.slice(5));
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const monthly = months.map((m) => stats(inMonth(list, m)));
  const ytdSaved = monthly.slice(0, monthNo).reduce((a, s) => a + s.saved, 0);
  const goal = goalOf(S.who);
  const yearGoal = goal * 12;

  const monthTx = inMonth(list, S.ym);
  const byCat = new Map();
  for (const t of monthTx) {
    if (t.type !== 'variable') continue;
    const c = byCat.get(t.category) || { sum: 0, n: 0 };
    c.sum += t.amount; c.n += 1;
    byCat.set(t.category, c);
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const catMax = cats[0]?.[1].sum || 1;
  const fixedList = monthTx.filter((t) => t.type === 'fixed').sort((a, b) => b.amount - a.amount);
  const recent = [...monthTx].sort((a, b) => (b.date + (b.id || '')).localeCompare(a.date + (a.id || ''))).slice(0, 7);
  const scopeName = S.who === 'all' ? '통합' : S.who;

  const perPerson = S.who === 'all' ? `
    <article class="card span-12">
      <div class="card-head"><h2>사람별 ${monthNo}월 비교</h2><span class="sub">통합 = ${MEMBERS.join(' + ')}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>이름</th><th>수입</th><th>고정비용</th><th>소비지출</th><th>정기 저축</th><th>실제 저축</th><th>저축률</th></tr></thead>
        <tbody>
          ${MEMBERS.map((m) => {
            const s = stats(inMonth(scopedTx(m), S.ym));
            return `<tr><td><span class="dot" style="background:${memberColor(m)}"></span> ${esc(m)}</td>
              <td class="c-income">${fmt(s.income)}</td><td>${fmt(s.fixed)}</td><td>${fmt(s.variable)}</td>
              <td>${fmt(s.saving)}</td><td class="${s.saved >= 0 ? 'c-saving' : 'c-expense'}">${fmt(s.saved)}</td><td>${pct(s.rate)}</td></tr>`;
          }).join('')}
          <tr class="total"><td>합계</td><td class="c-income">${fmt(cur.income)}</td><td>${fmt(cur.fixed)}</td><td>${fmt(cur.variable)}</td>
            <td>${fmt(cur.saving)}</td><td class="${cur.saved >= 0 ? 'c-saving' : 'c-expense'}">${fmt(cur.saved)}</td><td>${pct(cur.rate)}</td></tr>
        </tbody>
      </table></div>
    </article>` : '';

  $('#view-dashboard').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="k-label">수입</div><div class="k-value c-income">${won(cur.income)}</div>
        <div class="k-foot">${deltaText(cur.income, prev.income, false) || '&nbsp;'}</div></div>
      <div class="kpi"><div class="k-label">지출 (고정+소비)</div><div class="k-value c-expense">${won(cur.spend)}</div>
        <div class="k-foot">고정 ${shortWon(cur.fixed)} · 소비 ${shortWon(cur.variable)}</div></div>
      <div class="kpi"><div class="k-label">정기 저축</div><div class="k-value">${won(cur.saving)}</div>
        <div class="k-foot">고정비용 중 ${SAVING_CATS.join('·')}</div></div>
      <div class="kpi hero"><div class="k-label">실제 저축 · 저축률 ${pct(cur.rate)}</div><div class="k-value">${won(cur.saved)}</div>
        <div class="k-foot">수입 − 고정비용 − 소비지출</div></div>
    </div>

    <div class="grid">
      <article class="card span-8">
        <div class="card-head"><h2>${year}년 월별 흐름</h2><span class="sub">${esc(scopeName)} · 막대: 수입/지출, 선: 실제 저축</span></div>
        <div class="chart-box"><canvas id="chart-year" aria-label="월별 수입, 지출, 저축 차트"></canvas></div>
      </article>
      <article class="card span-4">
        <div class="card-head"><h2>저축 목표</h2><span class="sub">월 목표 ${won(goal)}</span></div>
        <div class="goal-row">
          <div class="goal-top"><span>${monthNo}월 실제 저축</span><span><strong>${shortWon(cur.saved)}</strong> / ${shortWon(goal)}</span></div>
          <div class="progress"><span style="width:${goal ? Math.max(0, Math.min(100, (cur.saved / goal) * 100)) : 0}%"></span></div>
          <span class="hint">${goal ? `달성률 ${pct(cur.saved / goal)}` : '설정에서 월 목표를 정하세요'}</span>
        </div>
        <div class="goal-row">
          <div class="goal-top"><span>${year}년 누적 (1~${monthNo}월)</span><span><strong>${shortWon(ytdSaved)}</strong> / ${shortWon(yearGoal)}</span></div>
          <div class="progress"><span style="width:${yearGoal ? Math.max(0, Math.min(100, (ytdSaved / yearGoal) * 100)) : 0}%"></span></div>
          <span class="hint">${yearGoal ? `연간 목표 대비 ${pct(ytdSaved / yearGoal)}` : ''}</span>
        </div>
        <div class="goal-row">
          <div class="goal-top"><span>${monthNo}월 남은 돈</span><span class="${cur.left >= 0 ? 'c-saving' : 'c-expense'}"><strong>${won(cur.left)}</strong></span></div>
          <span class="hint">수입에서 지출과 정기 저축을 뺀 금액</span>
        </div>
        <img class="mascot mascot-group" src="img/wasabi-bears.png" alt="" onerror="this.remove()">
      </article>

      ${perPerson}

      ${budgetCard(cats, catMax, cur, monthNo)}

      <article class="card span-6">
        <div class="card-head"><h2>${monthNo}월 일별 소비</h2><span class="sub">소비지출 + 고정비용(저축 제외)</span></div>
        <div class="chart-box small"><canvas id="chart-daily" aria-label="일별 지출 차트"></canvas></div>
        <div class="card-head" style="margin:16px 0 6px"><h2>고정비용</h2><span class="sub">${fixedList.length}건 · ${won(cur.fixed + cur.saving)}</span></div>
        ${fixedList.length ? `<ul class="mini-list">${fixedList.map((t) => `
          <li><span class="pill ${isSaving(t) ? 'saving' : 'fixed'}">${esc(t.category)}</span>
            <span class="grow">${esc(t.memo || t.category)}${S.who === 'all' ? ` <span class="meta">· ${esc(t.owner)}</span>` : ''}</span>
            <span>${fmt(t.amount)}</span></li>`).join('')}</ul>` : '<p class="empty">이번 달 고정비용이 없습니다.</p>'}
      </article>

      <article class="card span-12">
        <div class="card-head"><h2>최근 내역</h2><a class="sub" href="#list">전체 보기 →</a></div>
        ${recent.length ? `<ul class="mini-list">${recent.map((t) => `
          <li><span class="meta" style="width:44px">${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8))}</span>
            <span class="pill ${t.type === 'income' ? 'income' : isSaving(t) ? 'saving' : t.type === 'fixed' ? 'fixed' : ''}">${esc(t.category)}</span>
            <span class="grow">${esc(t.memo || t.category)}${S.who === 'all' ? ` <span class="meta">· ${esc(t.owner)}</span>` : ''}</span>
            <span class="${t.type === 'income' ? 'c-income' : ''}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</span></li>`).join('')}</ul>`
          : '<p class="empty">아직 내역이 없습니다.</p>'}
      </article>
    </div>`;

  drawYearChart(months, monthly);
  drawDailyChart(monthTx);
}

/* ---------- 분류별 예산 ---------- */
// 예산은 사람별 소비지출 분류의 월 금액. 통합 화면은 두 사람 예산의 합.
function budgetsOf(who) {
  const b = S.settings.budgets || {};
  const out = {};
  for (const m of who === 'all' ? MEMBERS : [who]) {
    for (const [c, v] of Object.entries(b[m] || {})) if (Number(v) > 0) out[c] = (out[c] || 0) + Number(v);
  }
  return out;
}

// 이번 달이면 지난 날짜 비율과 남은 날 수, 지난 달은 다 지난 것으로 본다
function monthProgress(ym) {
  const t = today();
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  if (ym < t.slice(0, 7)) return { elapsed: 1, left: 0, current: false };
  if (ym > t.slice(0, 7)) return { elapsed: 0, left: days, current: false };
  const d = Number(t.slice(8));
  return { elapsed: d / days, left: days - d + 1, current: true };
}

// ok: 여유, warn: 80% 이상이거나 날짜보다 빨리 쓰는 중, over: 초과
function budgetState(spent, budget, elapsed) {
  const r = spent / budget;
  if (r > 1) return 'over';
  if (r >= 0.8 || (elapsed < 1 && r > elapsed + 0.15)) return 'warn';
  return 'ok';
}

// endYm 이전 최근 n달 중, 그 사람이 가계부를 적은 달만으로 평균을 낸다 (적기 전 달은 0원으로 치지 않음)
function avgSpend(who, cat, endYm, n = 3) {
  const all = scopedTx(who);
  const list = all.filter((t) => t.type === 'variable' && t.category === cat);
  let sum = 0;
  let months = 0;
  for (let i = 1; i <= n; i++) {
    const ym = shiftYM(endYm, -i);
    if (!all.some((t) => t.date.startsWith(ym))) continue;
    months += 1;
    sum += list.filter((t) => t.date.startsWith(ym)).reduce((a, t) => a + t.amount, 0);
  }
  return months ? sum / months : 0;
}

function budgetCard(cats, catMax, cur, monthNo) {
  const budgets = budgetsOf(S.who);
  const spentOf = new Map(cats.map(([c, v]) => [c, v.sum]));
  const budgeted = Object.keys(budgets);
  const prog = monthProgress(S.ym);
  if (!budgeted.length) {
    return `<article class="card span-6">
      <div class="card-head"><h2>${monthNo}월 소비지출 분류</h2><a class="sub" href="#settings" data-goto-budget>예산 정하기 →</a></div>
      ${cats.length ? `<div class="bars">${cats.map(([name, c]) => `
        <div class="bar-row"><span class="name">${esc(name)}</span>
          <span class="bar-track"><span style="width:${(c.sum / catMax) * 100}%"></span></span>
          <span class="val">${fmt(c.sum)}<small>${pct(c.sum / cur.variable)}</small></span></div>`).join('')}</div>`
        : `<p class="empty">${ymLabel(S.ym)} 소비지출이 없습니다. 오른쪽 아래 ‘내역 입력’으로 추가하세요.</p>`}
      <p class="hint" style="margin-top:12px">설정에서 분류별 월 예산을 정하면 여기서 얼마나 썼는지, 얼마 남았는지 보여드려요.</p>
    </article>`;
  }
  const totalBudget = budgeted.reduce((a, c) => a + budgets[c], 0);
  const totalSpent = budgeted.reduce((a, c) => a + (spentOf.get(c) || 0), 0);
  const totalState = budgetState(totalSpent, totalBudget, prog.elapsed);
  const leftMoney = totalBudget - totalSpent;
  const rows = budgeted.map((c) => ({ c, spent: spentOf.get(c) || 0, budget: budgets[c] }))
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget);
  const extra = cats.filter(([c]) => !budgets[c]);
  const message = !prog.current ? (leftMoney >= 0 ? `예산보다 ${won(leftMoney)} 덜 썼어요` : `예산을 ${won(-leftMoney)} 넘었어요`)
    : leftMoney < 0 ? `벌써 예산을 ${won(-leftMoney)} 넘었어요`
      : `남은 ${prog.left}일 동안 하루 ${won(Math.floor(leftMoney / prog.left))}까지 쓸 수 있어요`;
  return `<article class="card span-6">
    <div class="card-head"><h2>${monthNo}월 예산</h2><a class="sub" href="#settings" data-goto-budget>예산 수정 →</a></div>
    <div class="budget-total ${totalState}">
      <div class="goal-top"><span>예산 ${won(totalBudget)} 중 <strong>${won(totalSpent)}</strong> 사용</span><span class="pill ${totalState}">${pct(totalSpent / totalBudget)}</span></div>
      <div class="progress budget"><span class="${totalState}" style="width:${Math.min(100, (totalSpent / totalBudget) * 100)}%"></span>
        ${prog.current ? `<i class="pace" style="left:${prog.elapsed * 100}%" title="오늘까지 지난 날짜"></i>` : ''}</div>
      <span class="hint">${message}</span>
    </div>
    <div class="bars budget-rows">${rows.map((r) => {
      const st = budgetState(r.spent, r.budget, prog.elapsed);
      const left = r.budget - r.spent;
      return `<div class="bar-row"><span class="name">${esc(r.c)}</span>
        <span class="bar-track"><span class="${st}" style="width:${Math.min(100, (r.spent / r.budget) * 100)}%"></span>
          ${prog.current ? `<i class="pace" style="left:${prog.elapsed * 100}%"></i>` : ''}</span>
        <span class="val">${fmt(r.spent)}<small>/ ${shortWon(r.budget)}</small>
          <em class="${st}">${left >= 0 ? `남음 ${shortWon(left)}` : `${shortWon(-left)} 초과`}</em></span></div>`;
    }).join('')}</div>
    ${extra.length ? `<p class="hint" style="margin-top:12px">예산 없는 분류: ${extra.map(([c, v]) => `${esc(c)} ${shortWon(v.sum)}`).join(' · ')}</p>` : ''}
  </article>`;
}

function chartDefaults() {
  if (!window.Chart) return false;
  Chart.defaults.font.family = cssVar('--font') || 'sans-serif';
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--line');
  return true;
}

function drawYearChart(months, monthly) {
  charts.year?.destroy();
  const el = $('#chart-year');
  if (!el || !chartDefaults()) return;
  charts.year = new Chart(el, {
    data: {
      labels: months.map((m) => `${Number(m.slice(5))}월`),
      datasets: [
        { type: 'bar', label: '수입', data: monthly.map((s) => s.income), backgroundColor: cssVar('--income'), borderRadius: 4, maxBarThickness: 18, order: 2 },
        { type: 'bar', label: '지출', data: monthly.map((s) => s.spend), backgroundColor: cssVar('--expense'), borderRadius: 4, maxBarThickness: 18, order: 2 },
        { type: 'line', label: '실제 저축', data: monthly.map((s) => (s.income || s.spend ? s.saved : null)), borderColor: cssVar('--saving'),
          backgroundColor: cssVar('--saving'), tension: .3, pointRadius: 3, spanGaps: true, order: 1 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${won(c.raw)}` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: (v) => shortWon(v) }, grid: { color: cssVar('--line') } },
      },
    },
  });
}

function drawDailyChart(monthTx) {
  charts.daily?.destroy();
  const el = $('#chart-daily');
  if (!el || !chartDefaults()) return;
  const [y, m] = S.ym.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const sums = Array(days).fill(0);
  for (const t of monthTx) if (t.type !== 'income' && !isSaving(t)) sums[Number(t.date.slice(8)) - 1] += t.amount;
  charts.daily = new Chart(el, {
    type: 'bar',
    data: { labels: sums.map((_, i) => i + 1), datasets: [{ label: '지출', data: sums, backgroundColor: cssVar('--expense'), borderRadius: 3 }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `${m}월 ${c[0].label}일`, label: (c) => won(c.raw) } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { ticks: { callback: (v) => shortWon(v) }, grid: { color: cssVar('--line') } },
      },
    },
  });
}

/* ---------- 내역 ---------- */
function renderList() {
  const f = S.filter;
  let list = inMonth(scopedTx(), S.ym);
  const all = stats(list);
  if (f.type !== 'all') list = list.filter((t) => t.type === f.type);
  if (f.cat) list = list.filter((t) => t.category === f.cat);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((t) => `${t.memo} ${t.category} ${t.method}`.toLowerCase().includes(q));
  }
  list.sort((a, b) => b.date.localeCompare(a.date) || (b.id || '').localeCompare(a.id || ''));
  const filteredSum = list.reduce((a, t) => a + t.amount, 0);
  const catSet = f.type === 'all'
    ? [...new Set([...categoryOptions('variable'), ...categoryOptions('fixed'), ...categoryOptions('income')])]
    : categoryOptions(f.type);

  const groups = [];
  for (const t of list) {
    if (groups.at(-1)?.date !== t.date) groups.push({ date: t.date, items: [] });
    groups.at(-1).items.push(t);
  }
  const prevYM = shiftYM(S.ym, -1);
  const canCopyFixed = S.who !== 'all';

  const recur = recurringSuggestions();
  $('#view-list').innerHTML = `
    ${recur.length ? `<div class="card recur-card">
      <div class="card-head"><h2>고정비용으로 처리할까요?</h2>
        <button type="button" class="btn small primary" data-recur-all>모두 고정비용으로</button></div>
      <p class="hint">소비지출로 들어가 있지만 같은 가게에서 비슷한 금액으로 두 달 이상 나간 결제입니다. 고정비용으로 옮기면 대시보드의 고정비용에 합산돼요.</p>
      <ul class="mini-list">${recur.map((g) => `
        <li><span class="pill fixed">${esc(fixedCategoryFor(g, g.items[0].memo))}</span>
          <span class="grow">${esc(g.items[0].memo)}${S.who === 'all' ? ` <span class="meta">· ${esc(g.items[0].owner)}</span>` : ''}
            <span class="meta">· 약 ${fmt(g.amount)}원 · ${g.months}개월 · 소비지출 ${g.variable.length}건</span></span>
          <button type="button" class="btn small" data-recur-apply="${esc(g.key)}">고정비용으로</button>
          <button type="button" class="btn small ghost" data-recur-ignore="${esc(g.key)}">아님</button></li>`).join('')}</ul>
    </div>` : ''}
    <div class="card">
      <div class="toolbar">
        <div class="seg" id="type-filter">
          ${[['all', '전체'], ['variable', '소비지출'], ['fixed', '고정비용'], ['income', '수입']].map(([v, l]) =>
            `<button type="button" data-v="${v}" aria-pressed="${f.type === v}">${l}</button>`).join('')}
        </div>
        <select class="input" id="cat-filter" style="width:auto" aria-label="분류 필터">
          <option value="">모든 분류</option>
          ${catSet.map((c) => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <input class="input grow" id="q-filter" type="search" placeholder="메모·분류 검색" value="${esc(f.q)}" aria-label="검색">
      </div>
      <div class="summary-line" style="margin-top:12px">
        <span>${ymLabel(S.ym)} · ${esc(S.who === 'all' ? '통합' : S.who)}</span>
        <span>수입 <b class="c-income">${fmt(all.income)}</b></span>
        <span>고정 <b>${fmt(all.fixed + all.saving)}</b></span>
        <span>소비 <b>${fmt(all.variable)}</b></span>
        ${f.type !== 'all' || f.cat || f.q ? `<span>필터 결과 <b>${list.length}건 · ${fmt(filteredSum)}원</b></span>` : `<span><b>${list.length}</b>건</span>`}
      </div>
      <div class="toolbar" style="margin-top:12px">
        <button type="button" class="btn small primary" id="open-upload">엑셀 일괄 등록</button>
        ${canCopyFixed ? `<button type="button" class="btn small" id="copy-fixed">${Number(prevYM.slice(5))}월 고정비용을 ${Number(S.ym.slice(5))}월로 복사</button>` : ''}
        <span class="hint">${canCopyFixed ? '구독료·보험·저축처럼 매달 같은 항목은 복사로 한 번에 넣을 수 있어요.' : '양식에 여러 건을 적어 한 번에 올릴 수 있어요.'}</span>
      </div>
    </div>
    ${groups.length ? groups.map((g) => {
      const out = g.items.filter((t) => t.type !== 'income').reduce((a, t) => a + t.amount, 0);
      return `<div class="day-group">
        <div class="day-head"><span>${dayLabel(g.date)}</span><span>${out ? `지출 ${fmt(out)}` : ''}</span></div>
        ${g.items.map((t) => `
          <button type="button" class="tx-row" data-id="${esc(t.id)}">
            <span class="pill ${t.type === 'income' ? 'income' : isSaving(t) ? 'saving' : t.type === 'fixed' ? 'fixed' : ''}">${esc(t.category)}</span>
            <span class="left-col"><span class="memo">${esc(t.memo || t.category)}</span>
              <span class="meta">${S.who === 'all' ? `<span><span class="dot" style="background:${memberColor(t.owner)}"></span> ${esc(t.owner)}</span>` : ''}
                <span>${TYPE_LABEL[t.type]}</span>${t.method ? `<span>${esc(t.method)}</span>` : ''}</span></span>
            <span class="amt ${t.type === 'income' ? 'c-income' : ''}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</span>
          </button>`).join('')}
      </div>`;
    }).join('') : `<div class="card"><p class="empty">${ymLabel(S.ym)}에 조건에 맞는 내역이 없습니다.</p></div>`}`;
}

async function copyFixedFromPrev() {
  const prevYM = shiftYM(S.ym, -1);
  const prev = inMonth(scopedTx(), prevYM).filter((t) => t.type === 'fixed');
  if (!prev.length) { toast(`${Number(prevYM.slice(5))}월 고정비용이 없습니다`); return; }
  const existing = new Set(inMonth(scopedTx(), S.ym).filter((t) => t.type === 'fixed').map((t) => `${t.category}|${t.memo}`));
  const [y, m] = S.ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const add = prev.filter((t) => !existing.has(`${t.category}|${t.memo}`)).map((t) => ({
    owner: t.owner, type: 'fixed', category: t.category, method: t.method || '', memo: t.memo || '', amount: t.amount,
    date: `${S.ym}-${String(Math.min(Number(t.date.slice(8)), last)).padStart(2, '0')}`,
  }));
  if (!add.length) { toast('이미 모두 복사되어 있습니다'); return; }
  await S.store.bulk({ addTx: add });
  toast(`고정비용 ${add.length}건을 추가했습니다`);
}

/* ---------- 자산 ---------- */
function renderAssets() {
  const owners = S.who === 'all' ? MEMBERS : [S.who];
  const list = S.assets.filter((a) => owners.includes(a.owner));
  const sum = (arr, kind) => arr.filter((a) => a.kind === kind).reduce((s, a) => s + a.amount, 0);
  const totalA = sum(list, '자산');
  const totalD = sum(list, '부채');
  const byGroup = new Map();
  for (const a of list) if (a.kind === '자산') byGroup.set(a.group, (byGroup.get(a.group) || 0) + a.amount);
  const groups = [...byGroup.entries()].sort((a, b) => b[1] - a[1]);
  const trend = netWorthSeries(S.who);
  const before = trend.length > 1 ? trend.at(-2) : null;
  const change = before ? (totalA - totalD) - before.value : null;

  $('#view-assets').innerHTML = `
    <div class="kpis">
      <div class="kpi hero"><div class="k-label">순자산</div><div class="k-value">${won(totalA - totalD)}</div>
        <div class="k-foot">${change == null ? esc(S.who === 'all' ? '통합' : S.who)
          : `${Number(before.ym.slice(5))}월보다 <b class="${change >= 0 ? 'c-saving' : 'c-expense'}">${change >= 0 ? '+' : '−'}${shortWon(Math.abs(change))}</b>${before.kind === 'estimate' ? ' (추정 대비)' : ''}`}</div></div>
      <div class="kpi"><div class="k-label">총 자산</div><div class="k-value c-saving">${won(totalA)}</div><div class="k-foot">${list.filter((a) => a.kind === '자산').length}개 항목</div></div>
      <div class="kpi"><div class="k-label">부채</div><div class="k-value c-expense">${won(totalD)}</div><div class="k-foot">${list.filter((a) => a.kind === '부채').length}개 항목</div></div>
      <div class="kpi"><div class="k-label">자산 구성</div><div class="k-value" style="font-size:18px">${groups.length ? esc(groups[0][0]) : '–'}</div>
        <div class="k-foot">${groups.length ? `최대 비중 ${pct(groups[0][1] / totalA)}` : '항목을 추가하세요'}</div></div>
    </div>
    <div class="grid">
      ${S.who === 'all' ? `<article class="card span-12">
        <div class="card-head"><h2>사람별 순자산</h2></div>
        <div class="bars">${MEMBERS.map((m) => {
          const mine = S.assets.filter((a) => a.owner === m);
          const net = sum(mine, '자산') - sum(mine, '부채');
          const max = Math.max(1, ...MEMBERS.map((x) => { const l = S.assets.filter((a) => a.owner === x); return sum(l, '자산') - sum(l, '부채'); }));
          return `<div class="bar-row"><span class="name"><span class="dot" style="background:${memberColor(m)}"></span> ${esc(m)}</span>
            <span class="bar-track"><span style="width:${Math.max(0, net / max) * 100}%;background:${memberColor(m)}"></span></span>
            <span class="val">${fmt(net)}<small>${pct(net / Math.max(1, totalA - totalD))}</small></span></div>`;
        }).join('')}</div>
      </article>` : ''}
      ${assetTrendCard()}
      <article class="card span-12">
        <div class="card-head"><h2>자산·부채 목록</h2><button type="button" class="btn small primary" id="add-asset">＋ 항목 추가</button></div>
        ${list.length ? `<div class="table-wrap"><table>
          <thead><tr>${S.who === 'all' ? '<th class="left">누구</th>' : ''}<th class="left">구분</th><th class="left">분류</th><th class="left">상세 항목</th><th class="left">금융기관/보관처</th><th>평가 금액</th><th class="left">비고</th></tr></thead>
          <tbody>${[...list].sort((a, b) => a.owner.localeCompare(b.owner) || a.kind.localeCompare(b.kind) || b.amount - a.amount).map((a) => `
            <tr data-asset="${esc(a.id)}" style="cursor:pointer">
              ${S.who === 'all' ? `<td class="left"><span class="dot" style="background:${memberColor(a.owner)}"></span> ${esc(a.owner)}</td>` : ''}
              <td class="left"><span class="pill ${a.kind === '부채' ? '' : 'saving'}">${esc(a.kind)}</span></td>
              <td class="left">${esc(a.group)}</td><td class="left">${esc(a.name)}</td><td class="left">${esc(a.place)}</td>
              <td class="${a.kind === '부채' ? 'c-expense' : ''}">${fmt(a.amount)}</td><td class="left">${esc(a.note)}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<p class="empty">아직 자산 항목이 없습니다. ‘항목 추가’를 누르거나 설정에서 엑셀을 가져오세요.</p>'}
      </article>
    </div>`;
  drawNetWorthChart();
}

/* ---------- 자산 추이 ---------- */
// 자산 목록이 바뀔 때마다 '이번 달' 기록을 덮어써서, 달마다 마지막 상태가 남게 한다.
// 기록이 시작되기 전 달은 가계부의 월별 실제 저축(수입 − 지출)으로 거꾸로 추정한다.
const nowYM = () => today().slice(0, 7);
const isMonthKey = (k) => /^\d{4}-\d{2}$/.test(k);

function assetEntry() {
  const e = {};
  for (const m of MEMBERS) {
    const mine = S.assets.filter((a) => a.owner === m);
    const groups = {};
    mine.filter((a) => a.kind === '자산').forEach((a) => { groups[a.group] = (groups[a.group] || 0) + a.amount; });
    e[m] = {
      asset: mine.filter((a) => a.kind === '자산').reduce((s, a) => s + a.amount, 0),
      debt: mine.filter((a) => a.kind === '부채').reduce((s, a) => s + a.amount, 0),
      groups,
    };
  }
  return e;
}
// Firestore는 맵의 키 순서를 보장하지 않으니 정렬해서 비교한다
const canonEntry = (e) => JSON.stringify(MEMBERS.map((m) => {
  const x = e?.[m];
  return x ? [x.asset, x.debt, Object.entries(x.groups || {}).sort()] : null;
}));

let historyTimer;
function syncAssetHistory() {
  if (!S.ready || !S.store?.saveAssetHistory) return;
  const ym = nowYM();
  const stored = S.history[ym];
  if (!S.assets.length && !stored) return;
  const entry = assetEntry();
  if (stored && !stored.manual && canonEntry(stored) === canonEntry(entry)) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    S.store.saveAssetHistory({ [ym]: { ...entry, at: new Date().toISOString() } }).catch(() => {});
  }, 800);
}

function seriesRange(owners) {
  const recorded = Object.keys(S.history).filter((k) => isMonthKey(k) && owners.some((m) => S.history[k]?.[m])).sort();
  if (!recorded.length) return null;
  const txMonths = S.tx.filter((t) => owners.includes(t.owner)).map((t) => t.date.slice(0, 7)).sort();
  return { start: [txMonths[0], recorded[0]].filter(Boolean).sort()[0], end: [nowYM(), recorded.at(-1)].sort().at(-1) };
}

// 통합은 사람별 추이를 같은 기간으로 맞춰 더한다 (한 사람만 직접 입력한 달도 다른 사람은 추정치로 채워짐)
function netWorthSeries(who, range = null) {
  if (who === 'all') {
    const r = seriesRange(MEMBERS);
    if (!r) return [];
    const parts = MEMBERS.map((m) => netWorthSeries(m, r));
    return parts[0].map((p, i) => {
      const kinds = parts.map((s) => s[i]?.kind).filter(Boolean);
      return {
        ym: p.ym,
        value: parts.reduce((a, s) => a + (s[i]?.value || 0), 0),
        kind: kinds.includes('estimate') ? 'estimate' : kinds.includes('manual') ? 'manual' : 'recorded',
      };
    });
  }
  const has = (e) => !!e?.[who];
  const val = (e) => (e[who].asset || 0) - (e[who].debt || 0);
  const r = range || seriesRange([who]);
  if (!r || !Object.keys(S.history).some((k) => isMonthKey(k) && has(S.history[k]))) {
    return range ? pointsWithoutRecord(range) : [];
  }
  const saved = (ym) => stats(inMonth(scopedTx(who), ym)).saved;
  const pts = [];
  for (let m = r.start; m <= r.end; m = shiftYM(m, 1)) {
    const e = S.history[m];
    pts.push({ ym: m, value: has(e) ? val(e) : null, kind: has(e) ? (e[who].manual || e.manual ? 'manual' : 'recorded') : null });
  }
  for (let i = pts.length - 2; i >= 0; i--) {
    if (pts[i].value == null && pts[i + 1].value != null) {
      pts[i].value = pts[i + 1].value - saved(pts[i + 1].ym);
      pts[i].kind = 'estimate';
    }
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].value == null && pts[i - 1].value != null) {
      pts[i].value = pts[i - 1].value + saved(pts[i].ym);
      pts[i].kind = 'estimate';
    }
  }
  return pts;
}

// 자산 기록이 하나도 없는 사람은 통합 합계에 0으로 들어간다
function pointsWithoutRecord(range) {
  const pts = [];
  for (let m = range.start; m <= range.end; m = shiftYM(m, 1)) pts.push({ ym: m, value: 0, kind: null });
  return pts;
}

const KIND_LABEL = { recorded: '기록', manual: '직접 입력', estimate: '추정' };

function assetTrendCard() {
  const pts = netWorthSeries(S.who);
  const last = nowYM();
  const maxPast = shiftYM(last, -1);
  const form = S.histForm ? `
    <form class="hist-form" id="hist-form">
      <label class="field"><span class="label">월</span><input type="month" class="input" id="hist-month" max="${maxPast}" value="${maxPast}" required></label>
      <label class="field"><span class="label">누구</span><select class="input" id="hist-owner">${MEMBERS.map((m) =>
        `<option ${m === (S.who === 'all' ? MEMBERS[0] : S.who) ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="field"><span class="label">자산 합계 (원)</span><input class="input" id="hist-asset" inputmode="numeric" required></label>
      <label class="field"><span class="label">부채 합계 (원)</span><input class="input" id="hist-debt" inputmode="numeric" value="0"></label>
      <div class="hist-actions"><button type="button" class="btn ghost" id="hist-cancel">취소</button><button type="submit" class="btn primary">기록 저장</button></div>
    </form>` : '';
  if (!pts.length) {
    return `<article class="card span-12"><div class="card-head"><h2>순자산 추이</h2>
      <button type="button" class="btn small" id="hist-open">지난 달 기록 입력</button></div>
      ${form}<p class="empty">자산 항목이 생기면 이번 달부터 매달 자동으로 기록돼요.</p></article>`;
  }
  const first = pts[0].value;
  const lastPt = pts.at(-1);
  const prev = pts.at(-2);
  const hasEstimate = pts.some((p) => p.kind === 'estimate');
  return `<article class="card span-12">
    <div class="card-head"><h2>순자산 추이</h2>
      <span class="sub">${esc(S.who === 'all' ? '통합' : S.who)} · ${ymLabel(pts[0].ym)}부터 ${pts.length}개월
        ${pts.length > 1 ? ` · 그동안 <b class="${lastPt.value - first >= 0 ? 'c-saving' : 'c-expense'}">${lastPt.value - first >= 0 ? '+' : '−'}${shortWon(Math.abs(lastPt.value - first))}</b>` : ''}</span></div>
    <div class="chart-box"><canvas id="chart-networth" aria-label="월별 순자산 추이 차트"></canvas></div>
    ${hasEstimate ? '<p class="hint">점선은 자산 기록이 없던 달을 가계부의 실제 저축(수입 − 지출)으로 거꾸로 계산한 추정치예요. 수입을 빠짐없이 적을수록 정확해져요.</p>' : ''}
    <div class="table-wrap" style="margin-top:8px"><table>
      <thead><tr><th class="left">월</th><th>순자산</th><th>전월 대비</th><th>그 달 실제 저축</th><th class="left">구분</th></tr></thead>
      <tbody>${[...pts].reverse().map((p, i, arr) => {
        const before = arr[i + 1];
        const diff = before ? p.value - before.value : null;
        const sv = stats(inMonth(scopedTx(), p.ym)).saved;
        return `<tr><td class="left">${ymLabel(p.ym)}</td><td>${fmt(p.value)}</td>
          <td class="${diff == null ? '' : diff >= 0 ? 'c-saving' : 'c-expense'}">${diff == null ? '–' : `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}`}</td>
          <td>${fmt(sv)}</td><td class="left"><span class="pill ${p.kind === 'estimate' ? '' : 'saving'}">${KIND_LABEL[p.kind]}</span></td></tr>`;
      }).join('')}</tbody></table></div>
    <div class="toolbar" style="margin-top:12px">
      <button type="button" class="btn small" id="hist-open">지난 달 기록 입력</button>
      <span class="hint">통장 잔고 등 예전 달 자산을 알면 넣어 주세요. 추정 대신 그 값을 씁니다.${prev ? '' : ''}</span>
    </div>
    ${form}
  </article>`;
}

function drawNetWorthChart() {
  charts.networth?.destroy();
  const el = $('#chart-networth');
  if (!el || !chartDefaults()) return;
  const range = seriesRange(MEMBERS);
  const series = (who) => netWorthSeries(who, who === 'all' ? null : range);
  const main = netWorthSeries(S.who);
  const dashed = (pts) => (ctx) => (pts[ctx.p0DataIndex]?.kind === 'estimate' || pts[ctx.p1DataIndex]?.kind === 'estimate' ? [6, 5] : undefined);
  const datasets = [{
    label: S.who === 'all' ? '통합 순자산' : `${S.who} 순자산`,
    data: main.map((p) => p.value), borderColor: cssVar('--accent'), backgroundColor: 'rgba(107,158,79,.12)',
    fill: true, tension: .3, borderWidth: 2.5,
    pointRadius: main.map((p) => (p.kind === 'estimate' ? 2 : 4)), pointBackgroundColor: cssVar('--accent'),
    segment: { borderDash: dashed(main) },
  }];
  if (S.who === 'all') {
    MEMBERS.forEach((m) => {
      const s = series(m);
      const byYm = new Map(s.map((p) => [p.ym, p]));
      const aligned = main.map((p) => byYm.get(p.ym) || { value: null });
      datasets.push({
        label: m, data: aligned.map((p) => p.value), borderColor: cssVar(m === MEMBERS[0] ? '--p1' : '--p2'),
        backgroundColor: cssVar(m === MEMBERS[0] ? '--p1' : '--p2'), tension: .3, borderWidth: 1.5, pointRadius: 2,
        segment: { borderDash: dashed(aligned) }, spanGaps: true,
      });
    });
  }
  charts.networth = new Chart(el, {
    type: 'line',
    data: { labels: main.map((p) => `${Number(p.ym.slice(5))}월`), datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: S.who === 'all', position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: {
          title: (c) => ymLabel(main[c[0].dataIndex].ym),
          label: (c) => `${c.dataset.label}: ${won(c.raw)}${c.datasetIndex === 0 ? ` (${KIND_LABEL[main[c.dataIndex].kind]})` : ''}`,
        } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: (v) => shortWon(v) }, grid: { color: cssVar('--line') } },
      },
    },
  });
}

async function saveHistForm() {
  const ym = $('#hist-month').value;
  const owner = $('#hist-owner').value;
  const asset = parseAmount($('#hist-asset').value);
  const debt = parseAmount($('#hist-debt').value);
  if (!ym || ym >= nowYM()) { toast('지난 달만 직접 입력할 수 있어요 (이번 달은 자동 기록)'); return; }
  const prev = S.history[ym] || {};
  await S.store.saveAssetHistory({ [ym]: { ...prev, [owner]: { asset, debt, groups: {}, manual: true }, at: new Date().toISOString() } });
  S.histForm = false;
  toast(`${ymLabel(ym)} ${owner} 자산 기록을 저장했습니다`);
}

/* ---------- 설정 ---------- */
function renderSettings() {
  const st = S.settings;
  const list = (arr) => esc(arr.join(', '));
  if (!MEMBERS.includes(S.budgetWho)) S.budgetWho = S.who !== 'all' ? S.who : MEMBERS[0];
  const bw = S.budgetWho;
  const myBudget = (st.budgets || {})[bw] || {};
  const thisYm = today().slice(0, 7);
  const budgetCats = categoryOptions('variable');
  $('#view-settings').innerHTML = `
    <div class="settings-grid">
      <article class="card budget-editor" id="budget-card">
        <div class="card-head"><h2>분류별 월 예산</h2>
          <div class="seg" id="budget-who">${MEMBERS.map((m) => `<button type="button" data-v="${esc(m)}" aria-pressed="${bw === m}">
            <span class="dot" style="background:${memberColor(m)}"></span>${esc(m)}</button>`).join('')}</div></div>
        <form class="form-stack" id="budget-form">
          <p class="hint">${esc(bw)}님의 소비지출 분류별 한 달 예산이에요. 비워 두면 예산 없음으로 봅니다. 오른쪽 회색 숫자는 지난 3달 평균이에요.</p>
          <div class="budget-grid">${budgetCats.map((c) => {
            const avg = avgSpend(bw, c, thisYm);
            return `<label class="budget-line"><span class="name">${esc(c)}</span>
              <input class="input" data-budget-cat="${esc(c)}" inputmode="numeric" placeholder="예산 없음" value="${myBudget[c] ? fmt(myBudget[c]) : ''}">
              <span class="avg" data-avg="${Math.round(avg / 10000) * 10000}">${avg ? `평균 ${shortWon(avg)}` : ''}</span></label>`;
          }).join('')}</div>
          <div class="toolbar">
            <span class="hint" id="budget-sum">합계 ${won(Object.values(myBudget).reduce((a, v) => a + (Number(v) || 0), 0))}</span>
            <span class="spacer"></span>
            <button class="btn" type="button" id="budget-fill-avg">빈칸을 평균으로 채우기</button>
            <button class="btn primary" type="submit">예산 저장</button>
          </div>
        </form>
      </article>

      <article class="card">
        <div class="card-head"><h2>월 저축 목표</h2></div>
        <form class="form-stack" id="goal-form">
          ${MEMBERS.map((m) => `<label class="field"><span class="label">${esc(m)} (원)</span>
            <input class="input" id="goal-${esc(m)}" data-member="${esc(m)}" inputmode="numeric" value="${fmt(st.goals[m])}"></label>`).join('')}
          <p class="hint">통합 화면의 목표는 두 사람 목표의 합입니다. 연간 목표 = 월 목표 × 12.</p>
          <div><button class="btn primary" type="submit">목표 저장</button></div>
        </form>
      </article>

      <article class="card">
        <div class="card-head"><h2>엑셀 가계부 가져오기</h2></div>
        <div class="form-stack">
          <p class="hint">기존 ‘가계부 - 이름.xlsx’ 파일을 선택하세요. 수입·소비지출·고정비용·자산 시트를 읽습니다. 파일은 이 브라우저에서만 읽고 서버로 올라가지 않습니다(변환된 내역만 저장).</p>
          <input type="file" id="import-input" accept=".xlsx,.xls" multiple class="input">
          <div id="import-files">${S.imports.map((im, i) => `
            <div class="import-file">
              <span class="fname">${esc(im.name)}<br><span class="hint">${im.error ? `<span class="error">${esc(im.error)}</span>` : `내역 ${im.data.tx.length}건 · 자산 ${im.data.assets.length}건`}</span></span>
              <select class="input" data-import-owner="${i}" style="width:auto" aria-label="이 파일의 주인">
                <option value="">누구 파일?</option>
                ${MEMBERS.map((m) => `<option ${im.owner === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
              </select>
            </div>`).join('')}</div>
          ${S.imports.length ? `<label class="check"><input type="checkbox" id="import-replace" checked>
            <span>같은 사람의 이전 엑셀 가져오기 데이터를 지우고 새로 넣기 (직접 입력한 내역은 유지)</span></label>
            <div><button class="btn primary" id="import-run" type="button">가져오기</button></div>` : ''}
        </div>
      </article>

      <article class="card">
        <div class="card-head"><h2>분류 관리</h2></div>
        <form class="form-stack" id="cat-form">
          <label class="field"><span class="label">소비지출 분류</span><textarea id="cat-variable">${list(st.categories.variable)}</textarea></label>
          <label class="field"><span class="label">고정비용 분류 (저축·단기 적금은 저축으로 집계)</span><textarea id="cat-fixed">${list(st.categories.fixed)}</textarea></label>
          <label class="field"><span class="label">수입 분류</span><textarea id="cat-income">${list(st.categories.income)}</textarea></label>
          <label class="field"><span class="label">결제 수단 (소비지출)</span><textarea id="m-variable">${list(st.methods.variable)}</textarea></label>
          <label class="field"><span class="label">결제 수단 (고정비용)</span><textarea id="m-fixed">${list(st.methods.fixed)}</textarea></label>
          <p class="hint">쉼표로 구분합니다. 순서대로 입력 화면에 표시됩니다.</p>
          <div><button class="btn primary" type="submit">분류 저장</button></div>
        </form>
      </article>

      <article class="card">
        <div class="card-head"><h2>계정 · 백업</h2></div>
        <div class="form-stack">
          <p class="hint">${S.store.mode === 'demo'
            ? '데모 모드: 데이터가 이 브라우저에만 저장됩니다. js/firebase-config.js를 채우면 두 사람이 함께 쓰는 클라우드 모드로 바뀝니다.'
            : `로그인: ${esc(S.user.email)}`}</p>
          <p class="hint">전체 내역 ${S.tx.length}건 · 자산 ${S.assets.length}건</p>
          <div class="toolbar">
            <button type="button" class="btn" id="export-json">JSON 백업 받기</button>
            <label class="btn" for="restore-input">JSON 백업 복원</label>
            <input type="file" id="restore-input" accept=".json" hidden>
            ${S.store.mode === 'firebase' ? '<button type="button" class="btn danger" id="logout">로그아웃</button>' : ''}
          </div>
          <p class="hint" id="restore-msg"></p>
        </div>
      </article>
    </div>`;
}

const splitList = (s) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];

async function runImport() {
  const replace = $('#import-replace')?.checked;
  const ready = S.imports.filter((im) => !im.error);
  if (ready.some((im) => !im.owner)) { toast('각 파일의 주인을 선택하세요'); return; }
  const owners = [...new Set(ready.map((im) => im.owner))];
  const addTx = [];
  const addAssets = [];
  for (const im of ready) {
    im.data.tx.forEach((t) => addTx.push({ ...t, owner: im.owner, src: 'xlsx' }));
    im.data.assets.forEach((a) => {
      const owner = MEMBERS.includes(a.who) ? a.who : im.owner;
      const { who, ...rest } = a;
      addAssets.push({ ...rest, owner, src: 'xlsx' });
    });
  }
  const deleteTx = replace ? S.tx.filter((t) => t.src === 'xlsx' && owners.includes(t.owner)).map((t) => t.id) : [];
  const deleteAssets = replace ? S.assets.filter((a) => a.src === 'xlsx' && owners.includes(a.owner)).map((a) => a.id) : [];
  const btn = $('#import-run');
  btn.disabled = true; btn.textContent = '가져오는 중…';
  try {
    await S.store.bulk({ addTx, addAssets, deleteTx, deleteAssets });
    S.imports = [];
    const latest = addTx.map((t) => t.date).sort().at(-1);
    if (latest) S.ym = latest.slice(0, 7);
    toast(`내역 ${addTx.length}건, 자산 ${addAssets.length}건을 가져왔습니다`);
    render();
  } catch (e) {
    btn.disabled = false; btn.textContent = '가져오기';
    toast(`가져오기 실패: ${e.message}`);
  }
}

function exportJSON() {
  const strip = ({ updatedAt, ...rest }) => rest;
  const payload = { app: 'gagyebu', version: 1, exportedAt: new Date().toISOString(), settings: S.settings,
    tx: S.tx.map(strip), assets: S.assets.map(strip), assetHistory: S.history };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `가계부-백업-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let pendingRestore = null;
async function handleRestoreFile(file) {
  const msg = $('#restore-msg');
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'gagyebu' || !Array.isArray(data.tx)) throw new Error('가계부 백업 파일이 아닙니다');
    pendingRestore = data;
    msg.innerHTML = `내역 ${data.tx.length}건 · 자산 ${(data.assets || []).length}건. 현재 데이터를 모두 지우고 복원합니다.
      <button type="button" class="btn small danger" id="restore-confirm">복원 실행</button>`;
  } catch (e) {
    msg.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}
async function runRestore() {
  const d = pendingRestore;
  if (!d) return;
  const clean = ({ id, ...rest }) => rest;
  await S.store.bulk({
    deleteTx: S.tx.map((t) => t.id), deleteAssets: S.assets.map((a) => a.id),
    addTx: d.tx.map(clean), addAssets: (d.assets || []).map(clean),
  });
  if (d.settings) await S.store.saveSettings(d.settings);
  if (d.assetHistory && Object.keys(d.assetHistory).length) await S.store.saveAssetHistory(d.assetHistory);
  pendingRestore = null;
  toast('백업을 복원했습니다');
}

/* ---------- 엑셀 일괄 등록 ---------- */
const U = { owner: '', files: [], raw: [], includeDup: false, busy: false };
const txKey = (t) => `${t.owner}|${t.date}|${t.type}|${t.amount}|${(t.memo || '').trim()}`;

// 가맹점명 → 분류 추정. 이전에 직접 분류한 내역이 키워드 규칙보다 우선한다.
// [분류, 키워드, 구분(생략 시 소비지출)] — 위에서부터 먼저 맞는 규칙을 쓴다
const KEYWORD_RULES = [
  ['통신/구독', ['ANTHROPIC', 'CLAUDE', 'OPENAI', 'NETFLIX', '넷플릭스', 'YOUTUBE', '유튜브', '구글페이먼트', 'GOOGLE',
    'SPOTIFY', '스포티파이', 'APPLE.COM', '애플코리아', '디즈니플러스', '티빙', 'WAVVE', '왓챠', '쿠팡와우'], 'fixed'],
  ['카페/간식', ['스타벅스', '투썸', '이디야', '메가커피', '메가엠지씨', '컴포즈', '빽다방', '할리스', '폴바셋', '엔제리너스',
    '매머드', '커피빈', '공차', '커피', '카페', '베이커리', '파리바게', '뚜레쥬르', '배스킨', '던킨', '편의점', 'GS25',
    '지에스25', 'CU', '씨유', '세븐일레븐', '이마트24', '미니스톱']],
  ['식비', ['이마트', '홈플러스', '롯데마트', '코스트코', '트레이더스', '하나로마트', '마트', '배달의민족', '배민', '요기요',
    '쿠팡이츠', '김밥', '치킨', '피자', '맥도날드', '버거킹', '롯데리아', '맘스터치', '식당', '푸드', '식품', '국밥', '해장국',
    '씨푸드', '수산', '횟집', '그릴', '고기', '갈비', '삼겹', '찌개', '분식', '반점', '짜장', '냉면', '칼국수', '돈까스', '돈가스',
    '스시', '초밥', '라멘', '버거', '샐러드']],
  ['교통비', ['주유', '오일', 'SK에너지', 'GS칼텍스', 'S-OIL', '에쓰오일', '택시', '카카오T', '카카오모빌리티', '티머니',
    '코레일', '고속버스', '주차', '하이패스', '도로공사', '휴게소']],
  ['인형뽑기', ['인형뽑기', '뽑기', '뽑아', '오락실', '오락관', '스테이션', '크레인']],
  ['미용', ['미용실', '헤어', '네일', '올리브영', '바버']],
  ['의료/건강', ['병원', '의원', '약국', '치과', '한의원', '안과', '피부과']],
  ['취미/여가', ['CGV', '메가박스', '롯데시네마', '영화', 'PC방', '노래', '볼링', '파크랜드']],
  ['쇼핑', ['문구', '무신사', '지그재그', '에이블리', '유니클로', '자라', '아트박스']],
  ['생활비', ['다이소', '쿠팡', '11번가', 'G마켓', '지마켓', '옥션', '네이버페이', '오늘의집']],
];
const normMemo = (s) => String(s || '').replace(/\s/g, '').replace(/\(.*?\)/g, '').toUpperCase();

function makeClassifier() {
  const hist = new Map(); // 정규화된 메모 → {type, category}, 최근 내역이 이긴다
  [...S.tx].filter((t) => t.type !== 'income' && t.memo)
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((t) => { const k = normMemo(t.memo); if (k.length >= 2) hist.set(k, { type: t.type, category: t.category }); });
  const histKeys = [...hist.keys()].sort((a, b) => b.length - a.length);
  const known = { variable: new Set(categoryOptions('variable')), fixed: new Set(categoryOptions('fixed')) };
  return (merchant) => {
    const m = normMemo(merchant);
    const viaGateway = GATEWAY.test(merchant);
    if (!viaGateway && hist.has(m)) return { ...hist.get(m), source: '이전 내역' };
    const k = !viaGateway && histKeys.find((h) => h.length >= 3 && (m.includes(h) || h.includes(m)));
    if (k) return { ...hist.get(k), source: '이전 내역' };
    const rule = KEYWORD_RULES.find(([cat, words, type = 'variable']) =>
      known[type].has(cat) && words.some((w) => m.includes(normMemo(w))));
    if (rule) return { type: rule[2] || 'variable', category: rule[0], source: '키워드' };
    return { type: 'variable', category: '기타', source: '' };
  };
}

// 카드 결제 한 건이 이미 가계부에 있는지 찾는다. 해외 결제(가맹점명에 'USD:22.00' 등)는
// 직접 적은 금액과 환율 차이가 나므로 같은 날 3% 이내면 같은 결제로 본다.
const FOREIGN = /[A-Z]{3}\s*:\s*[\d.,]+/;
// 결제대행사 이름은 실제 가게가 매번 달라서 한 건의 분류를 다른 줄로 옮기지 않는다
const GATEWAY = /네이버페이|카카오페이|토스페이|페이코|PAYCO|이니시스|나이스페이|KCP|다날|스마일페이|쿠페이/i;
// 한 번 짝지어진 기존 내역은 다시 쓰지 않는다: 같은 날 같은 금액 결제가 여러 번이어도 1:1로만 겹친다고 본다.
function existingMatcher() {
  const byDay = new Map();
  for (const t of S.tx) {
    if (t.type === 'income') continue;
    const d = `${t.owner}|${t.date}`;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  const used = new Set();
  return (r) => {
    const day = (byDay.get(`${r.owner}|${r.date}`) || []).filter((t) => !used.has(t));
    const t = day.find((x) => x.amount === r.amount)
      || (FOREIGN.test(r.memo) && day.find((x) => Math.abs(x.amount - r.amount) <= r.amount * 0.03))
      || null;
    if (t) used.add(t);
    return t;
  };
}

// 이미 가계부에 있는 결제와 짝지어진 카드 내역에서 '가맹점명 → 분류'를 배워, 같은 가게의 다른 줄에도 적용한다.
function learnFromMatches(files) {
  const match = existingMatcher();
  const learned = new Map();
  for (const f of files) {
    if (f.format !== 'card') continue;
    for (const r of f.rows) {
      const t = match(r);
      if (!t) continue;
      r.type = t.type; r.category = t.category; r.guessed = '이전 내역'; r.matched = true;
      if (!GATEWAY.test(r.memo)) learned.set(normMemo(r.memo), { type: t.type, category: t.category });
    }
    for (const r of f.rows) {
      const l = learned.get(normMemo(r.memo));
      if (l && r.guessed !== '이전 내역') { r.type = l.type; r.category = l.category; r.guessed = '이전 내역'; }
    }
  }
}

/* ---------- 매달 반복 결제 → 고정비용 제안 ---------- */
// 같은 사람·같은 가게에서 비슷한 금액(±15%)이 두 달 이상 결제되면 고정비용 '후보'로 본다.
// 바로 바꾸지 않고 "고정비용으로 처리할까요?"라고 물어본 뒤, 확인하면 그때 고정비용으로 넣는다.
// 금액이 다른 결제(같은 가게의 다른 구매)는 따로 본다. 한 달에 같은 금액이 여러 번 나오는 곳(뽑기 등)은 제외.
const recurKey = (t) => `${t.owner}|${normMemo(String(t.memo || '').replace(FOREIGN, ''))}`;
const SIMILAR = 0.15;
const DAILY_CATS = new Set(['식비', '외식', '카페/간식', '생활비', '쇼핑', '미용', '인형뽑기', '선물', '여행', '이벤트', '경조사', '결혼 비용']);
// 장보기·식당·커피·편의점은 금액이 같아도 고정비용으로 묻지 않는다
const NEVER_FIXED = new Set(['식비', '외식', '카페/간식']);
const keywordCategory = (memo) => {
  const m = normMemo(memo);
  return KEYWORD_RULES.find(([, words, type]) => !type && words.some((w) => m.includes(normMemo(w))))?.[0] || '';
};
const majority = (arr) => {
  const n = new Map();
  arr.filter(Boolean).forEach((x) => n.set(x, (n.get(x) || 0) + 1));
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

function findRecurring(list) {
  const groups = new Map();
  for (const t of list) {
    if (t.type === 'income' || !t.memo || GATEWAY.test(t.memo)) continue;
    const k = recurKey(t);
    if (k.split('|')[1].length < 2) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const found = new Map();
  for (const [k, g] of groups) {
    // 가장 여러 달에 걸쳐 나온 금액을 기준으로, 그 금액과 비슷한 결제만 묶는다
    let best = null;
    for (const base of g) {
      const items = g.filter((t) => Math.abs(t.amount - base.amount) <= base.amount * SIMILAR);
      const months = new Set(items.map((t) => t.date.slice(0, 7))).size;
      if (!best || months > best.months || (months === best.months && items.length < best.items.length)) best = { items, months, base };
    }
    if (!best || best.months < 2 || best.items.length / best.months > 1.5) continue;
    const fixedCat = best.items.find((t) => t.type === 'fixed')?.category || null;
    // 사람이 붙인 분류를 먼저 보고, 없거나 '기타'면 가게 이름 키워드로 판단한다 (배민클럽처럼 이름은 배달이어도 분류가 구독이면 구독)
    const usualCat = majority(best.items.filter((t) => t.type !== 'fixed').map((t) => t.category));
    const kind = usualCat && usualCat !== '기타' ? usualCat : keywordCategory(best.items[0].memo);
    if (NEVER_FIXED.has(kind)) continue;
    // 고정비용으로 쓴 적 없는 가게가 생활비·쇼핑·미용처럼 일상 소비 분류면 우연히 금액이 같은 것으로 본다
    if (!fixedCat && DAILY_CATS.has(kind)) continue;
    const amts = best.items.map((t) => t.amount).sort((a, b) => a - b);
    found.set(k, { key: k, items: best.items, months: best.months, amount: amts[Math.floor(amts.length / 2)], fixedCat });
  }
  return found;
}
// 이 결제가 묶음에 속하는지 (같은 가게라도 금액이 다르면 일반 소비)
const inRecurring = (g, t) => !!g && Math.abs(t.amount - g.amount) <= g.amount * SIMILAR;

const FIXED_RULES = [
  ['저축', ['적금', '청약', '저축', '도약계좌']],
  ['보험', ['보험', '생명', '화재', '손해']],
  ['주거', ['관리비', '임대', '월세', '주택', 'LH']],
  ['공과금', ['한전', '전기', '가스', '수도']],
  ['통신/구독', ['SKT', 'KT', 'LGU', '유플러스', '통신', '인터넷', '모바일']],
];
function fixedCategoryFor(rec, memo) {
  const cats = categoryOptions('fixed');
  if (rec.fixedCat) return rec.fixedCat;
  const m = normMemo(memo);
  const hit = FIXED_RULES.find(([c, words]) => cats.includes(c) && words.some((w) => m.includes(normMemo(w))));
  if (hit) return hit[0];
  return cats.includes('통신/구독') ? '통신/구독' : (cats[0] || '기타');
}
const ignoredRecurring = () => new Set(S.settings.ignoredRecurring || []);

// 이미 저장된 소비지출 중 매달 반복되는 것 (현재 보고 있는 사람 기준)
function recurringSuggestions() {
  const ignored = ignoredRecurring();
  return [...findRecurring(S.tx).values()]
    .filter((g) => !ignored.has(g.key) && (S.who === 'all' || g.items[0].owner === S.who))
    .map((g) => ({ ...g, variable: g.items.filter((t) => t.type === 'variable') }))
    .filter((g) => g.variable.length)
    .sort((a, b) => b.amount - a.amount);
}

async function moveRecurringToFixed(groups) {
  const fixedMethods = methodOptions('fixed');
  const updateTx = groups.flatMap((g) => g.variable.map((t) => ({
    id: t.id,
    data: { type: 'fixed', category: fixedCategoryFor(g, t.memo), method: fixedMethods.includes(t.method) ? t.method : (fixedMethods[0] || '') },
  })));
  await S.store.bulk({ updateTx });
  toast(`${updateTx.length}건을 고정비용으로 옮겼습니다`);
}

async function ignoreRecurring(key) {
  const st = structuredClone(S.settings);
  st.ignoredRecurring = [...new Set([...(st.ignoredRecurring || []), key])];
  await S.store.saveSettings(st);
  toast('앞으로 이 결제는 소비지출로 둡니다');
}

// 일괄 등록 줄 중 매달 반복되는 소비지출에 '고정비용 제안'을 붙인다. 구분은 그대로 두고 확인을 기다린다.
// (이미 있는 내역과 짝지어진 줄·직접 고친 줄은 제외)
function markRecurring(files) {
  const fresh = files.flatMap((f) => f.rows).filter((r) => !r.matched);
  const rec = findRecurring([...S.tx, ...fresh]);
  const ignored = ignoredRecurring();
  for (const r of fresh) {
    delete r.suggest;
    const hit = rec.get(recurKey(r));
    if (!inRecurring(hit, r) || ignored.has(hit.key) || r.type !== 'variable' || r.guessed === '직접') continue;
    r.suggest = { key: hit.key, category: fixedCategoryFor(hit, r.memo), months: hit.months };
  }
}

// 제안을 받아들이거나(고정비용으로) 거절한다. 같은 가게·같은 금액대 줄에 함께 적용한다.
async function answerSuggestion(rows, accept) {
  const fixedMethods = methodOptions('fixed');
  const keys = new Set(rows.map((r) => r.suggest.key));
  for (const r of U.files.flatMap((f) => f.rows)) {
    if (!r.suggest || !keys.has(r.suggest.key)) continue;
    if (accept) {
      r.type = 'fixed'; r.category = r.suggest.category; r.guessed = '직접'; r.recurring = r.suggest.months;
      if (!fixedMethods.includes(r.method)) r.method = fixedMethods[0] || '';
    }
    delete r.suggest;
  }
  if (!accept) {
    const st = structuredClone(S.settings);
    st.ignoredRecurring = [...new Set([...(st.ignoredRecurring || []), ...keys])];
    await S.store.saveSettings(st);
  }
  renderUpload();
}

function openUpload() {
  U.owner = S.who !== 'all' ? S.who : local.get('lastOwner', '');
  U.files = []; U.raw = []; U.includeDup = false; U.busy = false;
  $('#upload-input').value = '';
  renderUpload();
  $('#upload-dialog').showModal();
}

function uploadPlan() {
  const exact = new Set(S.tx.map(txKey));
  const match = existingMatcher();
  const rows = U.files.flatMap((f) => f.rows.map((r) => ({
    ...r, file: f.name, dup: exact.has(txKey(r)) || (f.format === 'card' && !!match(r)),
  })));
  const errors = U.files.flatMap((f) => f.errors.map((e) => ({ ...e, file: f.name })));
  const add = rows.filter((r) => U.includeDup || !r.dup);
  const cancels = U.files.reduce((a, f) => a + (f.skipped?.cancel || 0), 0);
  const card = U.files.some((f) => f.format === 'card');
  const suggest = add.filter((r) => r.suggest);
  return { rows, errors, add, dups: rows.filter((r) => r.dup).length, cancels, card, suggest };
}

function renderUpload() {
  $('#upload-owner').innerHTML = MEMBERS.map((m) => `<button type="button" data-v="${esc(m)}" aria-pressed="${U.owner === m}">
    <span class="dot" style="background:${memberColor(m)}"></span>${esc(m)}</button>`).join('');
  const box = $('#upload-preview');
  if (U.busy) { box.innerHTML = '<p class="empty">파일을 읽는 중…</p>'; return; }
  if (!U.files.length) { box.innerHTML = ''; return; }
  const p = uploadPlan();
  const sum = (type) => p.add.filter((r) => r.type === type).reduce((a, r) => a + r.amount, 0);
  const cnt = (type) => p.add.filter((r) => r.type === type).length;
  const months = [...new Set(p.add.map((r) => r.date.slice(0, 7)))].sort();
  box.innerHTML = `
    <div class="upload-summary">
      <div><b>${p.add.length}건 등록 예정</b> <span class="hint">${U.files.map((f) => esc(f.name)).join(', ')}${months.length ? ` · ${months.map(ymLabel).join(', ')}` : ''}</span></div>
      <div class="nums">
        <span>소비지출 ${cnt('variable')}건 <b>${fmt(sum('variable'))}</b></span>
        <span>고정비용 ${cnt('fixed')}건 <b>${fmt(sum('fixed'))}</b></span>
        <span>수입 ${cnt('income')}건 <b class="c-income">${fmt(sum('income'))}</b></span>
      </div>
      ${p.card ? `<p class="hint">이용내역 표(카드사 명세서·개인 내역표)로 인식했습니다. 분류는 ${[
        ['파일 분류', '파일에 적힌 분류'], ['이전 내역', '이전에 입력한 내역'], ['키워드', '가게 이름'], ['', '추정 못 함(기타)']]
        .map(([s, l]) => [l, p.rows.filter((r) => (r.guessed || '') === s).length])
        .filter(([, n], i) => n || i > 0).map(([l, n]) => `${l} ${n}건`).join(', ')}으로 정했어요. 아래 표에서 바꿀 수 있습니다.
        ${p.cancels ? `취소된 결제 ${p.cancels}건은 뺐습니다.` : ''}</p>` : ''}
      ${p.suggest.length ? `<div class="suggest-box">
        <span><b>고정비용으로 처리할까요?</b> 같은 가게에서 비슷한 금액으로 두 달 이상 나간 결제가 ${p.suggest.length}건 있어요
          (${[...new Set(p.suggest.map((r) => r.memo))].slice(0, 4).map(esc).join(', ')}${new Set(p.suggest.map((r) => r.memo)).size > 4 ? ' 등' : ''}).
          지금은 소비지출로 들어가 있고, 표에서 한 줄씩 고를 수도 있습니다.</span>
        <span class="suggest-actions"><button type="button" class="btn small primary" data-suggest-all="yes">모두 고정비용으로</button>
          <button type="button" class="btn small" data-suggest-all="no">아니요, 소비지출로</button></span>
      </div>` : ''}
      ${p.dups ? `<label class="check"><input type="checkbox" id="upload-dup" ${U.includeDup ? 'checked' : ''}>
        <span>이미 등록된 내역과 겹치는 ${p.dups}건도 등록하기. 끄면 건너뜁니다.
        ${p.card ? '(카드 내역은 같은 사람·날짜·금액이면 겹친다고 봅니다)' : '(같은 사람·날짜·구분·금액·메모)'}</span></label>` : ''}
      ${p.errors.length ? `<div><b class="c-expense">읽지 못한 줄 ${p.errors.length}개</b> <span class="hint">고쳐서 다시 올리면 됩니다. 나머지는 정상 등록됩니다.</span>
        <ul class="err-list">${p.errors.slice(0, 50).map((e) => `<li>${esc(e.file)}${e.line ? ` ${esc(e.sheet)} ${e.line}행` : ''}: ${esc(e.msg)}</li>`).join('')}</ul></div>` : ''}
    </div>
    ${p.rows.length ? `<div class="preview-table"><table>
      <thead><tr><th class="left">날짜</th><th class="left">누구</th><th class="left">구분</th><th class="left">분류</th><th class="left">결제 수단</th><th>금액</th><th class="left">메모</th></tr></thead>
      <tbody>${p.rows.slice(0, 300).map((r) => `<tr class="${r.dup && !U.includeDup ? 'dup' : ''}">
        <td class="left">${r.date}</td><td class="left">${esc(r.owner)}</td><td class="left">${TYPE_LABEL[r.type]}</td>
        <td class="left">${r.type === 'income' ? esc(r.category) : categorySelect(r)}</td><td class="left">${esc(r.method)}</td>
        <td class="${r.type === 'income' ? 'c-income' : ''}">${fmt(r.amount)}</td><td class="left">${esc(r.memo)}${r.dup ? ' <span class="pill">중복</span>' : ''}${r.recurring && r.type === 'fixed' ? ' <span class="pill fixed">매달 반복</span>' : ''}${r.suggest && !r.dup ? `
          <span class="suggest-inline">고정비용(${esc(r.suggest.category)})으로 할까요?
            <button type="button" class="btn small" data-suggest-yes="${esc(r.k)}">예</button>
            <button type="button" class="btn small ghost" data-suggest-no="${esc(r.k)}">아니요</button></span>` : ''}</td></tr>`).join('')}
      </tbody></table></div>${p.rows.length > 300 ? `<p class="hint">미리보기는 300줄까지만 보여줍니다. 등록은 전체 ${p.rows.length}줄 기준입니다.</p>` : ''}` : ''}
    <div class="sheet-actions">
      <button type="button" class="btn" id="upload-reset">다른 파일 고르기</button>
      <span class="spacer"></span>
      <button type="button" class="btn primary" id="upload-run" ${p.add.length ? '' : 'disabled'}>${p.add.length}건 등록</button>
    </div>`;
}

// 미리보기에서 분류(와 소비/고정 구분)를 바로 고치는 선택 상자
function categorySelect(r) {
  const opt = (type, c) => `<option value="${type}|${esc(c)}" ${r.type === type && r.category === c ? 'selected' : ''}>${esc(c)}</option>`;
  const groups = ['variable', 'fixed'].map((type) => {
    const cats = categoryOptions(type);
    if (r.type === type && !cats.includes(r.category)) cats.push(r.category);
    return `<optgroup label="${TYPE_LABEL[type]}">${cats.map((c) => opt(type, c)).join('')}</optgroup>`;
  });
  return `<select class="input cat-pick" data-k="${esc(r.k)}" aria-label="분류">${groups.join('')}</select>`;
}

async function readUploadFiles(fileList) {
  U.busy = true; renderUpload();
  const year = S.ym.slice(0, 4);
  const classify = makeClassifier();
  U.files = await Promise.all([...fileList].map(async (file) => {
    try {
      // 파일 이름에 사람 이름이 있으면(예: 가계부(혜미).xlsx) 그 사람 내역으로 본다
      const defaultOwner = guessOwner(file.name, MEMBERS) || U.owner;
      return { name: file.name, ...(await parseUpload(file, { members: MEMBERS, defaultOwner, year, classify })) };
    } catch (e) {
      return { name: file.name, rows: [], errors: [{ sheet: '', line: 0, msg: `파일을 열 수 없습니다 (${e.message})` }] };
    }
  }));
  U.files.forEach((f, fi) => f.rows.forEach((r, i) => { r.k = `${fi}-${i}`; }));
  learnFromMatches(U.files);
  markRecurring(U.files);
  U.raw = [...fileList];
  U.busy = false; renderUpload();
}

async function runUpload() {
  const { add } = uploadPlan();
  if (!add.length) return;
  const btn = $('#upload-run');
  btn.disabled = true; btn.textContent = '등록 중…';
  try {
    await S.store.bulk({ addTx: add.map(({ line, sheet, file, dup, k, guessed, matched, recurring, suggest, ...t }) => ({ ...t, src: 'upload' })) });
  } catch (e) {
    btn.disabled = false; btn.textContent = `${add.length}건 등록`;
    toast(`등록 실패: ${e.message}`);
    return;
  }
  const months = add.map((r) => r.date.slice(0, 7)).sort();
  S.ym = months.at(-1);
  $('#upload-dialog').close();
  toast(`${add.length}건을 등록했습니다`);
  render();
}

/* ---------- 내역 입력 시트 ---------- */
const form = { id: null, owner: '', type: 'variable', category: '', method: '' };

function setPressed(container, value) {
  $$('button', container).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
}

function renderTxChoices() {
  $('#tx-owner').innerHTML = MEMBERS.map((m) => `<button type="button" data-v="${esc(m)}"><span class="dot" style="background:${memberColor(m)}"></span>${esc(m)}</button>`).join('');
  setPressed($('#tx-owner'), form.owner);
  setPressed($('#tx-type'), form.type);
  const cats = categoryOptions(form.type);
  $('#tx-category').innerHTML = cats.map((c) => `<button type="button" data-v="${esc(c)}">${esc(c)}</button>`).join('');
  setPressed($('#tx-category'), form.category);
  $('#tx-method-field').hidden = form.type === 'income';
  const methods = form.type === 'income' ? [] : methodOptions(form.type);
  $('#tx-method').innerHTML = methods.map((c) => `<button type="button" data-v="${esc(c)}">${esc(c)}</button>`).join('');
  setPressed($('#tx-method'), form.method);
  const memos = new Map();
  for (const t of S.tx) if (t.type === form.type && t.memo) memos.set(t.memo, (memos.get(t.memo) || 0) + 1);
  $('#memo-list').innerHTML = [...memos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)
    .map(([m]) => `<option value="${esc(m)}"></option>`).join('');
  updateBudgetHint();
}

// 새로 입력하는 소비지출이 지난달들과 같은 가게·비슷한 금액이면 "고정비용으로 처리할까요?"라고 묻는다.
// 구분은 사람이 '예'를 눌러야 바뀐다. 직접 구분을 고른 뒤나 이미 답한 뒤에는 다시 묻지 않는다.
function checkRecurringForm() {
  const hint = $('#tx-hint');
  form.suggest = null;
  hint.hidden = true;
  if (form.id || form.typeTouched || form.type !== 'variable' || !form.owner) return;
  const cand = { owner: form.owner, type: 'variable', date: $('#tx-date').value,
    amount: parseAmount($('#tx-amount').value), memo: $('#tx-memo').value.trim() };
  if (!cand.date || !cand.amount || !cand.memo) return;
  cand.category = form.category || makeClassifier()(cand.memo).category;
  const hit = findRecurring([...S.tx, cand]).get(recurKey(cand));
  if (!inRecurring(hit, cand) || ignoredRecurring().has(hit.key)) return;
  form.suggest = { key: hit.key, category: fixedCategoryFor(hit, cand.memo) };
  hint.innerHTML = `<span><b>고정비용으로 처리할까요?</b> ‘${esc(cand.memo)}’ ${fmt(hit.amount)}원 안팎이 ${hit.months}개월째 나가고 있어요.</span>
    <span class="suggest-actions"><button type="button" class="btn small primary" id="tx-suggest-yes">고정비용(${esc(form.suggest.category)})으로</button>
    <button type="button" class="btn small" id="tx-suggest-no">아니요</button></span>`;
  hint.hidden = false;
}

async function answerFormSuggestion(accept) {
  const s = form.suggest;
  if (!s) return;
  form.typeTouched = true;
  form.suggest = null;
  $('#tx-hint').hidden = true;
  if (accept) {
    form.type = 'fixed';
    form.category = s.category;
    if (!methodOptions('fixed').includes(form.method)) form.method = methodOptions('fixed')[0] || '';
    renderTxChoices();
  } else {
    const st = structuredClone(S.settings);
    st.ignoredRecurring = [...new Set([...(st.ignoredRecurring || []), s.key])];
    await S.store.saveSettings(st);
  }
}

// 소비지출 분류를 고르면 그 사람의 이번 달 예산 사용 현황을 보여준다
function updateBudgetHint() {
  const el = $('#tx-budget');
  const date = $('#tx-date').value;
  const budget = form.owner && form.type === 'variable' && form.category ? budgetsOf(form.owner)[form.category] : 0;
  if (!budget || !date) { el.hidden = true; return; }
  const ym = date.slice(0, 7);
  const spent = S.tx.filter((t) => t.owner === form.owner && t.type === 'variable' && t.category === form.category
    && t.date.startsWith(ym) && t.id !== form.id).reduce((a, t) => a + t.amount, 0);
  const amount = parseAmount($('#tx-amount').value);
  const after = spent + amount;
  const st = budgetState(after, budget, monthProgress(ym).elapsed);
  el.className = `hint budget-hint ${st}`;
  el.textContent = `${Number(ym.slice(5))}월 ${form.category} 예산 ${won(budget)} 중 ${won(spent)} 사용`
    + (amount ? ` → 이번 것까지 ${won(after)} (${after > budget ? `${won(after - budget)} 초과` : `남음 ${won(budget - after)}`})` : ` · 남음 ${won(Math.max(0, budget - spent))}`);
  el.hidden = false;
}

function openTx(tx) {
  const t = tx || null;
  form.typeTouched = false;
  $('#tx-hint').hidden = true;
  form.id = t?.id || null;
  form.owner = t?.owner || (S.who !== 'all' ? S.who : local.get('lastOwner', ''));
  form.type = t?.type || local.get('lastType', 'variable');
  form.category = t?.category || '';
  form.method = t?.method || (form.type === 'income' ? '' : methodOptions(form.type)[0] || '');
  $('#tx-title').textContent = t ? '내역 수정' : '내역 입력';
  $('#tx-date').value = t?.date || (S.ym === today().slice(0, 7) ? today() : `${S.ym}-01`);
  $('#tx-amount').value = t ? fmt(t.amount) : '';
  $('#tx-memo').value = t?.memo || '';
  $('#tx-error').hidden = true;
  const del = $('#tx-delete');
  del.hidden = !t; del.textContent = '삭제'; delete del.dataset.armed;
  $('#tx-save-next').hidden = !!t;
  renderTxChoices();
  $('#tx-dialog').showModal();
  if (!t) setTimeout(() => $('#tx-amount').focus(), 50);
}

async function saveTx(keepOpen) {
  const err = $('#tx-error');
  const amount = parseAmount($('#tx-amount').value);
  const date = $('#tx-date').value;
  const problem = !form.owner ? '누구의 내역인지 선택하세요.'
    : !date ? '날짜를 입력하세요.'
    : !amount ? '금액을 입력하세요.'
    : !form.category ? '분류를 선택하세요.' : '';
  if (problem) { err.textContent = problem; err.hidden = false; return; }
  const data = {
    owner: form.owner, type: form.type, date, amount, category: form.category,
    method: form.type === 'income' ? '' : form.method, memo: $('#tx-memo').value.trim(),
  };
  local.set('lastOwner', form.owner);
  local.set('lastType', form.type);
  try {
    if (form.id) await S.store.updateTx(form.id, data);
    else await S.store.addTx(data);
  } catch (e) {
    err.textContent = `저장하지 못했습니다: ${e.message}`; err.hidden = false; return;
  }
  toast(form.id ? '수정했습니다' : `${TYPE_LABEL[data.type]} ${won(amount)} 저장`);
  if (keepOpen) {
    $('#tx-amount').value = ''; $('#tx-memo').value = ''; form.category = '';
    form.typeTouched = false; $('#tx-hint').hidden = true;
    renderTxChoices(); $('#tx-amount').focus();
  } else {
    $('#tx-dialog').close();
  }
}

/* ---------- 자산 입력 시트 ---------- */
const aform = { id: null, owner: '', kind: '자산' };
function openAsset(a) {
  aform.id = a?.id || null;
  aform.owner = a?.owner || (S.who !== 'all' ? S.who : '');
  aform.kind = a?.kind || '자산';
  $('#asset-owner').innerHTML = MEMBERS.map((m) => `<button type="button" data-v="${esc(m)}"><span class="dot" style="background:${memberColor(m)}"></span>${esc(m)}</button>`).join('');
  setPressed($('#asset-owner'), aform.owner);
  setPressed($('#asset-kind'), aform.kind);
  $('#asset-group').value = a?.group || '';
  $('#asset-name').value = a?.name || '';
  $('#asset-place').value = a?.place || '';
  $('#asset-amount').value = a ? fmt(a.amount) : '';
  $('#asset-note').value = a?.note || '';
  $('#asset-group-list').innerHTML = [...new Set(['현금', '예금', '적금', '투자', '보증금', '대출', ...S.assets.map((x) => x.group)])]
    .map((g) => `<option value="${esc(g)}"></option>`).join('');
  $('#asset-error').hidden = true;
  const del = $('#asset-delete');
  del.hidden = !a; del.textContent = '삭제'; delete del.dataset.armed;
  $('#asset-dialog').showModal();
}
async function saveAsset() {
  const err = $('#asset-error');
  const amount = parseAmount($('#asset-amount').value);
  const name = $('#asset-name').value.trim();
  const problem = !aform.owner ? '누구의 자산인지 선택하세요.' : !name ? '상세 항목을 입력하세요.' : '';
  if (problem) { err.textContent = problem; err.hidden = false; return; }
  const data = { owner: aform.owner, kind: aform.kind, group: $('#asset-group').value.trim() || '기타', name,
    place: $('#asset-place').value.trim(), amount, note: $('#asset-note').value.trim() };
  try {
    if (aform.id) await S.store.updateAsset(aform.id, data);
    else await S.store.addAsset(data);
  } catch (e) {
    err.textContent = `저장하지 못했습니다: ${e.message}`; err.hidden = false; return;
  }
  $('#asset-dialog').close();
  toast('자산 항목을 저장했습니다');
}

/* ---------- 이벤트 ---------- */
function armDelete(btn, action) {
  if (btn.dataset.armed) { action(); return; }
  btn.dataset.armed = '1';
  btn.textContent = '한 번 더 누르면 삭제';
}

function formatAmountInput(input) {
  const n = parseAmount(input.value);
  input.value = n ? fmt(n) : '';
}

function bind() {
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v)) { S.view = v; render(); window.scrollTo(0, 0); }
  });
  $('#who-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-who]');
    if (!b) return;
    S.who = b.dataset.who; local.set('who', S.who); render();
  });
  $('#prev-month').onclick = () => { S.ym = shiftYM(S.ym, -1); render(); };
  $('#next-month').onclick = () => { S.ym = shiftYM(S.ym, 1); render(); };
  $('#month-label').onclick = () => { S.ym = today().slice(0, 7); render(); };
  $('#fab').onclick = () => openTx(null);
  $('#login-btn').onclick = async () => {
    try { await S.store.signIn(); } catch (e) {
      const el = $('#login-error'); el.textContent = `로그인 실패: ${e.message}`; el.hidden = false;
    }
  };

  // 내역
  $('#view-list').addEventListener('click', (e) => {
    const row = e.target.closest('.tx-row');
    if (row) { openTx(S.tx.find((t) => t.id === row.dataset.id)); return; }
    const tb = e.target.closest('#type-filter button');
    if (tb) { S.filter.type = tb.dataset.v; S.filter.cat = ''; renderList(); return; }
    if (e.target.closest('#copy-fixed')) copyFixedFromPrev();
    if (e.target.closest('#open-upload')) openUpload();
    const ra = e.target.closest('[data-recur-apply]');
    if (ra) moveRecurringToFixed(recurringSuggestions().filter((g) => g.key === ra.dataset.recurApply));
    if (e.target.closest('[data-recur-all]')) moveRecurringToFixed(recurringSuggestions());
    const ri = e.target.closest('[data-recur-ignore]');
    if (ri) ignoreRecurring(ri.dataset.recurIgnore);
  });
  $('#view-list').addEventListener('change', (e) => {
    if (e.target.id === 'cat-filter') { S.filter.cat = e.target.value; renderList(); }
  });
  $('#view-list').addEventListener('input', (e) => {
    if (e.target.id !== 'q-filter') return;
    S.filter.q = e.target.value;
    const pos = e.target.selectionStart;
    renderList();
    const q = $('#q-filter'); q.focus(); q.setSelectionRange(pos, pos);
  });

  // 자산
  $('#view-assets').addEventListener('click', (e) => {
    if (e.target.closest('#add-asset')) { openAsset(null); return; }
    const row = e.target.closest('[data-asset]');
    if (row) { openAsset(S.assets.find((a) => a.id === row.dataset.asset)); return; }
    if (e.target.closest('#hist-open')) { S.histForm = true; renderAssets(); $('#hist-asset')?.focus(); return; }
    if (e.target.closest('#hist-cancel')) { S.histForm = false; renderAssets(); }
  });
  $('#view-assets').addEventListener('submit', (e) => {
    if (e.target.id !== 'hist-form') return;
    e.preventDefault();
    saveHistForm().catch((err) => toast(`저장하지 못했습니다: ${err.message}`));
  });
  $('#view-assets').addEventListener('input', (e) => {
    if (e.target.id === 'hist-asset' || e.target.id === 'hist-debt') formatAmountInput(e.target);
  });

  // 설정
  const vs = $('#view-settings');
  vs.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = structuredClone(S.settings);
    if (e.target.id === 'goal-form') {
      $$('[data-member]', e.target).forEach((i) => { st.goals[i.dataset.member] = parseAmount(i.value); });
      await S.store.saveSettings(st); toast('목표를 저장했습니다');
    } else if (e.target.id === 'cat-form') {
      st.categories = { variable: splitList($('#cat-variable').value), fixed: splitList($('#cat-fixed').value), income: splitList($('#cat-income').value) };
      st.methods = { variable: splitList($('#m-variable').value), fixed: splitList($('#m-fixed').value) };
      await S.store.saveSettings(st); toast('분류를 저장했습니다');
    } else if (e.target.id === 'budget-form') {
      const mine = {};
      $$('[data-budget-cat]', e.target).forEach((i) => { const v = parseAmount(i.value); if (v > 0) mine[i.dataset.budgetCat] = v; });
      st.budgets = { ...(st.budgets || {}), [S.budgetWho]: mine };
      await S.store.saveSettings(st); toast(`${S.budgetWho}님 예산을 저장했습니다`);
    }
  });
  vs.addEventListener('input', (e) => {
    if (e.target.dataset.budgetCat == null) return;
    formatAmountInput(e.target);
    const total = $$('[data-budget-cat]', vs).reduce((a, i) => a + parseAmount(i.value), 0);
    $('#budget-sum').textContent = `합계 ${won(total)}`;
  });
  vs.addEventListener('change', async (e) => {
    if (e.target.id === 'import-input') {
      const files = [...e.target.files];
      S.imports = await Promise.all(files.map(async (file) => {
        try {
          return { name: file.name, owner: guessOwner(file.name, MEMBERS), data: await parseWorkbook(file) };
        } catch (err) {
          return { name: file.name, owner: '', error: err.message, data: { tx: [], assets: [] } };
        }
      }));
      renderSettings();
    } else if (e.target.dataset.importOwner != null) {
      S.imports[Number(e.target.dataset.importOwner)].owner = e.target.value;
    } else if (e.target.id === 'restore-input' && e.target.files[0]) {
      handleRestoreFile(e.target.files[0]);
    }
  });
  vs.addEventListener('click', (e) => {
    if (e.target.id === 'import-run') runImport();
    else if (e.target.id === 'export-json') exportJSON();
    else if (e.target.id === 'restore-confirm') runRestore();
    else if (e.target.id === 'logout') S.store.signOut();
    const who = e.target.closest('#budget-who button');
    if (who) { S.budgetWho = who.dataset.v; renderSettings(); }
    if (e.target.closest('#budget-fill-avg')) {
      $$('[data-budget-cat]', vs).forEach((i) => {
        const avg = Number(i.closest('.budget-line').querySelector('.avg').dataset.avg);
        if (!parseAmount(i.value) && avg > 0) i.value = fmt(avg);
      });
      $('#budget-sum').textContent = `합계 ${won($$('[data-budget-cat]', vs).reduce((a, i) => a + parseAmount(i.value), 0))} (저장 전)`;
    }
  });
  vs.addEventListener('focusout', (e) => { if (e.target.dataset?.member) formatAmountInput(e.target); });

  // 내역 시트
  const dlg = $('#tx-dialog');
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
    if (e.target.closest('#tx-suggest-yes')) { answerFormSuggestion(true); return; }
    if (e.target.closest('#tx-suggest-no')) { answerFormSuggestion(false); return; }
    const pick = (sel, key, after) => {
      const b = e.target.closest(`${sel} button`);
      if (!b) return false;
      form[key] = b.dataset.v; after?.(); setPressed($(sel), form[key]); updateBudgetHint(); return true;
    };
    if (pick('#tx-owner', 'owner')) return;
    if (pick('#tx-type', 'type', () => {
      form.typeTouched = true; $('#tx-hint').hidden = true;
      form.category = '';
      form.method = form.type === 'income' ? '' : (methodOptions(form.type).includes(form.method) ? form.method : methodOptions(form.type)[0] || '');
      renderTxChoices();
    })) return;
    if (pick('#tx-category', 'category')) return;
    pick('#tx-method', 'method');
  });
  $('#tx-amount').addEventListener('input', (e) => { formatAmountInput(e.target); updateBudgetHint(); });
  $('#tx-date').addEventListener('change', updateBudgetHint);
  $('#view-dashboard').addEventListener('click', (e) => {
    if (e.target.closest('[data-goto-budget]') && S.who !== 'all') S.budgetWho = S.who;
  });
  $('#tx-memo').addEventListener('change', (e) => {
    if (!form.category) {
      const hit = [...S.tx].reverse().find((t) => t.type === form.type && t.memo === e.target.value);
      if (hit) { form.category = hit.category; if (hit.method) form.method = hit.method; renderTxChoices(); }
    }
    checkRecurringForm();
  });
  $('#tx-amount').addEventListener('change', checkRecurringForm);
  $('#tx-date').addEventListener('change', checkRecurringForm);
  $('#tx-form').addEventListener('submit', (e) => { e.preventDefault(); saveTx(false); });
  $('#tx-save-next').onclick = () => saveTx(true);
  $('#tx-delete').onclick = (e) => armDelete(e.currentTarget, async () => {
    await S.store.deleteTx(form.id); dlg.close(); toast('삭제했습니다');
  });

  // 일괄 등록
  const udlg = $('#upload-dialog');
  udlg.addEventListener('click', (e) => {
    if (e.target === udlg || e.target.closest('[data-close]')) { udlg.close(); return; }
    const o = e.target.closest('#upload-owner button');
    if (o) {
      U.owner = o.dataset.v;
      if (U.raw.length) readUploadFiles(U.raw); else renderUpload();
      return;
    }
    const sy = e.target.closest('[data-suggest-yes], [data-suggest-no]');
    if (sy) {
      const k = sy.dataset.suggestYes || sy.dataset.suggestNo;
      const row = U.files.flatMap((f) => f.rows).find((r) => r.k === k);
      if (row?.suggest) answerSuggestion([row], 'suggestYes' in sy.dataset);
      return;
    }
    const sa = e.target.closest('[data-suggest-all]');
    if (sa) { answerSuggestion(uploadPlan().suggest, sa.dataset.suggestAll === 'yes'); return; }
    if (e.target.closest('#template-btn')) {
      downloadTemplate(S.settings, MEMBERS).catch((err) => toast(err.message));
    } else if (e.target.closest('#upload-run')) {
      runUpload();
    } else if (e.target.closest('#upload-reset')) {
      U.files = []; U.raw = []; $('#upload-input').value = ''; renderUpload();
    }
  });
  udlg.addEventListener('change', (e) => {
    if (e.target.id === 'upload-input' && e.target.files.length) readUploadFiles(e.target.files);
    else if (e.target.id === 'upload-dup') { U.includeDup = e.target.checked; renderUpload(); }
    else if (e.target.classList.contains('cat-pick')) {
      const [type, ...rest] = e.target.value.split('|');
      const all = U.files.flatMap((f) => f.rows);
      const row = all.find((r) => r.k === e.target.dataset.k);
      if (row) {
        // 같은 가게의 다른 줄도 아직 직접 고치지 않았다면 함께 바꾼다
        const same = GATEWAY.test(row.memo) ? [row]
          : all.filter((r) => r === row || (r.guessed !== '직접' && r.type !== 'income' && normMemo(r.memo) === normMemo(row.memo)));
        same.forEach((r) => { r.type = type; r.category = rest.join('|'); r.guessed = '직접'; delete r.suggest; });
        if (same.length > 1) toast(`같은 가게 ${same.length}건을 함께 바꿨습니다`);
        const scroll = $('.preview-table')?.scrollTop;
        renderUpload();
        if (scroll != null) $('.preview-table').scrollTop = scroll;
      }
    }
  });

  // 자산 시트
  const adlg = $('#asset-dialog');
  adlg.addEventListener('click', (e) => {
    if (e.target === adlg || e.target.closest('[data-close]')) { adlg.close(); return; }
    const o = e.target.closest('#asset-owner button');
    if (o) { aform.owner = o.dataset.v; setPressed($('#asset-owner'), aform.owner); return; }
    const k = e.target.closest('#asset-kind button');
    if (k) { aform.kind = k.dataset.v; setPressed($('#asset-kind'), aform.kind); }
  });
  $('#asset-amount').addEventListener('input', (e) => formatAmountInput(e.target));
  $('#asset-form').addEventListener('submit', (e) => { e.preventDefault(); saveAsset(); });
  $('#asset-delete').onclick = (e) => armDelete(e.currentTarget, async () => {
    await S.store.deleteAsset(aform.id); adlg.close(); toast('삭제했습니다');
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.view === 'dashboard') render(); });
}

/* ---------- 시작 ---------- */
async function start() {
  bind();
  renderChrome();
  try {
    S.store = await createStore({
      onAuth(user) {
        S.user = user;
        $('#login').hidden = !!user;
        $('#loading').hidden = !user || S.ready;
        if (!user) { S.ready = false; S.tx = []; S.assets = []; }
        render();
      },
      onData({ tx, assets, settings, assetHistory, ready }) {
        S.tx = tx.filter((t) => t.date && Number.isFinite(t.amount));
        S.assets = assets;
        S.settings = settings;
        S.history = assetHistory || {};
        S.ready = ready;
        $('#loading').hidden = ready;
        $('#error-banner').hidden = true;
        render();
        syncAssetHistory();
      },
      onError(msg) {
        const el = $('#error-banner'); el.textContent = msg; el.hidden = false;
        $('#loading').hidden = true;
      },
    });
  } catch (e) {
    const el = $('#error-banner');
    el.textContent = `앱을 시작하지 못했습니다: ${e.message}`; el.hidden = false;
    $('#loading').hidden = true;
  }
}

start();
