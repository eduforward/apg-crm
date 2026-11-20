// 아프지마케팅 CRM — 홈페이지(아임웹) 상담신청 수신: POST /lead
// 본문: text/plain JSON {hospital, name, phone, role, source, ts} → Firestore leads/imweb_{전화숫자}_{분단위}
// 배포: Cloud Shell에서 firebase deploy --only functions (Blaze 요금제 필요)
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const ORIGINS = ['https://apgmarketing.kr', 'https://www.apgmarketing.kr'];
const ROLES = ['원장 / 대표원장', '개원 준비중', '병원 내 담당자'];
const CRM_URL = 'https://eduforward.github.io/apg-crm/'; // 슬랙 알림의 바로가기 링크
const RATE = new Map(); // phoneDigits → [timestamps] (인스턴스 메모리, 최소 남용 방지)

// 슬랙 알림: Firestore secrets/slack.webhookUrl 이 있을 때만 전송
async function notifySlack(l) {
  const d = await db.collection('secrets').doc('slack').get();
  const url = d.exists ? String(d.data().webhookUrl || '').trim() : '';
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  const kst = new Date(l.ts.getTime() + 9 * 3600e3), p = n => String(n).padStart(2, '0');
  const when = p(kst.getUTCMonth() + 1) + '/' + p(kst.getUTCDate()) + ' ' + p(kst.getUTCHours()) + ':' + p(kst.getUTCMinutes());
  const text = ':bell: *새 상담신청* — ' + [l.hospital, l.name, l.phone, l.role].filter(Boolean).join(' · ') + ' (' + when + ')' + (CRM_URL ? '\n<' + CRM_URL + '|CRM에서 확인하기>' : '');
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
}

exports.lead = onRequest({ region: 'asia-northeast3', cors: false, maxInstances: 5, invoker: 'public', serviceAccount: 'firebase-adminsdk-fbsvc@apg-crm-e3d36.iam.gserviceaccount.com' }, async (req, res) => {
  const origin = req.get('origin') || '';
  res.set('Access-Control-Allow-Origin', ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const fail = (code, error) => res.status(code).json({ ok: false, error });
  try {
    const raw = typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}));
    if (Buffer.byteLength(raw, 'utf8') > 2048) return fail(400, 'body too large');
    let b; try { b = JSON.parse(raw); } catch (e) { return fail(400, 'invalid json'); }
    const hospital = String(b.hospital || '').trim(), name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim(), phoneDigits = phone.replace(/\D/g, '');
    const role = ROLES.includes(String(b.role || '').trim()) ? String(b.role).trim() : '';
    if (hospital.length < 1 || hospital.length > 60) return fail(400, 'hospital 1~60자');
    if (name.length < 1 || name.length > 30) return fail(400, 'name 1~30자');
    if (phoneDigits.length < 9 || phoneDigits.length > 11) return fail(400, 'phone 9~11자리');
    const now = Date.now(), hits = (RATE.get(phoneDigits) || []).filter(t => now - t < 60000);
    if (hits.length >= 5) return fail(429, 'too many requests');
    hits.push(now); RATE.set(phoneDigits, hits);
    let ts = new Date(String(b.ts || '')); if (isNaN(ts.getTime())) ts = new Date(now);
    const p = n => String(n).padStart(2, '0');
    const minute = ts.getUTCFullYear() + p(ts.getUTCMonth() + 1) + p(ts.getUTCDate()) + p(ts.getUTCHours()) + p(ts.getUTCMinutes());
    const id = 'imweb_' + phoneDigits + '_' + minute; // 같은 번호·같은 분의 중복 접수는 한 건으로 합침
    const ref = db.collection('leads').doc(id);
    let created = false;
    await db.runTransaction(async tx => {
      const cur = await tx.get(ref); created = !cur.exists;
      const doc = { hospital, name, phone, phoneDigits, role, source: String(b.source || 'imweb').trim().slice(0, 20), submittedAt: admin.firestore.Timestamp.fromDate(ts), channel: 'homepage', updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (!cur.exists) Object.assign(doc, { status: 'new', createdAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(ref, doc, { merge: true });
    });
    if (created) await notifySlack({ hospital, name, phone, role, ts }).catch(e => console.error('slack', e.message));
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error(e);
    return fail(500, 'server error');
  }
});
