// 生圖引擎比較（會花 AI 費用）：同一組人物照＋商品，分別用 Nano Banana 2 / Nano Banana Pro / FASHN v1.6 / Kling Kolors v1.5 生成，存到 out/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
globalThis.__TRYON_TEST__ = true;
await import('../worker/worker.js');
const T = globalThis.__tryonTest;
const KEY = process.env.FAL_KEY, API = 'https://tryon-api.frankccc199.workers.dev';
const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', 'Origin': 'https://frankf19-19.github.io' };
mkdirSync('out', { recursive: true });
const CASES = JSON.parse(process.env.CASES || '[["qa/px_7208431.jpg",60,"bottom"],["qa/px_6513371.jpg",13,"top"],["qa/real_f.jpg",3,"top"],["qa/px_8811247.jpg",1860,"bottom"]]');
const ENGINES = (process.env.ENGINES || 'nb2,nbpro,fashn,kling').split(',');
const uri = (b, mime = 'image/jpeg') => `data:${mime};base64,${Buffer.from(b).toString('base64')}`;
async function falRun(model, input) {
  const r = await fetch('https://queue.fal.run/' + model, { method: 'POST', headers: { Authorization: 'Key ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const j = await r.json(); if (!j.status_url) throw new Error('submit ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await new Promise(z => setTimeout(z, 3000));
    const s = await (await fetch(j.status_url, { headers: { Authorization: 'Key ' + KEY } })).json();
    if (s.status === 'COMPLETED') { const out = await (await fetch(j.response_url, { headers: { Authorization: 'Key ' + KEY } })).json(); return { out, secs: Math.round((Date.now() - t0) / 1000) }; }
    if (s.status === 'FAILED' || s.error) throw new Error('failed ' + JSON.stringify(s).slice(0, 300));
  }
  throw new Error('timeout');
}
const pickUrl = o => (o.images && o.images[0] && (o.images[0].url || o.images[0])) || (o.image && o.image.url) || null;
const report = [];
for (const [ci, [personPath, pid, type]] of CASES.entries()) {
  const person = uri(readFileSync(personPath));
  const g = Buffer.from(await (await fetch(`${API}/api/img?id=${pid}`, { headers: UA })).arrayBuffer());
  writeFileSync(`out/c${ci}_garment.jpg`, g); writeFileSync(`out/c${ci}_person.jpg`, readFileSync(personPath));
  const garment = uri(g);
  const steps = [{ type, image_url: 'x' }];
  const prompt = T.outfitPrompt(steps, '', '', {});
  const jobs = {
    nb2: () => falRun('fal-ai/nano-banana-2/edit', { prompt, image_urls: [person, garment], num_images: 1, output_format: 'jpeg', resolution: '2K' }),
    nbpro: () => falRun('fal-ai/nano-banana-pro/edit', { prompt, image_urls: [person, garment], num_images: 1, output_format: 'jpeg', resolution: '2K' }),
    fashn: () => falRun('fal-ai/fashn/tryon/v1.6', { model_image: person, garment_image: garment, category: type === 'top' ? 'tops' : type === 'bottom' ? 'bottoms' : 'one-pieces', mode: 'quality', garment_photo_type: 'auto', output_format: 'jpeg' }),
    kling: () => falRun('fal-ai/kling/v1-5/kolors-virtual-try-on', { human_image_url: person, garment_image_url: garment }),
    fashn_b: () => falRun('fal-ai/fashn/tryon/v1.6', { model_image: person, garment_image: garment, category: type === 'top' ? 'tops' : type === 'bottom' ? 'bottoms' : 'one-pieces', mode: 'balanced', garment_photo_type: 'auto', output_format: 'jpeg' }),
    fashn_p: () => falRun('fal-ai/fashn/tryon/v1.6', { model_image: person, garment_image: garment, category: type === 'top' ? 'tops' : type === 'bottom' ? 'bottoms' : 'one-pieces', mode: 'performance', garment_photo_type: 'auto', output_format: 'jpeg' }),
    fashn_seg: () => falRun('fal-ai/fashn/tryon/v1.6', { model_image: person, garment_image: garment, category: type === 'top' ? 'tops' : type === 'bottom' ? 'bottoms' : 'one-pieces', mode: 'quality', garment_photo_type: 'auto', segmentation_free: false, output_format: 'jpeg' }),
    fashn_model: () => falRun('fal-ai/fashn/tryon/v1.6', { model_image: person, garment_image: garment, category: type === 'top' ? 'tops' : type === 'bottom' ? 'bottoms' : 'one-pieces', mode: 'quality', garment_photo_type: 'model', output_format: 'jpeg' }),
    fmax1: () => falRun('fal-ai/fashn/tryon/max', { model_image: person, product_image: garment, generation_mode: 'fast', resolution: '1k', output_format: 'jpeg' }),
    fmax2: () => falRun('fashn/tryon/max', { model_image: person, product_image: garment, generation_mode: 'fast', resolution: '1k', output_format: 'jpeg' }),
    fmax3: () => falRun('fal-ai/fashn/tryon-max', { model_image: person, product_image: garment, generation_mode: 'fast', resolution: '1k', output_format: 'jpeg' }),
  };
  await Promise.all(ENGINES.map(async e => {
    try {
      const { out, secs } = await jobs[e](); const u = pickUrl(out);
      const b = Buffer.from(await (await fetch(u)).arrayBuffer()); writeFileSync(`out/c${ci}_${e}.jpg`, b);
      report.push({ case: ci, engine: e, secs, ok: true });
    } catch (err) { report.push({ case: ci, engine: e, ok: false, error: String(err.message).slice(0, 300) }); }
  }));
}
writeFileSync('out/report.json', JSON.stringify({ engines: ENGINES, cases: CASES, report }, null, 1));
console.log(JSON.stringify(report));
