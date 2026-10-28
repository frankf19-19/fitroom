/**
 * 試穿吧 TryOn — 後端 Worker  v1.5.0
 * 部署到 Cloudflare Workers（建議 Workers Paid 方案：單次請求 CPU 上限 30 秒；免費方案 10ms 處理大圖會逾時）。
 * 所有金鑰、額度、扣點、金流都在這裡，前端只拿結果。
 *
 * 需要設定的變數（Worker → Settings → Variables and Secrets）
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY     Supabase anon key（Text）
 *   SUPABASE_SERVICE_KEY  Supabase service_role key（Secret）
 *   FAL_KEY               fal.ai API Key（Secret）— 上衣/下身/洋裝
 *   GEMINI_KEY            Google AI Studio API Key（Secret）— 鞋/帽/飾品/髮型
 *   GEMINI_IMAGE_MODEL    預設 gemini-nano-banana-2.1（Text，可改）
 *   SITE_URL              https://frankf19-19.github.io/fitroom（Text，允許來源與付款後導回；App 來源自動允許）
 *   FREE_DAILY            每日免費點數，預設 2（Text）
 *   ADMIN_EMAILS          管理者 Email，逗號分隔（Text）
 *   ECPAY_MERCHANT_ID     綠界特店編號（Text）；留空則使用綠界測試環境
 *   ECPAY_HASH_KEY        綠界 HashKey（Secret）
 *   ECPAY_HASH_IV         綠界 HashIV（Secret）
 */

const VERSION = '1.5.0';
const FAL_QUEUE = 'https://queue.fal.run/fal-ai/fashn/tryon/v1.6';
const PACKS = { // 點數包
  p10: { name: '10', credits: 10, price: 99 },
  p30: { name: '30', credits: 30, price: 249 },
  p100: { name: '100', credits: 100, price: 699 }
};
const ECPAY_TEST = { merchant: '3002607', key: 'pwFHCqoQZGmho4w6', iv: 'EkRm7iFT261dpevs', url: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5' };
const ECPAY_PROD_URL = 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5';
const APP_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost', 'ionic://localhost'];
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;     // 單張 data URI 上限（前端已縮到 1280px JPEG，約 300KB）
const UPSTREAM_TIMEOUT_MS = 150000;

const CLOTHING = { top: 'tops', bottom: 'bottoms', dress: 'one-pieces' };
const KEEP = 'Keep everything else in the first photo exactly the same: the person\'s face, identity, skin, pose, body shape, the rest of the outfit, background, camera angle and lighting. Do not crop, do not change the aspect ratio, do not add text or watermarks. Output one photorealistic image of the same size as the first photo.';
const EDIT_PROMPTS = {
  shoes: 'Photo edit task. Replace the shoes the person is wearing in the first photo with the shoes shown in the second image. Match the second image\'s style, color, material and details precisely, fit them naturally to the feet with correct perspective and shadows. ' + KEEP,
  hat: 'Photo edit task. Put the hat from the second image on the person in the first photo. Match the hat\'s style and color exactly, size it correctly to the head, sit it naturally on the hair with realistic shadows. ' + KEEP,
  accessory: 'Photo edit task. Make the person in the first photo wear or carry the accessory shown in the second image (it may be a necklace, earrings, a watch, a bracelet, glasses or a bag). Match its design exactly and place it where that kind of accessory is naturally worn. ' + KEEP,
  hair: 'Photo edit task. Change the hairstyle of the person in the first photo to the hairstyle shown in the second image: same length, cut, texture and hair color. Blend the hairline naturally with the face and keep the lighting consistent. ' + KEEP,
  hair_text: 'Photo edit task. Change the hairstyle of the person in the photo to: {{desc}}. Blend the hairline naturally with the face and keep the lighting consistent. ' + KEEP
};
const GEMINI_FALLBACKS = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const p = url.pathname, m = request.method;
      if (p === '/api/health') return json({ ok: true, version: VERSION }, 200, cors);
      if (p === '/api/me' && m === 'GET') return handleMe(request, env, cors);
      if (p === '/api/tryon' && m === 'POST') return handleTryon(request, env, cors);
      if (p === '/api/checkout' && m === 'POST') return handleCheckout(request, env, cors);
      if (p === '/api/ecpay/notify' && m === 'POST') return handleEcpayNotify(request, env);
      if (p === '/api/ecpay/return') return handleEcpayReturn(request, env);
      if (p === '/api/delete-account' && m === 'POST') return handleDeleteAccount(request, env, cors);
      if (p === '/api/admin/stats' && m === 'GET') return handleAdminStats(request, env, cors);
      if (p === '/api/event' && m === 'POST') return handleEvent(request, env, cors);
      if (p === '/api/error' && m === 'POST') return handleClientError(request, env, cors);
      return json({ error: '找不到此路徑' }, 404, cors);
    } catch (e) {
      return json({ error: '伺服器錯誤：' + (e.message || e) }, 500, cors);
    }
  }
};

