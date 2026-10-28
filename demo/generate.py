"""
產生首頁真人範例圖（試穿前 / 試穿後）。
引擎三選一（GitHub Actions 的 Run workflow 可選）：
  gemini : Google AI Studio 影像模型（金鑰免費申請、免費額度足夠做範例）
  fal    : fal.ai FASHN（正式上線用的模型，按張計費）
  hf     : Hugging Face 免費 Space（IDM-VTON，完全免費但可能排隊或失敗）

用法：
  GEMINI_KEY=xxx python3 demo/generate.py --engine gemini --person <網址或檔案> --garment <網址或檔案> --out demo/f
網址可以直接貼 Pexels 的照片頁（https://www.pexels.com/photo/xxx-12345/），會自動取原圖。
"""
import argparse, base64, io, json, os, re, sys, time, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (compatible; TryOnDemo/1.0)"}

def resolve_url(src):
    m = re.search(r"pexels\.com/photo/[^/]*?-?(\d+)/?", src) or re.search(r"pexels\.com/.*?/(\d+)", src)
    if m:
        return f"https://images.pexels.com/photos/{m.group(1)}/pexels-photo-{m.group(1)}.jpeg?auto=compress&cs=tinysrgb&w=1400"
    m = re.search(r"unsplash\.com/photos/[^/]*?-?([A-Za-z0-9_-]{11})$", src)
    if m:
        return f"https://unsplash.com/photos/{m.group(1)}/download?w=1400"
    return src

def load(src):
    if src.startswith("http"):
        url = resolve_url(src)
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90).read()
    else:
        data = open(src, "rb").read()
    mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    return data, mime

def to_jpeg(data, max_side=1400):
    from PIL import Image, ImageOps
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=92); return buf.getvalue()

def http_json(url, headers, body=None, method=None):
    req = urllib.request.Request(url, method=method or ("POST" if body is not None else "GET"), headers={**headers, "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())

# ---------- 引擎 ----------
def run_gemini(person, garment, category):
    key = os.environ.get("GEMINI_KEY") or sys.exit("缺少 GEMINI_KEY")
    what = {"tops": "top", "bottoms": "bottoms", "one-pieces": "dress", "auto": "garment"}[category]
    prompt = (f"Virtual try-on. Make the person in the first photo wear the {what} shown in the second image. "
              "Match the garment's exact design, color, pattern, fabric and fit; drape it naturally on the body with correct lighting and shadows. "
              "Keep everything else identical: the person's face, identity, skin, hair, pose, body shape, the rest of the outfit, background and camera angle. "
              "Do not crop, do not change the aspect ratio, no text. Output one photorealistic image of the same size as the first photo.")
    parts = [{"text": prompt},
             {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(person).decode()}},
             {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(garment).decode()}}]
    models = [os.environ.get("GEMINI_IMAGE_MODEL") or "gemini-nano-banana-2.1", "gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-2.5-flash-image"]
    last = ""
    for model in models:
        for cfg in ({"responseModalities": ["IMAGE"], "imageConfig": {"imageSize": "2K"}}, {"responseModalities": ["IMAGE"]}):
            try:
                d = http_json(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                              {"x-goog-api-key": key}, {"contents": [{"role": "user", "parts": parts}], "generationConfig": cfg})
            except urllib.error.HTTPError as e:
                last = f"{model}: {e.code} {e.read().decode()[:200]}"; print(last)
                if e.code == 404: break
                continue
            for p in d.get("candidates", [{}])[0].get("content", {}).get("parts", []):
                if "inlineData" in p:
                    print("gemini model:", model); return base64.b64decode(p["inlineData"]["data"])
            last = f"{model}: 沒有回傳圖片"
    sys.exit("Gemini 失敗：" + last)

def run_fal(person, garment, category):
    key = os.environ.get("FAL_KEY") or sys.exit("缺少 FAL_KEY")
    h = {"Authorization": "Key " + key}
    uri = lambda b: "data:image/jpeg;base64," + base64.b64encode(b).decode()
    job = http_json("https://queue.fal.run/fal-ai/fashn/tryon/v1.6", h, {"model_image": uri(person), "garment_image": uri(garment), "category": category,
                    "mode": "quality", "garment_photo_type": "auto", "num_samples": 1, "output_format": "jpeg", "seed": 42})
    for _ in range(80):
        time.sleep(3)
        st = http_json(job["status_url"], h)
        if st.get("status") == "COMPLETED": break
        if st.get("status") == "FAILED": sys.exit("fal 失敗：" + json.dumps(st)[:300])
    res = http_json(job["response_url"], h)
    return urllib.request.urlopen(res["images"][0]["url"], timeout=120).read()

def run_hf(person, garment, category):
    from gradio_client import Client, handle_file
    pp, gp = "/tmp/_person.jpg", "/tmp/_garment.jpg"
    open(pp, "wb").write(person); open(gp, "wb").write(garment)
    client = Client("yisol/IDM-VTON", hf_token=os.environ.get("HF_TOKEN") or None)
    try:
        out = client.predict({"background": handle_file(pp), "layers": [], "composite": None}, handle_file(gp),
                             "a photo of a garment", True, False, 30, 42, api_name="/tryon")
    except Exception as e:
        print("API 簽章可能已變更，可用的 API："); print(client.view_api(return_format="str")); raise
    path = out[0] if isinstance(out, (list, tuple)) else out
    return open(path if isinstance(path, str) else path["path"], "rb").read()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="gemini", choices=["gemini", "fal", "hf"])
    ap.add_argument("--person", required=True); ap.add_argument("--garment", required=True)
    ap.add_argument("--category", default="auto"); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    person = to_jpeg(load(a.person)[0]); garment = to_jpeg(load(a.garment)[0], 1024)
    after = {"gemini": run_gemini, "fal": run_fal, "hf": run_hf}[a.engine](person, garment, a.category)
    open(a.out + "-before.jpg", "wb").write(person)
    open(a.out + "-after.jpg", "wb").write(to_jpeg(after))
    print("saved", a.out + "-before.jpg", a.out + "-after.jpg")

if __name__ == "__main__":
    main()
