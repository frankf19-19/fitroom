// 離線測試：單品規格 → 送出 → 品質檢查（retry）→ 換 pro 引擎重做 → 品質檢查（pass）→ 完成
// 執行：node worker/test_quality.mjs（不需要網路；fetch 全部用假的）
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
globalThis.__TRYON_TEST__ = true;

/* ---------- 假的外部服務 ---------- */
const SB = 'https://sb.test';
const RESULT1 = 'https://fal.media/result-1.jpg', RESULT2 = 'https://fal.media/result-2.jpg';
const calls = { vision: [], submits: [], status: 0 };
let row;                                      // generations 那一列（模擬資料庫）
let visionQueue = [];                         // 看圖模型依序回覆
let queueStatus = [];                         // fal queue 狀態依序回覆
let genHook = null, storageHook = null;       // 個別測試覆寫 generations／公開 Storage 的回應

const res = (obj, status = 200, type = 'application/json') => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': type } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (url.startsWith(SB + '/auth/v1/user')) return res({ id: 'u1', email: 'a@b.c' });
  if (url.startsWith(SB + '/rest/v1/profiles')) return res([{ id: 'u1', credits: 5 }]);
  if (url.startsWith(SB + '/rest/v1/generations') && genHook) return genHook(url, opts);
  if (url.startsWith(SB + '/storage/v1/object/public/') && storageHook) return storageHook(url);
  if (url.startsWith(SB + '/rest/v1/generations')) {
    if (opts.method === 'PATCH') { Object.assign(row, body); return res([row]); }
    return res([row]);
  }
  if (url.startsWith(SB + '/storage/v1/object/')) return res({ Key: 'x' });
  if (url.startsWith('https://fal.run/openrouter/router/vision')) {
    calls.vision.push({ model: body.model, images: body.image_urls, prompt: body.prompt });
    const next = visionQueue.shift();
    if (next instanceof Error) return res({ error: { message: next.message } }, 500);
    return res({ output: '```json\n' + JSON.stringify(next) + '\n```' });
  }
  if (/queue\.fal\.run\/fal-ai\/nano-banana/.test(url)) {
    calls.submits.push({ url, prompt: body.prompt, images: body.image_urls });
    const k = calls.submits.length;
    return res({ status_url: `https://queue.fal.run/status/${k}`, response_url: `https://queue.fal.run/response/${k}` });
  }
  if (url.startsWith('https://queue.fal.run/status/')) { calls.status++; return res({ status: queueStatus.shift() || 'COMPLETED' }); }
  if (url.startsWith('https://queue.fal.run/response/')) { const k = url.split('/').pop(); return res({ images: [{ url: k === '1' ? RESULT1 : RESULT2 }] }); }
  if (url.startsWith('https://fal.media/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  throw new Error('unexpected fetch ' + url);
};

/* ---------- 載入 worker（複製成 .mjs 以便 import） ---------- */
const src = readFileSync(join(here, 'worker.js'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'tryon-'));
const modPath = join(dir, 'worker.mjs'); writeFileSync(modPath, src);
await import(pathToFileURL(modPath).href);
const T = globalThis.__tryonTest;
assert.ok(T, 'test hook not exposed');
assert.equal(T.VERSION, '2.23.2');

/* ---------- 單元：提示詞與解析 ---------- */
const items = [
  { type: 'top', category: 'tops', image_url: 'https://img/top.jpg' },
  { type: 'bottom', category: 'bottoms', image_url: 'https://img/bottom.jpg' },
  { type: 'hair', text: 'short bob' }
];
const targets = T.captionTargets(items);
assert.deepEqual(targets.map(t => [t.i, t.n, t.type]), [[0, 1, 'top'], [1, 2, 'bottom']], 'text-only hair skipped');
const caps = T.parseCaptions({ items: [{ n: 1, type: 'top', description: 'Navy oversized bomber, zipped' }, { n: 2, description: 'Cream wide-leg linen trousers, ankle length' }] }, items);
assert.equal(caps.length, 3); assert.equal(caps[2], null); assert.match(caps[1].description, /wide-leg/);
const p = T.outfitPrompt(items, 'height 172 cm, long legs', '', { captions: caps, fixNotes: 'trousers were slim' });
assert.match(p, /Product 1 specification \(Image 2\): Navy oversized bomber/);
assert.match(p, /Product 2 specification \(Image 3\): Cream wide-leg/);
assert.match(p, /The written specification and the product photo agree; follow both exactly\./);
assert.match(p, /correct physical scale/); assert.match(p, /customer's height/);
assert.match(p, /PREVIOUS ATTEMPT WAS REJECTED FOR: trousers were slim\. Fix these specifically\./);
assert.match(p, /hairstyle to: short bob/);
const p0 = T.outfitPrompt(items, '', '');
assert.ok(!/specification|REJECTED|customer's height/.test(p0), 'plain prompt has no captions / fix block');
const qa1 = T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9, issue: '' }, { n: 2, match: 4, issue: 'trousers are slim instead of wide-leg' }], framing: 8, artifacts: [], verdict: 'pass' }, targets);
assert.equal(qa1.verdict, 'retry', 'rule overrides model verdict when item match < 7');
assert.match(T.qaCorrections(qa1), /product 2 \(BOTTOM.*\) does not match.*slim instead of wide-leg/);
assert.equal(T.normalizeQa({ identity: 6, items: [{ n: 1, match: 9 }, { n: 2, match: 9 }], framing: 9 }, targets).verdict, 'retry');
assert.equal(T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9 }, { n: 2, match: 9 }], framing: 5 }, targets).verdict, 'retry');
assert.equal(T.normalizeQa({ identity: 9, items: [{ n: 1, match: 8 }, { n: 2, match: 7 }], framing: 9, verdict: 'pass' }, targets).verdict, 'pass');
assert.match(T.qaPrompt(targets, caps), /product 2 \(BOTTOM.*\) = image 4: Cream wide-leg/);