/* ---------------- 共用 ---------------- */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.SITE_URL || '').split(',').map(s => { try { return new URL(s.trim()).origin; } catch { return ''; } }).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin) || APP_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function need(env, k) { if (!env[k]) throw new Error('伺服器尚未完成設定（' + k + '）'); return env[k]; }
function siteUrl(env, request) { return (env.SITE_URL || '').split(',')[0].trim() || new URL(request.url).origin; }
async function fetchT(url, opts, label) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) { throw new Error((label || '服務') + (e.name === 'AbortError' ? '逾時，請稍後再試' : '連線失敗')); }
  finally { clearTimeout(t); }
}

async function sb(env, path, opts = {}) {
  const r = await fetch(need(env, 'SUPABASE_URL') + path, {
    ...opts,
    headers: { 'apikey': need(env, 'SUPABASE_SERVICE_KEY'), 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error('資料庫錯誤 ' + r.status + '：' + (d && d.message ? d.message : String(t).slice(0, 160)));
  return d;
}
const sbInsert = (env, table, row) => sb(env, '/rest/v1/' + table, { method: 'POST', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(row) }).then(r => Array.isArray(r) ? r[0] : r);
const sbPatch = (env, path, row, representation = false) => sb(env, path, { method: 'PATCH', headers: representation ? { 'Prefer': 'return=representation' } : {}, body: JSON.stringify(row) });
const rpc = (env, fn, args) => sb(env, '/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });

async function requireUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw Object.assign(new Error('請先登入'), { status: 401 });
  const r = await fetch(need(env, 'SUPABASE_URL') + '/auth/v1/user', { headers: { 'apikey': need(env, 'SUPABASE_ANON_KEY'), 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw Object.assign(new Error('登入已過期，請重新登入'), { status: 401 });
  const u = await r.json();
  if (!u || !u.id) throw Object.assign(new Error('登入無效'), { status: 401 });
  return u;
}
async function optionalUser(request, env) { try { return await requireUser(request, env); } catch { return null; } }
function isAdmin(env, user) { return (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes((user.email || '').toLowerCase()); }

async function getProfile(env, user) {
  let rows = await sb(env, `/rest/v1/profiles?id=eq.${user.id}&select=*`);
  if (!rows.length) {
    rows = await sb(env, '/rest/v1/profiles', {
      method: 'POST', headers: { 'Prefer': 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify({ id: user.id, email: user.email || null })
    });
  }
  return rows[0];
}
function taipeiDayStart() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 8 * 3600 * 1000).toISOString();
}
// 今日已用免費點數（含進行中的，避免同時連按繞過）
async function freeUsedToday(env, userId) {
  const rows = await sb(env, `/rest/v1/generations?user_id=eq.${userId}&status=in.(ok,running)&created_at=gte.${encodeURIComponent(taipeiDayStart())}&select=free_used`);
  return rows.reduce((a, r) => a + (r.free_used || 0), 0);
}

/* ---------------- /api/me ---------------- */
async function handleMe(request, env, cors) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  const p = await getProfile(env, user);
  const freeDaily = Number(env.FREE_DAILY || 2);
  const used = await freeUsedToday(env, user.id);
  const packs = Object.fromEntries(Object.entries(PACKS).map(([k, v]) => [k, { name: v.name + ' 點', credits: v.credits, price: v.price }]));
  return json({ email: user.email, credits: p.credits, free_daily: freeDaily, free_left: Math.max(0, freeDaily - used), packs, is_admin: isAdmin(env, user) }, 200, cors);
}

/* ---------------- /api/tryon ---------------- */
async function handleTryon(request, env, cors) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  let body; try { body = await request.json(); } catch { return json({ error: '資料格式錯誤' }, 400, cors); }
  const { person, items } = body || {};
  const variants = Number(body.variants) === 2 ? 2 : 1;
  if (!isDataImage(person)) return json({ error: '請提供全身照（檔案太大或格式不支援）' }, 400, cors);
  if (!Array.isArray(items) || !items.length || items.length > 7) return json({ error: '請至少選一個要試穿的品項（最多 7 個）' }, 400, cors);
  for (const it of items) {
    if (!['top', 'bottom', 'dress', 'shoes', 'hat', 'accessory', 'hair'].includes(it.type)) return json({ error: '品項類型錯誤' }, 400, cors);
    if (it.type === 'hair' && !isDataImage(it.image) && !(it.text && it.text.trim())) return json({ error: '髮型請上傳參考圖或輸入描述' }, 400, cors);
    if (it.type !== 'hair' && !isDataImage(it.image)) return json({ error: '每個品項都需要圖片' }, 400, cors);
  }
  const types = items.map(i => i.type);

  // 防濫用：進行中的不得超過 1 個；60 秒內最多 3 次
  const recent = await sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=in.(ok,running,failed)&created_at=gte.${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}&select=status`);
  if (recent.some(r => r.status === 'running')) return json({ error: '上一張還在合成中，請稍候' }, 429, cors);
  if (recent.length >= 3) return json({ error: '操作太頻繁，請等一分鐘再試' }, 429, cors);

  // 扣點：每個品項 1 點 × 張數；先用今日免費點數，不足再扣點數
  const cost = items.length * variants;
  const freeDaily = Number(env.FREE_DAILY || 2);
  const profile = await getProfile(env, user);
  const used = await freeUsedToday(env, user.id);
  const freeLeft = Math.max(0, freeDaily - used);
  const useFree = Math.min(freeLeft, cost);
  const payCredits = cost - useFree;
  if (payCredits > profile.credits) {
    return json({ error: `點數不足：這次需要 ${cost} 點（免費額度可抵 ${useFree} 點），你目前有 ${profile.credits} 點。`, need_credits: true }, 402, cors);
  }
  // 先登記進行中（鎖住免費額度與限流），再扣點，失敗再退
  const gen = await sbInsert(env, 'generations', { user_id: user.id, items: types, cost: payCredits, free_used: useFree, status: 'running', variants });
  if (payCredits > 0) {
    const ok = await rpc(env, 'add_credits', { p_user: user.id, p_amount: -payCredits });
    if (ok !== true) { await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'failed', error: '扣點失敗' }); return json({ error: '扣點失敗，請重試' }, 500, cors); }
  }

  const order = ['dress', 'top', 'bottom', 'hair', 'hat', 'accessory', 'shoes'];
  const sorted = [...items].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const runPipeline = async () => {
    let current = person;
    for (const it of sorted) {
      if (CLOTHING[it.type]) current = await fashnTryon(env, current, it.image, CLOTHING[it.type], it.photo_type);
      else current = await geminiEdit(env, current, it, person);
    }
    return current;
  };
  let results;
  try {
    results = await Promise.all(Array.from({ length: variants }, runPipeline));
  } catch (e) {
    if (payCredits > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: payCredits }).catch(() => {});
    await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'failed', error: String(e.message).slice(0, 300), cost: 0, free_used: 0 }).catch(() => {});
    return json({ error: '合成失敗（已退回點數）：' + e.message }, 502, cors);
  }

  // 存結果到 Storage；第一張更新原列，其餘各新增一列（不計免費額度）
  const urls = [];
  for (let i = 0; i < results.length; i++) {
    let u = null;
    try {
      const bin = await dataUriToBytes(results[i]);
      const path = `${user.id}/${Date.now()}-${i}.${bin.ext}`;
      const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/results/${path}`, {
        method: 'POST',
        headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': bin.mime, 'x-upsert': 'true' },
        body: bin.bytes
      });
      if (up.ok) u = `${env.SUPABASE_URL}/storage/v1/object/public/results/${path}`;
    } catch { /* 圖片存檔失敗不影響回傳 */ }
    urls.push(u);
    try {
      if (i === 0) await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'ok', image_url: u });
      else await sbInsert(env, 'generations', { user_id: user.id, items: types, cost: 0, free_used: 0, status: 'ok', image_url: u, variants });
    } catch { /* ignore */ }
  }

  let creditsNow = profile.credits - payCredits;
  try { creditsNow = (await getProfile(env, user)).credits; } catch { /* 用估算值 */ }
  return json({ image: results[0], images: results, image_urls: urls, charged: payCredits, free_used: useFree, credits: creditsNow, free_left: Math.max(0, freeLeft - useFree) }, 200, cors);
}

