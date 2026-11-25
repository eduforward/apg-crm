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
export const LEAD_STATUS = ['new', 'call', 'meet', 'won', 'hold'];
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
    };
  });
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