/* ---------- 整合：用假的 fetch 驅動 handleTryonStatus ---------- */
const env = { SUPABASE_URL: SB, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'svc', FAL_KEY: 'fal' };
const PERSON = SB + '/storage/v1/object/public/results/u1/jobs/1/t/person.jpg';
const steps = [{ type: 'top', category: 'tops', image_url: 'https://img/top.jpg' }, { type: 'bottom', category: 'bottoms', image_url: 'https://img/bottom.jpg' }];
row = { id: 1, status: 'running', error: null, image_url: null, views: null, created_at: new Date().toISOString(), cost: 2, free_used: 0, items: ['top', 'bottom'], variants: 1,
  job: { v: 1, lock_until: 0, touched: new Date().toISOString(), tok: 't', person_url: PERSON, meta: [], prefetch: false, pf: 0, aspect: 'auto', hires: true, key: 'k', pv: null,
    steps: [{ type: 'outfit', engine: 0 }, { type: 'qa' }], item_steps: steps, engine: 'outfit', chains: [{ i: 0, cur: PERSON, req: null }], want_views: false, views: null, views_error: null, hints: 'height 160 cm', face_hint: '', pay: 2, free: 0, free_left: 2, cost: 2 } };
visionQueue = [
  { items: [{ n: 1, type: 'top', description: 'Black cropped denim jacket, buttoned' }, { n: 2, type: 'bottom', description: 'Olive balloon-leg cargo trousers, full length' }] },
  { identity: 9, items: [{ n: 1, match: 9, issue: '' }, { n: 2, match: 3, issue: 'trousers are slim, not balloon-leg' }], framing: 9, artifacts: [], verdict: 'retry' },
  { identity: 9, items: [{ n: 1, match: 9, issue: '' }, { n: 2, match: 8, issue: '' }], framing: 9, artifacts: [], verdict: 'pass' }
];
queueStatus = ['IN_PROGRESS', 'COMPLETED', 'IN_PROGRESS', 'COMPLETED'];
// 跟前端一樣：伺服器回報「圖好了、等品質檢查」（checking）時馬上再問一次，檢查才會開始
const pollOnce = async () => { const r = await T.handleTryonStatus(new Request('https://w/api/tryon/status?id=1', { headers: { Authorization: 'Bearer tok' } }), env, {}, new URL('https://w/api/tryon/status?id=1')); return r.json(); };
const poll = async () => { let r = await pollOnce(); if (r && r.status === 'running' && r.checking) r = await pollOnce(); return r; };