/* ---- FASHN（queue 模式：送出 → 輪詢 → 取結果） ---- */
async function fashnTryon(env, person, garment, category, photoType) {
  const headers = { 'Authorization': 'Key ' + need(env, 'FAL_KEY'), 'Content-Type': 'application/json' };
  const submit = await fetchT(FAL_QUEUE, {
    method: 'POST', headers,
    body: JSON.stringify({
      model_image: person, garment_image: garment, category,
      mode: 'quality', garment_photo_type: ['flat-lay', 'model'].includes(photoType) ? photoType : 'auto',
      num_samples: 1, output_format: 'png', seed: Math.floor(Math.random() * 1e9)
    })
  }, '衣服試穿服務');
  const st = await submit.text();
  if (!submit.ok) throw new Error('衣服試穿服務：' + extractErr(st));
  const job = JSON.parse(st);
  const statusUrl = job.status_url, responseUrl = job.response_url;
  if (!statusUrl || !responseUrl) throw new Error('衣服試穿服務沒有回應工作編號');
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
  let delay = 1500;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, delay)); delay = Math.min(4000, delay + 500);
    const sr = await fetchT(statusUrl, { headers }, '衣服試穿服務');
    const sd = await sr.json().catch(() => ({}));
    if (sd.status === 'COMPLETED') break;
    if (sd.status === 'FAILED' || sr.status >= 400 && sr.status !== 202) throw new Error('衣服試穿服務：' + (sd.error || sd.detail || '處理失敗'));
  }
  const rr = await fetchT(responseUrl, { headers }, '衣服試穿服務');
  const rt = await rr.text();
  if (!rr.ok) throw new Error('衣服試穿服務：' + extractErr(rt));
  const d = JSON.parse(rt);
  const u = d && d.images && d.images[0] && d.images[0].url;
  if (!u) throw new Error('衣服試穿服務沒有回傳圖片');
  return await urlToDataUri(u);
}
function extractErr(t) { try { const j = JSON.parse(t); return String(j.detail ? JSON.stringify(j.detail) : (j.error || j.message || t)).slice(0, 200); } catch { return String(t).slice(0, 200); } }

