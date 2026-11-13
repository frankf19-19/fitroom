/**
 * 試穿吧 TryOn — 後端 Worker
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
 *   FREE_MODE             "1"＝會員限時免費（試穿不扣點）；FREE_MODE_DAILY 每人每天件數（預設 30）、FREE_MODE_GLOBAL 全站每天筆數（預設 400）
 *   ADMIN_EMAILS          管理者 Email，逗號分隔（Text）
 *   ECPAY_MERCHANT_ID     綠界特店編號（Text）；留空則使用綠界測試環境
 *   ECPAY_HASH_KEY        綠界 HashKey（Secret）
 *   ECPAY_HASH_IV         綠界 HashIV（Secret）
 */

const VERSION = '2.27.1';
const RUNNING_STALE_MS = 3 * 60 * 1000;    // 進行中超過 3 分鐘沒有進度視為失敗並退點
const TRYON_BUDGET_MS = 8 * 60 * 1000;      // 單次合成整體上限
const POLL_BUDGET_MS = 25000;                // 單次輪詢：超過就不再開始新步驟
const POLL_HARD_MS = 70000;                  // 單次輪詢：所有外部呼叫的硬上限
const LOCK_MS = 150000;                      // 輪詢鎖（> POLL_HARD_MS + 儲存等無逾時的呼叫）
const PREFETCH_DAILY = 5;                    // 每人每天預先合成上限
const FAL_QUEUE = 'https://queue.fal.run/fal-ai/fashn/tryon/v1.6';
// 整套換裝引擎（一次把所有單品穿上；可改變版型，如短褲→寬褲）。依序備援
const FASHN_MODE = 'balanced';   // 第一次用 FASHN 平衡模式（實測畫質與 quality 相近、每件快 5–10 秒）；重做時才用 quality
const JOB_MAX_AGE_MS = 12 * 60 * 1000;   // 一筆試穿從開始（或認領）起最久 12 分鐘，超過就收尾／退點
// 會員限時免費（FREE_MODE=1）：試穿不扣點，改用「每人每天免費件數」(FREE_MODE_DAILY，預設 30) 當上限；
// 另有全站每天上限 (FREE_MODE_GLOBAL，預設 400 筆) 保護儲值不被刷爆。360° 影片成本高，仍然要用點數。
const freeMode = env => String(env.FREE_MODE || '') === '1';
const freeDailyOf = env => freeMode(env) ? Number(env.FREE_MODE_DAILY || 30) : Number(env.FREE_DAILY || 2);
const MAX_CONCURRENT = 3;   // 每人同時進行中的試穿上限
const OUTFIT_ENGINES = ['https://queue.fal.run/fal-ai/nano-banana-2/edit', 'https://queue.fal.run/fal-ai/nano-banana-pro/edit'];
const ITEM_LABEL = { top: 'TOP or OUTERWEAR (upper body garment)', bottom: 'BOTTOM (trousers / skirt / shorts)', dress: 'ONE-PIECE (dress / jumpsuit)', shoes: 'SHOES', hat: 'HAT', accessory: 'ACCESSORY (bag / jewelry / glasses / watch)', hair: 'HAIRSTYLE reference' };
/* ---- 尺寸合身度：前端算好每個部位緊/鬆幾公分，這裡轉成看得見的畫面描述 ---- */
const FIT_ZONES = ['chest', 'shoulder', 'waist', 'hip', 'length', 'sleeve', 'inseam', 'thigh'];
const FIT_VERDICTS = ['tight', 'snug', 'fit', 'loose', 'short', 'long'];
const BODY_KEYS = { height_cm: [80, 230], weight_kg: [20, 250], chest_cm: [40, 200], waist_cm: [30, 200], hip_cm: [40, 200], shoulder_cm: [20, 80], inseam_cm: [30, 120] };
const cleanStr = (v, n = 300) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '';
// items[i].fit 驗證：格式不對就當作沒給（不擋請求）
function cleanFit(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const size = cleanStr(f.size, 20);
  const zones = (Array.isArray(f.zones) ? f.zones : []).slice(0, 10).map(z => {
    if (!z || typeof z !== 'object') return null;
    const zone = String(z.zone || '').toLowerCase(), verdict = String(z.verdict || '').toLowerCase();
    if (!FIT_ZONES.includes(zone) || !FIT_VERDICTS.includes(verdict)) return null;
    let d = Number(z.delta_cm); d = Number.isFinite(d) ? Math.max(-60, Math.min(60, Math.round(d * 10) / 10)) : null;
    return { zone, delta_cm: d, verdict };
  }).filter(Boolean);
  const summary_en = cleanStr(f.summary_en, 300);
  if (!size && !zones.length && !summary_en) return null;
  return { size: size || null, zones, summary_en: summary_en || null };
}
function cleanBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(BODY_KEYS)) { const n = Number(b[k]); if (b[k] != null && b[k] !== '' && Number.isFinite(n) && n >= lo && n <= hi) out[k] = Math.round(n * 10) / 10; }
  return Object.keys(out).length ? out : null;
}
function bodyLine(body) {
  if (!body) return '';
  const main = [body.height_cm ? body.height_cm + ' cm tall' : '', body.weight_kg ? body.weight_kg + ' kg' : ''].filter(Boolean).join(', ');
  const m = [['chest', body.chest_cm], ['waist', body.waist_cm], ['hip', body.hip_cm], ['shoulder width', body.shoulder_cm], ['inseam', body.inseam_cm]].filter(x => x[1]).map(x => `${x[0]} ${x[1]} cm`).join(', ');
  if (!main && !m) return '';
  return 'The customer is ' + (main || 'of the build shown') + (m ? ` (body measurements: ${m})` : '') + '. Use these numbers ONLY to judge how each garment fits and where hems and cuffs end; never reshape or resize the body — the body must look exactly as in Image 1.';
}
// 一個部位 → 具體畫面描述（緊：布料被撐開、橫向拉扯皺褶；鬆：多餘布料、垂直垂墜皺褶；短/長：下擺袖口落在身體哪裡）
function fitPhrases(fit, type = 'top') {
  if (!fit || !Array.isArray(fit.zones)) return [];
  const bottom = type === 'bottom';
  return fit.zones.map(z => {
    const a = z.delta_cm == null ? null : Math.abs(z.delta_cm);
    const by = a == null || a < 1 ? '' : ` by about ${Math.round(a)} cm`;
    const amt = a == null || a < 1 ? 'slightly ' : (a >= 6 ? 'clearly ' : '');
    const cm = a == null || a < 1 ? 'slightly' : `about ${Math.round(a)} cm`;
    const v = z.verdict;
    if (v === 'fit') return {
      chest: 'chest fits cleanly (smooth fabric with a little ease, no pulling, no excess)', shoulder: 'shoulder seams sit right on the shoulder point',
      waist: bottom ? 'waistband sits flat and closed at the natural waist with no gaping or digging in' : 'waist area hangs smoothly with normal ease', hip: 'fabric skims the hips smoothly',
      thigh: 'legs skim the thighs with normal ease', length: bottom ? 'trouser hem ends at the intended spot (just touching the top of the shoe)' : 'hem ends where it is designed to end on this body',
      sleeve: 'sleeves end at the wrist bone', inseam: 'trouser hem ends at the ankle with a clean break'
    }[z.zone];
    if (v === 'tight' || v === 'snug') {
      const t = v === 'tight';
      return {
        chest: t ? `chest is ${amt}tight${by} (fabric stretched and pulling across the chest with horizontal tension wrinkles, buttons/closure straining, fabric clinging to the torso)` : 'chest is snug (close to the body with light tension, no excess fabric)',
        shoulder: t ? `shoulders are ${amt}narrow${by} (shoulder seams sit inside the shoulder point, sleeve heads pull and fabric strains across the upper back)` : 'shoulder seams sit just inside the shoulder point (close, structured fit)',
        waist: bottom ? (t ? `waistband is ${amt}tight${by} (waistband digs in, fabric pulls with horizontal strain lines, closure under tension)` : 'waistband is snug (sits firmly at the waist, no gap)') : (t ? `waist is ${amt}tight${by} (fabric clings to the midsection with horizontal pull lines)` : 'waist is close-fitting (follows the body at the midsection)'),
        hip: t ? `hips are ${amt}tight${by} (fabric stretched over the hips and seat with horizontal pull lines, pockets pulled open)` : 'hips are snug (fabric follows the hip line closely)',
        thigh: t ? `thighs are ${amt}tight${by} (fabric clings to the thighs with horizontal strain wrinkles)` : 'thighs are snug (legs follow the thigh closely)',
        sleeve: t ? `sleeves are ${amt}tight${by} (sleeves cling to the upper arms with pulling at the elbow)` : 'sleeves are close-fitting on the arms',
        length: t ? `garment is ${amt}too short in the body${by}` : 'length is on the short side', inseam: t ? `trousers pull up${by}` : 'trousers sit slightly high'
      }[z.zone];
    }
    if (v === 'loose') return {
      chest: `chest is ${amt}loose${by} (extra fabric, soft vertical drape folds, the garment stands away from the torso)`,
      shoulder: `shoulder seams sit ${cm} past the shoulder point (dropped shoulder, seams hanging down onto the upper arm)`,
      waist: bottom ? `waistband is ${amt}loose${by} (waistband gapes at the back, fabric bunches and gathers, trousers sit lower on the hips)` : `waist is ${amt}loose${by} (boxy, fabric hangs straight down from the chest with vertical folds)`,
      hip: `hips are ${amt}loose${by} (fabric hangs straight off the hips with extra room and soft folds)`,
      thigh: `thighs are ${amt}loose${by} (roomy legs, fabric drapes with vertical folds instead of touching the thigh)`,
      sleeve: `sleeves are ${amt}roomy${by} (wide sleeves with extra fabric and soft folds)`,
      length: `garment is ${amt}long${by}`, inseam: `trousers are ${amt}long${by}`
    }[z.zone];
    if (v === 'short') return {
      length: bottom ? `trouser hem ends ${cm} higher than intended (above the ankle bone, ankle exposed)` : (type === 'dress' ? `hem ends ${cm} higher on the leg than on the product model` : `hem ends ${cm} higher than intended (ends higher on the torso, toward the waist; may expose the waistband when the arms lift)`),
      sleeve: `sleeves end ${cm} above the wrist bone (wrist exposed)`, inseam: `trouser hem ends ${cm} above the ankle bone (ankle exposed, cropped look)`,
      chest: `the top is short across the chest${by}`, shoulder: `shoulders are narrow${by}`, waist: `waist sits high${by}`, hip: `the garment ends above the hips${by}`, thigh: `legs ride up on the thigh${by}`
    }[z.zone];
    if (v === 'long') return {
      length: bottom ? `trousers are ${cm} too long (hem stacks and puddles in folds over the shoes)` : (type === 'dress' ? `hem ends ${cm} lower on the leg than on the product model` : `hem ends ${cm} lower than intended (extends past the hips, covering more of the seat)`),
      sleeve: `sleeves extend ${cm} past the wrist bone (covering part of the hand, fabric bunching at the cuff)`, inseam: `trousers are ${cm} too long (fabric stacks in folds at the ankle and over the shoes)`,
      chest: `the top is long across the chest${by}`, shoulder: `shoulder seams drop${by}`, waist: `waist sits low${by}`, hip: `the garment extends below the hips${by}`, thigh: `legs hang long${by}`
    }[z.zone];
    return null;
  }).filter(Boolean);
}
// 一件商品的合身度提示句（給生成模型）
function fitLine(fit, type, n) {
  if (!fit) return '';
  const ph = fitPhrases(fit, type);
  if (!fit.size && !ph.length && !fit.summary_en) return '';
  return `Product ${n} is size ${fit.size || 'as selected'}.` + (ph.length ? ' Render its real fit on this body: ' + ph.join('; ') + '.' : '') + (fit.summary_en ? ' Fit summary: ' + fit.summary_en : '');
}
// 快取鍵：不同尺寸絕不共用結果（沒有尺寸資訊時維持舊鍵）
function fitSig(items) {
  const sizes = (items || []).map(it => (it && it.fit && it.fit.size) ? `${it.type}:${it.fit.size}` : '');
  if (!sizes.some(Boolean)) return '';
  let h = 0x811c9dc5; for (const ch of sizes.join('|')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return '-s' + h.toString(16).padStart(8, '0');
}
// opts.captions：與 steps 對齊的文字規格（看圖模型產生，可為 null）；opts.fixNotes：上一次品質檢查不通過的原因；opts.body：使用者身體尺寸
// 使用者選的穿法（上衣紮不紮、褲腳放下或反摺）→ 給生圖與品質檢查的文字；沒選回傳 ''
function wearOf(w) { const o = {}; if (w && (w.tuck === 'in' || w.tuck === 'out')) o.tuck = w.tuck; if (w && (w.hem === 'down' || w.hem === 'cuff')) o.hem = w.hem; return Object.keys(o).length ? o : null; }
function wearLine(w, types) {
  const out = [];
  if (w && w.tuck === 'in' && types.has('top')) out.push('the top is worn TUCKED INTO the waistband of the trousers or skirt all the way round, so the waistband is fully visible');
  if (w && w.tuck === 'out' && types.has('top')) out.push('the top is worn UNTUCKED: its whole hem is visible all the way round and lies on the OUTSIDE of the trousers or skirt, covering the waistband wherever the top is long enough; no part of the top goes inside the waistband, and do not add a belt');
  if (w && w.hem === 'down' && types.has('bottom')) out.push('trouser hems are worn down at their natural full length, not rolled or cuffed');
  if (w && w.hem === 'cuff' && types.has('bottom')) out.push('trouser hems are rolled up into a neat cuff (about 5 cm, one or two turns) so the ankle shows; ignore this if the bottom is a skirt or shorts');
  return out.join('; ');
}
function outfitPrompt(steps, hints, faceHint, opts = {}) {
  const captions = Array.isArray(opts.captions) ? opts.captions : [];
  const lines = [], specs = [], fits = []; let k = 2;
  const refs = steps.map((st, i) => {
    if (!st.image_url) return null;
    const n = k++;
    lines.push(`Image ${n} is a product photo of the ${ITEM_LABEL[st.type]} to put on the customer.`);
    const cap = captions[i] && captions[i].description ? String(captions[i].description).slice(0, 600) : '';
    if (cap) specs.push(`Product ${n - 1} specification (Image ${n}): ${cap}`);
    const oth = captions[i] && Array.isArray(captions[i].others) ? captions[i].others : [];
    if (oth.length) specs.push(`The model in Image ${n} also wears ${oth.join(', ')} — these are NOT products: do NOT put them on the customer.`);
    const fl = st.type !== 'hair' ? fitLine(st.fit, st.type, n - 1) : '';
    if (fl) fits.push(fl);
    return n;
  });
  const body = bodyLine(opts.body);
  const hairText = steps.find(st => st.type === 'hair' && !st.image_url && st.text);
  const types = new Set(steps.map(s => s.type));
  const hasHeight = /\b1\d{2}\s?cm\b|\bheight\b|\btall\b|\d\s?(ft|feet)\b/i.test(String(hints || '') + ' ' + body);
  const fix = opts.fixNotes ? String(opts.fixNotes).slice(0, 900) : '';
  return [
    'Virtual try-on photo edit for a fashion e-commerce app.',
    'Image 1 is the customer photo. ' + lines.join(' '),
    specs.length ? specs.join('\n') + '\nThe written specification and the product photo agree; follow both exactly.' : '',
    hairText ? `Also change the customer's hairstyle to: ${hairText.text}.` : '',
    'Produce a photo of the SAME customer from Image 1 now wearing exactly these products.',
    'GARMENT FIDELITY IS THE TOP PRIORITY. Copy each product exactly as it appears in its product photo:',
    '- identical silhouette, cut and proportions (wide or balloon-leg trousers must stay wide/balloon-shaped, oversized stays oversized, cropped stays cropped), the same length relative to the body, rise and fit' + (fits.length ? ' (except where the SIZE AND FIT notes below say this size sits differently on this body)' : '') + ';',
    '- identical color, fabric, texture, quilting and stitching, pattern, prints, logos, buttons, zippers, pockets, collar/hood and hem details;',
    '- worn the same way as in the product photo (jacket open or closed, sleeves, tucked or untucked). A hood stays DOWN behind the neck unless it is worn up in the product photo. Do not add hats, scarves or extra layers that were not provided.',
    'From each product photo use ONLY that product. Ignore the model wearing it, any other clothes they wear, the background and any text overlays.',
    refs.filter(Boolean).length ? 'STRICT: the models in the product photos often also wear OTHER garments (for example a jacket, coat, hoodie or top over trousers). Those are NOT products here and must NOT appear on the customer. ' + steps.filter(st => st.image_url).map((st, i) => `From Image ${refs.filter(Boolean)[i]} take only the ${ITEM_LABEL[st.type]}.`).join(' ') : '',
    types.has('bottom') ? 'BOTTOMS: the leg or skirt outline from hip to hem must match the product photo — flared or bootcut legs widen clearly below the knee exactly as much as in the product, wide legs stay wide, straight stays straight, skinny stays skinny. The hem ends at the same point on the body as on the product model (floor-length trousers cover the ankle and most of the shoe; a maxi skirt stays maxi; a mini stays mini). Never shorten, crop, taper or narrow them to follow the shape of what the customer wore before. A skirt is one continuous piece of fabric: no gap or hole between the legs.' : '',
    types.has('top') ? 'If the top is outerwear shown open over another garment, the customer keeps their own top underneath.' : '',
    "Fully replace the customer's current clothing in the provided categories (for example shorts become full-length trousers when the product is trousers). Keep the customer's clothing in categories that were not provided unchanged.",
    'IDENTITY AND SCENE MUST NOT CHANGE: same face, facial expression, ' + (types.has('hair') ? '' : 'hairstyle, ') + 'skin tone, body shape and proportions, pose, hands and anything held in the hands (for example a phone), background, mirror, lighting, camera angle and framing.',
    'Keep the exact body size: do not make the person bigger, wider, heavier, taller, slimmer or shorter. Do NOT mirror or flip the image: every object, the background and the hand holding the phone stay on the same side as in Image 1.',
    'Render each product at the correct physical scale for this person (sleeve, hem and trouser length end where they would on this body).' + (hasHeight ? " Use the customer's height given in the body notes to judge where hems and sleeves end." : ''),
    'Realistic fit and drape on this body with natural folds and shadows. Photorealistic. No text, no watermark. Keep the same aspect ratio and framing as Image 1.',
    body,
    fits.length ? 'SIZE AND FIT (the customer chose a specific size; the photo must visibly show how that size really fits this body):\n' + fits.join('\n') + '\nThe size only changes how the garment sits on the body (tension, wrinkles, drape, where seams, hems and cuffs land); it never changes the garment design, color, fabric, pattern or details. Do not "correct" a tight or loose fit into a perfect fit.' : '',
    hints ? 'Body notes: ' + hints : '', types.has('hair') && faceHint ? faceHint : '',
    wearLine(opts.wear, types) ? 'HOW THE CUSTOMER WANTS TO WEAR IT (this overrides how the product photo is styled; the garment design itself does not change): ' + wearLine(opts.wear, types) + '.' : '',
    opts.keepOutfit ? 'The customer in Image 1 is already wearing their new clothes: keep every garment, the pose and the person exactly as they are and change ONLY the items listed above.' : '',
    fix ? 'PREVIOUS ATTEMPT WAS REJECTED FOR: ' + fix + '. Fix these specifically.' : ''
  ].filter(Boolean).join('\n');
}
/* ---- 品質：單品文字規格（送出前）與結果品質檢查（送出後） ---- */
// 看圖模型（衣服描述＋品質檢查）。2026-11-12 用 22 張人工標記的生成圖實測（qa/qa_eval.mjs）：
//   gpt-6.1-terra：11 張壞圖抓到 10 張、中位數 2.8 秒；gemini-2.5-flash（原本的）只抓到 6–7 張；gemini-4-argon 全抓到但要 12 秒以上。
// 第一個失敗（下架、逾時）會自動換下一個。
const QA_MODELS = ['openai/gpt-6.1-terra', 'google/gemini-2.5-flash'];
const QA_TIMEOUT_MS = 12000;
const QA_MIN_ITEM = 7, QA_MIN_IDENTITY = 7, QA_MIN_FRAMING = 6, QA_MIN_FIT = 5;
// 有圖的單品（純文字髮型略過）：回傳 [{ i: item_steps 索引, n: 單品編號(1 起), type, url }]
function captionTargets(steps) {
  const out = []; let n = 1;
  (steps || []).forEach((st, i) => { if (st.image_url) out.push({ i, n: n++, type: st.type, url: st.image_url, fit: st.fit || null }); });
  return out;
}
function captionPrompt(targets) {
  return [
    'You are a fashion product cataloguer. You are given ' + targets.length + ' product photo(s), in order: ' + targets.map(t => `image ${t.n} = product ${t.n} (${ITEM_LABEL[t.type] || t.type})`).join('; ') + '.',
    'For EACH product write one precise, concrete description of the product itself (ignore the model, background and any text overlays). Include: exact color names, silhouette and fit (slim, straight, wide, balloon, oversized, cropped...), length relative to the body (e.g. hits mid-thigh, ankle length), rise for bottoms, sleeve type and length, neckline or collar, closure and its state (buttoned, zipped, open), fabric and texture, pattern / logos / prints and their placement, notable details (pockets, hood, drawstrings, hardware, pleats, slits), and how it is worn in the photo (tucked, open, hood down...). 2-4 sentences, English.',
    'Also list in "other_garments" every OTHER clothing item or accessory the model in that photo wears that is NOT this product (for example "black bomber jacket", "grey hoodie", "white T-shirt"), or [] if none. These will be explicitly excluded.',
    'Return ONLY JSON: {"items":[{"n":1,"type":"...","description":"...","other_garments":["..."]}, ...]} with one entry per product in the same order.'
  ].join('\n');
}
// 把模型回傳整理成與 item_steps 對齊的陣列（沒圖的位置為 null）
function parseCaptions(json, steps) {
  const targets = captionTargets(steps);
  const items = json && Array.isArray(json.items) ? json.items : [];
  const out = (steps || []).map(() => null);
  targets.forEach((t, k) => {
    const hit = items.find(x => x && Number(x.n) === t.n) || items[k];
    const d = hit && typeof hit.description === 'string' ? hit.description.trim() : '';
    const others = hit && Array.isArray(hit.other_garments) ? hit.other_garments.filter(x => typeof x === 'string' && x.trim() && !/^(none|n\/a|-)$/i.test(x.trim())).map(x => x.trim().slice(0, 60)).slice(0, 5) : [];
    if (d || others.length) out[t.i] = { n: t.n, type: t.type, description: d.slice(0, 600), others };
  });
  return out.some(Boolean) ? out : null;
}
// 有沒有「看得出來」的合身度要求（有部位資料才算；只有尺寸名稱不評 fit_match）
const hasFitZones = fit => !!(fit && Array.isArray(fit.zones) && fit.zones.length);
function qaPrompt(targets, captions, wear) {
  const wl = wearLine(wear, new Set(targets.map(t => t.type)));
  const specs = targets.map(t => { const c = captions && captions[t.i]; return `product ${t.n} (${ITEM_LABEL[t.type] || t.type}) = image ${t.n + 2}` + (c && c.description ? ': ' + c.description : '') + (c && c.others && c.others.length ? ` (the model there also wears ${c.others.join(', ')}, which must NOT appear on the customer)` : ''); });
  const fitT = targets.filter(t => hasFitZones(t.fit));
  const fitSpec = fitT.map(t => `product ${t.n} is size ${t.fit.size || '?'} and should visibly show: ${fitPhrases(t.fit, t.type).join('; ')}`);
  return [
    'You are a strict QA inspector for a virtual try-on service. Image 1 is the GENERATED result. Image 2 is the ORIGINAL customer photo. The remaining images are the product photos: ' + specs.join('; ') + '.',
    wl ? 'The customer asked for this styling: ' + wl + '. That styling is CORRECT even if the product photo is styled differently — do not lower any score for it; do lower the match score of that item if the requested styling is clearly NOT followed.' : '',
    'Score the result. identity (0-10): is the person in image 1 the same person as image 2 (face, expression, skin tone, hair unless a hairstyle product was given, body shape, pose, hands and held objects, background, lighting)? 10 = identical.',
    'For each product, match (0-10): does the garment worn in image 1 reproduce that product photo exactly (silhouette/cut, length on the body, color, fabric, pattern/logo/print, details, how it is worn)? 10 = exact copy. In "issue" state concretely what differs (e.g. "trousers are slim instead of wide-leg", "logo missing on chest"), or "" if nothing.',
    fitT.length ? 'EXPECTED SIZE FIT: ' + fitSpec.join('. ') + '. For each of these products also score fit_match (0-10): does the garment in image 1 visibly show this fit (tension and strain wrinkles where tight, extra fabric and drape where loose, hems and cuffs ending where stated)? A result that renders a clearly tight or loose size as a neutral regular fit gets fit_match 4 or lower. Mention a fit problem in "issue". For products without an expected fit, set fit_match to null.' : '',
    'framing (0-10): same crop, aspect ratio and camera angle as image 2. artifacts: list visible defects (extra limbs, warped hands, text, duplicated garments, floating items) or [].',
    'mirrored (true/false): is image 1 a left-right mirror of image 2 (background, objects or the hand holding the phone switched sides)?',
    'body_changed (true/false): does the person in image 1 look clearly bigger, wider, heavier, slimmer, taller or shorter than in image 2?',
    'pose_changed (true/false): is the pose different from image 2 (arms, hands, legs, head angle or body position moved)?',
    'color_wrong (true/false): is any product a clearly different color in image 1 than in its product photo (for example a light blue top rendered white, olive trousers rendered black)? Judge the garment color itself and allow for the lighting of image 2.',
    'zoomed (true/false): is the person noticeably larger or smaller in the frame than in image 2 (zoomed in or out, re-cropped, or moved to a different position)?',
    'leftover (true/false): are parts of the ORIGINAL garment that should have been replaced still visible in image 1 (old sleeves, collar, straps, hem or waistband poking out from under or around the new product)?',
    'extra_items: list MAJOR garments the person wears in image 1 that are NOT one of the products AND were NOT already worn in image 2 — outerwear (jacket, coat, hoodie), a different top, trousers, skirt, shorts, dress, hat, scarf or bag, typically copied from a product photo model — or []. Do NOT list socks, belts, jewelry, or an inner layer that only shows inside the opening of an open-front product (for example a top visible under an unbuttoned cardigan or jacket): put those in minor_extras instead.',
    'minor_extras: list such small additions (socks, belt, inner layer inside an open-front product), or [].',
    `verdict: "retry" if ANY product match < ${QA_MIN_ITEM}` + (fitT.length ? `, any fit_match < ${QA_MIN_FIT}` : '') + `, identity < ${QA_MIN_IDENTITY}, framing < ${QA_MIN_FRAMING}, mirrored, body_changed, pose_changed, color_wrong, zoomed, leftover or extra_items is not empty; otherwise "pass".`,
    'Return ONLY JSON: {"identity":0-10,"items":[{"n":1,"match":0-10,' + (fitT.length ? '"fit_match":0-10|null,' : '') + '"issue":"..."}],"framing":0-10,"artifacts":["..."],"mirrored":false,"body_changed":false,"pose_changed":false,"color_wrong":false,"zoomed":false,"leftover":false,"extra_items":["..."],"minor_extras":["..."],"verdict":"pass"|"retry"}'
  ].join('\n');
}
// 品質分數（挑最好的一張用）：鏡像／身形／動作改變重扣，多出衣服扣分，加上最差單品分與人物一致分
const qaScore = qa => !qa ? -99 : (qa.mirrored || qa.body_changed || qa.pose_changed || qa.zoomed ? -20 : 0) - (qa.color_wrong ? 6 : 0) - 5 * ((qa.extra_items || []).length) - (qa.leftover ? 3 : 0) + Math.min(10, ...(qa.items || []).map(x => x.match == null ? 10 : x.match)) + (qa.identity == null ? 8 : qa.identity);
// 連檢查都判定「明顯不合格」：單品幾乎不像（≤4 分）、左右顛倒、身形被改、或幾乎不是本人。這種結果不向使用者收費。
const qaClearlyBad = qa => !!(qa && qa.verdict === 'retry' && ((qa.items || []).some(x => x.match != null && x.match <= 4) || qa.mirrored || qa.body_changed || (qa.identity != null && qa.identity < 5)));
const CLOTHING_TYPES = ['top', 'bottom', 'dress'];
const clamp10 = v => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : null; };
// 正規化品質檢查結果；依規則重新判定 verdict（不完全信任模型自己的 verdict）
function normalizeQa(json, targets) {
  const q = json && typeof json === 'object' ? json : {};
  const rawItems = Array.isArray(q.items) ? q.items : [];
  const items = targets.map((t, k) => {
    const hit = rawItems.find(x => x && Number(x.n) === t.n) || rawItems[k] || {};
    const o = { n: t.n, type: t.type, match: clamp10(hit.match), issue: typeof hit.issue === 'string' ? hit.issue.trim().slice(0, 200) : '' };
    if (hasFitZones(t.fit)) o.fit_match = hit.fit_match == null ? null : clamp10(hit.fit_match);
    return o;
  });
  const identity = clamp10(q.identity), framing = clamp10(q.framing);
  const artifacts = Array.isArray(q.artifacts) ? q.artifacts.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 120)).slice(0, 6) : [];
  const mirrored = q.mirrored === true, body_changed = q.body_changed === true, pose_changed = q.pose_changed === true, leftover = q.leftover === true, color_wrong = q.color_wrong === true, zoomed = q.zoomed === true;
  const extra_items = Array.isArray(q.extra_items) ? q.extra_items.filter(x => typeof x === 'string' && x.trim() && !/^(none|n\/a|-)$/i.test(x.trim())).map(x => x.trim().slice(0, 80)).slice(0, 4) : [];
  const bad = items.some(it => (it.match != null && it.match < QA_MIN_ITEM) || (it.fit_match != null && it.fit_match < QA_MIN_FIT)) || (identity != null && identity < QA_MIN_IDENTITY) || (framing != null && framing < QA_MIN_FRAMING) || mirrored || body_changed || pose_changed || leftover || color_wrong || zoomed || extra_items.length > 0;
  const verdict = bad ? 'retry' : 'pass';   // 依規則判定，不採信模型自己寫的 verdict（實測它會因為襪子、皮帶這類小東西就寫 retry）
  const minor_extras = Array.isArray(q.minor_extras) ? q.minor_extras.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 60)).slice(0, 4) : [];
  return { identity, items, framing, artifacts, mirrored, body_changed, pose_changed, leftover, color_wrong, zoomed, extra_items, minor_extras, verdict, at: Date.now() };
}
// 由檢查結果組成「上次被退回的原因」（放進重做的提示詞）
// targets（可省略）：帶入各商品的合身度，讓重做提示詞寫出「應該看到的合身樣子」
function qaCorrections(qa, targets) {
  const out = [];
  for (const it of (qa.items || [])) {
    const badItem = it.match != null && it.match < QA_MIN_ITEM, badFit = it.fit_match != null && it.fit_match < QA_MIN_FIT;
    if (badItem) out.push(`product ${it.n} (${ITEM_LABEL[it.type] || it.type}) does not match its product photo` + (it.issue ? ': ' + it.issue : ''));
    else if (it.issue && !badFit) out.push(`product ${it.n}: ${it.issue}`);
    if (badFit) {
      const t = (targets || []).find(x => x.n === it.n), f = t && t.fit;
      out.push(`product ${it.n} does not show the real fit of the chosen size` + (f && f.size ? ' ' + f.size : '') + (f ? ' — it must visibly show: ' + fitPhrases(f, it.type).join('; ') : '') + (it.issue && !badItem ? ' (' + it.issue + ')' : ''));
    }
  }
  if (qa.identity != null && qa.identity < QA_MIN_IDENTITY) out.push("the customer's identity changed (face, body, pose, background or lighting differ from Image 1) — keep the person in Image 1 identical");
  if (qa.framing != null && qa.framing < QA_MIN_FRAMING) out.push('the framing / crop / aspect ratio differs from Image 1 — keep the exact same framing');
  if (qa.mirrored) out.push('the image was mirrored left-right — keep the exact orientation of Image 1 (background and the hand holding the phone on the same side)');
  if (qa.body_changed) out.push("the customer's body size changed — keep exactly the same body size and proportions as Image 1");
  if (qa.leftover) out.push("parts of the customer's ORIGINAL garment are still visible — fully remove the old garment in the replaced category (no old sleeves, collar, straps or hem showing)");
  if (qa.color_wrong) out.push('a product has the wrong color — reproduce the exact garment color from its product photo');
  if (qa.zoomed) out.push('the person was zoomed / re-cropped — keep the person at exactly the same size and position in the frame as Image 1');
  if (qa.pose_changed) out.push("the pose changed — keep exactly the same pose as Image 1 (arms, hands, legs, head angle, and the hand holding the phone)");
  if (qa.extra_items && qa.extra_items.length) out.push('remove garments that were not provided (they came from a product photo model): ' + qa.extra_items.join(', ') + " — keep the customer's own clothing in those areas");
  if (qa.artifacts && qa.artifacts.length) out.push('visible defects: ' + qa.artifacts.join(', '));
  return out.join('; ').slice(0, 900);
}
async function visionJson(env, prompt, imageUrls, maxMs = QA_TIMEOUT_MS) {
  const t0 = Date.now(); let last;
  for (const model of QA_MODELS) {
    const rem = maxMs - (Date.now() - t0);
    if (rem < 3000) break;
    try { return await falLLMOnce(env, prompt, imageUrls, model, rem); } catch (e) { last = e; if (/額度不足|locked|balance/i.test(e.message)) break; }
  }
  throw last || new Error('AI 看圖服務逾時');
}
const SPIN_MODELS = ['https://queue.fal.run/minimax/h3-max-turbo/image-to-video', 'https://queue.fal.run/minimax/h3-max/image-to-video', 'https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video'];
const SPIN_PROMPT = 'Fashion turntable shot. The camera is fixed and locked off. The person stands in place and slowly turns their whole body around a full 360 degrees at a constant speed, like on a rotating platform: from facing the camera, to the side profile, to the back, to the other side, and back to facing the camera. Arms relaxed at the sides. Keep the exact same person, face, hairstyle, body shape and every garment detail (color, silhouette, length, fit) perfectly consistent throughout. Same background and lighting. Smooth, realistic, no cuts.';
async function falQueueSubmit(env, endpoint, payload, label) {
  const r = await fetchT(endpoint, { method: 'POST', headers: { 'Authorization': 'Key ' + need(env, 'FAL_KEY'), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, label, 15000);
  const t = await r.text();
  if (!r.ok) throw new Error(label + '：' + extractErr(t));
  const j = JSON.parse(t);
  if (!j.status_url || !j.response_url) throw new Error(label + '沒有回應工作編號');
  return { status_url: j.status_url, response_url: j.response_url, at: Date.now() };
}
const ASPECTS = ['1:1', '4:5', '3:4', '2:3', '9:16', '5:4', '4:3', '3:2', '16:9'];
async function outfitSubmit(env, engineIdx, imageUrls, prompt, hi = true, aspect = 'auto') {
  const headers = { 'Authorization': 'Key ' + need(env, 'FAL_KEY'), 'Content-Type': 'application/json' };
  const body = { prompt, image_urls: imageUrls, num_images: 1, aspect_ratio: ASPECTS.includes(aspect) ? aspect : 'auto', output_format: 'jpeg' };
  if (hi) body.resolution = '2K';
  const r = await fetchT(OUTFIT_ENGINES[engineIdx], { method: 'POST', headers, body: JSON.stringify(body) }, '換裝服務', 15000);
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
// 文字／看圖模型走 fal（OpenRouter 轉接，用 fal 儲值），失敗再用 Google 免費額度
async function falLLM(env, prompt, imageUrl, deadline) {
  let last;
  for (const model of ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'google/gemini-2.5-flash-lite']) {
    const rem = deadline ? deadline - Date.now() : 60000;
    if (rem < 3000) break;
    try { return await falLLMOnce(env, prompt, imageUrl, model, Math.min(60000, rem)); } catch (e) { last = e; if (/額度不足|locked|balance/i.test(e.message)) break; }
  }
  throw last || new Error('AI 文字服務逾時');
}
// imageUrl 可為單一網址、網址陣列（多張圖一次看）或空
async function falLLMOnce(env, prompt, imageUrl, model, maxMs = 60000) {
  if (!env.FAL_KEY) throw new Error('未設定 FAL_KEY');
  const body = { model, prompt, system_prompt: 'You are a precise assistant. Reply with a single valid JSON object only, no markdown.', temperature: 0.3, max_tokens: 3000 };
  const imgs = (Array.isArray(imageUrl) ? imageUrl : [imageUrl]).filter(u => typeof u === 'string' && u);
  if (imgs.length) body.image_urls = imgs;
  const r = await fetchT('https://fal.run/openrouter/router' + (imgs.length ? '/vision' : ''), { method: 'POST', headers: { 'Authorization': 'Key ' + env.FAL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'AI 文字服務', maxMs);
  const t = await r.text();
  if (!r.ok) throw new Error('AI 文字服務：' + extractErr(t));
  try { const e0 = JSON.parse(t); if (e0 && e0.error && !e0.output) throw new Error('AI 文字服務：' + String(e0.error.message || e0.error).slice(0, 120)); } catch (e1) { if (String(e1.message).startsWith('AI 文字服務')) throw e1; }
  let d; try { d = JSON.parse(t); } catch { throw new Error('AI 文字服務回傳格式異常'); }
  const txt = String(d.output ?? d.text ?? (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) ?? '');
  const m = txt.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 文字服務沒有回傳 JSON');
  return JSON.parse(m[0]);
}
const TEXT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const GEMINI_FALLBACKS = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'];
const VIEW_PROMPTS = {
  side: 'Generate a new photo of the exact same person wearing the exact same outfit as in this photo, but photographed from the left side (a full 90-degree profile view, the person has turned sideways). Same background, lighting, camera distance and framing, full body visible. Keep identity, body shape, hairstyle, skin and every garment detail (color, pattern, length, fit) perfectly consistent. Photorealistic, no text.',
  back: 'Generate a new photo of the exact same person wearing the exact same outfit as in this photo, but photographed from behind (a full back view, the person has turned around 180 degrees, face not visible). Same background, lighting, camera distance and framing, full body visible. Keep body shape, hairstyle, skin and every garment detail (color, pattern, length, fit) perfectly consistent. Photorealistic, no text.'
};

/* 排程（每分鐘）：使用者離開網站（切到別的 App、鎖螢幕、關分頁）時沒人輪詢，進度會停住，回來可能已逾時。
   這裡代替他推進「超過 12 秒沒人碰」的付費試穿，回來時結果已經在紀錄裡。每次最多 3 筆、推進 2 輪。 */
async function cronAdvance(env) {
  for (let round = 0; round < 2; round++) {
    const cut = encodeURIComponent(new Date(Date.now() - 12000).toISOString());
    const rows = await sb(env, `/rest/v1/generations?status=in.(running,working)&job=not.is.null&job->>touched=lt.${cut}&or=(job->>prefetch.is.null,job->>prefetch.eq.false)&select=id,user_id&order=id&limit=3`).catch(() => []);
    if (!Array.isArray(rows) || !rows.length) return;
    for (const r of rows) { try { await handleTryonStatus(null, env, {}, null, { userId: r.user_id, id: r.id }); } catch { /* 下一分鐘再試 */ } }
    if (round === 0) await new Promise(z => setTimeout(z, 20000));
  }
}
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(cronAdvance(env).catch(() => {})); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const p = url.pathname, m = request.method;
      if (p === '/api/health') return json({ ok: true, version: VERSION }, 200, cors);
      if (p === '/api/me' && m === 'GET') return await handleMe(request, env, cors);
      if (p === '/api/tryon' && m === 'POST') return await handleTryon(request, env, cors, ctx);
      if (p === '/api/tryon/status' && m === 'GET') return await handleTryonStatus(request, env, cors, url);
      if (p === '/api/outfit' && m === 'POST') return await handleOutfit(request, env, cors);
      if (p === '/api/analyze' && m === 'POST') return await handleAnalyze(request, env, cors, ctx);
      if (p === '/api/products' && m === 'GET') return await handleProducts(request, env, cors, url);
      if (p === '/api/brands' && m === 'GET') return await handleBrands(env, cors, url);
      if (p === '/api/sizechart' && m === 'GET') return await handleSizechart(env, cors, url);
      if (p === '/api/img' && m === 'GET') return await handleImgProxy(request, env, cors, url);
      if (p === '/api/product-click' && m === 'POST') return await handleProductClick(request, env, cors);
      if (p === '/api/admin/products/import' && m === 'POST') return await handleProductImport(request, env, cors);
      if (p === '/api/admin/products' && m === 'POST') return await handleProductUpsert(request, env, cors);
      if (p === '/api/admin/products' && m === 'DELETE') return await handleProductDelete(request, env, cors, url);
      if (p === '/api/checkout' && m === 'POST') return await handleCheckout(request, env, cors);
      if (p === '/api/ecpay/notify' && m === 'POST') return await handleEcpayNotify(request, env);
      if (p === '/api/ecpay/return') return await handleEcpayReturn(request, env);
      if (p === '/api/delete-account' && m === 'POST') return await handleDeleteAccount(request, env, cors);
      if (p === '/api/admin/stats' && m === 'GET') return await handleAdminStats(request, env, cors);
      if (p === '/api/event' && m === 'POST') return await handleEvent(request, env, cors);
      if (p === '/api/error' && m === 'POST') return await handleClientError(request, env, cors);
      return json({ error: '找不到此路徑' }, 404, cors);
    } catch (e) {
      return json({ error: '伺服器錯誤：' + (e.message || e) }, 500, cors);
    }
  }
};
// 離線測試用（worker/test_quality.mjs）：只有在測試旗標開啟時才掛出內部函式
if (globalThis.__TRYON_TEST__) globalThis.__tryonTest = { outfitPrompt, fitPhrases, fitLine, fitSig, cleanFit, cleanBody, bodyLine, handleTryon, handleSizechart, captionTargets, captionPrompt, parseCaptions, qaPrompt, normalizeQa, qaCorrections, visionJson, handleTryonStatus, OUTFIT_ENGINES, VERSION };

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
// 資料庫 id：只接受正整數（避免 1e21、NaN 之類進到 PostgREST 篩選）
function intId(v) { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; }
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
function isAdminEmail(env, email) { return !!email && (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(String(email).toLowerCase()); }
// 管理者：Email 在名單內且已驗證（避免有人用未驗證的同名 Email 註冊）
function isAdmin(env, user) { return !!(user && user.email_confirmed_at) && isAdminEmail(env, user.email); }

/* ---- 預先合成狀態加密（使用者能直接讀自己的 generations 列，付款前不能看到結果網址） ---- */
let _pfKey = null;
async function pfKey(env) {
  const src = need(env, 'SUPABASE_SERVICE_KEY');
  if (_pfKey && _pfKey.src === src) return _pfKey.key;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src + 'pf'));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  _pfKey = { src, key }; return key;
}
function bytesToB64(u) { let s = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(s); }
function b64ToBytes(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function encStr(env, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pfKey(env), new TextEncoder().encode(str)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return bytesToB64(out);
}
async function decStr(env, s) {
  const u = b64ToBytes(s);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, await pfKey(env), u.subarray(12)));
}
// 資料庫查詢會用到的欄位留在外面（明文），其餘整包加密成 job.enc
const JOB_PUBLIC = ['v', 'lock_until', 'touched', 'prefetch', 'pf', 'bkey', 'key'];
async function sealJob(env, job) {
  if (!job || !job.prefetch) return job;
  const pub = {}; for (const k of JOB_PUBLIC) pub[k] = job[k] === undefined ? null : job[k];
  pub.enc = await encStr(env, JSON.stringify(job));
  return pub;
}
async function openJob(env, j) {
  if (!j || !j.enc) return j;
  const inner = JSON.parse(await decStr(env, j.enc));
  for (const k of JOB_PUBLIC) if (j[k] !== undefined) inner[k] = j[k];
  return inner;
}
const randTok = () => crypto.randomUUID().replace(/-/g, '');