let s = await poll();   // 1: 規格 + 送出
assert.equal(s.status, 'running'); assert.equal(s.progress.current, 'outfit'); assert.ok(!s.progress.fixing);
assert.equal(calls.vision.length, 1); assert.deepEqual(calls.vision[0].images, ['https://img/top.jpg', 'https://img/bottom.jpg']);
assert.equal(calls.submits.length, 1); assert.match(calls.submits[0].url, /nano-banana-2\/edit/);
assert.match(calls.submits[0].prompt, /Product 2 specification \(Image 3\): Olive balloon-leg/); assert.ok(!/REJECTED/.test(calls.submits[0].prompt));
assert.equal(row.job.cap_done, true); assert.equal(row.job.captions.length, 2);
s = await poll();       // 2: IN_PROGRESS
assert.equal(s.status, 'running'); assert.equal(s.progress.current, 'outfit'); assert.equal(calls.vision.length, 1);
s = await poll();       // 3: COMPLETED → QA(retry) → 換 pro 重送（同一輪，預算足夠）
assert.equal(s.status, 'running'); assert.equal(s.progress.current, 'outfit'); assert.equal(s.progress.fixing, true); assert.equal(s.progress.retries, 1);
assert.equal(calls.vision.length, 2); assert.deepEqual(calls.vision[1].images, [RESULT1, PERSON, 'https://img/top.jpg', 'https://img/bottom.jpg']);
assert.equal(calls.submits.length, 2); assert.match(calls.submits[1].url, /nano-banana-2\/edit/, "retry keeps the same engine (Pro changes framing)");
assert.match(calls.submits[1].prompt, /PREVIOUS ATTEMPT WAS REJECTED FOR: product 2 \(BOTTOM.*\) does not match its product photo: trousers are slim, not balloon-leg\. Fix these specifically\./);
assert.equal(row.job.retries, 1); assert.equal(row.job.qa.verdict, 'retry'); assert.equal(row.job.steps[0].engine || 0, 0);
s = await poll();       // 4: IN_PROGRESS
assert.equal(s.status, 'running'); assert.equal(s.progress.fixing, true);
s = await poll();       // 5: COMPLETED → QA(pass) → 存正面 → 完成
assert.equal(s.status, 'ok', JSON.stringify(s));
assert.equal(calls.vision.length, 3); assert.equal(calls.vision[2].images[0], RESULT2);
assert.equal(calls.submits.length, 2, 'no third generation');
assert.deepEqual(s.result.quality, { identity: 9, items: [9, 8], framing: 9, retried: true });
assert.equal(row.job.qa_history.length, 2); assert.equal(row.status, 'ok');
assert.ok(/front-0-/.test(row.image_url) || row.image_url === RESULT2, 'front image stored (Node lacks stream-body duplex, so fallback to source URL is fine)');

/* ---------- 整合：QA 呼叫失敗 → 視為通過；prefetch 不做規格 ---------- */
calls.vision.length = 0; calls.submits.length = 0;
row.status = 'running'; row.image_url = null; row.views = null;
row.job = { ...row.job, v: 1, lock_until: 0, touched: new Date().toISOString(), chains: [{ i: 0, cur: PERSON, req: null }], steps: [{ type: 'outfit', engine: 0 }, { type: 'qa' }], front: undefined, qa: undefined, qa_history: undefined, retries: 0, fix_notes: undefined, cap_done: false, captions: null, t: undefined,
  item_steps: [{ ...steps[0], fit: { size: 'S', zones: [{ zone: 'chest', delta_cm: -4, verdict: 'tight' }], summary_en: null } }, steps[1]], body: { height_cm: 158, weight_kg: 48 },
  meta: [{ type: 'top', fit: { size: 'S', zones: [{ zone: 'chest', delta_cm: -4, verdict: 'tight' }], summary_en: null } }, { type: 'bottom', fit: null }] };
