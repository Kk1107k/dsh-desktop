# -*- coding: utf-8 -*-
"""
DeepSeek 鲸鱼图标渲染器
- 输入：assets/whale.svg（dsh 官方 favicon 的精确复刻，社区已校验）
- 输出：多尺寸 ICO / PNG（透明背景，黑色鲸鱼）

渲染管线（2026-09-24 重写）：
  无头 Chrome/Edge 光栅化 SVG（2048px，透明底）
    → Pillow 多级 2× 降采样到目标尺寸 → 加徽章 → 手写 PNG-in-ICO

为什么不再用 Pillow 画多边形：
  鲸鱼 path 有 4 条子路径，其中第 2 条是身体镂空（绕向与主体相反）、
  第 3/4 条是眼睛等细节。ImageDraw.polygon 不懂 nonzero 填充规则，
  会把镂空和细节也涂黑，整条鲸鱼糊成一坨圆团。
  SVG 的填充规则必须交给真正的渲染器（浏览器）来做。
"""
import io
import os
import re
import struct
import subprocess
import tempfile
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SVG_PATH = os.path.join(ASSETS, "whale.svg")
MASTER = 2048                            # 光栅化母版尺寸

# 状态徽章色（update=琥珀，running=绿）
AMBER = (255, 176, 32)
GREEN = (52, 211, 153)

_BROWSERS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)


def _find_browser():
    for p in _BROWSERS:
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 Chrome/Edge，无法光栅化 SVG（本脚本依赖浏览器渲染填充规则）")


def _rasterize_master():
    """无头浏览器把 whale.svg 光栅化成 2048px 透明底 RGBA 母版"""
    d = re.findall(r'<path[^>]*\sd="([^"]+)"',
                   open(SVG_PATH, encoding="utf-8").read())[0]
    tmp = tempfile.mkdtemp(prefix="whale_svg_")
    html = os.path.join(tmp, "whale.html")
    png = os.path.join(tmp, "whale.png")
    with open(html, "w", encoding="utf-8") as f:
        f.write(
            '<html><body style="margin:0">'
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{MASTER}" height="{MASTER}" '
            'viewBox="0 0 50 50">'
            f'<path fill-rule="nonzero" fill="#000" d="{d}"/>'
            "</svg></body></html>"
        )
    subprocess.run(
        [_find_browser(), "--headless", "--disable-gpu",
         "--default-background-color=00000000",      # 透明底截图
         f"--window-size={MASTER},{MASTER}",
         "--virtual-time-budget=3000",
         f"--screenshot={png}",
         "file:///" + html.replace("\\", "/")],
        check=True, capture_output=True, timeout=120,
    )
    im = Image.open(png).convert("RGBA")
    for p in (html, png):
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp)
    except OSError:
        pass
    return im


_master = None


def load_master():
    global _master
    if _master is None:
        _master = _rasterize_master()
    return _master


def _downscale(im, target):
    """
    多级 2× 降采样后再落到目标尺寸。
    一次性大比例 LANCZOS（如 2048→256）会有振铃与残余锯齿；
    逐级减半能让边缘过渡更干净。
    """
    while im.width > target * 2:
        nxt = max(target, im.width // 2)
        im = im.resize((nxt, nxt), Image.LANCZOS)
    return im.resize((target, target), Image.LANCZOS)


def _fix_transparent_rgb(im):
    """
    把"完全透明"像素的 RGB 从 (0,0,0) 改成白。

    忽略 alpha 通道的看图工具（Windows 照片查看器/画图等）会把
    RGB 为黑的透明区显示成整块黑方块。半透明边缘像素保持原样 ——
    那些是抗锯齿，动它们会在深色背景上出白边。
    """
    r, g, b, a = im.split()
    mask = a.point(lambda v: 255 if v == 0 else 0)      # 仅命中完全透明像素
    white = Image.new("L", im.size, 255)
    return Image.merge("RGBA", (
        Image.composite(white, r, mask),
        Image.composite(white, g, mask),
        Image.composite(white, b, mask),
        a,
    ))


def render_whale(S, margin=0.10):
    """
    输出 S×S 透明底黑色鲸鱼。
    margin: 相对画布的边距比例（防止贴边被裁剪）。
    """
    m = load_master()
    bbox = m.getbbox()                                  # 按 alpha 求内容包围盒
    content = m.crop(bbox)
    side = max(content.size)
    pad = round(side * margin / (1 - 2 * margin))
    canvas = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    canvas.alpha_composite(content, (
        (side + 2 * pad - content.size[0]) // 2,
        (side + 2 * pad - content.size[1]) // 2,
    ))
    return _fix_transparent_rgb(_downscale(canvas, S))


def draw_badge(im, color=AMBER):
    """右上角圆形徽章"""
    S = im.size[0]
    d = ImageDraw.Draw(im)
    R = max(2, S * 0.22)
    cx = S - R * 0.95
    cy = R * 0.95
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=color + (255,))
    # 浅描边，保证在浅色背景上徽章也清晰
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=(255, 255, 255, 90))
    return _fix_transparent_rgb(im)


def save_ico(path, sizes, badge=None):
    """手写 PNG-in-ICO 容器（Pillow 12 的 ICO save 只写单帧，必须自己组）"""
    frames = []
    for s in sizes:
        im = render_whale(s)
        if badge:
            draw_badge(im, badge)
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        frames.append((s, buf.getvalue()))

    n = len(frames)
    header = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    entries = bytearray()
    for s, data in frames:
        b = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", b, b, 0, 0, 1, 32, len(data), offset)
        offset += len(data)

    with open(path, "wb") as f:
        f.write(header + bytes(entries) + b"".join(d for _, d in frames))
    return path


def main():
    # 1) 应用主图标（窗口 / 安装包 / 任务栏）
    save_ico(os.path.join(ASSETS, "icon.ico"),
             [16, 20, 24, 32, 40, 48, 64, 128, 256])

    # 2) 托盘 - 常态（黑色鲸鱼）
    save_ico(os.path.join(ASSETS, "tray.ico"),
             [16, 20, 24, 32, 48, 64])

    # 3) 托盘 - 有可用更新（带琥珀徽章）
    save_ico(os.path.join(ASSETS, "tray-update.ico"),
             [16, 20, 24, 32, 48, 64], badge=AMBER)

    # 4) 托盘 - 运行中（绿色徽章）
    save_ico(os.path.join(ASSETS, "tray-running.ico"),
             [16, 20, 24, 32, 48, 64], badge=GREEN)

    # 5) 单尺寸 PNG
    for s in (16, 32, 64, 128, 256, 512):
        render_whale(s).save(os.path.join(ASSETS, f"logo-{s}.png"))
    for s in (16, 32, 64, 256):
        render_whale(s).save(os.path.join(ASSETS, f"tray-{s}.png"))
    render_whale(256).save(os.path.join(ASSETS, "tray.png"))
    draw_badge(render_whale(256), AMBER).save(os.path.join(ASSETS, "tray-update.png"))
    draw_badge(render_whale(256), GREEN).save(os.path.join(ASSETS, "tray-running.png"))

    # 6) 验证输出
    print("=== 生成完成 ===")
    for f in sorted(os.listdir(ASSETS)):
        if f.endswith((".ico", ".png")) and not f.startswith("_"):
            p = os.path.join(ASSETS, f)
            print(f"  {os.path.getsize(p):>8} B  {f}")


if __name__ == "__main__":
    main()
