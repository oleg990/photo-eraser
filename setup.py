#!/usr/bin/env python3
"""Докачивает то, чего нет в архиве: движок onnxruntime-web, модель LaMa (стирание)
и, по желанию, детектор для авто-уборки.

Запуск (один раз, на компьютере):
    python setup.py          — движок + модель стирания (~110 МБ)
    python setup.py --auto   — плюс детектор лишних предметов (поставит ultralytics, ~2 ГБ, один раз)
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request

ORT_VERSION = "1.22.0"
HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor")
MODELS = os.path.join(HERE, "models")
# классы детектора: те же слова, что в GROUPS в app.js (порядок важен)
AUTO_CLASSES = [
    "person", "shoes", "slippers", "boots", "clothes", "towel", "laundry", "jacket",
    "bag", "backpack", "plastic bag", "suitcase", "bottle", "cup", "dish", "shampoo bottle", "cosmetics",
    "box", "cardboard box", "trash", "garbage bag", "cable", "toy", "broom", "bucket", "mop",
]
DET_BASE = os.environ.get("DET_MODEL", "yolov8s-worldv2.pt")   # yolov8m-worldv2.pt — точнее, но тяжелее
MODEL_URLS = [
    "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
    "https://hf-mirror.com/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
]


def get(url, dest, label):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest + ".part", "wb") as f:
        total = int(r.headers.get("content-length") or 0)
        got = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                print(f"\r  {label}: {got / 1e6:.0f} / {total / 1e6:.0f} МБ", end="", flush=True)
    os.replace(dest + ".part", dest)
    print(f"\r  {label}: готово ({os.path.getsize(dest) / 1e6:.1f} МБ)          ")


def main():
    os.makedirs(VENDOR, exist_ok=True)
    os.makedirs(MODELS, exist_ok=True)

    print("1/2 Движок onnxruntime-web", ORT_VERSION)
    api = f"https://data.jsdelivr.com/v1/package/npm/onnxruntime-web@{ORT_VERSION}/flat"
    files = json.load(urllib.request.urlopen(urllib.request.Request(api, headers={"User-Agent": "Mozilla/5.0"}), timeout=60))["files"]
    want = []
    for f in files:
        n = f["name"]
        base = n.rsplit("/", 1)[-1]
        if n.startswith("/dist/") and (base == "ort.min.js" or (base.startswith("ort-wasm-simd-threaded") and base.endswith((".wasm", ".mjs")))):
            want.append((base, f"https://cdn.jsdelivr.net/npm/onnxruntime-web@{ORT_VERSION}{n}"))
    if not any(b == "ort.min.js" for b, _ in want):
        sys.exit("Не нашёл ort.min.js в пакете. Проверьте интернет или версию.")
    for base, url in want:
        dest = os.path.join(VENDOR, base)
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            print("  уже есть:", base)
            continue
        get(url, dest, base)

    print("2/2 Модель LaMa (92 МБ)")
    dest = os.path.join(MODELS, "lama_fp32.onnx")
    if os.path.exists(dest) and os.path.getsize(dest) > 80e6:
        print("  уже есть")
    else:
        for url in MODEL_URLS:
            try:
                get(url, dest, "lama_fp32.onnx")
                break
            except Exception as e:
                print("\n  не вышло:", url.split("/")[2], "-", e)
        else:
            sys.exit(
                "\nМодель не скачалась. Откройте в браузере (при необходимости с VPN):\n"
                "  https://huggingface.co/Carve/LaMa-ONNX/blob/main/lama_fp32.onnx\n"
                "скачайте файл и положите его сюда: " + dest
            )
    split_model(dest)
    if "--auto" in sys.argv:
        setup_auto()
    else:
        print("\n(Авто-уборка не установлена. Для неё:  python setup.py --auto)")
    print("\nГотово. Проверка на компьютере:  python -m http.server 8000  →  http://localhost:8000")


def split_model(path, chunk=45 * 1024 * 1024):
    """GitHub не принимает файлы больше 100 МБ: режем модель на части, приложение склеит их само."""
    size = os.path.getsize(path)
    man_path = path + ".json"
    if os.path.exists(man_path):
        try:
            man = json.load(open(man_path, encoding="utf-8"))
            if man.get("size") == size and all(os.path.exists(f"{path}.part{i:02d}") for i in range(man["parts"])):
                print(f"  части модели уже есть: {man['parts']}")
                return
        except Exception:
            pass
    n = 0
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            with open(f"{path}.part{n:02d}", "wb") as o:
                o.write(b)
            n += 1
    with open(man_path, "w", encoding="utf-8") as f:
        json.dump({"size": size, "parts": n}, f)
    print(f"  модель разрезана на {n} частей по 45 МБ (для GitHub)")


def setup_auto():
    print("3/3 Детектор для авто-уборки")
    dest = os.path.join(MODELS, "detector.onnx")
    if os.path.exists(dest) and os.path.getsize(dest) > 5e6:
        print("  уже есть (удалите models/detector.onnx, чтобы пересобрать)")
    else:
        try:
            import ultralytics  # noqa: F401
        except ImportError:
            print("  ставлю ultralytics (один раз, вместе с PyTorch — это долго)...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "ultralytics"])
        from ultralytics import YOLO, YOLOWorld
        work = os.path.join(MODELS, "_build")
        os.makedirs(work, exist_ok=True)
        cwd = os.getcwd()
        os.chdir(work)
        try:
            m = YOLOWorld(DET_BASE)
            m.set_classes(AUTO_CLASSES)
            m.save("custom_world.pt")
            onnx = YOLO("custom_world.pt").export(format="onnx", imgsz=640, opset=12)
            shutil.move(onnx, dest)
        finally:
            os.chdir(cwd)
        shutil.rmtree(work, ignore_errors=True)
        print(f"  detector.onnx: {os.path.getsize(dest) / 1e6:.1f} МБ")
    with open(os.path.join(MODELS, "detector_classes.json"), "w", encoding="utf-8") as f:
        json.dump(AUTO_CLASSES, f, ensure_ascii=False)
    print("  классы записаны: detector_classes.json")


if __name__ == "__main__":
    main()