async function getProfile(env, user) {
  let rows = await sb(env, `/rest/v1/profiles?id=eq.${user.id}&select=*`);
  if (!rows.length) {
    rows = await sb(env, '/rest/v1/profiles', {
      method: 'POST', headers: { 'Prefer': 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify({ id: user.id, email: user.email || null })
    });
  }
  const p = rows[0];
  // 新會員見面禮：2026-11-08 起註冊的帳號送一次點數（預設 10，環境變數 SIGNUP_BONUS 可改）。
  // 防重複：以 generations 表的一筆 status='bonus' 紀錄為準（使用者無法刪除 generations），
  // 先寫紀錄再確認自己是第一筆才加點，同時多個請求也只會送一次。prefs.welcome 只是省查詢的快速標記。
  const bonus = Number(env.SIGNUP_BONUS ?? 10);
  if (p && bonus > 0 && !(p.prefs && p.prefs.welcome) && new Date(p.created_at || 0) >= new Date('2026-11-07T16:00:00Z')) {
    try {
      const had = await sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=eq.bonus&select=id&order=id&limit=1`);
      if (!had.length) {
        const ins = await sbInsert(env, 'generations', { user_id: user.id, items: ['welcome'], cost: -bonus, free_used: 0, status: 'bonus', variants: 1, deleted: true });
        const first = await sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=eq.bonus&select=id&order=id&limit=1`);
        const myId = Array.isArray(ins) ? (ins[0] && ins[0].id) : (ins && ins.id);
        if (first.length && String(first[0].id) === String(myId)) {
          await rpc(env, 'add_credits', { p_user: user.id, p_amount: bonus });
          p.credits = (p.credits || 0) + bonus; p.welcome_bonus = bonus;
        }
      }
      p.prefs = { ...(p.prefs || {}), welcome: bonus };
      await sbPatch(env, `/rest/v1/profiles?id=eq.${user.id}`, { prefs: p.prefs }).catch(() => {});
    } catch {}
  }
  return p;
}
function taipeiDayStart() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 8 * 3600 * 1000).toISOString();
}
// 今日已用免費點數（含進行中的，避免同時連按繞過）
async function freeUsedToday(env, userId) {
  const rows = await sb(env, `/rest/v1/generations?user_id=eq.${userId}&status=in.(ok,running,working)&created_at=gte.${encodeURIComponent(taipeiDayStart())}&select=free_used`);
  return rows.reduce((a, r) => a + (r.free_used || 0), 0);
}