visionQueue = [new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom')];   // 規格兩個模型都失敗、QA 兩個模型都失敗
queueStatus = ['COMPLETED'];
s = await poll(); assert.equal(s.status, 'running'); assert.equal(calls.submits.length, 1); assert.equal(row.job.captions, null); assert.match(row.job.cap_error, /AI 文字服務/);
assert.ok(!/specification/.test(calls.submits[0].prompt));
s = await poll(); assert.equal(s.status, 'ok'); assert.equal(s.result.quality.identity, null);
assert.match(calls.submits[0].prompt, /Product 1 is size S\. Render its real fit on this body: chest is tight by about 4 cm/); assert.match(calls.submits[0].prompt, /The customer is 158 cm tall, 48 kg/);
assert.equal(s.result.fit.length, 2); assert.equal(s.result.fit[0].size, 'S'); assert.equal(s.result.fit[1], null); assert.equal(s.result.quality.retried, false); assert.equal(calls.submits.length, 1);

calls.vision.length = 0; calls.submits.length = 0;
row.status = 'running'; row.image_url = null; row.views = null;
row.job = { ...row.job, v: 1, lock_until: 0, touched: new Date().toISOString(), prefetch: false, chains: [{ i: 0, cur: PERSON, req: null }], steps: [{ type: 'outfit', engine: 0 }], front: undefined, qa: undefined, qa_history: undefined, retries: 0, fix_notes: undefined, cap_done: false, captions: null, t: undefined };
// 模擬預先合成：prefetch 為 true 時 job 會被加密（sealJob），這裡只驗證「不做規格、沒有 qa 步驟」的分支
row.job.prefetch = true; row.job.pf = 1;
visionQueue = [{ items: [] }];
queueStatus = ['COMPLETED'];
s = await poll(); assert.equal(s.status, 'running'); assert.equal(calls.vision.length, 1, 'prefetch: caption call too (better garment fidelity)'); assert.equal(calls.submits.length, 1);
// 預先合成也會被品質檢查：鏡像／多出來的外套 → 判定重做
{ const tg = [{ n: 1, type: 'bottom', i: 0 }];
  const q1 = T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9 }], framing: 9, mirrored: true, verdict: 'pass' }, tg); assert.equal(q1.verdict, 'retry'); assert.match(T.qaCorrections(q1, tg), /mirrored/);
  const q2 = T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9 }], framing: 9, extra_items: ['black bomber jacket'], verdict: 'pass' }, tg); assert.equal(q2.verdict, 'retry'); assert.match(T.qaCorrections(q2, tg), /black bomber jacket/);
  const q3 = T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9 }], framing: 9, extra_items: ['none'], body_changed: false, verdict: 'pass' }, tg); assert.equal(q3.verdict, 'pass');
  const q4 = T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9 }], framing: 9, body_changed: true }, tg); assert.equal(q4.verdict, 'retry'); }

