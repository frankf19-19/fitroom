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

const res = (obj, status = 200, type = 'application/json') => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': type } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (url.startsWith(SB + '/auth/v1/user')) return res({ id: 'u1', email: 'a@b.c' });
  if (url.startsWith(SB + '/rest/v1/profiles')) return res([{ id: 'u1', credits: 5 }]);
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
assert.equal(T.VERSION, '2.12.0');

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
const poll = async () => { const r = await T.handleTryonStatus(new Request('https://w/api/tryon/status?id=1', { headers: { Authorization: 'Bearer tok' } }), env, {}, new URL('https://w/api/tryon/status?id=1')); return r.json(); };

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
assert.equal(calls.submits.length, 2); assert.match(calls.submits[1].url, /nano-banana-pro\/edit/);
assert.match(calls.submits[1].prompt, /PREVIOUS ATTEMPT WAS REJECTED FOR: product 2 \(BOTTOM.*\) does not match its product photo: trousers are slim, not balloon-leg\. Fix these specifically\./);
assert.equal(row.job.retries, 1); assert.equal(row.job.qa.verdict, 'retry'); assert.equal(row.job.steps[0].engine, 1);
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
row.job = { ...row.job, v: 1, lock_until: 0, touched: new Date().toISOString(), chains: [{ i: 0, cur: PERSON, req: null }], steps: [{ type: 'outfit', engine: 0 }, { type: 'qa' }], front: undefined, qa: undefined, qa_history: undefined, retries: 0, fix_notes: undefined, cap_done: false, captions: null, t: undefined };
visionQueue = [new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom')];   // 規格兩個模型都失敗、QA 兩個模型都失敗
queueStatus = ['COMPLETED'];
s = await poll(); assert.equal(s.status, 'running'); assert.equal(calls.submits.length, 1); assert.equal(row.job.captions, null); assert.match(row.job.cap_error, /AI 文字服務/);
assert.ok(!/specification/.test(calls.submits[0].prompt));
s = await poll(); assert.equal(s.status, 'ok'); assert.equal(s.result.quality.identity, null); assert.equal(s.result.quality.retried, false); assert.equal(calls.submits.length, 1);

calls.vision.length = 0; calls.submits.length = 0;
row.status = 'running'; row.image_url = null; row.views = null;
row.job = { ...row.job, v: 1, lock_until: 0, touched: new Date().toISOString(), prefetch: false, chains: [{ i: 0, cur: PERSON, req: null }], steps: [{ type: 'outfit', engine: 0 }], front: undefined, qa: undefined, qa_history: undefined, retries: 0, fix_notes: undefined, cap_done: false, captions: null, t: undefined };
// 模擬預先合成：prefetch 為 true 時 job 會被加密（sealJob），這裡只驗證「不做規格、沒有 qa 步驟」的分支
row.job.prefetch = true; row.job.pf = 1;
visionQueue = [{ items: [] }];
queueStatus = ['COMPLETED'];
s = await poll(); assert.equal(s.status, 'running'); assert.equal(calls.vision.length, 0, 'prefetch: no caption call'); assert.equal(calls.submits.length, 1);

console.log('test_quality: all assertions passed');
console.log('vision calls in paid flow: captions 1 + QA per attempt; generations in retry flow: 2');