/* ---------------- /api/me ---------------- */
async function handleMe(request, env, cors) {
  let user;
  try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  // 開啟 App 時順便清掉卡住的「進行中」（Worker 被終止、關掉頁面等），一次便宜查詢，有才處理
  try { await sweepStale(env, user.id, true); } catch { /* ignore */ }
  const p = await getProfile(env, user);
  const freeDaily = freeDailyOf(env);
  const used = await freeUsedToday(env, user.id);
  const packs = Object.fromEntries(Object.entries(PACKS).map(([k, v]) => [k, { name: v.name + ' 點', credits: v.credits, price: v.price }]));
  let payEnabled = false; try { payEnabled = !ecpayCfg(env).test || isAdmin(env, user); } catch { payEnabled = false; }
  return json({ free_mode: freeMode(env) || undefined, welcome_bonus: p.welcome_bonus || 0, email: user.email, credits: p.credits, free_daily: freeDaily, free_left: Math.max(0, freeDaily - used), packs, is_admin: isAdmin(env, user), pay_enabled: payEnabled, views_available: !!env.FAL_KEY, analyze_available: !!(env.GEMINI_KEY || env.FAL_KEY), body: p.body || null, analysis: p.analysis || null, free_daily_reset: '00:00 Asia/Taipei' }, 200, cors);
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
  if (!env.GEMINI_KEY && !env.FAL_KEY) return json({ error: '身形分析服務尚未啟用' }, 503, cors);
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
  // 先登記使用次數（同時連按、失敗重試都算），再呼叫 AI
  await sb(env, '/rest/v1/events', { method: 'POST', body: JSON.stringify({ user_id: user.id, name: 'analyze', platform: String(body.platform || 'web').slice(0, 20) }) });
  const deadline = Date.now() + (asyncMode ? 20000 : 90000);   // 背景工作（waitUntil）約 30 秒會被終止：留時間給存圖與寫回
  const job = async () => {
    const parts = [{ text: ANALYZE_PROMPT + '\n' + meas }, inlinePart(person)];
    let out = null, lastErr = '';
    try { const pu = await putImage(env, `${user.id}/analyze-${randTok()}`, person); out = await falLLM(env, ANALYZE_PROMPT + '\n' + meas, pu, deadline); } catch (e) { lastErr = e.message; }
    const models = out || !env.GEMINI_KEY ? [] : TEXT_MODELS;
    for (const model of models) {
      const rem = deadline - Date.now(); if (rem < 3000) { lastErr = lastErr || '逾時'; break; }
      const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }) }, '身形分析服務', Math.min(45000, rem));
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
  const asyncMode = false;
  const stepMode = body.async === true;
  const prefetch = body.prefetch === true && stepMode && variants === 1;
  // 360°：分段模式用 fal 影片模型；舊的同步模式用 Gemini 側面/背面。預先合成一律不做 360°（未付款不花錢做影片）
  const wantViews = body.views === true && !prefetch && (stepMode ? !!env.FAL_KEY : !!env.GEMINI_KEY);
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
  // 尺寸合身度（選填）：每件的 fit、整體的 body；格式不對就忽略
  for (const it of items) it.fit = it.type === 'hair' ? null : cleanFit(it.fit);
  const fitBody = cleanBody(body.body);
  const fsig = fitSig(items);

  // 清理卡住的「進行中」（Worker 中途被終止時）：標記失敗並退點
  // 這裡原本是 9 個左右的資料庫查詢一個接一個（約 2.5 秒）。彼此不相依的改成同時發出、分兩輪等，省約 1.5 秒。
  const settle = pr => pr.then(v => ({ v }), e => ({ e }));
  const ckey = typeof body.key === 'string' && /^[a-f0-9]{16,64}$/.test(body.key) ? body.key + fsig + (wantViews ? '-v' : '') + '-' + variants : null;
  const bkey = typeof body.key === 'string' && /^[a-f0-9]{16,64}$/.test(body.key) ? body.key + fsig + '-' + variants : null;
  const useCache = !!(ckey && body.async === true && !body.nocache);
  const P_sweep = settle(sweepStale(env, user.id, true));   // cheap：一個查詢就夠（touched 一定晚於建立時間）
  const P_profile = settle(getProfile(env, user));
  const P_hit = useCache ? sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=eq.ok&job->>key=eq.${ckey}&created_at=gte.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}&select=id,views&order=created_at.desc&limit=1`).catch(() => []) : null;
  const P_pf = (bkey && stepMode) ? sb(env, `/rest/v1/generations?user_id=eq.${user.id}&job->>prefetch=eq.true&status=in.(running,working,ok)&created_at=gte.${encodeURIComponent(new Date(Date.now() - 30 * 60000).toISOString())}&select=id,status,job,views,variants,cost,free_used&order=created_at.desc`).catch(() => []) : null;
  await P_sweep;   // 第二輪的計數要在清理之後
  const P_recent = settle(sb(env, `/rest/v1/generations?user_id=eq.${user.id}&or=(status.in.(running,working),cost.gt.0,free_used.gt.0)&created_at=gte.${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}&select=status`));
  const P_used = settle(freeUsedToday(env, user.id));
  const P_active = !prefetch ? sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=in.(running,working)&or=(job.is.null,job->>prefetch.is.null,job->>prefetch.eq.false)&select=id`).catch(() => []) : null;
  const P_pfToday = prefetch ? sb(env, `/rest/v1/generations?user_id=eq.${user.id}&job->>pf=eq.1&created_at=gte.${encodeURIComponent(taipeiDayStart())}&select=id`).catch(() => []) : null;
  const P_running = prefetch ? sb(env, `/rest/v1/generations?user_id=eq.${user.id}&status=in.(running,working)&select=id`).catch(() => []) : null;
  // 防濫用：60 秒內最多 3 次正式合成
  { const rc = await P_recent; if (rc.e) throw rc.e; if (rc.v.length >= 3) return json({ error: '操作太頻繁，請等一分鐘再試' }, 429, cors); }

  // 同一張照片＋同樣單品組合 7 天內做過 → 直接用舊結果（秒出、不扣點）
  if (useCache) {
    const hit = await P_hit;
    const r = hit[0] && hit[0].views && hit[0].views.result;
    if (r) { const u0 = await P_used, p0 = await P_profile; const used = u0.e ? 0 : u0.v; const pr = p0.e ? null : p0.v; return json({ cached: true, result: { ...r, charged: 0, free_used: 0, credits: pr ? pr.credits : null, free_left: Math.max(0, freeDailyOf(env) - used) } }, 200, cors); }
  }
  // ---- 預先合成（使用者還在挑尺寸時就先跑；按下「開始」才扣點）----
  if (bkey && stepMode) {
    const pfRows = await P_pf;
    for (const g of pfRows) {
      if (g.job && g.job.bkey === bkey) {
        if (prefetch) return json({ id: g.id, prefetch: true, ready: g.status === 'ok' }, 202, cors);
        return claimPrefetch(env, cors, user, g, { items, variants, wantViews, ckey });
      }
      if (g.status === 'running' || g.status === 'working') await sbPatch(env, `/rest/v1/generations?id=eq.${g.id}&status=in.(running,working)`, { status: 'failed', error: '預先合成已被取代' }).catch(() => {});
    }
  }
  if (prefetch) {
    const pfToday = await P_pfToday;
    if (pfToday.length >= PREFETCH_DAILY) return json({ skip: true, reason: 'daily' }, 200, cors);
    const realRunning = await P_running;
    if (realRunning.length) return json({ skip: true, reason: 'busy' }, 200, cors);
  }
  // 扣點：每個品項 1 點 × 張數；先用今日免費點數，不足再扣點數
  const cost = items.length * variants + (wantViews ? 2 : 0);
  const freeDaily = freeDailyOf(env);
  const p1 = await P_profile; if (p1.e) throw p1.e; const profile = p1.v;
  const u1 = await P_used; if (u1.e) throw u1.e; const used = u1.v;
  const freeLeft = Math.max(0, freeDaily - used);
  const FM = freeMode(env);
  const useFree = Math.min(freeLeft, FM && wantViews ? cost - 2 : cost);   // 限時免費期間：360° 的 2 點不能用免費額度抵
  const payCredits = cost - useFree;
  if (prefetch && payCredits > profile.credits) return json({ skip: true, reason: 'credits' }, 200, cors);
  if (payCredits > profile.credits) {
    if (FM) return json({ error: wantViews && freeLeft >= cost - 2 ? `360° 需要 2 點，你目前有 ${profile.credits} 點。關掉 360° 就能免費試穿。` : `今天的免費試穿用完了（每天 ${freeDaily} 件，今天還剩 ${freeLeft} 件，這次要 ${cost - (wantViews ? 2 : 0)} 件）。明天會再補滿。`, need_credits: true, free_mode: true }, 402, cors);
    return json({ error: `點數不足：這次需要 ${cost} 點（免費額度可抵 ${useFree} 點），你目前有 ${profile.credits} 點。`, need_credits: true }, 402, cors);
  }
  if (FM && !prefetch) {
    const cap = Number(env.FREE_MODE_GLOBAL || 400);
    const today = await sb(env, `/rest/v1/generations?created_at=gte.${encodeURIComponent(taipeiDayStart())}&free_used=gt.0&select=id&limit=${cap + 1}`).catch(() => []);
    if (Array.isArray(today) && today.length >= cap && payCredits < cost) return json({ error: '今天免費試穿的名額已經滿了，明天再來，或用點數試穿。', busy: true }, 429, cors);
  }
  // 先登記進行中（鎖住免費額度與限流），再扣點，失敗再退
  let gen;
  if (!prefetch) {
    const active = await P_active;
    if (active.length >= MAX_CONCURRENT) return json({ error: `最多同時試穿 ${MAX_CONCURRENT} 套，等其中一套好了再試這套`, busy: true }, 429, cors);
  }
  try { gen = await sbInsert(env, 'generations', { user_id: user.id, items: types, cost: prefetch ? 0 : payCredits, free_used: prefetch ? 0 : useFree, status: 'working', variants }); }   // 'working'（不是舊的 'running'）：舊資料庫有「每人只能一筆 running」的限制，改用新狀態才能同時跑多套
  catch (e) { if (/409|duplicate|unique/i.test(String(e.message))) return json({ error: '上一張還在合成中（360° 側面背面可能還在生成），請稍候再試' }, 429, cors); throw e; }
  if (payCredits > 0 && !prefetch) {
    let ok = false;
    try { ok = await rpc(env, 'add_credits', { p_user: user.id, p_amount: -payCredits }); } catch { ok = false; }
    if (ok !== true) { await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { status: 'failed', error: '扣點失敗', cost: 0, free_used: 0 }).catch(() => {}); return json({ error: '扣點失敗，請重試' }, 500, cors); }
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
        const path = `${user.id}/${Date.now()}-${randTok()}-${i}.${bin.ext}`;
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
          const path = `${user.id}/${Date.now()}-${randTok()}-${k}.${bin.ext}`;
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
  const T_REQ = Date.now();
  if (stepMode) {
    // 分段模式：先把輸入圖存到 Storage，之後每次前端輪詢推進一步（不靠長時間背景工作）
    try {
      const tok = randTok();                       // 路徑加隨機段，網址猜不到
      const base = `${user.id}/jobs/${gen.id}/${tok}`;
      // 照片與單品圖同時上傳（省幾秒）
      const [personUrl, ...steps] = await Promise.all([putImage(env, `${base}/person`, person), ...sorted.map(async (it, k) => {
        const st = { type: it.type };
        if (it.fit) st.fit = it.fit;
        if (CLOTHING[it.type]) { st.category = CLOTHING[it.type]; st.photo_type = it.photo_type || null; st.image_url = await putImage(env, `${base}/item${k}`, it.image); }
        else { if (isDataImage(it.image)) st.image_url = await putImage(env, `${base}/item${k}`, it.image); if (it.text) st.text = String(it.text).slice(0, 200); }
        return st;
      })]);
      const meta = sorted.map((it, k) => ({ type: it.type, name: String(it.name || '').slice(0, 80) || null, product_id: intId(it.product_id) || null, buy_url: typeof it.buy_url === 'string' && /^https?:/.test(it.buy_url) ? it.buy_url.slice(0, 500) : null, image_url: steps[k].image_url || null, text: steps[k].text || null, fit: it.fit || null }));
      const useOutfit = !!env.FAL_KEY && body.engine !== 'fashn';
      // 只試一件衣服（上衣／下身／洋裝）：先用 FASHN 專門試穿模型（只改衣服那一塊，人不會被重畫；實測人像最穩、也較便宜）。
      // 品質檢查不過關 → 自動改用整套引擎（Nano Banana）帶著原因重做。
      const clothing = steps.filter(x => x.category), extras = steps.filter(x => !x.category);
      // 只有衣服：FASHN 逐件換（人完全不動）。含鞋子／帽子／飾品／髮型：先用整套引擎一次換好（約 35 秒；逐件換要 80 秒以上），
      // 品質檢查發現動到人或衣服不對，再退回「FASHN 逐件換衣服＋最後只換配件」的保守做法（job.alt）。
      // 下身（褲子／裙子）不交給 FASHN：2026-11-14 實測它會把喇叭褲做成直筒、長裙做成中間破洞或變短，整套引擎才畫得出正確的長度和版型。
      const hasBottom = clothing.some(x => x.type === 'bottom'), fashnable = clothing.filter(x => x.type !== 'bottom');
      const fashnFirst = useOutfit && clothing.length >= 1 && !hasBottom && !wearOf(body.wear) && extras.length === 0 && body.engine !== 'pro' && body.quality !== 'high' && env.FASHN_FIRST !== '0';
      const fashnAlt = useOutfit && !fashnFirst && fashnable.length >= 1 && (extras.length >= 1 || hasBottom) && body.engine !== 'pro' && body.quality !== 'high' && env.FASHN_FIRST !== '0';
      const jobState = { v: 1, lock_until: 0, touched: new Date().toISOString(), tok, person_url: personUrl, meta, prefetch: prefetch ? true : false, pf: prefetch ? 1 : 0, bkey,
        aspect: typeof body.aspect === 'string' ? body.aspect : 'auto', hires: body.res !== '1K', key: prefetch ? null : ckey,
        pv: (!prefetch && useOutfit && !fashnFirst && steps.some(x => x.category)) ? { i: 0, cur: personUrl, req: null } : null, first: fashnFirst ? 'fashn' : undefined, alt: fashnAlt ? 'fashn' : undefined,
        // 整套引擎：付費（非預先合成）的工作多一個 qa 步驟（結果品質檢查，不過關自動重做一次）
        // 衣服（上衣／下身／洋裝）逐件用 FASHN（人不動）；鞋子、帽子、飾品、髮型最後才用整套引擎只換那幾樣
        steps: fashnFirst ? [...clothing.map(x => ({ ...x })), { type: 'qa' }] : useOutfit ? [{ type: 'outfit', engine: (body.engine === 'pro' || body.quality === 'high') ? 1 : 0 }, { type: 'qa' }] : steps, item_steps: steps, engine: useOutfit ? 'outfit' : 'fashn',
        chains: Array.from({ length: variants }, () => ({ i: 0, cur: personUrl, req: null })),
        want_views: wantViews, views: null, views_error: null, hints, face_hint: faceHint, body: fitBody, wear: wearOf(body.wear) || undefined,
        pay: prefetch ? 0 : payCredits, free: prefetch ? 0 : useFree, free_left: freeLeft, cost };
      jobState.t0 = Date.now(); jobState.tm = [['ready', Date.now() - T_REQ]];
      // 不等第一次輪詢：衣服已上傳好就立刻送出第一件（描述衣服改成同時進行），省掉開始前約 7–10 秒的空等
      if (fashnFirst && variants === 1) {
        try { const s0 = jobState.steps[0]; jobState.chains[0].req = await falSubmit(env, personUrl, s0.image_url, s0.category, s0.photo_type, s0.mode || FASHN_MODE, { seed: s0.seed, seg: s0.seg }); jobState.tm.push(['submit:' + s0.type, Date.now() - T_REQ]); }
        catch (e) { jobState.chains[0].req = null; jobState.early_error = String(e.message).slice(0, 120); }
      }
      await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}`, { job: await sealJob(env, jobState) });
    } catch (e) {
      // 先標記失敗，真的改到那一列才退點（避免和逾時清理重複退）
      const got = await sbPatch(env, `/rest/v1/generations?id=eq.${gen.id}&status=in.(running,working)`, { status: 'failed', error: '準備失敗：' + String(e.message).slice(0, 200), cost: 0, free_used: 0 }, true).catch(() => []);
      if (payCredits > 0 && !prefetch && Array.isArray(got) && got.length) await rpc(env, 'add_credits', { p_user: user.id, p_amount: payCredits }).catch(() => {});
      return json({ error: '準備合成失敗（已退回點數）：' + e.message }, 502, cors);
    }
    return json(prefetch ? { id: gen.id, prefetch: true } : { id: gen.id, async: true, cost }, 202, cors);
  }
  try { return json(await job(), 200, cors); }
  catch (e) { return json({ error: e.message }, e.status || 502, cors); }
}
async function claimPrefetch(env, cors, user, g, { items, wantViews, ckey }) {
  let job;
  try { job = await openJob(env, g.job); } catch { job = null; }
  if (!job) return json({ error: '系統忙碌，請再按一次' }, 503, cors);
  // 單品必須和預先合成時一致；扣點依「實際合成的內容」計算，不信任這次請求
  const meta = Array.isArray(job.meta) ? job.meta : [];
  const sig = a => a.map(x => x.type).sort().join(',');
  if (!meta.length || sig(meta) !== sig(items)) {
    await sbPatch(env, `/rest/v1/generations?id=eq.${g.id}&job->>prefetch=eq.true&status=in.(running,working,ok)`, { status: 'failed', error: '預先合成與送出的單品不一致' }).catch(() => {});
    return json({ error: '這次的單品和預先準備的不一致，請再按一次「開始」' }, 409, cors);
  }
  const cost = meta.length * (Number(g.variants) || 1) + (wantViews ? 2 : 0);
  const freeDaily = freeDailyOf(env);
  const profile = await getProfile(env, user);
  const used = await freeUsedToday(env, user.id);
  const freeLeft = Math.max(0, freeDaily - used);
  const FM = freeMode(env);
  const useFree = Math.min(freeLeft, FM && wantViews ? cost - 2 : cost);
  const payCredits = cost - useFree;
  if (payCredits > profile.credits) return json({ error: FM ? (wantViews && freeLeft >= cost - 2 ? `360° 需要 2 點，你目前有 ${profile.credits} 點。關掉 360° 就能免費試穿。` : `今天的免費試穿用完了（每天 ${freeDaily} 件，今天還剩 ${freeLeft} 件）。明天會再補滿。`) : `點數不足：這次需要 ${cost} 點（免費額度可抵 ${useFree} 點），你目前有 ${profile.credits} 點。`, need_credits: true, free_mode: FM || undefined }, 402, cors);
  // 等輪詢放開鎖再改（避免被覆寫）；最多 10 輪、總計約 40 秒（長步驟的輪詢可能鎖較久）
  let row = g;
  const CLAIM_WAITS = [1500, 2000, 3000, 4000, 4500, 5000, 5000, 5000, 5000, 5000];
  for (let i = 0; i < 10; i++) {
    if (!job.prefetch) return json({ id: row.id, async: true, cost, claimed: true }, 202, cors);   // 另一個同時送出的請求已認領並扣點
    if ((job.lock_until || 0) <= Date.now()) {
      const v = job.v;
      job.t0 = Date.now();
      if (!job.front && !job.pv && job.first !== 'fashn' && job.engine === 'outfit' && (job.item_steps || []).some(x => x.category)) job.pv = { i: 0, cur: job.person_url, req: null };
      // 認領後成為付費工作：正面還沒完成就補上品質檢查步驟
      if (!job.front && job.engine === 'outfit' && Array.isArray(job.steps) && !job.steps.some(s => s.type === 'qa')) job.steps = [...job.steps, { type: 'qa' }];
      job.v = v + 1; job.prefetch = false; job.pay = payCredits; job.free = useFree; job.free_left = freeLeft; job.cost = cost; job.key = ckey; job.want_views = wantViews; job.touched = new Date().toISOString();
      const patch = { cost: payCredits, free_used: useFree, job };
      if (row.status === 'ok' && job.pf_bad && job.qa && (job.retries || 0) < 1 && job.engine === 'outfit') {
        // 預先做好的結果沒通過品質檢查：改成付費工作後，帶著退回原因用 pro 引擎重做一次
        const targets = captionTargets(job.item_steps);
        job.retries = 1; job.fix_notes = qaCorrections(job.qa, targets) || 'the result did not match the product photos closely enough';
        job.rejected = [...(job.rejected || []), ...(job.front || [])].slice(-2);
        if (!job.steps.some(s => s.type === 'outfit')) {
          job.steps = [{ type: 'outfit', engine: 0 }, { type: 'qa' }]; job.first_rejected = 'fashn';
        }
        const oi = job.steps.findIndex(s => s.type === 'outfit');
        const onlyStep = oi >= 0 && Array.isArray(job.steps[oi].only);
        job.front = null; job.pf_bad = false; job.chains.forEach(c => { c.i = oi >= 0 ? oi : 0; c.cur = (onlyStep && c.base) ? c.base : job.person_url; c.req = null; });
        patch.status = 'working'; patch.image_url = null; patch.views = null;
      } else if (row.status === 'ok') {
        let r = (row.views && row.views.result) || {}, vu = {};
        if (row.views && row.views.enc) { try { const dec = JSON.parse(await decStr(env, row.views.enc)); r = dec.result || {}; vu = dec.view_urls || {}; } catch { r = {}; } }
        if (wantViews) { patch.status = 'working'; job.views = null; job.views_error = null; job.views_req = null; job.spin_m = 0; }
        else { patch.image_url = (r.image_urls || job.front || [])[0] || null; patch.views = { ...vu, result: { ...r, charged: payCredits, free_used: useFree, credits: profile.credits - payCredits, free_left: Math.max(0, freeLeft - useFree) } }; }
      }
      const got = await sbPatch(env, `/rest/v1/generations?id=eq.${row.id}&job->>v=eq.${v}&job->>prefetch=eq.true`, patch, true).catch(() => []);
      if (Array.isArray(got) && got.length) {
        if (payCredits > 0) {
          let ok = false;
          try { ok = await rpc(env, 'add_credits', { p_user: user.id, p_amount: -payCredits }); } catch { ok = false; }
          if (ok !== true) { await sbPatch(env, `/rest/v1/generations?id=eq.${row.id}`, { status: 'failed', error: '扣點失敗', cost: 0, free_used: 0, image_url: null, views: null }).catch(() => {}); return json({ error: '扣點失敗，請重試' }, 500, cors); }
        }
        return json({ id: row.id, async: true, cost, claimed: true }, 202, cors);
      }
    }
    await new Promise(r => setTimeout(r, CLAIM_WAITS[i]));
    const rr = await sb(env, `/rest/v1/generations?id=eq.${row.id}&select=id,status,job,views,variants,cost,free_used`).catch(() => []);
    if (!rr[0] || !['running', 'working', 'ok'].includes(rr[0].status)) break;
    row = rr[0];
    try { job = await openJob(env, row.job); } catch { job = null; }
    if (!job) break;
  }
  return json({ error: '系統忙碌，請再按一次' }, 503, cors);
}

/* ---- 合成收尾／停止（退點只在真的改到那一列時才做，避免重複退） ---- */
async function finishJob(env, userId, g, job, cond = '') {
  const urls = job.front || [];
  const viewUrls = job.views || {};
  const prof = await getProfile(env, { id: userId }).catch(() => null);
  const result = { timing: job.t ? { created: g.created_at, queue_s: Math.round(((job.t.start || 0) - (job.t.submit || 0)) / 1000), gen_s: Math.round(((job.t.done || 0) - (job.t.start || 0)) / 1000) } : null, items: job.meta || [], engine: job.engine, images: urls.map(() => null), image_urls: urls, views: null, view_urls: viewUrls, views_error: job.views_error || null, charged: job.pay, free_used: job.free, credits: prof ? prof.credits : null, free_left: Math.max(0, (job.free_left || 0) - job.free) };
  result.fit = (job.meta || []).map(x => x.fit || null);
  if (job.extras_dropped) result.extras_dropped = job.extras_dropped;
  if (job.tm) result.marks = [...job.tm, ['finish', Date.now() - (job.t0 || new Date(g.created_at).getTime())]];
  if (job.fashn_failed) result.fashn_failed = job.fashn_failed;
  // 追查用：每次品質檢查的結論與當時那張圖（被退回的也留著），方便事後看是真的壞還是檢查太嚴
  if (job.qa_log) result.qa_log = job.qa_log;
  if (job.bad_refund) result.not_charged = true;
  if (job.drop_refund) result.dropped_not_charged = (job.drop_refund.pay || 0) + (job.drop_refund.free || 0);
  if (job.first === 'fashn' && !job.fashn_failed && !job.first_rejected && !(job.steps || []).some(st => st.type === 'outfit')) result.fashn_only = true;
  if (job.qa) { result.quality = { identity: job.qa.identity, items: (job.qa.items || []).map(x => x.match), framing: job.qa.framing, retried: !!(job.retries > 0) }; if ((job.qa.items || []).some(x => x.fit_match !== undefined)) result.quality.fit_match = job.qa.items.map(x => x.fit_match === undefined ? null : x.fit_match); }
  job.v += 1; job.lock_until = 0; job.touched = new Date().toISOString();
  const row = { status: 'ok', cost: job.pay, free_used: job.free, error: job.views_error || null, job: await sealJob(env, job) };
  if (job.prefetch) { row.image_url = null; row.views = { enc: await encStr(env, JSON.stringify({ view_urls: viewUrls, result })) }; }   // 未付款：結果網址加密，認領後才寫出
  else { row.image_url = urls[0] || null; row.views = { ...viewUrls, result }; }
  const got = await sbPatch(env, `/rest/v1/generations?id=eq.${g.id}&status=in.(running,working)${cond}`, row, true).catch(() => []);
  const ok = Array.isArray(got) && got.length > 0;
  if (ok && !job.prefetch) for (let i = 1; i < urls.length; i++) await sbInsert(env, 'generations', { user_id: userId, items: g.items, cost: 0, free_used: 0, status: 'ok', image_url: urls[i], variants: g.variants }).catch(() => {});
  return { got: ok, result };
}
// 逾時或出錯：正面已完成 → 以成功收尾，只退 360° 的點數；否則標記失敗並全額退點
async function stopJob(env, userId, g, job, msg, cond = '') {
  const costCond = `&cost=eq.${Number(g.cost) || 0}`;
  if (job && Array.isArray(job.front) && job.front.length) {
    let refund = 0;
    if (job.want_views && !job.views && !job.views_error) {
      refund = Math.min(2, job.pay || 0);
      job.views_error = '360° 影片未完成（已退回 2 點）';
      job.pay = (job.pay || 0) - refund; job.free = (job.free || 0) - (2 - refund);
    }
    const { got, result } = await finishJob(env, userId, g, job, cond + costCond);
    if (!got) return null;
    if (refund > 0) { await rpc(env, 'add_credits', { p_user: userId, p_amount: refund }).catch(() => {}); if (result.credits != null) result.credits += refund; }
    return { status: 'ok', result };
  }
  const got = await sbPatch(env, `/rest/v1/generations?id=eq.${g.id}&status=in.(running,working)${cond}${costCond}`, { status: 'failed', error: String(msg).slice(0, 300), cost: 0, free_used: 0 }, true).catch(() => []);
  if (!Array.isArray(got) || !got.length) return null;
  if (g.cost > 0) await rpc(env, 'add_credits', { p_user: userId, p_amount: g.cost }).catch(() => {});
  return { status: 'failed', error: msg };
}
// 清理這個使用者卡住的「進行中」（Worker 中途被終止、使用者關掉頁面）
// cheap=true（/api/me）：只用一次查詢撈「建立超過 3 分鐘的進行中」再在程式裡判斷
async function sweepStale(env, userId, cheap = false) {
  const now = Date.now();
  const cutIso = new Date(now - RUNNING_STALE_MS).toISOString(), cut = encodeURIComponent(cutIso);
  const sel = 'select=id,cost,free_used,job,created_at,items,variants';
  let s1 = [], s2 = [];
  if (cheap) {
    const rows = await sb(env, `/rest/v1/generations?user_id=eq.${userId}&status=in.(running,working)&created_at=lt.${cut}&${sel}&limit=20`).catch(() => []);
    for (const g of (Array.isArray(rows) ? rows : [])) {
      if (!g.job) { s1.push(g); continue; }
      const touched = new Date(g.job.touched || g.created_at).getTime();
      if (!(touched > now - RUNNING_STALE_MS)) s2.push(g);            // touched 缺失或 NaN 也視為逾時
    }
  } else {
    s1 = await sb(env, `/rest/v1/generations?user_id=eq.${userId}&status=in.(running,working)&job=is.null&created_at=lt.${cut}&${sel}`).catch(() => []);
    // touched 缺失的舊列：以 created_at 當後備（否則永遠不會被清）
    s2 = await sb(env, `/rest/v1/generations?user_id=eq.${userId}&status=in.(running,working)&job=not.is.null&or=(job->>touched.lt.${cut},and(job->>touched.is.null,created_at.lt.${cut}))&${sel}`).catch(() => []);
  }
  for (const g of (Array.isArray(s1) ? s1 : [])) await stopJob(env, userId, g, null, '逾時（系統自動標記，已退回點數）', '&job=is.null').catch(() => {});
  for (const g of (Array.isArray(s2) ? s2 : [])) {
    if (!g.job || (g.job.lock_until || 0) > now) continue;             // 有輪詢正在處理
    let job; try { job = await openJob(env, g.job); } catch { job = null; }
    const vcond = g.job.v === undefined || g.job.v === null ? '&job->>v=is.null' : `&job->>v=eq.${g.job.v}`;
    await stopJob(env, userId, g, job, '逾時（系統自動標記，已退回點數）', vcond).catch(() => {});
  }
}

// internal：排程（cron）代替離線的使用者推進進度時傳入 { userId, id }，跳過登入檢查
async function handleTryonStatus(request, env, cors, url, internal = null) {
  let user;
  if (internal) user = { id: internal.userId };
  else { try { user = await requireUser(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); } }
  const id = internal ? intId(internal.id) : intId(url.searchParams.get('id')); if (!id) return json({ error: '缺少 id' }, 400, cors);
  const rows = await sb(env, `/rest/v1/generations?id=eq.${id}&user_id=eq.${user.id}&select=id,status,error,image_url,views,created_at,job,cost,free_used,items,variants`);
  const g = rows[0]; if (!g) return json({ error: '找不到這筆合成' }, 404, cors);
  const pf = !!(g.job && g.job.prefetch);
  const jout = (obj, st = 200, h = cors) => json(pf && obj && obj.status ? { status: obj.status === 'ok' ? 'prefetched' : obj.status, prefetch: true, error: obj.error } : obj, st, h);
  if (g.status === 'failed') return jout({ status: 'failed', error: g.error || '合成失敗' }, 200, cors);
  if (g.status === 'ok') { const r = (g.views && g.views.result) || null; return jout({ status: 'ok', result: r || { images: [null], image_urls: [g.image_url], views: null, view_urls: g.views || {}, views_error: null } }, 200, cors); }
  if (!g.job) {
    // 沒有進度資料又超過時間：真的標記失敗並退點（不只是回訊息）
    if (Date.now() - new Date(g.created_at).getTime() > RUNNING_STALE_MS) { const r = await stopJob(env, user.id, g, null, '合成逾時（已退回點數），請再試一次', '&job=is.null'); return jout(r || { status: 'running' }, 200, cors); }
    return jout({ status: 'running' }, 200, cors);
  }
  let job;
  try { job = await openJob(env, g.job); } catch { job = null; }
  if (!job) { const r = await stopJob(env, user.id, g, null, '合成資料異常（已退回點數），請再試一次', g.job.v == null ? '&job->>v=is.null' : `&job->>v=eq.${g.job.v}`); return jout(r || { status: 'running' }, 200, cors); }
  const progress = () => { const tot = job.steps.length * job.chains.length + (job.want_views ? 1 : 0); const done = job.chains.reduce((a, c) => a + c.i, 0) + (job.views || job.views_error ? 1 : 0); const ch = job.chains[0]; const cur = ch && ch.i < job.steps.length ? (Array.isArray(job.steps[ch.i].only) ? job.steps[ch.i].only[0] : job.steps[ch.i].type) : (job.want_views && !job.views && !job.views_error ? 'views' : 'finish'); const p = { done, total: tot + 1, current: cur }; if (job.retries && cur !== 'finish' && cur !== 'views') p.fixing = true; p.labels = job.steps.map(st => Array.isArray(st.only) ? st.only[0] : st.type); if (job.retries) p.retries = job.retries; return p; };
  const frontOut = () => job.front ? { timing: job.t ? { queue_s: Math.round(((job.t.start || 0) - (job.t.submit || 0)) / 1000), gen_s: Math.round(((job.t.done || 0) - (job.t.start || 0)) / 1000), prep_s: Math.round(((job.t.submit || 0) - new Date(g.created_at).getTime()) / 1000) } : null, items: job.meta || [], fit: (job.meta || []).map(x => x.fit || null), engine: job.engine, images: job.front.map(() => null), image_urls: job.front, views: null, view_urls: {}, views_pending: true, views_error: null, charged: job.pay, free_used: job.free, credits: null, free_left: Math.max(0, (job.free_left || 0) - job.free) } : undefined;
  const running = () => jout({ status: 'running', progress: progress(), front: frontOut(), checking: (!job.front && job.chains[0] && job.checking && job.checking === job.chains[0].cur && job.qa_for !== job.chains[0].cur) || undefined, preview: (!job.front && job.pv && job.pv.shown) ? { url: job.pv.shown, partial: !!job.pv.more } : (!job.front && !job.prefetch && job.chains[0] && job.chains[0].cur && job.chains[0].cur !== job.person_url && !job.retries && (job.checking === job.chains[0].cur || (job.first === 'fashn' && job.chains[0].i > 0))) ? { url: job.chains[0].cur, partial: job.checking !== job.chains[0].cur, step: true, checking: job.checking === job.chains[0].cur } : undefined }, 200, cors);
  // 取得鎖（避免兩個輪詢同時推進）
  if ((job.lock_until || 0) > Date.now()) return running();
  const touchedMs = new Date(job.touched || g.created_at).getTime();                 // touched 缺失時以建立時間後備
  const stale = !(Date.now() - touchedMs <= RUNNING_STALE_MS) || (Date.now() - (job.t0 || new Date(g.created_at).getTime()) > JOB_MAX_AGE_MS);   // NaN 也視為逾時；整筆超過上限也收尾
  const v = Number(job.v) || 0;
  job.v = v + 1; job.lock_until = Date.now() + LOCK_MS;
  const lockedV = job.v; let vcond = `&job->>v=eq.${lockedV}`;
  const got = await sbPatch(env, `/rest/v1/generations?id=eq.${id}&status=in.(running,working)&${g.job.v == null ? 'job->>v=is.null' : 'job->>v=eq.' + v}`, { job: await sealJob(env, job) }, true).catch(() => []);
  if (!Array.isArray(got) || !got.length) return running();
  // 太久沒進度（使用者關掉頁面等）→ 正面已完成就以成功收尾，否則失敗並退點
  if (stale) { const r = await stopJob(env, user.id, g, job, '合成逾時（已退回點數），請再試一次', vcond); return jout(r || { status: 'running' }, 200, cors); }
  // save 只在鎖還是自己的（版本相符）時寫入
  // 存檔但不放開鎖（同一輪還要繼續做事）：讓其他輪詢看得到最新進度，例如圖已經好了、正在檢查
  const checkpoint = async () => { const prev = vcond; job.v += 1; job.touched = new Date().toISOString(); const got = await sbPatch(env, `/rest/v1/generations?id=eq.${id}${prev}`, { job: await sealJob(env, job) }, true).catch(() => null); if (Array.isArray(got) && got.length) vcond = `&job->>v=eq.${job.v}`; else job.v -= 1; };
  const save = async (extra = {}) => { job.v += 1; job.lock_until = 0; job.touched = new Date().toISOString(); await sbPatch(env, `/rest/v1/generations?id=eq.${id}${vcond}`, { job: await sealJob(env, job), ...extra }); };
  const base = job.tok ? `${user.id}/jobs/${id}/${job.tok}` : `${user.id}/jobs/${id}`;
  const t0 = Date.now();
  const canStart = () => Date.now() - t0 < POLL_BUDGET_MS;     // 超過預算就不再開始新步驟，留到下次輪詢
  const T_JOB = job.t0 || new Date(g.created_at).getTime();
  const mark = label => { job.tm = [...(job.tm || []), [label, Date.now() - T_JOB]].slice(-30); };   // 各步驟時間點（毫秒），收尾時放進結果，方便追查哪一步慢
  const hardLeft = () => t0 + POLL_HARD_MS - Date.now();
  try {
    // 0) 單品文字規格：付費工作、整套引擎、第一次送出前，只做一次（一個看圖呼叫；失敗就不帶規格繼續）
    // 第一步是 FASHN（不需要文字規格）時，不擋送出：送出後同一輪或下一輪再做，兩件事同時進行
    const firstIsFashn = !!(job.steps[0] && job.steps[0].category);
    if (job.engine === 'outfit' && !job.cap_done && (firstIsFashn ? job.chains.every(c => c.req || c.i > 0) : job.chains.some(c => c.i === 0 && !c.req)) && canStart()) {
      job.cap_done = true;
      const targets = captionTargets(job.item_steps);
      if (targets.length) {
        try { job.captions = parseCaptions(await visionJson(env, captionPrompt(targets), targets.map(t => t.url), QA_TIMEOUT_MS), job.item_steps); }
        catch (e) { job.captions = null; job.cap_error = String(e.message).slice(0, 120); }
      }
      mark('captions');
      if (!canStart()) { await save(); return running(); }   // 規格花太久：這次輪詢不再送出合成
    }
    // 1) 推進每條合成鏈（一次最多一個 Gemini 步驟）
    await Promise.all(job.chains.map(async (ch, ci) => {
      for (let guard = 0; guard < 3 && ch.i < job.steps.length && canStart(); guard++) {
        const st = job.steps[ch.i];
        if (st.type === 'outfit') {
          if (!ch.req) {
            job.t = job.t || {}; job.t.submit = Date.now(); job.t.start = 0; mark('submit:outfit');
            const only = Array.isArray(st.only) ? st.only : null;
            if (!job.cap_done) { const tg = captionTargets(job.item_steps); job.cap_done = true; if (tg.length) { try { job.captions = parseCaptions(await visionJson(env, captionPrompt(tg), tg.map(t => t.url), QA_TIMEOUT_MS), job.item_steps); } catch (e) { job.captions = null; } mark('captions'); } }
            if (only && !ch.base) ch.base = ch.cur;          // 衣服已由 FASHN 換好：記下來，萬一換鞋改到動作可以退回
            const sel = (job.item_steps || []).map((x, i) => [x, i]).filter(([x]) => !only || only.includes(x.type));
            const urls = [ch.cur, ...sel.filter(([x]) => x.image_url).map(([x]) => x.image_url)];
            const caps = Array.isArray(job.captions) ? sel.map(([, i]) => job.captions[i]) : null;
            ch.req = await outfitSubmit(env, st.engine || 0, urls, outfitPrompt(sel.map(([x]) => x), job.hints, job.face_hint, { captions: caps, fixNotes: job.fix_notes, body: job.body, wear: job.wear, keepOutfit: !!only }), job.hires !== false, job.aspect); return;
          }
          let r;
          try { r = await falCheck(env, ch.req, '換裝服務'); }
          catch (e) {
            // 備援：換下一個整套引擎；都不行就改用逐件 FASHN
            ch.req = null;
            job.outfit_errors = [...(job.outfit_errors || []), String(e.message).slice(0, 120)];
            if ((st.engine || 0) + 1 < OUTFIT_ENGINES.length) { st.engine = (st.engine || 0) + 1; return; }
            job.engine = 'fashn'; job.steps = job.item_steps; job.chains.forEach(c => { c.i = 0; c.cur = job.person_url; c.req = null; });
            return;
          }
          job.t = job.t || {};
          if (!r) { if (ch.req.last_status === 'IN_PROGRESS' && !job.t.start) job.t.start = Date.now(); return; }
          job.t.done = Date.now(); if (!job.t.start) job.t.start = job.t.done; mark('done:outfit');
          ch.cur = r; ch.req = null; ch.i++;
          if (!canStart()) return;                // 查詢可能花了十幾秒：超過預算就不再送下一步
          continue;
        }
        if (st.type === 'qa') {
          // 品質檢查：一個看圖呼叫；呼叫失敗視為通過。不過關且還沒重做過 → 換 pro 引擎、帶著原因重做一次
          const targets = captionTargets(job.item_steps);
          // 先回報「圖好了、檢查中」讓使用者馬上看到這張，品質檢查留到下一次輪詢（前端收到後會立刻再問一次）。排程代跑時不必等。
          if (!job.prefetch && !internal && job.checking !== ch.cur) { job.checking = ch.cur; mark('show'); return; }
          if (!job.cap_done && targets.length) {
            job.cap_done = true;
            try { job.captions = parseCaptions(await visionJson(env, captionPrompt(targets), targets.map(t => t.url), QA_TIMEOUT_MS), job.item_steps); } catch (e) { job.captions = null; job.cap_error = String(e.message).slice(0, 120); }
            mark('captions');
          }
          let qa = null;
          try { qa = normalizeQa(await visionJson(env, qaPrompt(targets, job.captions, job.wear), [ch.cur, job.person_url, ...targets.map(t => t.url)], QA_TIMEOUT_MS), targets); }
          catch (e) { qa = { identity: null, items: [], framing: null, artifacts: [], verdict: 'pass', error: String(e.message).slice(0, 120), at: Date.now() }; }
          qa.chain = ci; qa.attempt = (job.retries || 0) + 1; mark('qa:' + qa.verdict + (qa.verdict === 'retry' ? '[' + ['mirrored', 'body_changed', 'pose_changed', 'zoomed', 'color_wrong', 'leftover'].filter(k => qa[k]).concat((qa.extra_items || []).length ? ['extra'] : [], (qa.items || []).filter(x => x.match != null && x.match < QA_MIN_ITEM).map(x => 'm' + x.match), qa.identity != null && qa.identity < QA_MIN_IDENTITY ? ['id' + qa.identity] : [], qa.framing != null && qa.framing < QA_MIN_FRAMING ? ['fr' + qa.framing] : [], qa.error ? ['err'] : []).join(',') + ']' : (qa.error ? '[err]' : '')));
          job.qa_for = ch.cur;
          job.qa_log = [...(job.qa_log || []), { url: ch.cur, verdict: qa.verdict, identity: qa.identity, framing: qa.framing, items: (qa.items || []).map(x => ({ t: x.type, m: x.match, issue: x.issue })), flags: ['mirrored', 'body_changed', 'pose_changed', 'zoomed', 'color_wrong', 'leftover'].filter(k => qa[k]), extra: qa.extra_items || [], artifacts: qa.artifacts || [] }].slice(-4);
          job.qa = qa; job.qa_history = [...(job.qa_history || []), qa].slice(-4);
          job.cands = [...(job.cands || []), { url: ch.cur, s: qaScore(qa), qa }].slice(-3);
          const changed = q => !!(q && (q.pose_changed || q.body_changed || q.mirrored || q.zoomed || (q.identity != null && q.identity < QA_MIN_IDENTITY)));   // 人被動到了
          const onlySt = job.steps.find(s => s.type === 'outfit' && Array.isArray(s.only));
          // 排程代跑時（使用者不在線上），配件那一步動到人就直接退回只換好衣服的那張，不多花一次
          if (qa.verdict === 'retry' && ch.base && changed(qa) && internal && !job.prefetch) {
            job.extras_dropped = onlySt ? onlySt.only : null; ch.cur = ch.base; job.qa = { ...qa, verdict: 'pass', fallback: 'base' }; ch.i++; continue;
          }
          if (qa.verdict === 'retry' && job.prefetch) { job.pf_bad = true; ch.i++; continue; }   // 預先合成不過關：先不重做（不一定會被用），認領時再重做
          // 重做一次就好（實測：FASHN 被退回後再用 FASHN 重做多半還是不過，換整套引擎的成功率高很多；再多做只是讓人多等）
          const maxRetries = 1;
          if (qa.verdict === 'retry' && (job.retries || 0) < maxRetries) {
            job.retries = (job.retries || 0) + 1;
            job.fix_notes = qaCorrections(qa, targets) || 'the result did not match the product photos closely enough';
            // 有配件步驟（only）時：
            //  ・配件那一步動到人（動作／身形／鏡像／放大）→ 從「只換好衣服」那張再做一次配件（衣服是 FASHN 做的，人沒動過）
            //  ・人沒動、但衣服本身不對（FASHN 那幾步做壞了）→ 只重做配件救不回來，全部交給整套引擎從頭做
            const clothingBad = (qa.items || []).some(x => CLOTHING_TYPES.includes(x.type) && x.match != null && x.match < QA_MIN_ITEM) || qa.leftover || qa.color_wrong || (qa.extra_items || []).length > 0;
            if (ch.base) job.safe = ch.base;       // 記住「人沒被動過」的那張，最後萬一都不行可以退回它
            // 整套引擎先做（含配件）的工作不過關，而且是動到人或衣服不對 → 改走保守做法：FASHN 逐件換衣服，最後才只換配件
            if (job.alt === 'fashn' && !job.alt_used && (changed(qa) || clothingBad)) {
              job.alt_used = true; job.first = 'fashn';
              const cl = (job.item_steps || []).filter(x => x.category && x.type !== 'bottom'), ex = (job.item_steps || []).filter(x => !x.category || x.type === 'bottom');
              job.steps = [...cl.map(x => ({ ...x })), ...(ex.length ? [{ type: 'outfit', engine: 0, only: ex.map(x => x.type) }] : []), { type: 'qa' }];
              job.rejected = [...(job.rejected || []), ch.cur].slice(-2);
              job.chains.forEach(c => { c.req = null; c.cur = job.person_url; c.i = 0; c.base = null; });
              mark('alt:fashn');
              if (!canStart()) return;
              continue;
            }
            if (!job.steps.some(s => s.type === 'outfit') || (onlySt && clothingBad && !changed(qa))) { job.steps = [{ type: 'outfit', engine: 0 }, { type: 'qa' }]; job.first_rejected = 'fashn'; job.chains.forEach(c => { c.base = null; }); }   // FASHN 不過關 → 改用整套引擎
            const oi = job.steps.findIndex(s => s.type === 'outfit');
            const ost = job.steps[oi];
            // 實測 Pro 常會放大裁切、改構圖，重做時維持同一個引擎、只帶上退回原因（使用者開高品質模式才用 Pro）
            job.rejected = [...(job.rejected || []), ch.cur].slice(-2);
            ch.req = null; ch.cur = (ost && Array.isArray(ost.only) && ch.base) ? ch.base : job.person_url; ch.i = oi >= 0 ? oi : 0;
            if (!canStart()) return;              // 重送交給下次輪詢（避免同一輪再多一個呼叫）
            continue;
          }
          // 不再重做：挑最好的一張；如果最好的那張還是動到了人，而我們有「只換好衣服、人沒動」的那張 → 用那張，並告訴使用者哪幾樣沒換上
          if (qa.verdict === 'retry') {
            const best = (job.cands || []).reduce((a, b) => (b.s > a.s ? b : a), { s: -1e9, qa: qa, url: ch.cur });
            const safe = ch.base || job.safe;
            if (safe && changed(best.qa)) {
              job.extras_dropped = onlySt ? onlySt.only.slice() : (job.item_steps || []).filter(x => !x.category).map(x => x.type); if (!job.extras_dropped.length) job.extras_dropped = null;
              ch.cur = safe; job.qa = { ...best.qa, verdict: 'pass', fallback: 'base' };
            } else if (best.url && best.url !== ch.cur && best.s > qaScore(qa)) { ch.cur = best.url; job.qa = { ...best.qa, picked: 'earlier' }; }
          }
          ch.i++;
          continue;
        }
        if (st.category) {
          let r;
          try {
            if (!ch.req) { ch.req = await falSubmit(env, ch.cur, st.image_url, st.category, st.photo_type, st.mode || FASHN_MODE, { seed: st.seed, seg: st.seg }); mark('submit:' + st.type); return; }
            r = await falCheck(env, ch.req, '衣服試穿服務');
          } catch (e) {
            // FASHN 這張做不了（照片被擋、偵測不到人、服務異常…）：不要整筆失敗，改用整套引擎重做
            if (job.first === 'fashn' && !job.fashn_failed && job.engine === 'outfit') {
              job.fashn_failed = String(e.message).slice(0, 160); mark('fashn-error');
              job.steps = [{ type: 'outfit', engine: 0 }, { type: 'qa' }];
              job.chains.forEach(c => { c.i = 0; c.cur = job.person_url; c.req = null; c.base = null; });
              return;
            }
            throw e;
          }
          if (!r) return;                         // 還在排隊／處理中
          ch.cur = r; ch.req = null; ch.i++; mark('done:' + st.type);     // 完成，換下一步
          if (!canStart()) return;
          continue;
        }
        if (hardLeft() < 45000) return;           // Gemini 步驟需要較長時間，留到下次輪詢
        const [personData, idRef, itemImg] = await Promise.all([urlToDataUri(ch.cur, 15000), urlToDataUri(job.person_url, 15000), st.image_url ? urlToDataUri(st.image_url, 15000) : Promise.resolve(undefined)]);
        const item = { type: st.type, image: itemImg, text: st.text };
        const out = await geminiEdit(env, personData, item, idRef, (job.hints || '') + (st.type === 'hair' ? (job.face_hint || '') : ''), t0 + POLL_HARD_MS);
        ch.cur = await putImage(env, `${base}/c${ci}-s${ch.i}`, out); ch.i++;
        return;                                   // 一次只做一個 Gemini（控制單次請求時間）
      }
    }));
    // 快速預覽：付費（非預先合成）才做，而且只做一次 FASHN（主要那件衣服）
    if (job.pv && !job.pv.done && !job.front && !job.prefetch && canStart()) {
      const pv = job.pv, cl = job.item_steps.filter(x => x.category && x.type !== 'bottom');
      try {
        if (!cl.length) pv.done = true;
        else if (!pv.req) pv.req = await falSubmit(env, pv.cur || job.person_url, cl[0].image_url, cl[0].category, cl[0].photo_type, 'performance');
        else { const r = await falCheck(env, pv.req, '預覽'); if (r) { pv.shown = r; pv.req = null; pv.i = 1; pv.done = true; pv.more = cl.length > 1; } }
      } catch { pv.done = true; }
    }
    const chainsDone = job.chains.every(c => c.i >= job.steps.length);
    if (!chainsDone) { await save(); return running(); }
    // 正面先完成就先存檔回傳，360° 在後面慢慢補
    if (!job.front) {
      if (hardLeft() < 25000) { await save(); return running(); }
      job.front = await Promise.all(job.chains.map((c, i) => { const u = c.cur; return u.startsWith(env.SUPABASE_URL) ? u : copyToStorage(env, `${base}/front-${i}-${randTok()}`, u).catch(() => u); }));
    }
    // 2) 360°：用影片模型生成「原地轉一圈」的短片（首尾都是正面 → 無縫循環），前端拖曳即可旋轉
    if (job.want_views && !job.views && !job.views_error) {
      if (!canStart()) { await save(); return running(); }
      const refundViews = async (msg) => {
        job.views_error = String(msg).slice(0, 160);
        const refund = Math.min(2, job.pay);
        const newPay = job.pay - refund, newFree = job.free - (2 - refund);
        // 資料庫的 cost 欄同步更新；真的改到才退點（逾時清理是依 cost 欄退）
        const upd = await sbPatch(env, `/rest/v1/generations?id=eq.${id}&status=in.(running,working)&cost=eq.${Number(g.cost) || 0}`, { cost: newPay, free_used: newFree }, true).catch(() => []);
        if (Array.isArray(upd) && upd.length) {
          if (refund > 0) await rpc(env, 'add_credits', { p_user: user.id, p_amount: refund }).catch(() => {});
          g.cost = newPay; g.free_used = newFree; job.pay = newPay; job.free = newFree;
        }
      };
      try {
        const spinSubmit = async () => {
          // 依序嘗試：送出失敗（端點或參數不符）就換下一個
          job.spin_m = job.spin_m || 0;
          while (job.spin_m < SPIN_MODELS.length) {
            if (hardLeft() < 20000) return;       // 時間不夠，下次輪詢再送
            try { job.views_req = await falQueueSubmit(env, SPIN_MODELS[job.spin_m], { prompt: SPIN_PROMPT, image_url: job.front[0], start_image_url: job.front[0], first_frame_image: job.front[0], end_image_url: job.front[0], duration: '5', generate_audio: false, prompt_optimizer: false, negative_prompt: 'blur, distortion, morphing, changing clothes, changing face, extra limbs, camera shake, cut, zoom, text' }, '360° 服務'); job.views_req.m = job.spin_m; return; }
            catch (e) { job.spin_errors = [...(job.spin_errors || []), SPIN_MODELS[job.spin_m].split('fal.run/')[1] + ': ' + String(e.message).slice(0, 160)]; job.spin_m++; }
          }
          throw new Error('360° 服務暫時無法使用');
        };
        if (!job.views_req) {
          await spinSubmit();
        } else {
          let d;
          try { d = await falCheck(env, job.views_req, '360° 服務', true); }   // 直接傳物件，讓 last_status／暫時性錯誤計數存進 job
          catch (e) { job.spin_errors = [...(job.spin_errors || []), 'run ' + job.spin_m + ': ' + String(e.message).slice(0, 160)]; job.spin_m++; job.views_req = null; await spinSubmit(); d = null; }
          if (d) {
            job.spin_done_at = Date.now();
            const vurl = d.video && d.video.url;
            if (!vurl) throw new Error('360° 服務沒有回傳影片');
            job.views = { video: await copyToStorage(env, `${base}/spin-${randTok()}`, vurl).catch(() => vurl) };
          }
        }
      } catch (e) { await refundViews(e.message); }
      await save(); return running();
    }
    // 3) 收尾。重做後最好的那張仍被判定「明顯不合格」→ 圖照給（附說明），但這次不收費
    let badRefund = 0;
    if (!job.prefetch && !job.bad_refund && qaClearlyBad(job.qa)) { badRefund = job.pay || 0; job.bad_refund = { pay: job.pay || 0, free: job.free || 0 }; job.pay = 0; job.free = 0; }
    // 沒換上的配件（一換就會動到人，所以保留原樣）不收費：每樣退 1 點；用免費額度付的就把額度還回去
    else if (!job.prefetch && Array.isArray(job.extras_dropped) && job.extras_dropped.length && !job.drop_refund) {
      const n = job.extras_dropped.length, backPay = Math.min(n, job.pay || 0), backFree = Math.min(n - backPay, job.free || 0);
      job.drop_refund = { pay: backPay, free: backFree }; job.pay = (job.pay || 0) - backPay; job.free = (job.free || 0) - backFree; badRefund = backPay;
    }
    const fin = await finishJob(env, user.id, g, job, vcond);
    if (!fin.got) return running();
    if (badRefund > 0) { await rpc(env, 'add_credits', { p_user: user.id, p_amount: badRefund }).catch(() => {}); if (fin.result.credits != null) fin.result.credits += badRefund; }
    return jout({ status: 'ok', result: fin.result }, 200, cors);
  } catch (e) {
    const r = await stopJob(env, user.id, g, job, '合成失敗（已退回點數）：' + e.message, vcond).catch(() => null);
    return jout(r || { status: 'running' }, 200, cors);
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
  const r = await fetchT(srcUrl, {}, '下載結果', 20000);
  if (!r.ok) throw new Error('下載結果失敗');
  const mime = (r.headers.get('Content-Type') || 'image/png').split(';')[0];
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
  const path = `${pathNoExt}.${ext}`;
  const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/results/${path}`, { method: 'POST', headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' }, body: r.body });
  if (!up.ok) throw new Error('圖片儲存失敗');
  return `${env.SUPABASE_URL}/storage/v1/object/public/results/${path}`;
}
/* ---- FASHN 分段：送出／查一次 ---- */
async function falSubmit(env, personUrl, garmentUrl, category, photoType, mode = 'quality', opt = {}) {
  const headers = { 'Authorization': 'Key ' + need(env, 'FAL_KEY'), 'Content-Type': 'application/json' };
  const r = await fetchT(FAL_QUEUE, { method: 'POST', headers, body: JSON.stringify({ model_image: personUrl, garment_image: garmentUrl, category, mode, garment_photo_type: ['flat-lay', 'model'].includes(photoType) ? photoType : 'auto', num_samples: 1, output_format: 'jpeg', seed: Number.isFinite(opt.seed) ? opt.seed : Math.floor(Math.random() * 1e9), ...(opt.seg ? { segmentation_free: false } : {}) }) }, '衣服試穿服務', 15000);
  const t = await r.text();
  if (!r.ok) throw new Error('衣服試穿服務：' + extractErr(t));
  const j = JSON.parse(t);
  if (!j.status_url || !j.response_url) throw new Error('衣服試穿服務沒有回應工作編號');
  return { status_url: j.status_url, response_url: j.response_url, at: Date.now() };
}
async function falCheck(env, req, label = '衣服試穿服務', raw = false) {
  const headers = { 'Authorization': 'Key ' + need(env, 'FAL_KEY') };
  if (Date.now() - (req.at || 0) > (raw ? 6 * 60 * 1000 : UPSTREAM_TIMEOUT_MS)) throw new Error(label + '逾時，請稍後再試');
  // 暫時性錯誤（我們這邊逾時／連線失敗、fal 5xx）：保留 req，當作「還在處理」下次再查；避免誤判成失敗而重送（重複付費）
  let sr;
  try { sr = await fetchT(req.status_url, { headers }, label, 10000); } catch (e) { req.transient = (req.transient || 0) + 1; if (req.transient <= 6) return null; throw e; }
  if (sr.status >= 500) { req.transient = (req.transient || 0) + 1; if (req.transient <= 6) return null; throw new Error(label + '：服務暫時無法使用（' + sr.status + '）'); }
  const sd = await sr.json().catch(() => ({}));
  req.last_status = sd.status;
  if (sd.status === 'FAILED' || (sr.status >= 400 && sr.status !== 202)) throw new Error(label + '：' + friendlyFal(typeof sd.error === 'string' ? sd.error : (Array.isArray(sd.detail) ? sd.detail.map(x => x && x.msg || '').join('; ') : (sd.detail || '處理失敗'))));
  if (sd.status !== 'COMPLETED') return null;
  let rr;
  try { rr = await fetchT(req.response_url, { headers }, label, 15000); } catch (e) { req.transient = (req.transient || 0) + 1; if (req.transient <= 6) return null; throw e; }
  const rt = await rr.text();
  if (rr.status >= 500) { req.transient = (req.transient || 0) + 1; if (req.transient <= 6) return null; throw new Error(label + '：' + extractErr(rt)); }
  if (!rr.ok) throw new Error(label + '：' + extractErr(rt));
  const d = JSON.parse(rt);
  if (raw) return d;
  const u = d && d.images && d.images[0] && d.images[0].url;
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
  if (/exhausted balance|user is locked|insufficient (credit|balance)/i.test(m)) return 'AI 服務暫時無法使用（系統額度不足），請稍後再試';
  if (/detect body pose|person_image|no person|pose/i.test(m)) return '照片裡偵測不到完整的人體，請換一張正面、全身入鏡、光線清楚的照片';
  if (/garment_image|garment/i.test(m)) return '衣服圖看不清楚，請換一張正面、背景乾淨的衣服照';
  if (/content|nsfw|safety/i.test(m)) return '這張照片不符合安全規範，請換一張';
  if (/timeout|timed out/i.test(m)) return '處理逾時，請再試一次';
  return m.slice(0, 200);
}
function extractErr(t) { let raw; try { const j = JSON.parse(t); const d = j.detail; raw = Array.isArray(d) ? d.map(x => x && x.msg || '').join('; ') : (typeof d === 'string' ? d : (j.error || j.message || t)); } catch { raw = String(t); } return friendlyFal(raw); }

/* ---- Gemini 影像編輯（模型備援鏈） ---- */
async function geminiEdit(env, person, item, identityRef, bodyHint, deadline) {
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
      const rem = deadline ? deadline - Date.now() : UPSTREAM_TIMEOUT_MS;
      if (rem < 5000) { lastErr = lastErr || '處理逾時，請再試一次'; break; }
      const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': need(env, 'GEMINI_KEY') },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
      }, '配件/髮型服務', deadline ? Math.min(60000, rem) : undefined);
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
    if (deadline && deadline - Date.now() < 5000) break;
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
async function urlToDataUri(u, maxMs) {
  const r = await fetchT(u, {}, '下載結果', maxMs);
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
  if (!env.GEMINI_KEY && !env.FAL_KEY) return json({ error: '搭配建議服務尚未啟用' }, 503, cors);
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
  // 先登記使用次數再呼叫 AI（避免同時連發或失敗重試繞過每日上限）
  await sb(env, '/rest/v1/events', { method: 'POST', body: JSON.stringify({ user_id: user.id, name: 'outfit', props: { have: have.length } }) });
  let out = null, lastErr = '';
  try { out = await falLLM(env, prompt); } catch (e) { lastErr = e.message; }
  const models = out || !env.GEMINI_KEY ? [] : TEXT_MODELS;
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
  return json({ outfits, note: String(out.note || '').slice(0, 120) }, 200, cors);
}

