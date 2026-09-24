# -*- coding: utf-8 -*-
"""
从品牌字体提取文字的 SVG 轮廓（真·逐线条书写动画用）。

输出两层：
- `fill`：整字的完整 path（多个 contour 合在一起），写完一个字后由它"落墨"
- `strokes[]`：把每个字拆成**一根根独立的轮廓线**，每根单独一条 path，
  笔一根一根地写 —— 而不是靠"填充渐显"把字补出来

要点：
- 应用 kern 表（花体连笔位置必须按字距排布，否则字母脱节）
- 坐标全部"烘焙"成最终 px（缩放 + Y 翻转 + 基线定位），不留 transform，
  浏览器端 getTotalLength / getPointAtLength 才能直接返回可用坐标
- 输出保留 2 位小数，控制体积
"""
import os

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.misc.transform import Transform

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND_TEXT = "DeepseekHarness"


def _ntos(v):
    s = f"{v:.2f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def _split_contours(glyph):
    """把一个字形的轮廓拆成若干根独立线条（以 moveTo 为界）"""
    rec = RecordingPen()
    glyph.draw(rec)
    parts = []
    cur = None
    for op, args in rec.value:
        if op == "moveTo":
            if cur is not None:
                parts.append(cur)
            cur = RecordingPen()
            getattr(cur, op)(*args)
        elif op in ("lineTo", "curveTo", "qCurveTo"):
            getattr(cur, op)(*args)
        elif op in ("closePath", "endPath"):
            getattr(cur, op)()
    if cur is not None:
        parts.append(cur)
    return parts


def brand_paths(font_path, text=BRAND_TEXT, px=60, pad=10):
    """返回 dict：w / h / glyphs[]，每个 glyph = {fill: str, strokes: [str, ...]}"""
    f = TTFont(font_path)
    cmap = f.getBestCmap()
    gs = f.getGlyphSet()
    hmtx = f["hmtx"]
    upem = f["head"].unitsPerEm
    s = px / upem

    kern = {}
    if "kern" in f:
        for st in f["kern"].kernTables:
            kern.update(st.kernTable)

    # 第一遍：排布 + 求包围盒
    x = 0.0
    prev = None
    y_min = y_max = 0.0
    seq = []
    for ch in text:
        g = cmap.get(ord(ch))
        if g is None:
            raise SystemExit(f"字体缺字形: {ch!r}")
        if prev is not None and (prev, g) in kern:
            x += kern[(prev, g)]
        bp = BoundsPen(gs)
        gs[g].draw(bp)
        if bp.bounds:
            y_min = min(y_min, bp.bounds[1])
            y_max = max(y_max, bp.bounds[3])
        seq.append((g, x))
        x += hmtx[g][0]
        prev = g

    dy = pad + y_max * s          # 基线在 SVG 里的 y 坐标
    w = round(x * s + 2 * pad)
    h = round((y_max - y_min) * s + 2 * pad)

    # 第二遍：生成填充层 + 逐线条层
    glyphs = []
    for g, gx in seq:
        tf = Transform(s, 0, 0, -s, pad + gx * s, dy)

        pen = SVGPathPen(gs, ntos=_ntos)
        gs[g].draw(TransformPen(pen, tf))
        fill_d = pen.getCommands()

        strokes = []
        for part in _split_contours(gs[g]):
            sp = SVGPathPen(gs, ntos=_ntos)
            part.replay(TransformPen(sp, tf))
            d = sp.getCommands()
            if d:
                strokes.append(d)

        glyphs.append({"fill": fill_d, "strokes": strokes})
    return {"w": w, "h": h, "glyphs": glyphs}


def brand_svg_markup(paths):
    w, h = paths["w"], paths["h"]
    out = []
    for gi, gl in enumerate(paths["glyphs"]):
        rows = [f'<path class="gl-fill" d="{gl["fill"]}"/>']
        rows += [f'<path class="gl-tr" d="{d}"/>' for d in gl["strokes"]]
        out.append(f'<g class="g" data-i="{gi}">' + "".join(rows) + "</g>")
    # 湿墨光晕：跟随笔头的极柔和渐变，只做"笔还在走"的暗示，不是硬黑点
    pen = (
        '<defs><radialGradient id="wetink">'
        '<stop offset="0" stop-color="#0B1020" stop-opacity=".13"/>'
        '<stop offset="50%" stop-color="#0B1020" stop-opacity=".04"/>'
        '<stop offset="100%" stop-color="#0B1020" stop-opacity="0"/>'
        "</radialGradient></defs>\n"
        '        <g id="nib" opacity="0"><circle r="7.5" fill="url(#wetink)"/></g>'
    )
    return (
        f'<svg id="brand" class="brand" viewBox="0 0 {w} {h}" width="{w}" height="{h}"\n'
        f'     role="img" aria-label="{BRAND_TEXT}">\n        '
        + "\n        ".join(out)
        + "\n        "
        + pen
        + "\n      </svg>"
    )


if __name__ == "__main__":
    p = brand_paths(os.path.join(ROOT, "assets", "fonts", "shelley-allegro.woff2"))
    lines = sum(len(g["strokes"]) for g in p["glyphs"])
    print(f"text={BRAND_TEXT!r}  size={p['w']}x{p['h']}  glyphs={len(p['glyphs'])}  lines={lines}")
    for ch, g in zip(BRAND_TEXT, p["glyphs"]):
        print(f"  {ch}: {len(g['strokes'])} 条线")
