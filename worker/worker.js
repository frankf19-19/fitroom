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

const VERSION = '2.3.0';
const RUNNING_STALE_MS = 3 * 60 * 1000;    // 進行中超過 3 分鐘沒有進度視為失敗並退點
const TRYON_BUDGET_MS = 8 * 60 * 1000;      // 單次合成整體上限
const FAL_QUEUE = 'https://queue.fal.run/fal-ai/fashn/tryon/v1.6';
// 整套換裝引擎（一次把所有單品穿上；可改變版型，如短褲→寬褲）。依序備援
const OUTFIT_ENGINES = ['https://queue.fal.run/fal-ai/nano-banana-pro/edit', 'https://queue.fal.run/fal-ai/nano-banana-2/edit'];
const ITEM_LABEL = { top: 'TOP or OUTERWEAR (upper body garment)', bottom: 'BOTTOM (trousers / skirt / shorts)', dress: 'ONE-PIECE (dress / jumpsuit)', shoes: 'SHOES', hat: 'HAT', accessory: 'ACCESSORY (bag / jewelry / glasses / watch)', hair: 'HAIRSTYLE reference' };
function outfitPrompt(steps, hints, faceHint) {
  const lines = []; let k = 2;
  const refs = steps.map(st => { if (st.image_url) { const n = k++; lines.push(`Image ${n} is a product photo of the ${ITEM_LABEL[st.type]} to put on the customer.`); return n; } return null; });
  const hairText = steps.find(st => st.type === 'hair' && !st.image_url && st.text);
  const types = new Set(steps.map(s => s.type));
  return [
    'Virtual try-on photo edit for a fashion e-commerce app.',
    'Image 1 is the customer photo. ' + lines.join(' '),
    hairText ? `Also change the customer's hairstyle to: ${hairText.text}.` : '',
    'Produce a photo of the SAME customer from Image 1 now wearing exactly these products.',
    'GARMENT FIDELITY IS THE TOP PRIORITY. Copy each product exactly as it appears in its product photo:',
    '- identical silhouette, cut and proportions (wide or balloon-leg trousers must stay wide/balloon-shaped, oversized stays oversized, cropped stays cropped), the same length relative to the body, rise and fit;',
    '- identical color, fabric, texture, quilting and stitching, pattern, prints, logos, buttons, zippers, pockets, collar/hood and hem details;',
    '- worn the same way as in the product photo (jacket open or closed, sleeves, tucked or untucked). A hood stays DOWN behind the neck unless it is worn up in the product photo. Do not add hats, scarves or extra layers that were not provided.',
    'From each product photo use ONLY that product. Ignore the model wearing it, any other clothes they wear, the background and any text overlays.',
    types.has('top') ? 'If the top is outerwear shown open over another garment, the customer keeps their own top underneath.' : '',
    "Fully replace the customer's current clothing in the provided categories (for example shorts become full-length trousers when the product is trousers). Keep the customer's clothing in categories that were not provided unchanged.",
    'IDENTITY AND SCENE MUST NOT CHANGE: same face, facial expression, ' + (types.has('hair') ? '' : 'hairstyle, ') + 'skin tone, body shape and proportions, pose, hands and anything held in the hands (for example a phone), background, mirror, lighting, camera angle and framing.',
    'Realistic fit and drape on this body with natural folds and shadows. Photorealistic. No text, no watermark. Keep the same aspect ratio and framing as Image 1.',
    hints ? 'Body notes: ' + hints : '', types.has('hair') && faceHint ? faceHint : ''
  ].filter(Boolean).join('\n');
}
const ASPECTS = ['1:1', '4:5', '3:4', '2:3', '9:16', '5:4', '4:3', '3:2', '16:9'];
async function outfitSubmit(env, engineIdx, imageUrls, prompt, hi = true, aspect = 'auto') {
  const headers = { 'Authorization': 'Key ' + need(env, 'FAL_KEY'), 'Content-Type': 'application/json' };
  const body = { prompt, image_urls: imageUrls, num_images: 1, aspect_ratio: ASPECTS.includes(aspect) ? aspect : 'auto', output_format: 'png' };
  if (hi) body.resolution = '2K';
  const r = await fetchT(OUTFIT_ENGINES[engineIdx], { method: 'POST', headers, body: JSON.stringify(body) }, '換裝服務', 30000);
  const t = await r.text();
  if (!r.ok) { if (hi && r.status === 422 && /resolution/i.test(t)) return outfitSubmit(env, engineIdx, imageUrls, prompt, false, aspect); throw new Error('換裝服務：' + extractErr(t)); }
  const j = JSON.parse(t);
  if (!j.status_url || !j.response_url) throw new Error('換裝服務沒有回應工作編號');
  return { status_url: j.status_url, response_url: j.response_url, at: Date.now() };
}
const VIEW_FAL_PROMPTS = {
  side: 'Generate a new photo of the exact same person wearing the exact same outfit as in this photo, photographed from the side (a 90-degree profile view, the person has turned sideways). Same background, lighting, camera distance and framing, full body visible. Keep identity, body shape, hairstyle, skin and every garment detail (color, silhouette, length, fit) perfectly consistent. Photorealistic, no text.',
  back: 'Generate a new photo of the exact same person wearing the exact same outfit as in this photo, photographed from behind (full back view, the person has turned around 180 degrees, face not visible). Same background, lighting, camera distance and framing, full body visible. Keep body shape, hairstyle, skin and every garment detail (color, silhouette, length, fit) perfectly consistent. Photorealistic, no text.'
};
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
const TEXT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const GEMINI_FALLBACKS = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'];
const VIEW_PROMPTS = {
  side: 'Generate a new photo of the exact same person wearing the exact same outfit as in this photo, but photographed from the left side (a full 90-degree profile view, the person has turned sideways). Same background, lighting, camera distance and framing, full body visible. Keep identity, body shape, hairstyle, skin and every garment detail (color, pattern, length, fit) perfectly consistent. Photorealistic, no text.',
  back: 'Generate a new photo of the exact same person wearing the exact same outfit as in this photo, but photographed from behind (a full back view, the person has turned around 180 degrees, face not visible). Same background, lighting, camera distance and framing, full body visible. Keep body shape, hairstyle, skin and every garment detail (color, pattern, length, fit) perfectly consistent. Photorealistic, no text.'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const p = url.pathname, m = request.method;
      if (p === '/api/health') return json({ ok: true, version: VERSION }, 200, cors);
      if (p === '/api/me' && m === 'GET') return handleMe(request, env, cors);
      if (p === '/api/tryon' && m === 'POST') return handleTryon(request, env, cors, ctx);
      if (p === '/api/tryon/status' && m === 'GET') return handleTryonStatus(request, env, cors, url);
      if (p === '/api/outfit' && m === 'POST') return handleOutfit(request, env, cors);
      if (p === '/api/analyze' && m === 'POST') return handleAnalyze(request, env, cors, ctx);
      if (p === '/api/products' && m === 'GET') return handleProducts(request, env, cors, url);
      if (p === '/api/img' && m === 'GET') return handleImgProxy(request, env, cors, url);
      if (p === '/api/product-click' && m === 'POST') return handleProductClick(request, env, cors);
      if (p === '/api/admin/products/import' && m === 'POST') return handleProductImport(request, env, cors);
      if (p === '/api/admin/products' && m === 'POST') return handleProductUpsert(request, env, cors);
      if (p === '/api/admin/products' && m === 'DELETE') return handleProductDelete(request, env, cors, url);
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
  const ok = (allowed.length > 0 && allowed.includes(origin)) || APP_ORIGINS.includes(origin);
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin } : {}),
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
async function fetchT(url, opts, label, maxMs) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), Math.max(1000, Math.min(UPSTREAM_TIMEOUT_MS, maxMs || UPSTREAM_TIMEOUT_MS)));
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
  return json({ email: user.email, credits: p.credits, free_daily: freeDaily, free_left: Math.max(0, freeDaily - used), packs, is_admin: isAdmin(env, user), views_available: !!env.GEMINI_KEY, analyze_available: !!env.GEMINI_KEY, body: p.body || null, analysis: p.analysis || null, free_daily_reset: '00:00 Asia/Taipei' }, 200, cors);
}