/* ---------------- 商品櫥窗 ---------------- */
async function handleProducts(request, env, cors, url) {
  // 商品清單 60 秒內同樣的查詢直接用記憶體快取（workers.dev 網域不支援 Cache API），不必每次都查資料庫
  const ck = url.search, CC = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' };
  const hit = PROD_CACHE.get(ck); if (hit && Date.now() - hit.t < 60000) return new Response(hit.body, { status: 200, headers: { ...cors, ...CC, 'X-Cache': 'HIT' } });
  const type = url.searchParams.get('type'), gender = url.searchParams.get('gender'), q = (url.searchParams.get('q') || '').replace(/[(),"*\\]/g, ' ').trim().slice(0, 40);
  const page = Math.min(10000, Math.max(0, Math.floor(Number(url.searchParams.get('page')) || 0))), size = Math.min(24, Math.max(6, Math.floor(Number(url.searchParams.get('size')) || 24)));
  let qs = `/rest/v1/products?active=eq.true&select=id,source,brand,name,type,gender,price,currency,image_url,buy_url,tags,sizes,featured&order=${(gender === 'f' || gender === 'm') ? 'gender.asc,' : ''}featured.desc,created_at.desc&limit=${size}&offset=${page * size}`;   // 選了男／女：該性別的商品排前面，不分男女的（鞋、帽、包、男女適穿）排後面（'f'、'm' 的字母順序都在 'u' 前）
  if (type && ['top','bottom','dress','shoes','hat','accessory','hair'].includes(type)) qs += `&type=eq.${type}`;
  if (gender === 'f' || gender === 'm') qs += `&gender=in.(${gender},u)` + (gender === 'm' && !type ? '&type=neq.dress' : '');   // 男生不顯示洋裝
  const brand = (url.searchParams.get('brand') || '').replace(/[(),"*\\]/g, ' ').trim().slice(0, 60);
  if (brand) qs += `&brand=eq.${encodeURIComponent(brand)}`;
  if (q) qs += `&or=(name.ilike.*${encodeURIComponent(q)}*,brand.ilike.*${encodeURIComponent(q)}*)`;
  let rows;
  try { rows = await sb(env, qs); } catch (e) { rows = await sb(env, qs.replace(',sizes,', ',')); }  // 舊資料庫尚未加 sizes 欄位時仍可用
  const th = await thumbIndex(env);
  if (th && Array.isArray(rows)) for (const r of rows) { const k = th[String(r.id)]; if (k) r.thumb_url = `${env.SUPABASE_URL}/storage/v1/object/public/thumbs/${r.id}-${k}.webp`; }
  const body = JSON.stringify({ products: rows, page, has_more: rows.length === size });
  if (PROD_CACHE.size > 300) PROD_CACHE.clear(); PROD_CACHE.set(ck, { t: Date.now(), body });
  return new Response(body, { status: 200, headers: { ...cors, ...CC } });
}
const PROD_CACHE = new Map();
/* 預先產生的縮圖索引（tools/build_thumbs.py 寫入）；同一個 Worker 執行個體快取 5 分鐘 */
let THUMB_IDX = null, THUMB_AT = 0;
async function thumbIndex(env) {
  if (THUMB_IDX && Date.now() - THUMB_AT < 300000) return THUMB_IDX;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/public/thumbs/index.json`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) { THUMB_IDX = await r.json(); THUMB_AT = Date.now(); }
  } catch {}
  return THUMB_IDX;
}
async function handleBrands(env, cors, url) {
  // Supabase 一次最多回 1000 筆，商品超過後要分頁，否則品牌清單會少
  // gender=f|m：只算那一邊（含不分男女）的商品，男生就不會看到只有女裝的品牌
  const g = url && url.searchParams.get('gender'); const gq = (g === 'f' || g === 'm') ? `&gender=in.(${g},u)` + (g === 'm' ? '&type=neq.dress' : '') : '';
  const rows = [];
  for (let off = 0; off < 10000; off += 1000) {
    const page = await sb(env, `/rest/v1/products?active=eq.true${gq}&select=brand&order=id&limit=1000&offset=${off}`).catch(() => []);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const c = {}; for (const r of rows) if (r.brand) c[r.brand] = (c[r.brand] || 0) + 1;
  const brands = Object.entries(c).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  return json({ brands }, 200, { ...cors, 'Cache-Control': 'public, max-age=600' });
}
// 商品尺寸表：tools/sync_*.py 寫在 Supabase Storage（公開 sizecharts 桶；建桶失敗時放在 results/sizecharts/）
const SIZECHART_PATHS = ['sizecharts/', 'results/sizecharts/'];
async function handleSizechart(env, cors, url) {
  const id = intId(url.searchParams.get('id')); if (!id) return json({ error: '缺少 id' }, 400, cors);
  for (const pre of SIZECHART_PATHS) {
    const r = await fetchT(`${env.SUPABASE_URL}/storage/v1/object/public/${pre}${id}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } }, '尺寸表', 10000).catch(() => null);
    if (!r || !r.ok) continue;
    let d; try { d = await r.json(); } catch { continue; }
    if (!d || typeof d !== 'object' || !d.sizes || typeof d.sizes !== 'object') continue;
    return json(d, 200, { ...cors, 'Cache-Control': 'public, max-age=86400' });
  }
  return json({ error: '這件商品沒有尺寸表' }, 404, { ...cors, 'Cache-Control': 'public, max-age=600' });
}
async function handleProductClick(request, env, cors) {
  let body; try { body = await request.json(); } catch { return json({ ok: false }, 400, cors); }
  const user = await optionalUser(request, env);
  const action = body.action === 'buy' ? 'buy' : 'try';
  await sb(env, '/rest/v1/product_clicks', { method: 'POST', body: JSON.stringify({ product_id: intId(body.product_id) || null, user_id: user ? user.id : null, anon_id: String(body.anon_id || '').slice(0, 64) || null, action }) }).catch(() => {});
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
  if (body.id) { const pid = intId(body.id); if (!pid) return json({ error: 'id 格式錯誤' }, 400, cors); await sbPatch(env, `/rest/v1/products?id=eq.${pid}`, row); return json({ ok: true, id: pid }, 200, cors); }
  const r = await sbInsert(env, 'products', row); return json({ ok: true, id: r && r.id }, 200, cors);
}
async function handleProductDelete(request, env, cors, url) {
  try { await requireAdmin(request, env); } catch (e) { return json({ error: e.message }, e.status || 401, cors); }
  const id = intId(url.searchParams.get('id')); if (!id) return json({ error: '缺少 id' }, 400, cors);
  await sbPatch(env, `/rest/v1/products?id=eq.${id}`, { active: false }); return json({ ok: true }, 200, cors);
}

