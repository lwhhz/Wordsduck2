# 从项目根目录的 logo.png 生成安卓启动图标（各密度）+ 网页用的 favicon。
# 源图 2160x2160 32bpp，是「白底上的便签」，本身已经是完整的方形图标，
# 所以直接按密度等比缩放即可，不需要再补背景或加圆角
# （安卓各个启动器会自己套圆角/圆形遮罩）。
from PIL import Image
import os

ROOT = r"C:\Users\Administrator\Downloads\Wordsduck2"
SRC = os.path.join(ROOT, "logo.png")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

# 安卓各密度下的启动图标边长（dp 值 48 乘以密度倍数）
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

src = Image.open(SRC).convert("RGBA")
print("source:", src.size, src.mode)

for d, size in DENSITIES.items():
    out_dir = os.path.join(RES, "mipmap-" + d)
    os.makedirs(out_dir, exist_ok=True)
    im = src.resize((size, size), Image.LANCZOS)
    path = os.path.join(out_dir, "ic_launcher.png")
    im.save(path, "PNG", optimize=True)
    print("wrote", path, size, os.path.getsize(path), "bytes")

# 网页 favicon：浏览器标签页用，48 和 180（iOS 主屏）各一份
assets = os.path.join(ROOT, "assets")
os.makedirs(assets, exist_ok=True)
for size, name in ((192, "logo-192.png"), (512, "logo-512.png")):
    im = src.resize((size, size), Image.LANCZOS)
    path = os.path.join(assets, name)
    im.save(path, "PNG", optimize=True)
    print("wrote", path, size, os.path.getsize(path), "bytes")
