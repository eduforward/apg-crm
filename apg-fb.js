// 아프지마케팅 CRM 공용: Firebase 연동 (Auth · Firestore)
// 브라우저가 Firestore를 직접 읽고 쓰며, 권한은 firebase/firestore.rules 가 판정합니다.
export const FIREBASE = {
  apiKey: 'AIzaSyCylaw8vGvQUsUk09Dc308yFmuBPWID-uQ',
  authDomain: 'apg-crm-e3d36.firebaseapp.com',
  projectId: 'apg-crm-e3d36',
  storageBucket: 'apg-crm-e3d36.firebasestorage.app',
  messagingSenderId: '605445699906',
  appId: '1:605445699906:web:58b7aa1b25e14500db70db',
};
export const ROOT_ADMINS = ['ceo@eduforward.kr'];
const FBV = '10.14.1', FBU = 'https://www.gstatic.com/firebasejs/' + FBV + '/';

let _app, _auth, _db, _mods, _user = null, _ready, _me = null;

export function init() {
  if (_ready) return _ready;
  _ready = (async () => {
    const [app, auth, fs] = await Promise.all([import(FBU + 'firebase-app.js'), import(FBU + 'firebase-auth.js'), import(FBU + 'firebase-firestore.js')]);
    _mods = { auth, fs };
    _app = app.getApps().length ? app.getApp() : app.initializeApp(FIREBASE);
    _auth = auth.getAuth(_app); _db = fs.getFirestore(_app);
    await auth.setPersistence(_auth, auth.browserLocalPersistence).catch(() => {});
    _user = await new Promise(res => { const off = auth.onAuthStateChanged(_auth, u => { off(); res(u); }); });
    auth.onAuthStateChanged(_auth, u => { _user = u; if (!u) _me = null; });
    return true;
  })();
  return _ready;
}

export function isSignedIn() { return !!_user; }
export function userEmail() { return _user ? String(_user.email || '').toLowerCase() : ''; }
export async function signIn() {
  await init(); const { auth } = _mods;
  const p = new auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  const r = await auth.signInWithPopup(_auth, p); _user = r.user; _me = null;
  return { email: userEmail() };
}
export async function signOut() { await init(); await _mods.auth.signOut(_auth); _user = null; _me = null; }
function need() { if (!_user) throw new Error('로그인이 필요해요.'); }

// 내 정보: { email, role, name, admin }. 등록되지 않은 계정은 role 이 '' 입니다.
export async function me(force) {
  if (_me && !force) return _me;
  await init(); need(); const { fs } = _mods; const email = userEmail();
  let role = '', name = _user.displayName || '';
  if (ROOT_ADMINS.includes(email)) role = 'super';
  try {
    const d = await fs.getDoc(fs.doc(_db, 'users', email));
    if (d.exists()) { if (!role) role = d.data().role || 'member'; name = d.data().name || name; }
  } catch (e) { /* 미등록 계정은 규칙에서 읽기가 거부됩니다 */ }
  _me = { email, role, name, admin: role === 'admin' || role === 'super' };
  return _me;
}