// 商品圖代理：只允許代理資料庫裡的商品圖（防止被當成開放代理）
async function handleImgProxy(request, env, cors, url) {
  const id = intId(url.searchParams.get('id')); if (!id) return json({ error: '缺少 id' }, 400, cors);
  const rows = await sb(env, `/rest/v1/products?id=eq.${id}&active=eq.true&select=image_url`);
  if (!rows.length) return json({ error: '找不到商品' }, 404, cors);
  let r = await fetchT(rows[0].image_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TryOnBot/1.0)' } }, '商品圖', 20000).catch(() => ({ ok: false }));
  if (!r.ok) {   // 有些官網（例如 plain-me）擋機器人 UA，改用一般瀏覽器 UA＋來源官網 Referer 再試一次
    let origin = ''; try { origin = new URL(rows[0].image_url).origin + '/'; } catch {}
    r = await fetchT(rows[0].image_url, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'image/*,*/*;q=0.8', 'Referer': origin } }, '商品圖', 20000).catch(() => ({ ok: false }));
  }
  if (!r.ok) {   // 有些圖床（fonlego 系統的 gozo 等）擋 Cloudflare Worker 的連線：改經 wsrv.nl 圖片服務轉抓（前端縮圖本來就用它）
    r = await fetchT('https://wsrv.nl/?url=' + encodeURIComponent(rows[0].image_url) + '&output=jpg&q=90', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TryOnBot/1.0)' } }, '商品圖', 20000).catch(() => ({ ok: false }));
  }
  if (!r.ok) return json({ error: '商品圖載入失敗' }, 502, cors);
  const ct = (r.headers.get('Content-Type') || 'image/jpeg').split(';')[0];
  if (!ct.startsWith('image/')) return json({ error: '不是圖片' }, 502, cors);
  return new Response(r.body, { status: 200, headers: { ...cors, 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' } });
}

/* ---------------- 事件與錯誤回報 ---------------- */
// analyze／outfit 由 Worker 自己登記（當每日次數用），前端不可再送，否則會重複計數
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
  // 1) 優先用資料庫端 RPC 一次刪光（見 supabase/delete_user_objects.sql）；沒有這個函式才走遞迴列出
  let purged = false;
  try { await rpc(env, 'delete_user_objects', { p_user: user.id }); purged = true; }
  catch { /* 函式不存在（404 / 42883 / PGRST202）或執行失敗：改走遞迴列出 */ }
  if (!purged) {
    const r = await purgeUserStorage(env, user.id).catch(() => ({ done: false }));
    purged = r.done;
  }
  if (!purged) await sbPatch(env, `/rest/v1/profiles?id=eq.${user.id}`, { purge_pending: true }).catch(() => {});   // 還有殘留：之後再清（欄位不存在也不阻擋）
  try { await sbPatch(env, `/rest/v1/orders?user_id=eq.${user.id}`, { user_email: user.email || null }); } catch {}
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY } });
  if (!r.ok) return json({ error: '刪除帳號失敗，請聯絡客服' }, 500, cors);
  return json({ ok: true }, 200, cors);
}