/* ---------- 尺寸合身度：fitPhrases／提示詞／QA／快取鍵 ---------- */
const fitTop = T.cleanFit({ size: 'M', zones: [{ zone: 'chest', delta_cm: -3.2, verdict: 'tight' }, { zone: 'shoulder', delta_cm: 2, verdict: 'loose' }, { zone: 'sleeve', delta_cm: -2, verdict: 'short' }, { zone: 'length', delta_cm: 0, verdict: 'fit' }, { zone: 'bogus', delta_cm: 1, verdict: 'tight' }, { zone: 'waist', verdict: 'meh' }], summary_en: 'Tight across the chest, slightly dropped shoulders.\u0000' });
assert.equal(fitTop.zones.length, 4, 'invalid zones dropped'); assert.equal(fitTop.zones[0].delta_cm, -3.2); assert.ok(!/\u0000/.test(fitTop.summary_en));
assert.equal(T.cleanFit({ size: 'L', zones: Array.from({ length: 15 }, () => ({ zone: 'chest', delta_cm: 1, verdict: 'fit' })) }).zones.length, 10, '≤10 zones');
assert.equal(T.cleanFit({ size: 'x'.repeat(50), summary_en: 'y'.repeat(500) }).summary_en.length, 300);
assert.equal(T.cleanFit('M'), null); assert.equal(T.cleanFit({}), null);
assert.deepEqual(T.cleanBody({ height_cm: 162, weight_kg: '52', chest_cm: 9999, waist_cm: null, hip_cm: 'abc' }), { height_cm: 162, weight_kg: 52 });
const ph = T.fitPhrases(fitTop, 'top');
assert.equal(ph.length, 4);
assert.match(ph[0], /chest is tight by about 3 cm \(fabric stretched and pulling across the chest with horizontal tension wrinkles/);
assert.match(ph[1], /shoulder seams sit about 2 cm past the shoulder point \(dropped shoulder/);
assert.match(ph[2], /sleeves end about 2 cm above the wrist bone/);
assert.match(ph[3], /hem ends where it is designed to end/);
const phB = T.fitPhrases({ zones: [{ zone: 'waist', delta_cm: 4, verdict: 'loose' }, { zone: 'inseam', delta_cm: 5, verdict: 'long' }, { zone: 'thigh', delta_cm: -7, verdict: 'tight' }, { zone: 'length', delta_cm: -3, verdict: 'short' }] }, 'bottom');
assert.match(phB[0], /waistband is loose by about 4 cm \(waistband gapes/);
assert.match(phB[1], /trousers are about 5 cm too long \(fabric stacks in folds at the ankle/);
assert.match(phB[2], /thighs are clearly tight by about 7 cm \(fabric clings/);
assert.match(phB[3], /trouser hem ends about 3 cm higher than intended \(above the ankle bone/);
assert.deepEqual(T.fitPhrases(null), []);
const fitItems = [{ ...items[0], fit: fitTop }, { ...items[1], fit: { size: 'L', zones: [{ zone: 'waist', delta_cm: 4, verdict: 'loose' }], summary_en: null } }, items[2]];
const pf = T.outfitPrompt(fitItems, '', '', { body: { height_cm: 162, weight_kg: 52, waist_cm: 66 } });
assert.match(pf, /Product 1 is size M\. Render its real fit on this body: chest is tight by about 3 cm .*; shoulder seams sit about 2 cm past the shoulder point .*; sleeves end about 2 cm above the wrist bone/);
assert.match(pf, /Fit summary: Tight across the chest/);
assert.match(pf, /Product 2 is size L\. Render its real fit on this body: waistband is loose by about 4 cm/);
assert.match(pf, /The customer is 162 cm tall, 52 kg \(body measurements: waist 66 cm\)/);
assert.match(pf, /SIZE AND FIT/); assert.match(pf, /never changes the garment design, color, fabric, pattern or details/);
assert.match(pf, /GARMENT FIDELITY IS THE TOP PRIORITY/); assert.match(pf, /except where the SIZE AND FIT notes/);
assert.match(pf, /customer's height/, 'body height counts as a height hint');
assert.ok(!/SIZE AND FIT|The customer is|except where/.test(p0), 'no fit block without fit');
// QA：有合身度的商品要評 fit_match；fit_match < 5 視同單品不符
const ft = T.captionTargets(fitItems);
assert.equal(ft[0].fit.size, 'M');
const qp = T.qaPrompt(ft, null);
assert.match(qp, /EXPECTED SIZE FIT: product 1 is size M and should visibly show: chest is tight/); assert.match(qp, /fit_match/); assert.match(qp, /any fit_match < 5/);
assert.ok(!/fit_match/.test(T.qaPrompt(targets, caps)), 'no fit_match without fit');
const qf = T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9, fit_match: 3, issue: 'top looks regular fit, no tension at chest' }, { n: 2, match: 9, fit_match: 8 }], framing: 9, verdict: 'pass' }, ft);
assert.equal(qf.verdict, 'retry', 'fit_match < 5 forces retry'); assert.equal(qf.items[0].fit_match, 3);
assert.match(T.qaCorrections(qf, ft), /product 1 does not show the real fit of the chosen size M — it must visibly show: chest is tight by about 3 cm.*\(top looks regular fit/);
assert.equal(T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9, fit_match: 6 }, { n: 2, match: 9, fit_match: null }], framing: 9 }, ft).verdict, 'pass');
assert.equal(T.normalizeQa({ identity: 9, items: [{ n: 1, match: 9 }, { n: 2, match: 9 }], framing: 9 }, targets).items[0].fit_match, undefined, 'no fit_match key without fit');
// 快取鍵
const sM = T.fitSig([{ type: 'top', fit: { size: 'M' } }, { type: 'bottom' }]), sL = T.fitSig([{ type: 'top', fit: { size: 'L' } }, { type: 'bottom' }]);
assert.match(sM, /^-s[0-9a-f]{8}$/); assert.notEqual(sM, sL); assert.equal(T.fitSig([{ type: 'top' }]), '', 'no size → legacy key');