/* ---------------- /api/analyze：身形與臉型分析（免費，不扣點；每天最多 5 次） ---------------- */
const ANALYZE_PROMPT = `You are a professional fashion stylist and body-shape consultant. Analyze the full-body photo together with the measurements provided. Output ONLY a JSON object (no markdown) with these keys:
{
 "body_shape": one of ["hourglass","pear","inverted_triangle","rectangle","apple","athletic"],
 "shoulder": "narrow|average|broad",
 "torso": "short|average|long",
 "legs": "short|average|long",
 "proportion_note": "one short sentence in Traditional Chinese about shoulder/waist/hip proportion seen in the photo",
 "face_shape": one of ["oval","round","square","heart","long","diamond"],
 "skin_tone": "cool|neutral|warm",
 "current_hair": "short|medium|long",
 "hair_texture": "straight|wavy|curly",
 "fit_advice": {"tops": "...", "bottoms": "...", "dresses": "...", "colors": "...", "hair": "..."}  (each a concise Traditional Chinese sentence tailored to this person),
 "avoid": "one Traditional Chinese sentence on what to avoid",
 "estimated": {"bust": int, "waist": int, "hip": int, "shoulder": int}  (your best estimate of this person's body circumferences in cm from the photo, height and weight; if a measurement was provided, echo it),
 "render_hints": "one English sentence for an image model describing this person's real body proportions and how garments should drape on them (e.g. 'broad shoulders, defined waist, long legs; fitted tops sit close at the waist, trousers fall long')"
}
Be specific and honest but kind. Base body_shape on both the photo and the numbers. Never mention weight loss. Do not include any text outside the JSON.`;
async function handleAnalyze(request, env, cors, ctx) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  if (!env.GEMINI_KEY) return json({ error: '身形分析服務尚未啟用' }, 503, cors);
  let body; try { body = await request.json(); } catch { return json({ error: '資料格式錯誤' }, 400, cors); }
  const { person } = body || {}; const b = body.body || {};
  if (!isDataImage(person)) return json({ error: '請提供全身照' }, 400, cors);
  const h = Number(b.height), w = Number(b.weight);
  if (!(h >= 120 && h <= 220) || !(w >= 30 && w <= 200)) return json({ error: '請填寫身高（120–220 cm）與體重（30–200 kg）' }, 400, cors);
  // 每日 5 次
  const cnt = await sb(env, `/rest/v1/events?user_id=eq.${user.id}&name=eq.analyze&created_at=gte.${encodeURIComponent(taipeiDayStart())}&select=id`);
  if (cnt.length >= 5) return json({ error: '今天的分析次數已用完（每天 5 次），明天再試' }, 429, cors);
  const bmi = w / Math.pow(h / 100, 2);
  const meas = `Measurements: height ${h} cm, weight ${w} kg (BMI ${bmi.toFixed(1)})` + (b.bust ? `, bust ${b.bust} cm` : '') + (b.waist ? `, waist ${b.waist} cm` : '') + (b.hip ? `, hip ${b.hip} cm` : '') + (b.gender ? `, gender ${b.gender === 'm' ? 'male' : 'female'}` : '') + '.';
  const asyncMode = body.async === true && ctx && typeof ctx.waitUntil === 'function';
  const startedAt = new Date().toISOString();
  const job = async () => {
    const parts = [{ text: ANALYZE_PROMPT + '\n' + meas }, inlinePart(person)];
    const models = TEXT_MODELS;
    let out = null, lastErr = '';
    for (const model of models) {
      const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }) }, '身形分析服務', 45000);
      const t = await r.text();
      if (r.ok) { try { const d = JSON.parse(t); const txt = d.candidates[0].content.parts.map(p => p.text || '').join(''); out = JSON.parse(txt.replace(/^```json|```$/g, '').trim()); break; } catch (e) { lastErr = '回傳格式異常'; continue; } }
      let em; try { em = JSON.parse(t).error.message.slice(0, 160); } catch { em = t.slice(0, 160); }
      if (r.status === 429) lastErr = '文字模型額度已用完（' + model + '），請稍後再試或綁定 Google AI 帳單'; else if (r.status !== 404) lastErr = em; else if (!lastErr) lastErr = em;
      if (r.status === 404 || r.status === 429 || r.status >= 500) continue; break;
    }
    if (!out) { const err = new Error('身形分析失敗：' + lastErr); err.status = 502; throw err; }
    out.bmi = Number(bmi.toFixed(1)); const est = out.estimated || {}; const n = v => (Number(v) > 30 && Number(v) < 200) ? Math.round(Number(v)) : null;
    out.measured = { height: h, weight: w, bust: b.bust || null, waist: b.waist || null, hip: b.hip || null, gender: b.gender || null,
      est_bust: n(est.bust), est_waist: n(est.waist), est_hip: n(est.hip), est_shoulder: n(est.shoulder) }; out.analyzed_at = new Date().toISOString();
    await sbPatch(env, `/rest/v1/profiles?id=eq.${user.id}`, { body: out.measured, analysis: out, analysis_at: out.analyzed_at }).catch(() => {});
    await sb(env, '/rest/v1/events', { method: 'POST', body: JSON.stringify({ user_id: user.id, name: 'analyze', platform: String(body.platform || 'web').slice(0, 20) }) }).catch(() => {});
    return out;
  };
  if (asyncMode) {
    ctx.waitUntil(job().catch(async e => { await sbPatch(env, `/rest/v1/profiles?id=eq.${user.id}`, { analysis: { error: String(e.message).slice(0, 200), analyzed_at: new Date().toISOString() } }).catch(() => {}); }));
    return json({ async: true, started_at: startedAt }, 202, cors);
  }
  try { return json({ analysis: await job() }, 200, cors); }
  catch (e) { return json({ error: e.message }, e.status || 502, cors); }
}