// 遞迴刪除使用者在 Storage 的圖片。Storage 的 list 只列「該層」，子目錄只回一個資料夾佔位（id 為 null），
// 所以 uid/jobs/<gen.id>/<tok>/... 要一層層往下走。每次刪最多 100 個路徑；總呼叫數有上限（Free 方案每請求 50 個子請求）。
async function purgeUserStorage(env, userId, maxCalls = 40) {
  let calls = 0; const stats = { done: true, deleted: 0 };
  const listDir = async (bucket, prefix) => {
    const out = { files: [], dirs: [] };
    for (let offset = 0; ; offset += 1000) {
      if (calls >= maxCalls) { stats.done = false; break; }
      calls++;
      const list = await sb(env, `/storage/v1/object/list/${bucket}`, { method: 'POST', body: JSON.stringify({ prefix, limit: 1000, offset }) });
      for (const o of (Array.isArray(list) ? list : [])) { if (!o || !o.name) continue; if (o.id) out.files.push(prefix + o.name); else out.dirs.push(prefix + o.name + '/'); }
      if (!Array.isArray(list) || list.length < 1000) break;
    }
    return out;
  };
  const del = async (bucket, names) => {
    for (let i = 0; i < names.length; i += 100) {
      if (calls >= maxCalls) { stats.done = false; return; }
      calls++;
      await sb(env, `/storage/v1/object/${bucket}`, { method: 'DELETE', body: JSON.stringify({ prefixes: names.slice(i, i + 100) }) });
      stats.deleted += Math.min(100, names.length - i);
    }
  };
  for (const bucket of ['results', 'wardrobe']) {
    try {
      const stack = [userId + '/'];                       // 深度優先：uid/ → jobs/ → <id>/ → <tok>/
      while (stack.length) {
        if (calls >= maxCalls) { stats.done = false; break; }
        const prefix = stack.pop();
        const { files, dirs } = await listDir(bucket, prefix);
        if (files.length) await del(bucket, files);
        stack.push(...dirs);
      }
    } catch { stats.done = false; }                      // 刪不掉不阻擋刪帳號，但標記未清完
  }
  return stats;
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
  // 尚未設定正式綠界金鑰（測試環境）：只有管理者能測試，一般使用者不能用測試卡換到真點數
  if (cfg.test && !isAdmin(env, user)) return json({ error: '付款功能尚未開放' }, 503, cors);
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
    // 測試環境的金鑰是公開的：只替管理者的測試訂單加點
    if (cfg.test && !isAdminEmail(env, o.user_email)) {
      await sbPatch(env, `/rest/v1/orders?trade_no=eq.${encodeURIComponent(p.MerchantTradeNo)}&status=eq.pending`, { status: 'test_blocked' }).catch(() => {});
      return new Response('1|OK');
    }
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