/* ---- Gemini 影像編輯（模型備援鏈） ---- */
async function geminiEdit(env, person, item, identityRef) {
  const preferred = env.GEMINI_IMAGE_MODEL || GEMINI_FALLBACKS[0];
  const models = [preferred, ...GEMINI_FALLBACKS.filter(m => m !== preferred)];
  let prompt = (item.type === 'hair' && !isDataImage(item.image)) ? EDIT_PROMPTS.hair_text.replace('{{desc}}', item.text.trim().slice(0, 200)) : EDIT_PROMPTS[item.type];
  const hasRef = isDataImage(item.image), hasId = identityRef && identityRef !== person;
  prompt += hasId ? ` The ${hasRef ? 'third' : 'second'} image is the same person (identity reference): the face, skin tone and body in the output must be identical to this person.` : ' The face and identity of the person must remain exactly identical.';
  const parts = [{ text: prompt }, inlinePart(person)];
  if (hasRef) parts.push(inlinePart(item.image));
  if (hasId) parts.push(inlinePart(identityRef));

  let lastErr = '', d = null;
  for (const model of models) {
    const isGen3 = !model.includes('2.5');
    const cfgs = isGen3 ? [{ responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K' } }, { responseModalities: ['IMAGE'] }] : [{ responseModalities: ['IMAGE'] }];
    let ok = false;
    for (const generationConfig of cfgs) {
      const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': need(env, 'GEMINI_KEY') },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
      }, '配件/髮型服務');
      const t = await r.text();
      if (r.ok) { d = JSON.parse(t); ok = true; break; }
      let m = t; try { m = JSON.parse(t).error.message; } catch {}
      lastErr = String(m).slice(0, 200);
      if (r.status === 404 || /not found|not supported|does not exist/i.test(m)) break;
      if (r.status === 400 && /imageConfig|imageSize|image_size/i.test(m)) continue;
      if (r.status === 429 || r.status >= 500) continue;
      throw new Error('配件/髮型服務：' + lastErr);
    }
    if (ok) break;
  }
  if (!d) throw new Error('配件/髮型服務：' + (lastErr || '所有影像模型都無法使用'));
  const cand = d.candidates && d.candidates[0];
  const img = cand && cand.content && cand.content.parts && cand.content.parts.find(p => p.inlineData);
  if (!img) throw new Error('配件/髮型服務：' + ((cand && cand.finishReason) || (d.promptFeedback && d.promptFeedback.blockReason) || '未回傳圖片'));
  return `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`;
}