/* ---------- handleTryon：不同尺寸查不同快取；fit 存進 job ---------- */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
const keyQueries = [];
genHook = (url, opts) => {
  if (opts.method === 'PATCH' || opts.method === 'POST') return res([]);
  const m = /job->>key=eq\.([^&]+)/.exec(decodeURIComponent(url));
  if (m) { keyQueries.push(m[1]); return res([{ id: 9, views: { result: { image_urls: ['https://x/r.jpg'], fit: [] } } }]); }
  return res([]);
};
const tryon = async (size) => (await T.handleTryon(new Request('https://w/api/tryon', { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ async: true, key: 'abcdef0123456789', person: PNG, items: [{ type: 'top', image: PNG, fit: { size, zones: [{ zone: 'chest', delta_cm: -2, verdict: 'snug' }] } }], body: { height_cm: 170 } }) }), env, {}, null)).json();
let tr = await tryon('M'); assert.equal(tr.cached, true);
tr = await tryon('L'); assert.equal(tr.cached, true);
assert.equal(keyQueries.length, 2); assert.notEqual(keyQueries[0], keyQueries[1], 'size M and L use different cache keys');
assert.ok(keyQueries[0].startsWith('abcdef0123456789-s'), keyQueries[0]);

/* ---------- /api/sizechart ---------- */
storageHook = (url) => url.includes('/public/sizecharts/42.json') ? res({ unit: 'cm', kind: 'garment', sizes: { M: { chest: 100 } } }) : res({ error: 'not found' }, 400);
let sc = await T.handleSizechart(env, {}, new URL('https://w/api/sizechart?id=42'));
assert.equal(sc.status, 200); assert.match(sc.headers.get('Cache-Control'), /max-age=86400/); assert.equal((await sc.json()).sizes.M.chest, 100);
storageHook = (url) => url.includes('/public/results/sizecharts/43.json') ? res({ unit: 'cm', kind: 'body', sizes: { S: { chest: 84 } } }) : res({ error: 'not found' }, 400);
sc = await T.handleSizechart(env, {}, new URL('https://w/api/sizechart?id=43')); assert.equal(sc.status, 200, 'falls back to results/sizecharts');
sc = await T.handleSizechart(env, {}, new URL('https://w/api/sizechart?id=44')); assert.equal(sc.status, 404); assert.ok((await sc.json()).error);
sc = await T.handleSizechart(env, {}, new URL('https://w/api/sizechart?id=abc')); assert.equal(sc.status, 400);
genHook = null; storageHook = null;

console.log('test_quality: all assertions passed');
console.log('vision calls in paid flow: captions 1 + QA per attempt; generations in retry flow: 2');

/* ---------- 商品圖模特兒身上的其他衣服：明確排除 ---------- */
{ const st = [{ type: 'bottom', image_url: 'https://x/p.jpg' }];
  const caps = T.parseCaptions({ items: [{ n: 1, description: 'Olive wide-leg trousers.', other_garments: ['black bomber jacket', 'none'] }] }, st);
  assert.deepEqual(caps[0].others, ['black bomber jacket']);
  const pr = T.outfitPrompt(st, '', '', { captions: caps });
  assert.match(pr, /The model in Image 2 also wears black bomber jacket — these are NOT products/);
  assert.match(pr, /From Image 2 take only the/); assert.match(pr, /Do NOT mirror or flip/);
  console.log('other-garment exclusion: ok'); }

