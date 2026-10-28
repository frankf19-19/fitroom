/**
 * 雲端試衣間 — AI 試穿代理 Worker  v0.2.0
 * 部署到 Cloudflare Workers。負責保管 fal.ai 金鑰、限制來源與大小，轉呼叫 FASHN 試穿模型。
 *
 * 需要設定的 Secret / 變數（Worker → Settings → Variables）：
 *   FAL_KEY          fal.ai 的 API Key（Secret）
 *   ALLOWED_ORIGIN   允許的網站來源，例如 https://frankf19-19.github.io（可用逗號填多個）
 */

const FAL_ENDPOINT = 'https://fal.run/fal-ai/fashn/tryon/v1.6';
const MAX_BODY_BYTES = 9 * 1024 * 1024; // 兩張 base64 圖的上限

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
    if (!originOk) return json({ error: '來源不被允許' }, 403);
    if (!env.FAL_KEY) return json({ error: 'Worker 尚未設定 FAL_KEY' }, 500);

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) return json({ error: '圖片太大，請縮小後再試' }, 413);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'JSON 格式錯誤' }, 400); }

    const { person, garment, category } = body || {};
    if (!isDataImage(person) || !isDataImage(garment)) return json({ error: '請提供人像與衣服圖片（data URI）' }, 400);
    const cat = ['tops', 'bottoms', 'one-pieces', 'auto'].includes(category) ? category : 'auto';

    const payload = {
      model_image: person,
      garment_image: garment,
      category: cat,
      mode: 'balanced',
      garment_photo_type: 'auto',
      num_samples: 1,
      output_format: 'png'
    };

    let r;
    try {
      r = await fetch(FAL_ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': 'Key ' + env.FAL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return json({ error: '無法連線到試穿服務：' + e.message }, 502);
    }

    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { msg = JSON.parse(text).detail || JSON.parse(text).error || text; } catch {}
      return json({ error: '試穿服務回報錯誤（' + r.status + '）：' + String(msg).slice(0, 300) }, 502);
    }
    let data;
    try { data = JSON.parse(text); } catch { return json({ error: '試穿服務回傳格式異常' }, 502); }
    const url = data?.images?.[0]?.url;
    if (!url) return json({ error: '試穿服務沒有回傳圖片' }, 502);
    return json({ image: url });
  }
};

function isDataImage(s) {
  return typeof s === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(s) && s.length < 6 * 1024 * 1024;
}