/* ---- 圖片工具（避免逐 byte 迴圈） ---- */
function inlinePart(dataUri) { const i = dataUri.indexOf(','); return { inlineData: { mimeType: dataUri.slice(5, dataUri.indexOf(';')), data: dataUri.slice(i + 1) } }; }
function isDataImage(s) {
  if (typeof s !== 'string' || s.length > MAX_IMAGE_CHARS) return false;
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]{16})/i.exec(s.slice(0, 64));
  if (!m) return false;
  const head = atob(m[2]);
  return head.startsWith('\x89PNG') || head.startsWith('\xff\xd8\xff') || head.startsWith('RIFF');
}
async function dataUriToBytes(uri) {
  const mime = uri.slice(5, uri.indexOf(';'));
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const bytes = new Uint8Array(await (await fetch(uri)).arrayBuffer());
  return { mime, ext, bytes };
}
async function urlToDataUri(u) {
  const r = await fetchT(u, {}, '下載結果');
  if (!r.ok) throw new Error('下載結果失敗');
  const mime = (r.headers.get('Content-Type') || 'image/png').split(';')[0];
  const buf = new Uint8Array(await r.arrayBuffer());
  const CH = 0x8000; let s = '';
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return `data:${mime};base64,${btoa(s)}`;
}

/* ---------------- 事件與錯誤回報 ---------------- */
const EVENT_NAMES = new Set(['open', 'login', 'photo', 'item', 'tryon_start', 'tryon_ok', 'tryon_fail', 'share', 'story', 'buy_click', 'paid', 'install']);
async function handleEvent(request, env, cors) {
  let body; try { body = await request.json(); } catch { return json({ ok: false }, 400, cors); }
  const name = String(body.name || ''); if (!EVENT_NAMES.has(name)) return json({ ok: false }, 400, cors);
  const user = await optionalUser(request, env);
  await sb(env, '/rest/v1/events', { method: 'POST', body: JSON.stringify({ user_id: user ? user.id : null, anon_id: String(body.anon_id || '').slice(0, 64) || null, name, props: body.props && typeof body.props === 'object' ? body.props : null, platform: String(body.platform || 'web').slice(0, 20) }) }).catch(() => {});
  return json({ ok: true }, 200, cors);
}
async function handleClientError(request, env, cors) {
  let body; try { body = await request.json(); } catch { return json({ ok: false }, 400, cors); }
  const user = await optionalUser(request, env);
  await sb(env, '/rest/v1/client_errors', { method: 'POST', body: JSON.stringify({ user_id: user ? user.id : null, message: String(body.message || '').slice(0, 500), stack: String(body.stack || '').slice(0, 2000), url: String(body.url || '').slice(0, 300), platform: String(body.platform || 'web').slice(0, 20), app_version: String(body.version || '').slice(0, 20) }) }).catch(() => {});
  return json({ ok: true }, 200, cors);
}