/* ---------- FASHN 優先：平衡模式 → 不過關就換整套引擎重做一次 → 挑最好的一張；兩張都明顯不合格則不收費 ---------- */
{ const fashn = []; const _f = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { if (/queue\.fal\.run\/fal-ai\/fashn/.test(String(url))) { const b = JSON.parse(opts.body); fashn.push(b); calls.submits.push({ url: String(url), fashn: b }); const k = calls.submits.length; return res({ status_url: `https://queue.fal.run/status/${k}`, response_url: `https://queue.fal.run/response/${k}` }); } if (String(url).includes('/rest/v1/rpc/')) { calls.rpc = (calls.rpc || []).concat([JSON.parse(opts.body)]); return res(true); } return _f(url, opts); };
  const top = { type: 'top', category: 'tops', image_url: 'https://img/top.jpg', photo_type: null };
  const fresh = extra => { calls.vision.length = 0; calls.submits.length = 0; fashn.length = 0; calls.rpc = []; row.status = 'working'; row.image_url = null; row.views = null; row.cost = 1; row.free_used = 0;
    row.job = { v: 1, lock_until: 0, touched: new Date().toISOString(), tok: 't', person_url: PERSON, meta: [{ type: 'top', fit: null }], prefetch: false, pf: 0, aspect: 'auto', hires: true, key: 'k2', pv: null, first: 'fashn', t0: Date.now(),
      steps: [{ ...top }, { type: 'qa' }], item_steps: [top], engine: 'outfit', chains: [{ i: 0, cur: PERSON, req: null }], want_views: false, views: null, views_error: null, hints: '', face_hint: '', pay: 1, free: 0, free_left: 2, cost: 1, ...extra }; queueStatus = []; };
  fresh();
  visionQueue = [
    { items: [{ n: 1, description: 'Light blue sleeveless top', other_garments: [] }] },
    { identity: 10, items: [{ n: 1, match: 8, issue: '' }], framing: 10, extra_items: ['black bomber jacket'], verdict: 'pass' },
    { identity: 9, items: [{ n: 1, match: 9, issue: '' }], framing: 9, minor_extras: ['socks'], verdict: 'retry' } ];
  let r = await pollOnce(); assert.equal(r.status, 'running'); assert.equal(fashn.length, 1, 'first poll submits FASHN without waiting for captions'); assert.equal(fashn[0].mode, 'balanced'); assert.equal(calls.vision.length, 0);
  r = await pollOnce();   // 規格（與 FASHN 同時）→ FASHN 完成 → 先回報「圖好了、檢查中」
  assert.equal(r.status, 'running'); assert.equal(r.checking, true); assert.ok(r.preview && r.preview.checking && r.preview.url, 'picture is shown while it is being checked'); assert.equal(calls.vision.length, 1);
  r = await pollOnce();   // 品質檢查不過（多了外套）→ 同一輪改送整套引擎
  assert.equal(r.status, 'running'); assert.equal(row.job.retries, 1); assert.equal(fashn.length, 1, 'no second FASHN attempt'); assert.match(calls.submits[1].url, /nano-banana-2\/edit/); assert.match(calls.submits[1].prompt, /PREVIOUS ATTEMPT WAS REJECTED.*black bomber jacket/); assert.equal(r.progress.fixing, true); assert.ok(!r.preview, 'rejected picture is no longer shown');
  r = await poll();       // 整套引擎完成 → 檢查（模型自己寫 retry，但只有襪子這種小東西 → 依規則算過關）→ 收尾
  assert.equal(r.status, 'ok'); assert.equal(r.result.quality.retried, true); assert.ok(!r.result.not_charged); assert.equal(calls.submits.length, 2, 'at most 2 generations');
  assert.ok(r.result.marks.some(m => /^qa:retry\[extra\]/.test(m[0])) && r.result.marks.some(m => m[0] === 'qa:pass'), 'step timing marks with reasons'); assert.equal(r.result.qa_log.length, 2);
  // 兩張都明顯不合格 → 圖照給，但不收費（退回已扣的點）
  fresh();
  visionQueue = [ { items: [{ n: 1, description: 'Light blue sleeveless top' }] },
    { identity: 9, items: [{ n: 1, match: 3, issue: 'completely different top' }], framing: 10 },
    { identity: 9, items: [{ n: 1, match: 4, issue: 'still wrong' }], framing: 10 } ];
  r = await pollOnce(); r = await poll(); r = r.status === 'ok' ? r : await poll(); r = r.status === 'ok' ? r : await poll();
  assert.equal(r.status, 'ok'); assert.equal(r.result.not_charged, true); assert.equal(r.result.charged, 0); assert.deepEqual(calls.rpc.map(x => x.p_amount), [1], 'the 1 point is refunded once'); assert.equal(row.cost, 0);
  // FASHN 直接失敗（照片被擋等）→ 不讓整筆失敗，改用整套引擎
  fresh();
  visionQueue = [{ items: [{ n: 1, description: 'Light blue sleeveless top' }] }, { identity: 9, items: [{ n: 1, match: 9 }], framing: 9, verdict: 'pass' }];
  queueStatus = [];
  r = await pollOnce(); assert.equal(fashn.length, 1);
  queueStatus = ['FAILED'];
  r = await poll(); assert.equal(r.status, 'running', 'FASHN failure does not fail the job'); assert.ok(row.job.fashn_failed); assert.equal(row.job.steps[0].type, 'outfit');
  queueStatus = [];
  r = await poll(); r = r.status === 'ok' ? r : await poll();
  assert.equal(r.status, 'ok'); assert.match(calls.submits[calls.submits.length - 1].url, /nano-banana-2\/edit/); assert.ok(r.result.fashn_failed);
  // 衣服＋鞋子：鞋子那一步動到姿勢 → 從「只換好衣服」那張再做一次鞋子；還是動到 → 交出只換好衣服的那張，並告知鞋子沒換上
  { const shoes = { type: 'shoes', image_url: 'https://img/shoes.jpg' };
    fresh({ steps: [{ ...top }, { type: 'outfit', engine: 0, only: ['shoes'] }, { type: 'qa' }], item_steps: [top, shoes], meta: [{ type: 'top', fit: null }, { type: 'shoes', fit: null }], pay: 2, cost: 2 });
    visionQueue = [ { items: [{ n: 1, description: 'Light blue top' }, { n: 2, description: 'White clogs' }] },
      { identity: 9, items: [{ n: 1, match: 9 }, { n: 2, match: 9 }], framing: 10, pose_changed: true },
      { identity: 9, items: [{ n: 1, match: 9 }, { n: 2, match: 9 }], framing: 10, pose_changed: true } ];
    r = await pollOnce();                       // 送出 FASHN 上衣
    r = await pollOnce();                       // 規格 → 上衣完成 → 送出鞋子（整套引擎，只換鞋）
    assert.equal(calls.submits.length, 2); assert.match(calls.submits[1].url, /nano-banana-2/); const base = row.job.chains[0].base; assert.ok(base, 'clothes-only picture remembered');
    assert.deepEqual(calls.submits[1].images, [base, 'https://img/shoes.jpg'], 'shoe step edits the FASHN result, shoe image only'); assert.match(calls.submits[1].prompt, /change ONLY the items listed above/);
    r = await poll();                           // 鞋子完成 → 檢查：姿勢變了 → 從 base 再做一次鞋子
    assert.equal(row.job.retries, 1); assert.equal(calls.submits.length, 3); assert.deepEqual(calls.submits[2].images, [base, 'https://img/shoes.jpg']); assert.match(calls.submits[2].prompt, /pose changed/);
    r = await poll(); r = r.status === 'ok' ? r : await poll();
    assert.equal(r.status, 'ok'); assert.deepEqual(r.result.extras_dropped, ['shoes']); assert.equal(r.result.dropped_not_charged, 1); assert.equal(r.result.charged, 1, 'only the top is charged'); assert.deepEqual(calls.rpc.map(x => x.p_amount), [1], 'the shoe point is refunded'); assert.equal(r.result.image_urls[0] === base || /front-0-/.test(r.result.image_urls[0]), true); assert.ok(!r.result.not_charged); assert.equal(calls.submits.length, 3); }
  globalThis.fetch = _f; console.log('fashn ladder + fallback: ok'); }