/* ---------------- /api/tryon ---------------- */
async function handleTryon(request, env, cors, ctx) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  let body; try { body = await request.json(); } catch { return json({ error: '資料格式錯誤' }, 400, cors); }
  const { person, items } = body || {};
  const variants = Number(body.variants) === 2 ? 2 : 1;
  const wantViews = body.views === true && !!env.GEMINI_KEY;
  const asyncMode = false;
  const stepMode = body.async === true;
  const started = Date.now();
  const left = () => TRYON_BUDGET_MS - (Date.now() - started);
  if (!isDataImage(person)) return json({ error: '請提供全身照（檔案太大或格式不支援）' }, 400, cors);
  if (!Array.isArray(items) || !items.length || items.length > 7) return json({ error: '請至少選一個要試穿的品項（最多 7 個）' }, 400, cors);
  for (const it of items) {
    if (!['top', 'bottom', 'dress', 'shoes', 'hat', 'accessory', 'hair'].includes(it.type)) return json({ error: '品項類型錯誤' }, 400, cors);
    if (it.type === 'hair' && !isDataImage(it.image) && !(it.text && it.text.trim())) return json({ error: '髮型請上傳參考圖或輸入描述' }, 400, cors);
    if (it.type !== 'hair' && !isDataImage(it.image)) return json({ error: '每個品項都需要圖片' }, 400, cors);
  }
  const types = items.map(i => i.type);

  // 清理卡住的「進行中」（Worker 中途被終止時）：標記失敗並退點
  try {
    const cut = encodeURIComponent(new Date(Date.now() - RUNNING_STALE_MS).toISOString());
    const mark = { method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify({ status: 'failed', error: '逾時（系統自動標記）' }) };
    const s1 = await sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=eq.running&job=is.null&created_at=lt.${cut}`, mark).catch(() => []);
    const s2 = await sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=eq.running&job->>touched=lt.${cut}`, mark).catch(() => []);
    const stale = [...(Array.isArray(s1) ? s1 : []), ...(Array.isArray(s2) ? s2 : [])];
    for (const g of (Array.isArray(stale) ? stale : [])) {
      if (g.cost > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: g.cost }).catch(() => {});
      await sbPatch(env, `/rest/v1/generations?id=eq.${g.id}`, { cost: 0, free_used: 0 }).catch(() => {});
    }
  } catch { /* ignore */ }
  // 防濫用：60 秒內最多 3 次正式合成（進行中由資料庫唯一索引鎖住）
  const recent = await sb(env, `/rest/v1/generations?user_id=eq.${user.id}&or=(status.eq.running,cost.gt.0,free_used.gt.0)&created_at=gte.${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}&select=status`);
  if (recent.length >= 3) return json({ error: '操作太頻繁，請等一分鐘再試' }, 429, cors);

  // 扣點：每個品項 1 點 × 張數；先用今日免費點數，不足再扣點數
  const cost = items.length * variants + (wantViews ? 2 : 0);
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
  let gen;
  try { gen = await sbInsert(env, 'generations', { user_id: user.id, items: types, cost: payCredits, free_used: useFree, status: 'running', variants }); }
  catch (e) { if (/409|duplicate|unique/i.test(String(e.message))) return json({ error: '上一張還在合成中（360° 側面背面可能還在生成），請稍候再試' }, 429, cors); throw e; }
  if (payCredits > 0) {
    const ok = await rpc(env, 'add_credits', { p_user: user.id, p_amount: -payCredits });
    if (ok !== true) { await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'failed', error: '扣點失敗' }); return json({ error: '扣點失敗，請重試' }, 500, cors); }
  }

  const order = ['dress', 'top', 'bottom', 'hair', 'hat', 'accessory', 'shoes'];
  const sorted = [...items].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const hints = (profile.analysis && profile.analysis.render_hints) ? String(profile.analysis.render_hints).slice(0, 300) : '';
  const faceHint = (profile.analysis && profile.analysis.face_shape) ? ` The person has a ${profile.analysis.face_shape} face shape; choose hair framing that flatters it.` : '';
  const runPipeline = async () => {
    let current = person;
    for (const it of sorted) {
      if (CLOTHING[it.type]) current = await fashnTryon(env, current, it.image, CLOTHING[it.type], it.photo_type);
      else current = await geminiEdit(env, current, it, person, hints + (it.type === 'hair' ? faceHint : ''));
    }
    return current;
  };
  const job = async () => {
    let results, views = null, viewsError = null;
    try {
      results = await Promise.all(Array.from({ length: variants }, runPipeline));
    } catch (e) {
      if (payCredits > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: payCredits }).catch(() => {});
      const msg = '合成失敗（已退回點數）：' + e.message;
      await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'failed', error: String(msg).slice(0, 300), cost: 0, free_used: 0 }).catch(() => {});
      const err = new Error(msg); err.status = 502; throw err;
    }
    // 多角度獨立處理：失敗只退 2 點，主圖照常回傳
    let finalPay = payCredits, finalFree = useFree;
    if (wantViews) {
      try {
        const [side, back] = await Promise.all([geminiView(env, results[0], 'side', left(), hints), geminiView(env, results[0], 'back', left(), hints)]);
        views = { side, back };
      } catch (e) {
        viewsError = String(e.message).slice(0, 160);
        const refund = Math.min(2, payCredits);
        if (refund > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: refund }).catch(() => {});
        finalPay = payCredits - refund; finalFree = useFree - (2 - refund);
      }
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
        if (i === 0) await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'ok', image_url: u, cost: finalPay, free_used: finalFree, error: viewsError });
        else await sbInsert(env, 'generations', { user_id: user.id, items: types, cost: 0, free_used: 0, status: 'ok', image_url: u, variants });
      } catch { /* ignore */ }
    }

    // 多角度圖也存起來
    const viewUrls = {};
    if (views) {
      for (const k of ['side', 'back']) {
        try {
          const bin = await dataUriToBytes(views[k]);
          const path = `${user.id}/${Date.now()}-${k}.${bin.ext}`;
          const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/results/${path}`, { method: 'POST', headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': bin.mime, 'x-upsert': 'true' }, body: bin.bytes });
          if (up.ok) viewUrls[k] = `${env.SUPABASE_URL}/storage/v1/object/public/results/${path}`;
        } catch { /* ignore */ }
      }
    }
    let creditsNow = profile.credits - finalPay;
    try { creditsNow = (await getProfile(env, user)).credits; } catch { /* 用估算值 */ }
    // 圖片已上傳成功的只回 URL，省下回應體積；上傳失敗的才回 base64
    const imagesOut = results.map((r, i) => urls[i] ? null : r);
    const payload = { images: imagesOut, image_urls: urls, views: views ? { side: viewUrls.side ? null : views.side, back: viewUrls.back ? null : views.back } : null, view_urls: viewUrls, views_error: viewsError, charged: finalPay, free_used: finalFree, credits: creditsNow, free_left: Math.max(0, freeLeft - finalFree) };
    // 非同步模式：結果只存 URL（base64 太大），存進 views.result 供輪詢取用
    const stored = { ...viewUrls, result: asyncMode ? { ...payload, images: payload.images.map(x => null), views: null } : undefined };
    if (asyncMode && (urls.some(u => !u) || (views && (!viewUrls.side || !viewUrls.back)))) stored.result.partial = true;
    try { await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { views: stored }); } catch { /* ignore */ }
    return payload;
  };
  if (stepMode) {
    // 分段模式：先把輸入圖存到 Storage，之後每次前端輪詢推進一步（不靠長時間背景工作）
    try {
      const base = `${user.id}/jobs/${gen.id}`;
      const personUrl = await putImage(env, `${base}/person`, person);
      const steps = [];
      for (let k = 0; k < sorted.length; k++) {
        const it = sorted[k];
        const st = { type: it.type };
        if (CLOTHING[it.type]) { st.category = CLOTHING[it.type]; st.photo_type = it.photo_type || null; st.image_url = await putImage(env, `${base}/item${k}`, it.image); }
        else { if (isDataImage(it.image)) st.image_url = await putImage(env, `${base}/item${k}`, it.image); if (it.text) st.text = String(it.text).slice(0, 200); }
        steps.push(st);
      }
      const meta = sorted.map((it, k) => ({ type: it.type, name: String(it.name || '').slice(0, 80) || null, product_id: Number(it.product_id) || null, buy_url: typeof it.buy_url === 'string' && /^https?:/.test(it.buy_url) ? it.buy_url.slice(0, 500) : null, image_url: steps[k].image_url || null, text: steps[k].text || null }));
      const useOutfit = !!env.FAL_KEY && body.engine !== 'fashn';
      const jobState = { v: 1, lock_until: 0, touched: new Date().toISOString(), person_url: personUrl, meta,
        aspect: typeof body.aspect === 'string' ? body.aspect : 'auto',
        steps: useOutfit ? [{ type: 'outfit', engine: body.engine === 'fast' ? 1 : 0 }] : steps, item_steps: steps, engine: useOutfit ? 'outfit' : 'fashn',
        chains: Array.from({ length: variants }, () => ({ i: 0, cur: personUrl, req: null })),
        want_views: wantViews, views: null, views_error: null, hints, face_hint: faceHint,
        pay: payCredits, free: useFree, free_left: freeLeft, cost };
      await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { job: jobState });
    } catch (e) {
      if (payCredits > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: payCredits }).catch(() => {});
      await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'failed', error: '準備失敗：' + String(e.message).slice(0, 200), cost: 0, free_used: 0 }).catch(() => {});
      return json({ error: '準備合成失敗（已退回點數）：' + e.message }, 502, cors);
    }
    return json({ id: gen.id, async: true, cost }, 202, cors);
  }
  try { return json(await job(), 200, cors); }
  catch (e) { return json({ error: e.message }, e.status || 502, cors); }
}
async function handleTryonStatus(request, env, cors, url) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  const id = Number(url.searchParams.get('id')); if (!id) return json({ error: '缺少 id' }, 400, cors);
  const rows = await sb(env, `/rest/v1/generations?id=eq.${id}&user_id=eq.${user.id}&select=id,status,error,image_url,views,created_at,job,cost,free_used,items,variants`);
  const g = rows[0]; if (!g) return json({ error: '找不到這筆合成' }, 404, cors);
  if (g.status === 'failed') return json({ status: 'failed', error: g.error || '合成失敗' }, 200, cors);
  if (g.status === 'ok') { const r = (g.views && g.views.result) || null; return json({ status: 'ok', result: r || { images: [null], image_urls: [g.image_url], views: null, view_urls: g.views || {}, views_error: null } }, 200, cors); }
  const job = g.job;
  if (!job) {
    if (Date.now() - new Date(g.created_at).getTime() > RUNNING_STALE_MS) return json({ status: 'failed', error: '合成逾時，點數會自動退回，請再試一次' }, 200, cors);
    return json({ status: 'running' }, 200, cors);
  }
  const progress = () => { const tot = job.steps.length * job.chains.length + (job.want_views ? 1 : 0); const done = job.chains.reduce((a, c) => a + c.i, 0) + (job.views || job.views_error ? 1 : 0); const ch = job.chains[0]; const cur = ch && ch.i < job.steps.length ? job.steps[ch.i].type : (job.want_views && !job.views && !job.views_error ? 'views' : 'finish'); return { done, total: tot + 1, current: cur }; };
  const frontOut = () => job.front ? { items: job.meta || [], engine: job.engine, images: job.front.map(() => null), image_urls: job.front, views: null, view_urls: {}, views_pending: true, views_error: null, charged: job.pay, free_used: job.free, credits: null, free_left: Math.max(0, (job.free_left || 0) - job.free) } : undefined;
  const running = () => json({ status: 'running', progress: progress(), front: frontOut() }, 200, cors);
  const fail = async (msg) => {
    if (job.pay > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: job.pay }).catch(() => {});
    await sbPatch(env, `/rest/v1/generations?id=eq.${id}&status=eq.running`, { status: 'failed', error: String(msg).slice(0, 300), cost: 0, free_used: 0 }).catch(() => {});
    return json({ status: 'failed', error: msg }, 200, cors);
  };
  // 太久沒進度（使用者關掉頁面等）→ 失敗並退點
  if (Date.now() - new Date(job.touched).getTime() > RUNNING_STALE_MS && (job.lock_until || 0) < Date.now()) return fail('合成逾時（已退回點數），請再試一次');
  // 取得鎖（避免兩個輪詢同時推進）
  if ((job.lock_until || 0) > Date.now()) return running();
  const v = job.v;
  job.v = v + 1; job.lock_until = Date.now() + 90000;
  const got = await sbPatch(env, `/rest/v1/generations?id=eq.${id}&status=eq.running&job->>v=eq.${v}`, { job }, true).catch(() => []);
  if (!Array.isArray(got) || !got.length) return running();
  const save = async (extra = {}) => { job.v += 1; job.lock_until = 0; job.touched = new Date().toISOString(); await sbPatch(env, `/rest/v1/generations?id=eq.${id}`, { job, ...extra }); };
  const base = `${user.id}/jobs/${id}`;
  try {
    // 1) 推進每條合成鏈（一次最多一個 Gemini 步驟）
    await Promise.all(job.chains.map(async (ch, ci) => {
      for (let guard = 0; guard < 3 && ch.i < job.steps.length; guard++) {
        const st = job.steps[ch.i];
        if (st.type === 'outfit') {
          if (!ch.req) { const urls = [ch.cur, ...job.item_steps.filter(x => x.image_url).map(x => x.image_url)]; ch.req = await outfitSubmit(env, st.engine || 0, urls, outfitPrompt(job.item_steps, job.hints, job.face_hint), true, job.aspect); return; }
          let r;
          try { r = await falCheck(env, ch.req, '換裝服務'); }
          catch (e) {
            // 備援：換下一個整套引擎；都不行就改用逐件 FASHN
            ch.req = null;
            if ((st.engine || 0) + 1 < OUTFIT_ENGINES.length) { st.engine = (st.engine || 0) + 1; job.outfit_errors = [...(job.outfit_errors || []), String(e.message).slice(0, 120)]; return; }
            job.outfit_errors = [...(job.outfit_errors || []), String(e.message).slice(0, 120)];
            job.engine = 'fashn'; job.steps = job.item_steps; job.chains.forEach(c => { c.i = 0; c.cur = job.person_url; c.req = null; });
            return;
          }
          if (!r) return;
          ch.cur = r; ch.req = null; ch.i++;
          continue;
        }
        if (st.category) {
          if (!ch.req) { ch.req = await falSubmit(env, ch.cur, st.image_url, st.category, st.photo_type); return; }
          const r = await falCheck(env, ch.req, '衣服試穿服務');
          if (!r) return;                         // 還在排隊／處理中
          ch.cur = r; ch.req = null; ch.i++;      // 完成，換下一步
          continue;
        }
        const personData = await urlToDataUri(ch.cur);
        const idRef = await urlToDataUri(job.person_url);
        const item = { type: st.type, image: st.image_url ? await urlToDataUri(st.image_url) : undefined, text: st.text };
        const out = await geminiEdit(env, personData, item, idRef, (job.hints || '') + (st.type === 'hair' ? (job.face_hint || '') : ''));
        ch.cur = await putImage(env, `${base}/c${ci}-s${ch.i}`, out); ch.i++;
        return;                                   // 一次只做一個 Gemini（控制單次請求時間）
      }
    }));
    const chainsDone = job.chains.every(c => c.i >= job.steps.length);
    if (!chainsDone) { await save(); return running(); }
    // 正面先完成就先存檔回傳，360° 在後面慢慢補
    if (!job.front) {
      job.front = [];
      for (let i = 0; i < job.chains.length; i++) { const u = job.chains[i].cur; job.front.push(u.startsWith(env.SUPABASE_URL) ? u : await copyToStorage(env, `${user.id}/${Date.now()}-${i}`, u).catch(() => u)); }
    }
    // 2) 360°（用 fal 的影像模型，送出後分次輪詢，不卡單次請求）
    if (job.want_views && !job.views && !job.views_error) {
      const refundViews = async (msg) => {
        job.views_error = String(msg).slice(0, 160);
        const refund = Math.min(2, job.pay);
        if (refund > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: refund }).catch(() => {});
        job.free = job.free - (2 - refund); job.pay = job.pay - refund;
      };
      try {
        if (!job.views_req) {
          job.views_req = {};
          for (const k of ['side', 'back']) job.views_req[k] = await outfitSubmit(env, 0, [job.chains[0].cur], VIEW_FAL_PROMPTS[k] + (job.hints ? ' Body proportions to preserve: ' + job.hints : ''), false, job.aspect);
        } else {
          const got = job.views_got || {};
          for (const k of ['side', 'back']) if (!got[k]) { const u = await falCheck(env, job.views_req[k], '多角度服務'); if (u) got[k] = u; }
          job.views_got = got;
          if (got.side && got.back) {
            job.views = {};
            for (const k of ['side', 'back']) job.views[k] = await copyToStorage(env, `${base}/${k}-${Date.now()}`, got[k]).catch(() => got[k]);
          }
        }
      } catch (e) { await refundViews(e.message); }
      await save(); return running();
    }
    // 3) 收尾：結果複製到我們的 Storage（fal 的網址會過期）
    const urls = job.front;
    const viewUrls = job.views || {};
    const prof = await getProfile(env, user).catch(() => null);
    const result = { items: job.meta || [], engine: job.engine, images: urls.map(() => null), image_urls: urls, views: null, view_urls: viewUrls, views_error: job.views_error, charged: job.pay, free_used: job.free, credits: prof ? prof.credits : null, free_left: Math.max(0, (job.free_left || 0) - job.free) };
    for (let i = 1; i < urls.length; i++) await sbInsert(env, 'generations', { user_id: user.id, items: g.items, cost: 0, free_used: 0, status: 'ok', image_url: urls[i], variants: g.variants }).catch(() => {});
    job.v += 1; job.lock_until = 0; job.touched = new Date().toISOString();
    await sbPatch(env, `/rest/v1/generations?id=eq.${id}`, { status: 'ok', image_url: urls[0], cost: job.pay, free_used: job.free, error: job.views_error, views: { ...viewUrls, result }, job });
    return json({ status: 'ok', result }, 200, cors);
  } catch (e) {
    return fail('合成失敗（已退回點數）：' + e.message);
  }
}
/* ---- Storage 工具 ---- */
async function putImage(env, pathNoExt, dataUri) {
  const bin = await dataUriToBytes(dataUri);
  const path = `${pathNoExt}.${bin.ext}`;
  const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/results/${path}`, { method: 'POST', headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': bin.mime, 'x-upsert': 'true' }, body: bin.bytes });
  if (!up.ok) throw new Error('圖片儲存失敗（' + up.status + '）');
  return `${env.SUPABASE_URL}/storage/v1/object/public/results/${path}`;
}
async function copyToStorage(env, pathNoExt, srcUrl) {
  const r = await fetchT(srcUrl, {}, '下載結果');
  if (!r.ok) throw new Error('下載結果失敗');
  const mime = (r.headers.get('Content-Type') || 'image/png').split(';')[0];
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
  const path = `${pathNoExt}.${ext}`;
  const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/results/${path}`, { method: 'POST', headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' }, body: r.body });
  if (!up.ok) throw new Error('圖片儲存失敗');
  return `${env.SUPABASE_URL}/storage/v1/object/public/results/${path}`;
}
/* ---- FASHN 分段：送出／查一次 ---- */
async function falSubmit(env, personUrl, garmentUrl, category, photoType) {
  const headers = { 'Authorization': 'Key ' + need(env, 'FAL_KEY'), 'Content-Type': 'application/json' };
  const r = await fetchT(FAL_QUEUE, { method: 'POST', headers, body: JSON.stringify({ model_image: personUrl, garment_image: garmentUrl, category, mode: 'quality', garment_photo_type: ['flat-lay', 'model'].includes(photoType) ? photoType : 'auto', num_samples: 1, output_format: 'png', seed: Math.floor(Math.random() * 1e9) }) }, '衣服試穿服務', 30000);
  const t = await r.text();
  if (!r.ok) throw new Error('衣服試穿服務：' + extractErr(t));
  const j = JSON.parse(t);
  if (!j.status_url || !j.response_url) throw new Error('衣服試穿服務沒有回應工作編號');
  return { status_url: j.status_url, response_url: j.response_url, at: Date.now() };
}
async function falCheck(env, req, label = '衣服試穿服務') {
  const headers = { 'Authorization': 'Key ' + need(env, 'FAL_KEY') };
  if (Date.now() - (req.at || 0) > UPSTREAM_TIMEOUT_MS) throw new Error(label + '逾時，請稍後再試');
  const sr = await fetchT(req.status_url, { headers }, label, 20000);
  const sd = await sr.json().catch(() => ({}));
  if (sd.status === 'FAILED' || (sr.status >= 400 && sr.status !== 202)) throw new Error(label + '：' + friendlyFal(typeof sd.error === 'string' ? sd.error : (Array.isArray(sd.detail) ? sd.detail.map(x => x && x.msg || '').join('; ') : (sd.detail || '處理失敗'))));
  if (sd.status !== 'COMPLETED') return null;
  const rr = await fetchT(req.response_url, { headers }, label, 30000);
  const rt = await rr.text();
  if (!rr.ok) throw new Error(label + '：' + extractErr(rt));
  const d = JSON.parse(rt); const u = d && d.images && d.images[0] && d.images[0].url;
  if (!u) throw new Error(label + '沒有回傳圖片' + (d && d.description ? '（' + String(d.description).slice(0, 80) + '）' : ''));
  return u;
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
  let delay = 1500, done = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, delay)); delay = Math.min(4000, delay + 500);
    const sr = await fetchT(statusUrl, { headers }, '衣服試穿服務', 30000);
    const sd = await sr.json().catch(() => ({}));
    if (sd.status === 'COMPLETED') { done = true; break; }
    if (sd.status === 'FAILED' || sr.status >= 400 && sr.status !== 202) throw new Error('衣服試穿服務：' + friendlyFal(typeof sd.error === 'string' ? sd.error : (Array.isArray(sd.detail) ? sd.detail.map(x => x && x.msg || '').join('; ') : (sd.detail || '處理失敗'))));
  }
  if (!done) throw new Error('衣服試穿服務逾時，請稍後再試');
  const rr = await fetchT(responseUrl, { headers }, '衣服試穿服務');
  const rt = await rr.text();
  if (!rr.ok) throw new Error('衣服試穿服務：' + extractErr(rt));
  const d = JSON.parse(rt);
  const u = d && d.images && d.images[0] && d.images[0].url;
  if (!u) throw new Error('衣服試穿服務沒有回傳圖片');
  return await urlToDataUri(u);
}
function friendlyFal(msg) {
  const m = String(msg || '');
  if (/detect body pose|person_image|no person|pose/i.test(m)) return '照片裡偵測不到完整的人體，請換一張正面、全身入鏡、光線清楚的照片';
  if (/garment_image|garment/i.test(m)) return '衣服圖看不清楚，請換一張正面、背景乾淨的衣服照';
  if (/content|nsfw|safety/i.test(m)) return '這張照片不符合安全規範，請換一張';
  if (/timeout|timed out/i.test(m)) return '處理逾時，請再試一次';
  return m.slice(0, 200);
}
function extractErr(t) { let raw; try { const j = JSON.parse(t); const d = j.detail; raw = Array.isArray(d) ? d.map(x => x && x.msg || '').join('; ') : (typeof d === 'string' ? d : (j.error || j.message || t)); } catch { raw = String(t); } return friendlyFal(raw); }

/* ---- Gemini 影像編輯（模型備援鏈） ---- */
async function geminiEdit(env, person, item, identityRef, bodyHint) {
  const preferred = env.GEMINI_IMAGE_MODEL || GEMINI_FALLBACKS[0];
  const models = [preferred, ...GEMINI_FALLBACKS.filter(m => m !== preferred)];
  let prompt = (item.type === 'hair' && !isDataImage(item.image)) ? EDIT_PROMPTS.hair_text.replace('{{desc}}', item.text.trim().slice(0, 200)) : EDIT_PROMPTS[item.type];
  const hasRef = isDataImage(item.image), hasId = identityRef && identityRef !== person;
  prompt += hasId ? ` The ${hasRef ? 'third' : 'second'} image is the same person (identity reference): the face, skin tone and body in the output must be identical to this person.` : ' The face and identity of the person must remain exactly identical.';
  if (bodyHint) prompt += ' Body notes for realistic fit: ' + bodyHint;
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

/* ---- 多角度：從正面結果生成側面／背面 ---- */
async function geminiView(env, front, which, maxMs, bodyHint) {
  if (maxMs !== undefined && maxMs < 15000) throw new Error('多角度服務：時間不足');
  const parts = [{ text: VIEW_PROMPTS[which] + (bodyHint ? ' Body proportions to preserve: ' + bodyHint : '') }, inlinePart(front)];
  const preferred = env.GEMINI_IMAGE_MODEL || GEMINI_FALLBACKS[0];
  const models = [preferred, ...GEMINI_FALLBACKS.filter(m => m !== preferred)];
  let lastErr = '';
  for (const model of models) {
    const isGen3 = !model.includes('2.5');
    const cfgs = isGen3 ? [{ responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K' } }, { responseModalities: ['IMAGE'] }] : [{ responseModalities: ['IMAGE'] }];
    for (const generationConfig of cfgs) {
      const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': need(env, 'GEMINI_KEY') }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }) }, '多角度服務', maxMs);
      const t = await r.text();
      if (r.ok) {
        const d = JSON.parse(t); const cand = d.candidates && d.candidates[0];
        const img = cand && cand.content && cand.content.parts && cand.content.parts.find(p => p.inlineData);
        if (img) return `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`;
        lastErr = (cand && cand.finishReason) || '未回傳圖片'; break;
      }
      let m = t; try { m = JSON.parse(t).error.message; } catch {}
      lastErr = String(m).slice(0, 200);
      if (r.status === 404 || /not found|not supported|does not exist/i.test(m)) break;
      if (r.status === 400 && /imageConfig|imageSize|image_size/i.test(m)) continue;
      if (r.status === 429 || r.status >= 500) continue;
      throw new Error('多角度服務：' + lastErr);
    }
  }
  throw new Error('多角度服務：' + lastErr);
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


/* ---------------- AI 搭配建議 ---------------- */
async function handleOutfit(request, env, cors) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  if (!env.GEMINI_KEY) return json({ error: '搭配建議服務尚未啟用' }, 503, cors);
  let body; try { body = await request.json(); } catch { return json({ error: '資料格式錯誤' }, 400, cors); }
  const have = Array.isArray(body.have) ? body.have.slice(0, 8) : [];
  const gender = body.gender === 'm' ? 'm' : 'f';
  const cnt = await sb(env, `/rest/v1/events?user_id=eq.${user.id}&name=eq.outfit&created_at=gte.${encodeURIComponent(taipeiDayStart())}&select=id`).catch(() => []);
  if (cnt.length >= 20) return json({ error: '今天的搭配建議次數已用完（每天 20 次），明天再試' }, 429, cors);
  const prof = (await sb(env, `/rest/v1/profiles?id=eq.${user.id}&select=analysis,body`).catch(() => []))[0] || {};
  const a = prof.analysis || {};
  const haveTypes = new Set(have.map(h => h.type));
  const wantTypes = ['top', 'bottom', 'dress', 'shoes', 'hat', 'accessory'].filter(t => !haveTypes.has(t));
  if (haveTypes.has('dress')) { ['top', 'bottom'].forEach(t => { const i = wantTypes.indexOf(t); if (i >= 0) wantTypes.splice(i, 1); }); }
  const cands = await sb(env, `/rest/v1/products?active=eq.true&gender=in.(${gender},u)&type=in.(${wantTypes.join(',')})&select=id,brand,name,type,gender,price,currency,image_url,buy_url,tags&order=featured.desc,created_at.desc&limit=90`).catch(() => []);
  if (!cands.length) return json({ outfits: [], note: '商店目前沒有可搭配的商品' }, 200, cors);
  const list = cands.map(c => `${c.id}|${c.type}|${c.brand || ''}|${c.name}|${(c.tags || []).join(' ')}|NT$${c.price || ''}`).join('\n');
  const profile = `User: ${gender === 'm' ? 'male' : 'female'}` + (a.body_shape ? `, body shape ${a.body_shape}` : '') + (a.shoulder ? `, ${a.shoulder} shoulders` : '') + (a.legs ? `, ${a.legs} legs` : '') + (a.skin_tone ? `, ${a.skin_tone} skin tone` : '') + (prof.body && prof.body.height ? `, height ${prof.body.height} cm` : '') + '.' + (a.fit_advice ? ` Stylist notes: tops: ${a.fit_advice.tops || ''}; bottoms: ${a.fit_advice.bottoms || ''}; colors: ${a.fit_advice.colors || ''}.` : '') + (a.avoid ? ` Avoid: ${a.avoid}` : '');
  const haveTxt = have.length ? have.map(h => `${h.type}: ${h.brand ? h.brand + ' ' : ''}${h.name}`).join('; ') : '(nothing yet)';
  const prompt = `You are a personal stylist for a Taiwanese fashion app. ${profile}
The user currently has in the fitting room: ${haveTxt}.
Candidate products from our shop (one per line: id|type|brand|name|tags|price):
${list}

Build ${have.length ? '2' : '3'} outfits that go with what the user already has (or complete looks if nothing yet). Use ONLY candidate ids. Each outfit: 2–4 products, at most one product per type, never two of the same type. Prefer items flattering the user's body shape and skin tone; keep colors coherent; mix price points sensibly.
Output ONLY JSON: {"outfits":[{"title":"short Traditional Chinese title","tip":"one Traditional Chinese sentence on why this look suits the user's body","items":[{"id":123,"reason":"short Traditional Chinese reason (<=25 chars)"}]}],"note":"one short Traditional Chinese sentence of overall advice"}`;
  const models = TEXT_MODELS;
  let out = null, lastErr = '';
  for (const model of models) {
    const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, responseMimeType: 'application/json' } }) }, '搭配建議服務', 45000);
    const t = await r.text();
    if (r.ok) { try { const d = JSON.parse(t); const txt = d.candidates[0].content.parts.map(p => p.text || '').join(''); out = JSON.parse(txt.replace(/^```json|```$/g, '').trim()); break; } catch { lastErr = '回傳格式異常'; continue; } }
    let em; try { em = JSON.parse(t).error.message.slice(0, 160); } catch { em = t.slice(0, 160); }
    if (r.status === 429) lastErr = '文字模型額度已用完（' + model + '），請稍後再試或綁定 Google AI 帳單'; else if (r.status !== 404) lastErr = em; else if (!lastErr) lastErr = em;
    if (r.status === 404 || r.status === 429 || r.status >= 500) continue; break;
  }
  if (!out) return json({ error: '搭配建議失敗：' + lastErr }, 502, cors);
  const byId = new Map(cands.map(c => [String(c.id), c]));
  const outfits = (out.outfits || []).map(o => { const seen = new Set(); const items = (o.items || []).map(i => { const pr = byId.get(String(i.id)); if (!pr || seen.has(pr.type)) return null; seen.add(pr.type); return { product: pr, reason: String(i.reason || '').slice(0, 80) }; }).filter(Boolean); return { title: String(o.title || '').slice(0, 30), tip: String(o.tip || '').slice(0, 120), items }; }).filter(o => o.items.length);
  await sb(env, '/rest/v1/events', { method: 'POST', body: JSON.stringify({ user_id: user.id, name: 'outfit', props: { have: have.length, out: outfits.length } }) }).catch(() => {});
  return json({ outfits, note: String(out.note || '').slice(0, 120) }, 200, cors);
}

/* ---------------- 商品櫥窗 ---------------- */
async function handleProducts(request, env, cors, url) {
  const type = url.searchParams.get('type'), gender = url.searchParams.get('gender'), q = (url.searchParams.get('q') || '').replace(/[(),"*\\]/g, ' ').trim().slice(0, 40);
  const page = Math.max(0, Number(url.searchParams.get('page') || 0)), size = 24;
  let qs = `/rest/v1/products?active=eq.true&select=id,source,brand,name,type,gender,price,currency,image_url,buy_url,tags,sizes,featured&order=featured.desc,created_at.desc&limit=${size}&offset=${page * size}`;
  if (type && ['top','bottom','dress','shoes','hat','accessory','hair'].includes(type)) qs += `&type=eq.${type}`;
  if (gender === 'f' || gender === 'm') qs += `&gender=in.(${gender},u)`;
  if (q) qs += `&or=(name.ilike.*${encodeURIComponent(q)}*,brand.ilike.*${encodeURIComponent(q)}*)`;
  let rows;
  try { rows = await sb(env, qs); } catch (e) { rows = await sb(env, qs.replace(',sizes,', ',')); }  // 舊資料庫尚未加 sizes 欄位時仍可用
  return json({ products: rows, page, has_more: rows.length === size }, 200, { ...cors, 'Cache-Control': 'public, max-age=60' });
}
async function handleProductClick(request, env, cors) {
  let body; try { body = await request.json(); } catch { return json({ ok: false }, 400, cors); }
  const user = await optionalUser(request, env);
  const action = body.action === 'buy' ? 'buy' : 'try';
  await sb(env, '/rest/v1/product_clicks', { method: 'POST', body: JSON.stringify({ product_id: Number(body.product_id) || null, user_id: user ? user.id : null, anon_id: String(body.anon_id || '').slice(0, 64) || null, action }) }).catch(() => {});
  return json({ ok: true }, 200, cors);
}
async function requireAdmin(request, env) { const u = await requireUser(request, env); if (!isAdmin(env, u)) throw Object.assign(new Error('沒有權限'), { status: 403 }); return u; }
function normProduct(x) {
  const t = String(x.type || '').toLowerCase();
  if (!['top','bottom','dress','shoes','hat','accessory','hair'].includes(t)) return null;
  if (!x.name || !x.image_url) return null;
  return { source: String(x.source || 'manual').slice(0, 20), external_id: x.external_id ? String(x.external_id).slice(0, 80) : null, brand: x.brand ? String(x.brand).slice(0, 60) : null, name: String(x.name).slice(0, 120), type: t, gender: ['f','m','u'].includes(x.gender) ? x.gender : 'u', price: x.price != null ? Math.round(Number(x.price)) : null, currency: String(x.currency || 'TWD').slice(0, 5), image_url: String(x.image_url).slice(0, 500), buy_url: x.buy_url ? String(x.buy_url).slice(0, 800) : null, tags: Array.isArray(x.tags) ? x.tags.slice(0, 10).map(s => String(s).slice(0, 20)) : [], active: x.active !== false, featured: !!x.featured, updated_at: new Date().toISOString() };
}
// 批次匯入：body = { products:[...] }（JSON）或 { csv:"..." }（欄位：source,external_id,brand,name,type,gender,price,image_url,buy_url,tags）
async function handleProductImport(request, env, cors) {
  try { await requireAdmin(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  let body; try { body = await request.json(); } catch { return json({ error: '資料格式錯誤' }, 400, cors); }
  let list = Array.isArray(body.products) ? body.products : [];
  if (typeof body.csv === 'string') {
    const lines = body.csv.split(/\r?\n/).filter(l => l.trim()); const head = lines.shift().split(',').map(h => h.trim());
    for (const l of lines) { const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')); const o = {}; head.forEach((h, i) => o[h] = cells[i]); if (o.tags) o.tags = String(o.tags).split('|'); list.push(o); }
  }
  const rows = list.map(normProduct).filter(Boolean).slice(0, 500);
  if (!rows.length) return json({ error: '沒有可匯入的商品（需要 name、image_url、type）' }, 400, cors);
  const withExt = rows.filter(r => r.external_id), noExt = rows.filter(r => !r.external_id);
  let n = 0;
  if (withExt.length) { const r = await sb(env, '/rest/v1/products?on_conflict=source,external_id', { method: 'POST', headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(withExt) }); n += Array.isArray(r) ? r.length : 0; }
  if (noExt.length) { const r = await sb(env, '/rest/v1/products', { method: 'POST', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(noExt) }); n += Array.isArray(r) ? r.length : 0; }
  return json({ ok: true, imported: n, skipped: list.length - rows.length }, 200, cors);
}
async function handleProductUpsert(request, env, cors) {
  try { await requireAdmin(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  let body; try { body = await request.json(); } catch { return json({ error: '資料格式錯誤' }, 400, cors); }
  const row = normProduct(body); if (!row) return json({ error: '需要 name、image_url、type' }, 400, cors);
  if (body.id) { await sbPatch(env, `/rest/v1/products?id=eq.${Number(body.id)}`, row); return json({ ok: true, id: Number(body.id) }, 200, cors); }
  const r = await sbInsert(env, 'products', row); return json({ ok: true, id: r && r.id }, 200, cors);
}
async function handleProductDelete(request, env, cors, url) {
  try { await requireAdmin(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  const id = Number(url.searchParams.get('id')); if (!id) return json({ error: '缺少 id' }, 400, cors);
  await sbPatch(env, `/rest/v1/products?id=eq.${id}`, { active: false }); return json({ ok: true }, 200, cors);
}

// 商品圖代理：只允許代理資料庫裡的商品圖（防止被當成開放代理）
async function handleImgProxy(request, env, cors, url) {
  const id = Number(url.searchParams.get('id')); if (!id) return json({ error: '缺少 id' }, 400, cors);
  const rows = await sb(env, `/rest/v1/products?id=eq.${id}&active=eq.true&select=image_url`);
  if (!rows.length) return json({ error: '找不到商品' }, 404, cors);
  const r = await fetchT(rows[0].image_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TryOnBot/1.0)' } }, '商品圖', 20000);
  if (!r.ok) return json({ error: '商品圖載入失敗' }, 502, cors);
  const ct = (r.headers.get('Content-Type') || 'image/jpeg').split(';')[0];
  if (!ct.startsWith('image/')) return json({ error: '不是圖片' }, 502, cors);
  return new Response(r.body, { status: 200, headers: { ...cors, 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' } });
}

/* ---------------- 事件與錯誤回報 ---------------- */
const EVENT_NAMES = new Set(['open', 'login', 'photo', 'item', 'tryon_start', 'tryon_ok', 'tryon_fail', 'share', 'story', 'buy_click', 'paid', 'install', 'analyze', 'outfit']);
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
  const n = [env.ECPAY_MERCHANT_ID, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV].filter(Boolean).length;
  if (n === 3) return { merchant: env.ECPAY_MERCHANT_ID, key: env.ECPAY_HASH_KEY, iv: env.ECPAY_HASH_IV, url: ECPAY_PROD_URL, test: false };
  if (n > 0) throw new Error('綠界設定不完整（需同時設定 MERCHANT_ID、HASH_KEY、HASH_IV）');
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
  if (p.SimulatePaid === '1' && !cfg.test) return new Response('1|OK');
  if (p.RtnCode === '1') {
    const rows = await sb(env, `/rest/v1/orders?trade_no=eq.${encodeURIComponent(p.MerchantTradeNo)}&select=*`);
    const o = rows[0];
    if (!o) return new Response('0|Order Not Found', { status: 400 });
    if (String(p.TradeAmt) !== String(o.amount)) return new Response('0|Amount Error', { status: 400 });
    // 只有從 pending 改成 paid 的那一次才加點（防重送/併發）
    const upd = await sbPatch(env, `/rest/v1/orders?trade_no=eq.${encodeURIComponent(p.MerchantTradeNo)}&status=eq.pending`, { status: 'paid', ecpay_trade_no: p.TradeNo || null, paid_at: new Date().toISOString() }, true);
    if (Array.isArray(upd) && upd.length && o.user_id) {
      await getProfile(env, { id: o.user_id, email: o.user_email }).catch(() => {});
      const ok = await rpc(env, 'add_credits', { p_user: o.user_id, p_amount: o.credits }).catch(() => false);
      if (ok !== true) await sbPatch(env, `/rest/v1/orders?trade_no=eq.${encodeURIComponent(p.MerchantTradeNo)}`, { status: 'paid_uncredited' }).catch(() => {});
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
