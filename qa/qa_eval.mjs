// 品質檢查（守門員）準確度評估：用人工標好「該過／該退」的生成結果，量每個看圖模型判對幾張、花幾秒。
// 重點看「該退卻放行」的數量——那代表壞圖會送到使用者手上。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
globalThis.__TRYON_TEST__ = true;
await import('../worker/worker.js');
const T = globalThis.__tryonTest;
const KEY = process.env.FAL_KEY, RAW = 'https://raw.githubusercontent.com/frankf19-19/fitroom/' + (process.env.GITHUB_SHA || 'main') + '/qa/qa_eval/';
const cases = JSON.parse(readFileSync('qa/qa_eval/cases.json', 'utf8'));
mkdirSync('out', { recursive: true });
let models = (process.env.MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
let catalog = [];
try {
  const j = await (await fetch('https://openrouter.ai/api/v1/models')).json();
  catalog = (j.data || []).filter(m => /^(google\/gemini|openai\/gpt)/.test(m.id) && ((m.architecture && (m.architecture.input_modalities || [])) || []).includes('image') && !/image|audio|tts|realtime|search|codex|embedding/.test(m.id))
    .map(m => ({ id: m.id, created: m.created, in: Number(m.pricing && m.pricing.prompt) * 1e6, out: Number(m.pricing && m.pricing.completion) * 1e6 })).sort((a, b) => b.created - a.created);
} catch (e) { console.log('catalog error', e.message); }
writeFileSync('out/catalog.json', JSON.stringify(catalog.slice(0, 40), null, 1));
if (!models.length) {
  const cheapNew = catalog.filter(m => /flash|mini|nano|lite/.test(m.id) && m.in <= 1.0).slice(0, 4).map(m => m.id);
  models = [...new Set(['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', ...cheapNew])];
}
console.log('models', models);
const NEEDS_REASONING = new Set();
async function ask(model, prompt, imgs) {
  const t0 = Date.now();
  const send = extra => fetch('https://fal.run/openrouter/router/vision', { method: 'POST', headers: { Authorization: 'Key ' + KEY, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model, prompt, system_prompt: 'You are a precise assistant. Reply with a single valid JSON object only, no markdown.', temperature: 0.3, max_tokens: 3000, image_urls: imgs, ...extra }) });
  let r = await send(NEEDS_REASONING.has(model) ? { reasoning: true } : {});
  let t = await r.text();
  if (!r.ok && /Reasoning is mandatory/i.test(t)) { NEEDS_REASONING.add(model); r = await send({ reasoning: true }); t = await r.text(); }
  const secs = (Date.now() - t0) / 1000;
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160));
  const d = JSON.parse(t); const txt = String(d.output ?? d.text ?? '');
  const m = txt.replace(/```json|```/g, '').match(/\{[\s\S]*\}/); if (!m) throw new Error('no json: ' + txt.slice(0, 120));
  return { json: JSON.parse(m[0]), secs };
}
const report = {};
for (const model of models) {
  const rows = [];
  const queue = cases.slice();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const c = queue.shift();
      const targets = [{ i: 0, n: 1, type: c.type, url: RAW + c.garment, fit: null }];
      try {
        const { json, secs } = await ask(model, T.qaPrompt(targets, null), [RAW + c.result, RAW + c.person, RAW + c.garment]);
        const qa = T.normalizeQa(json, targets);
        rows.push({ id: c.id, expect: c.expect, got: qa.verdict, secs: +secs.toFixed(1), match: qa.items[0] && qa.items[0].match, identity: qa.identity, framing: qa.framing, flags: ['mirrored', 'body_changed', 'pose_changed', 'leftover', 'color_wrong', 'zoomed'].filter(k => qa[k]).concat(qa.extra_items.length ? ['extra:' + qa.extra_items.join('/')] : []), issue: qa.items[0] && qa.items[0].issue });
      } catch (e) { rows.push({ id: c.id, expect: c.expect, got: 'error', error: String(e.message).slice(0, 140) }); }
    }
  }));
  const clear = rows.filter(r => r.expect !== 'soft'), ok = clear.filter(r => r.got === r.expect);
  const secs = rows.filter(r => r.secs).map(r => r.secs).sort((a, b) => a - b);
  report[model] = { correct: ok.length, of: clear.length, false_pass: clear.filter(r => r.expect === 'retry' && r.got === 'pass').map(r => r.id), false_retry: clear.filter(r => r.expect === 'pass' && r.got === 'retry').map(r => r.id + ' [' + (r.flags || []).join(',') + ' m' + r.match + ' i' + r.identity + ' f' + r.framing + ']'), errors: rows.filter(r => r.got === 'error').map(r => r.id + ': ' + r.error).slice(0, 3),
    needs_reasoning: NEEDS_REASONING.has(model), soft: rows.filter(r => r.expect === 'soft').map(r => r.id + '→' + r.got + ' [' + (r.flags || []).join(',') + ']'), median_secs: secs[Math.floor(secs.length / 2)], max_secs: secs[secs.length - 1], rows };
  console.log(model, JSON.stringify({ ...report[model], rows: undefined }));
}
writeFileSync('out/report.json', JSON.stringify(report, null, 1));
