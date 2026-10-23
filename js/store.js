// 저장소 계층: Firebase(Firestore) 또는 데모(localStorage) 중 하나를 같은 인터페이스로 제공한다.
import { firebaseConfig } from './firebase-config.js';

export const MEMBERS = ['인원', '혜미'];

export const DEFAULT_SETTINGS = {
  categories: {
    income: ['월급', '부업', '알바', '금융', '기타'],
    variable: ['식비', '외식', '카페/간식', '생활비', '쇼핑', '교통비', '취미/여가', '미용', '의료/건강',
      '여행', '선물', '경조사', '이벤트', '인형뽑기', '결혼 비용', '기타'],
    fixed: ['주거', '공과금', '보험', '통신/구독', '저축', '단기 적금', '기타'],
  },
  methods: {
    variable: ['신용카드', '체크카드', '현금/송금', '기타'],
    fixed: ['자동이체', '신용카드', '체크카드', '현금/송금', '기타'],
  },
  goals: { '인원': 100000, '혜미': 100000 },
  ignoredRecurring: [], // '매달 반복 아님'으로 표시한 가게 (사람|가게 키)
};

const FB_VERSION = '10.12.2';
const BATCH_LIMIT = 450;

export async function createStore({ onData, onAuth, onError }) {
  return firebaseConfig.apiKey ? createFirebaseStore({ onData, onAuth, onError }) : createDemoStore({ onData, onAuth });
}

function mergeSettings(s) {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!s) return base;
  return {
    categories: { ...base.categories, ...(s.categories || {}) },
    methods: { ...base.methods, ...(s.methods || {}) },
    goals: { ...base.goals, ...(s.goals || {}) },
    ignoredRecurring: Array.isArray(s.ignoredRecurring) ? s.ignoredRecurring : [],
  };
}

/* ---------- Firebase ---------- */
async function createFirebaseStore({ onData, onAuth, onError }) {
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;
  const [{ initializeApp }, fa, fs] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = fa.getAuth(app);
  let db;
  try {
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }

  const data = { tx: [], assets: [], settings: mergeSettings(null) };
  const loaded = { tx: false, assets: false, settings: false };
  let unsubs = [];
  const emit = () => onData({ ...data, ready: loaded.tx && loaded.assets && loaded.settings });
  const fail = (e) => onError(e.code === 'permission-denied'
    ? '이 계정은 가계부에 접근할 권한이 없습니다. firestore.rules에 이메일을 등록했는지 확인하세요.'
    : `데이터를 불러오지 못했습니다: ${e.message}`);

  fa.onAuthStateChanged(auth, (user) => {
    unsubs.forEach((u) => u());
    unsubs = [];
    onAuth(user ? { email: user.email, name: user.displayName } : null);
    if (!user) return;
    unsubs.push(fs.onSnapshot(fs.collection(db, 'tx'), (snap) => {
      data.tx = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      loaded.tx = true; emit();
    }, fail));
    unsubs.push(fs.onSnapshot(fs.collection(db, 'assets'), (snap) => {
      data.assets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      loaded.assets = true; emit();
    }, fail));
    unsubs.push(fs.onSnapshot(fs.doc(db, 'meta', 'settings'), (snap) => {
      data.settings = mergeSettings(snap.exists() ? snap.data() : null);
      loaded.settings = true; emit();
    }, fail));
  });

  async function chunked(ops) {
    for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
      const batch = fs.writeBatch(db);
      ops.slice(i, i + BATCH_LIMIT).forEach((op) => op(batch));
      await batch.commit();
    }
  }
  const stamp = () => ({ updatedAt: fs.serverTimestamp() });

  return {
    mode: 'firebase',
    async signIn() {
      const provider = new fa.GoogleAuthProvider();
      try {
        await fa.signInWithPopup(auth, provider);
      } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
          await fa.signInWithRedirect(auth, provider);
        } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
          throw e;
        }
      }
    },
    signOut: () => fa.signOut(auth),
    addTx: (t) => fs.addDoc(fs.collection(db, 'tx'), { ...t, ...stamp() }),
    updateTx: (id, t) => fs.updateDoc(fs.doc(db, 'tx', id), { ...t, ...stamp() }),
    deleteTx: (id) => fs.deleteDoc(fs.doc(db, 'tx', id)),
    addAsset: (a) => fs.addDoc(fs.collection(db, 'assets'), { ...a, ...stamp() }),
    updateAsset: (id, a) => fs.updateDoc(fs.doc(db, 'assets', id), { ...a, ...stamp() }),
    deleteAsset: (id) => fs.deleteDoc(fs.doc(db, 'assets', id)),
    saveSettings: (s) => fs.setDoc(fs.doc(db, 'meta', 'settings'), s),
    async bulk({ addTx = [], addAssets = [], deleteTx = [], deleteAssets = [], updateTx = [] }) {
      const ops = [
        ...deleteTx.map((id) => (b) => b.delete(fs.doc(db, 'tx', id))),
        ...updateTx.map(({ id, data: t }) => (b) => b.update(fs.doc(db, 'tx', id), { ...t, ...stamp() })),
        ...deleteAssets.map((id) => (b) => b.delete(fs.doc(db, 'assets', id))),
        ...addTx.map((t) => (b) => b.set(fs.doc(fs.collection(db, 'tx')), { ...t, ...stamp() })),
        ...addAssets.map((a) => (b) => b.set(fs.doc(fs.collection(db, 'assets')), { ...a, ...stamp() })),
      ];
      await chunked(ops);
    },
  };
}

/* ---------- 데모 (localStorage) ---------- */
function createDemoStore({ onData, onAuth }) {
  const KEY = 'gagyebu-demo-v1';
  let data;
  try {
    data = JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    data = null;
  }
  data = data || { tx: [], assets: [], settings: null };
  data.settings = mergeSettings(data.settings);

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* 저장 공간 없음: 메모리에만 유지 */ }
    onData({ ...data, ready: true });
  };
  const upd = (list, id, patch) => list.map((x) => (x.id === id ? { ...x, ...patch } : x));

  queueMicrotask(() => {
    onAuth({ email: 'demo', name: '데모' });
    onData({ ...data, ready: true });
  });

  return {
    mode: 'demo',
    async signIn() {},
    async signOut() {},
    async addTx(t) { data.tx = [...data.tx, { id: uid(), ...t }]; save(); },
    async updateTx(id, t) { data.tx = upd(data.tx, id, t); save(); },
    async deleteTx(id) { data.tx = data.tx.filter((x) => x.id !== id); save(); },
    async addAsset(a) { data.assets = [...data.assets, { id: uid(), ...a }]; save(); },
    async updateAsset(id, a) { data.assets = upd(data.assets, id, a); save(); },
    async deleteAsset(id) { data.assets = data.assets.filter((x) => x.id !== id); save(); },
    async saveSettings(s) { data.settings = mergeSettings(s); save(); },
    async bulk({ addTx = [], addAssets = [], deleteTx = [], deleteAssets = [], updateTx = [] }) {
      const dt = new Set(deleteTx); const da = new Set(deleteAssets);
      const ut = new Map(updateTx.map((u) => [u.id, u.data]));
      data.tx = data.tx.map((x) => (ut.has(x.id) ? { ...x, ...ut.get(x.id) } : x));
      data.tx = [...data.tx.filter((x) => !dt.has(x.id)), ...addTx.map((t) => ({ id: uid(), ...t }))];
      data.assets = [...data.assets.filter((x) => !da.has(x.id)), ...addAssets.map((a) => ({ id: uid(), ...a }))];
      save();
    },
  };
}