/* ---------------- 管理後台（聚合在資料庫端做，不受 1000 列上限影響） ---------------- */
async function handleAdminStats(request, env, cors) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  if (!isAdmin(env, user)) return json({ error: '沒有權限' }, 403, cors);
  const stats = await rpc(env, 'admin_stats', { p_day_start: taipeiDayStart() });
  return json(stats, 200, cors);
}

/* ---------------- 刪除帳號（含所有資料與圖片；訂單保留作對帳） ---------------- */
async function handleDeleteAccount(request, env, cors) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  for (const bucket of ['results', 'wardrobe']) {
    try {
      const list = await sb(env, `/storage/v1/object/list/${bucket}`, { method: 'POST', body: JSON.stringify({ prefix: user.id + '/', limit: 1000 }) });
      const names = (list || []).map(o => `${user.id}/${o.name}`);
      if (names.length) await sb(env, `/storage/v1/object/${bucket}`, { method: 'DELETE', body: JSON.stringify({ prefixes: names }) });
    } catch { /* 圖片刪不掉不阻擋 */ }
  }
  try { await sbPatch(env, `/rest/v1/orders?user_id=eq.${user.id}`, { user_email: user.email || null }); } catch {}
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY } });
  if (!r.ok) return json({ error: '刪除帳號失敗，請聯絡客服' }, 500, cors);
  return json({ ok: true }, 200, cors);
}