// ── 홈페이지 상담신청 (Firestore: leads/{id}, Cloud Function이 기록) ──
// 진행 상태: new(신규 접수) · away(부재중) · meet(상담 예정) · won(계약) · closed(종료). call·hold 는 예전 상태로, 읽기만 합니다.
export const LEAD_STATUS = ['new', 'away', 'meet', 'won', 'closed', 'call', 'hold'];
const toDate = t => t && typeof t.toDate === 'function' ? t.toDate() : (t ? new Date(t) : null);
export async function listLeads() {
  await init(); need(); const { fs } = _mods;
  const s = await fs.getDocs(fs.query(fs.collection(_db, 'leads'), fs.orderBy('submittedAt', 'desc'), fs.limit(500)));
  return s.docs.map(d => {
    const x = d.data();
    return {
      id: d.id, hosp: String(x.hospital || ''), name: String(x.name || ''), tel: String(x.phone || x.phoneDigits || ''),
      role: String(x.role || ''), status: LEAD_STATUS.includes(x.status) ? x.status : 'new',
      at: toDate(x.submittedAt) || toDate(x.createdAt) || new Date(0),
      memo: String(x.memo || ''), statusAt: toDate(x.statusAt), statusBy: String(x.statusBy || ''),
    };
  });
}
// 진행 상태·메모 저장 + 고객 히스토리(leads/{id}/history)에 기록 한 줄.
// 접수 건은 규칙이 허용하는 항목(status · memo · statusAt · statusBy)만 고칩니다. memo 에는 가장 최근에 적은 메모가 남습니다.
// 돌려주는 값 { logged }: 기록까지 남았으면 true. 기록 규칙이 아직 배포되지 않았으면 상태만 저장하고 false.
export async function updateLead(id, { status, memo, from }) {
  await init(); need(); const { fs } = _mods;
  if (!LEAD_STATUS.includes(status)) throw new Error('알 수 없는 진행 상태입니다.');
  const m = String(memo || '').trim().slice(0, 1000), ref = fs.doc(_db, 'leads', String(id));
  const patch = { status, statusAt: fs.serverTimestamp(), statusBy: userEmail() };
  if (m) patch.memo = m;
  const entry = { from: String(from || ''), to: status, memo: m, by: userEmail(), byName: (_me && _me.name) || '', at: fs.serverTimestamp() };
  try {
    const b = fs.writeBatch(_db);
    b.update(ref, patch); b.set(fs.doc(fs.collection(ref, 'history')), entry);
    await b.commit();
    return { logged: true };
  } catch (e) {
    if (e.code !== 'permission-denied') throw e;
    await fs.updateDoc(ref, patch);
    return { logged: false };
  }
}
// 고객 히스토리: 최신순. { from, to, memo, by, byName, at }
export async function listLeadHistory(id) {
  await init(); need(); const { fs } = _mods;
  const s = await fs.getDocs(fs.query(fs.collection(_db, 'leads', String(id), 'history'), fs.orderBy('at', 'desc'), fs.limit(100)));
  return s.docs.map(d => {
    const x = d.data();
    return { id: d.id, from: String(x.from || ''), to: String(x.to || ''), memo: String(x.memo || ''), by: String(x.by || ''), byName: String(x.byName || ''), at: toDate(x.at) };
  });
}

// 고객(접수 건) 삭제: 관리자만. 히스토리까지 한 묶음으로 지웁니다. 되돌릴 수 없습니다.
// 돌려주는 값 { historyDeleted }: 히스토리 삭제 규칙이 아직 배포되지 않았으면 접수 건만 지우고 false.
export async function deleteLead(id) {
  await init(); need(); const { fs } = _mods;
  const ref = fs.doc(_db, 'leads', String(id));
  const hs = await fs.getDocs(fs.query(fs.collection(ref, 'history'), fs.limit(400)));
  try {
    const b = fs.writeBatch(_db);
    hs.docs.forEach(d => b.delete(d.ref)); b.delete(ref);
    await b.commit();
    return { historyDeleted: true };
  } catch (e) {
    if (e.code !== 'permission-denied' || !hs.docs.length) throw e;
    await fs.deleteDoc(ref);
    return { historyDeleted: false };
  }
}

// ── 팀원(계정) 관리 (Firestore: users/{소문자 이메일}) ──
// 역할: super(최고관리자) · admin(관리자) · scheduler(일정 담당자) · member(구성원). 추가·제거 권한은 firestore.rules 가 판정합니다.
export const TEAM_ROLES = ['super', 'admin', 'scheduler', 'member'];
export async function listUsers() {
  await init(); need(); const { fs } = _mods;
  const s = await fs.getDocs(fs.collection(_db, 'users'));
  const list = s.docs.map(d => {
    const x = d.data();
    return {
      email: d.id, name: String(x.name || ''), addedAt: toDate(x.addedAt), addedBy: String(x.addedBy || ''),
      role: ROOT_ADMINS.includes(d.id) ? 'super' : (TEAM_ROLES.includes(x.role) ? x.role : 'member'),
    };
  });
  ROOT_ADMINS.forEach(e => { if (!list.some(u => u.email === e)) list.push({ email: e, name: '', addedAt: null, addedBy: '', role: 'super' }); });
  return list;
}
export async function addUser({ email, name, role }) {
  await init(); need(); const { fs } = _mods;
  const id = String(email || '').trim().toLowerCase(), ref = fs.doc(_db, 'users', id);
  if ((await fs.getDoc(ref)).exists()) { const e = new Error('이미 등록된 이메일입니다.'); e.code = 'already-exists'; throw e; }
  await fs.setDoc(ref, { email: id, name: String(name || '').trim(), role, addedBy: userEmail(), addedAt: fs.serverTimestamp() });
}
export async function removeUser(email) {
  await init(); need(); const { fs } = _mods;
  await fs.deleteDoc(fs.doc(_db, 'users', String(email || '').trim().toLowerCase()));
}
