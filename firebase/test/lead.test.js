// 상담신청 수신 함수(firebase/functions/index.js) 점검. 실제 Firebase·슬랙에 연결하지 않습니다.
// 실행: node --test firebase/test/lead.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// firebase-functions · firebase-admin 대역
const store = new Map(); // 'leads/…' · 'secrets/slack' → data
let slackCalls = [];
const snap = key => ({ exists: store.has(key), data: () => store.get(key) });
const docRef = key => ({ key, get: async () => snap(key) });
const fakeDb = {
  collection: c => ({ doc: id => docRef(c + '/' + id) }),
  runTransaction: async fn => fn({
    get: async ref => snap(ref.key),
    set: (ref, data, opt) => store.set(ref.key, opt && opt.merge ? { ...(store.get(ref.key) || {}), ...data } : data),
  }),
};
const fakeAdmin = { initializeApp() {}, firestore: Object.assign(() => fakeDb, { Timestamp: { fromDate: d => ({ toDate: () => d }) }, FieldValue: { serverTimestamp: () => '__now__' } }) };
let options = null;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'firebase-admin') return fakeAdmin;
  if (request === 'firebase-functions/v2/https') return { onRequest: (opts, fn) => { options = opts; return fn; } };
  return origLoad.call(this, request, ...rest);
};
const realFetch = global.fetch;
global.fetch = async (url, init) => { slackCalls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
const { lead } = require(path.join(__dirname, '..', 'functions', 'index.js'));
test.after(() => { Module._load = origLoad; global.fetch = realFetch; });

const HOOK = 'https://hooks.slack.com/services/T0000/B0000/testtesttest';
let seq = 0;
function reset({ hook = true } = {}) { store.clear(); slackCalls = []; if (hook) store.set('secrets/slack', { webhookUrl: HOOK }); }
async function post(body, { method = 'POST', origin = 'https://apgmarketing.kr', raw } = {}) {
  const res = { code: 0, headers: {}, body: null, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, send(o) { this.body = o; return this; } };
  await lead({ method, get: h => (h.toLowerCase() === 'origin' ? origin : ''), body: raw != null ? raw : JSON.stringify(body) }, res);
  return res;
}
// 번호를 매번 다르게 해서 인스턴스 메모리의 횟수 제한에 걸리지 않게 합니다.
const base = (extra = {}) => ({ hospital: '점검의원', name: '홍길동', phone: '010-1234-' + String(1000 + (seq++)), role: '원장 / 대표원장', source: 'imweb', ts: '2026-11-25T10:30:00.000Z', ...extra });
const onlyLead = () => { const k = [...store.keys()].filter(x => x.startsWith('leads/')); assert.equal(k.length, 1); return store.get(k[0]); };

test('설정값은 그대로: 서울 리전, 공개 호출, 지정 서비스 계정', () => {
  assert.equal(options.region, 'asia-northeast3');
  assert.equal(options.invoker, 'public');
  assert.equal(options.serviceAccount, 'firebase-adminsdk-fbsvc@apg-crm-e3d36.iam.gserviceaccount.com');
});

test('UTM 이 있으면 접수 건에 저장하고 슬랙 알림에 함께 보낸다', async () => {
  reset();
  const b = base({ utm: { source: 'meta', medium: 'paid', campaign: '병원블로그_11월', content: '릴스A', term: '병원 블로그 대행' } });
  const res = await post(b);
  assert.equal(res.code, 200); assert.equal(res.body.ok, true);
  const d = onlyLead();
  assert.deepEqual(d.utm, { source: 'meta', medium: 'paid', campaign: '병원블로그_11월', content: '릴스A', term: '병원 블로그 대행' });
  assert.equal(d.status, 'new'); assert.equal(d.hospital, '점검의원'); assert.equal(d.channel, 'homepage');
  assert.equal(slackCalls.length, 1); assert.equal(slackCalls[0].url, HOOK);
  const t = slackCalls[0].body.text;
  assert.match(t, /\*새 상담신청\* — 점검의원 · 홍길동 · 010-1234-\d{4} · 원장 \/ 대표원장 \(11\/25 19:30\)/);
  assert.ok(t.includes('\n유입(UTM): 소스 meta · 매체 paid · 캠페인 병원블로그_11월 · 콘텐츠 릴스A · 키워드 병원 블로그 대행\n'), t);
  assert.ok(t.endsWith('|CRM에서 확인하기>'), t);
});

test('utm_source 처럼 펼친 이름으로 와도 받는다. 일부만 있어도 된다', async () => {
  reset();
  await post(base({ utm_source: 'naver', utm_medium: 'blog' }));
  assert.deepEqual(onlyLead().utm, { source: 'naver', medium: 'blog' });
  assert.ok(slackCalls[0].body.text.includes('\n유입(UTM): 소스 naver · 매체 blog\n'));
});

test('UTM 이 없으면 항목을 만들지 않고, 알림에는 "없음"으로 적는다', async () => {
  reset();
  for (const extra of [{}, { utm: {} }, { utm: null }, { utm: 'meta' }, { utm: ['meta'] }, { utm: { source: '   ' } }]) {
    reset();
    const res = await post(base(extra));
    assert.equal(res.code, 200, JSON.stringify(extra));
    assert.equal('utm' in onlyLead(), false, JSON.stringify(extra));
    assert.ok(slackCalls[0].body.text.includes('\n유입(UTM): 없음\n'), JSON.stringify(extra));
  }
});

test('UTM: 모르는 항목은 버리고, 값은 100자까지, 줄바꿈·제어문자는 지운다, 글자·숫자만 받는다', async () => {
  reset();
  await post(base({ utm: { source: 'a'.repeat(300), medium: 'pa\nid\u0000', campaign: 12345, content: { x: 1 }, term: true, id: 'zzz', extra: 'nope' } }));
  const u = onlyLead().utm;
  assert.deepEqual(Object.keys(u).sort(), ['campaign', 'medium', 'source']);
  assert.equal(u.source.length, 100); assert.equal(u.medium, 'pa id'); assert.equal(u.campaign, '12345');
});

test('슬랙 문법은 풀어서 보낸다(멘션·링크 주입 방지)', async () => {
  reset();
  await post(base({ hospital: '<!channel> 의원', name: '<@U1>&', utm: { source: '<https://x.example|클릭>' } }));
  const t = slackCalls[0].body.text;
  assert.ok(!t.includes('<!channel>') && !t.includes('<@U1>') && !t.includes('<https://x.example'), t);
  assert.ok(t.includes('&lt;!channel&gt; 의원 · &lt;@U1&gt;&amp;') && t.includes('소스 &lt;https://x.example|클릭&gt;'), t);
  assert.equal(onlyLead().hospital, '<!channel> 의원'); // 저장은 원문 그대로
});

test('같은 번호·같은 분의 재접수는 한 건으로 합치고 알림은 한 번만. 먼저 온 UTM 은 지워지지 않는다', async () => {
  reset();
  const b = base({ utm: { source: 'meta' } });
  await post(b);
  await post({ ...b, utm: undefined, name: '홍길동2' });
  const d = onlyLead();
  assert.equal(slackCalls.length, 1); assert.equal(d.name, '홍길동2'); assert.deepEqual(d.utm, { source: 'meta' }); assert.equal(d.status, 'new');
});

test('이미 진행 중인 건의 상태는 재접수로 되돌아가지 않는다', async () => {
  reset();
  const b = base();
  await post(b);
  const key = [...store.keys()].find(x => x.startsWith('leads/'));
  store.set(key, { ...store.get(key), status: 'away', memo: '부재' });
  await post(b);
  assert.equal(store.get(key).status, 'away'); assert.equal(store.get(key).memo, '부재');
});

test('웹훅이 없거나 슬랙 주소가 아니면 알림 없이 접수만 한다', async () => {
  reset({ hook: false });
  assert.equal((await post(base())).code, 200); assert.equal(slackCalls.length, 0);
  reset({ hook: false }); store.set('secrets/slack', { webhookUrl: 'https://example.com/hook' });
  assert.equal((await post(base())).code, 200); assert.equal(slackCalls.length, 0);
});

test('슬랙 전송이 실패해도 접수는 성공으로 답한다', async () => {
  reset();
  const f = global.fetch; global.fetch = async () => { throw new Error('slack down'); };
  const err = console.error; console.error = () => {};
  try { const res = await post(base()); assert.equal(res.code, 200); assert.equal(onlyLead().status, 'new'); }
  finally { global.fetch = f; console.error = err; }
});

test('기존 검사는 그대로: 필수값, 방식, 크기, 허용 주소', async () => {
  reset();
  assert.equal((await post(base({ hospital: '' }))).code, 400);
  assert.equal((await post(base({ name: '' }))).code, 400);
  assert.equal((await post(base({ phone: '123' }))).code, 400);
  assert.equal((await post(null, { raw: '{not json' })).code, 400);
  assert.equal((await post(null, { raw: 'null' })).code, 400);
  assert.equal((await post(base({ utm: { source: '가'.repeat(2000) } }))).code, 400); // 4096바이트 초과
  assert.equal((await post(base(), { method: 'GET' })).code, 405);
  const o = await post(base(), { method: 'OPTIONS' }); assert.equal(o.code, 200);
  assert.equal((await post(base(), { origin: 'https://evil.example' })).headers['Access-Control-Allow-Origin'], 'https://apgmarketing.kr');
  assert.equal((await post(base(), { origin: 'https://www.apgmarketing.kr' })).headers['Access-Control-Allow-Origin'], 'https://www.apgmarketing.kr');
  assert.equal([...store.keys()].filter(x => x.startsWith('leads/')).length, 2); // 정상 요청 2건만 저장
});

test('직함이 목록에 없으면 빈 값으로 저장', async () => {
  reset();
  await post(base({ role: '기타' }));
  assert.equal(onlyLead().role, '');
});