/* ---------------- 綠界金流 ---------------- */
function ecpayCfg(env) {
  if (env.ECPAY_MERCHANT_ID && env.ECPAY_HASH_KEY && env.ECPAY_HASH_IV) return { merchant: env.ECPAY_MERCHANT_ID, key: env.ECPAY_HASH_KEY, iv: env.ECPAY_HASH_IV, url: ECPAY_PROD_URL, test: false };
  return { ...ECPAY_TEST, test: true };
}
async function handleCheckout(request, env, cors) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  let body; try { body = await request.json(); } catch { return json({ error: '資料格式錯誤' }, 400, cors); }
  const pack = PACKS[body.pack];
  if (!pack) return json({ error: '沒有這個點數包' }, 400, cors);
  const cfg = ecpayCfg(env);
  const tradeNo = ('TO' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  await sbInsert(env, 'orders', { trade_no: tradeNo, user_id: user.id, user_email: user.email || null, pack: body.pack, credits: pack.credits, amount: pack.price, status: 'pending' });
  const base = new URL(request.url).origin;
  const params = {
    MerchantID: cfg.merchant, MerchantTradeNo: tradeNo, MerchantTradeDate: ecpayDate(), PaymentType: 'aio',
    TotalAmount: String(pack.price), TradeDesc: 'TryOn credits', ItemName: `試穿吧點數包 ${pack.credits} 點`,
    ReturnURL: base + '/api/ecpay/notify', OrderResultURL: base + '/api/ecpay/return', ClientBackURL: siteUrl(env, request),
    ChoosePayment: 'ALL', EncryptType: '1', CustomField1: user.id
  };
  params.CheckMacValue = await ecpayMac(params, cfg.key, cfg.iv);
  const inputs = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('');
  const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>前往付款</title><body style="font-family:sans-serif;text-align:center;padding:40px">正在前往綠界付款頁…${cfg.test ? '<p style="color:#999">（目前為綠界測試環境，不會真的扣款）</p>' : ''}<form id="f" method="post" action="${cfg.url}">${inputs}</form><script>document.getElementById('f').submit()</script></body></html>`;
  return json({ html, test: cfg.test }, 200, cors);
}
async function handleEcpayNotify(request, env) {
  const form = await request.formData();
  const p = {}; for (const [k, v] of form.entries()) p[k] = v;
  const cfg = ecpayCfg(env);
  const mac = p.CheckMacValue; delete p.CheckMacValue;
  if (mac !== await ecpayMac(p, cfg.key, cfg.iv)) return new Response('0|CheckMacValue Error', { status: 400 });
  if (p.MerchantID !== cfg.merchant) return new Response('0|MerchantID Error', { status: 400 });
  if (p.RtnCode === '1') {
    const rows = await sb(env, `/rest/v1/orders?trade_no=eq.${encodeURIComponent(p.MerchantTradeNo)}&select=*`);
    const o = rows[0];
    if (!o) return new Response('0|Order Not Found', { status: 400 });
    if (String(p.TradeAmt) !== String(o.amount)) return new Response('0|Amount Error', { status: 400 });
    // 只有從 pending 改成 paid 的那一次才加點（防重送/併發）
    const upd = await sbPatch(env, `/rest/v1/orders?trade_no=eq.${encodeURIComponent(p.MerchantTradeNo)}&status=eq.pending`, { status: 'paid', ecpay_trade_no: p.TradeNo || null, paid_at: new Date().toISOString() }, true);
    if (Array.isArray(upd) && upd.length && o.user_id) {
      await rpc(env, 'add_credits', { p_user: o.user_id, p_amount: o.credits });
      await sb(env, '/rest/v1/events', { method: 'POST', body: JSON.stringify({ user_id: o.user_id, name: 'paid', props: { pack: o.pack, amount: o.amount }, platform: 'ecpay' }) }).catch(() => {});
    }
  }
  return new Response('1|OK');
}
async function handleEcpayReturn(request, env) {
  let ok = false;
  try { const form = await request.formData(); ok = form.get('RtnCode') === '1'; } catch {}
  const site = siteUrl(env, request);
  return Response.redirect(site + (site.includes('?') ? '&' : '?') + (ok ? 'paid=1' : 'paid=0') + '#credits', 302);
}
function ecpayDate() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); const z = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${z(d.getUTCMonth() + 1)}/${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
}
async function ecpayMac(params, key, iv) {
  const keys = Object.keys(params).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  let s = 'HashKey=' + key + '&' + keys.map(k => k + '=' + params[k]).join('&') + '&HashIV=' + iv;
  s = dotNetUrlEncode(s).toLowerCase();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function dotNetUrlEncode(s) {
  return encodeURIComponent(s).replace(/%20/g, '+').replace(/%2D/gi, '-').replace(/%5F/gi, '_').replace(/%2E/gi, '.')
    .replace(/%21/gi, '!').replace(/%2A/gi, '*').replace(/%28/gi, '(').replace(/%29/gi, ')').replace(/'/g, '%27').replace(/~/g, '%7e');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
