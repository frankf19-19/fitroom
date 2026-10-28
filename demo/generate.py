"""
產生首頁真人範例圖：用 fal.ai FASHN 把一件衣服合成到一張全身照上，輸出 before/after。
用法（GitHub Actions 會自動呼叫）：
  FAL_KEY=xxx python3 demo/generate.py --person URL或檔案 --garment URL或檔案 --out demo/f
會產生 demo/f-before.jpg 與 demo/f-after.jpg
"""
import argparse, base64, json, os, sys, time, urllib.request

FAL = "https://queue.fal.run/fal-ai/fashn/tryon/v1.6"

def load(src):
    if src.startswith("http"):
        req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req, timeout=60).read()
    else:
        data = open(src, "rb").read()
    mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    return data, f"data:{mime};base64," + base64.b64encode(data).decode()

def call(url, key, method="GET", body=None):
    req = urllib.request.Request(url, method=method, headers={"Authorization": "Key " + key, "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--person", required=True); ap.add_argument("--garment", required=True)
    ap.add_argument("--category", default="auto"); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    key = os.environ.get("FAL_KEY")
    if not key: sys.exit("缺少 FAL_KEY")
    person_bytes, person_uri = load(a.person)
    _, garment_uri = load(a.garment)
    job = call(FAL, key, "POST", {"model_image": person_uri, "garment_image": garment_uri, "category": a.category,
                                   "mode": "quality", "garment_photo_type": "auto", "num_samples": 1, "output_format": "jpeg", "seed": 42})
    print("submitted", job.get("request_id"))
    deadline = time.time() + 240
    while time.time() < deadline:
        time.sleep(3)
        st = call(job["status_url"], key)
        if st.get("status") == "COMPLETED": break
        if st.get("status") == "FAILED": sys.exit("fal 失敗：" + json.dumps(st)[:300])
    res = call(job["response_url"], key)
    url = res["images"][0]["url"]
    after = urllib.request.urlopen(url, timeout=120).read()
    open(a.out + "-before.jpg", "wb").write(person_bytes)
    open(a.out + "-after.jpg", "wb").write(after)
    print("saved", a.out + "-before.jpg", a.out + "-after.jpg")

if __name__ == "__main__":
    main()
