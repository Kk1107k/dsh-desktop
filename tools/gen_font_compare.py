# -*- coding: utf-8 -*-
"""
生成 assets/fonts/_archive/_compare.html —— 花体字候选对比页（选字体阶段的产物，已归档）

注意：候选字体已归档到 assets/fonts/_archive/（品牌字已定稿为 Shelley LT Allegro Script）。
需要重跑本脚本时，字体文件从 _archive/ 取回或改 FONTS 指向 _archive/。
把每个候选字体以 base64 内联，单文件自包含，任何环境都能渲染。
用途：让凯哥一眼选定「和参考图一样」的字体。
"""
import base64
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, "assets", "fonts")

# 展示顺序：最接近 Shelley LT Allegro Script 的放前面
CANDIDATES = [
    ("alex-brush",    "Alex Brush",     "最接近 Shelley Allegro：流畅连笔 + 粗细对比明显"),
    ("great-vibes",   "Great Vibes",    "优雅圆润，连笔明显"),
    ("italianno",     "Italianno",      "极细笔画 + 大倾斜，装饰性强（当前默认）"),
    ("allura",        "Allura",         "近似 Great Vibes，略细"),
    ("pinyon-script", "Pinyon Script",  "正式花体，笔画较匀"),
    ("parisienne",    "Parisienne",     "中等粗细，复古感"),
    ("sacramento",    "Sacramento",     "细线感，单线笔触"),
    ("tangerine",     "Tangerine",      "极细，最轻灵"),
]


def main():
    rows = []
    faces = []
    for i, (key, name, note) in enumerate(CANDIDATES):
        p = os.path.join(FONTS, f"{key}.woff2")
        if not os.path.exists(p):
            continue
        b64 = base64.b64encode(open(p, "rb").read()).decode("ascii")
        fam = f"Cand{i}"
        faces.append(
            f"@font-face{{font-family:'{fam}';"
            f"src:url(data:font/woff2;base64,{b64}) format('woff2');"
            f"font-display:block;}}"
        )
        rows.append(f"""
  <section class="row">
    <div class="meta"><b>{i + 1}. {name}</b><span>{note}</span></div>
    <div class="sample" style="font-family:'{fam}'">DeepseekHarness</div>
    <div class="sample sm" style="font-family:'{fam}'">Deepseek Harness</div>
  </section>""")

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>花体字候选对比</title>
<style>
{chr(10).join(faces)}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#fff;color:#0f1115;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
  padding:28px 0 60px}}
.head{{padding:0 28px 20px;border-bottom:2px solid #0f1115}}
.head h1{{font-size:19px;font-weight:600;margin-bottom:6px}}
.head p{{font-size:13px;color:#6b7280;line-height:1.6}}
.row{{padding:20px 28px;border-bottom:1px solid #eceef2}}
.row:hover{{background:#fafbfc}}
.meta{{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}}
.meta b{{font-size:13px;color:#0f1115}}
.meta span{{font-size:12px;color:#9aa1ad}}
.sample{{font-size:46px;line-height:1.25;font-style:italic;color:#0f1115}}
.sample.sm{{font-size:26px;margin-top:4px;color:#4b5563}}
.foot{{padding:18px 28px;font-size:12.5px;color:#6b7280;line-height:1.7}}
</style>
</head>
<body>
  <div class="head">
    <h1>品牌字体候选</h1>
    <p>
      <b>你要的 Shelley LT Allegro Script 是 Linotype 商业字体</b>（Matthew Carter 设计），
      网上那些"免费下载"站要么要登录、要么是盗版，无法自动获取。<br>
      <b>拿到字体文件后</b>，把它命名为 <code>shelley-allegro.otf</code>（或 .ttf / .woff2）
      放进 <code>assets/fonts/</code>，重跑生成脚本即自动生效，无需改代码。<br>
      下面 8 个是<b>免费可商用</b>的近似替代，挑一个编号告诉我即可（例如「用 1」）。
    </p>
  </div>
{''.join(rows)}
  <div class="foot">
    候选字体均来自 Google Fonts（@fontsource 发行版），已 base64 内联，离线可看。<br>
    <b>Shelley LT Allegro Script 的合法获取途径</b>：Linotype 官网 / Adobe Fonts（Creative Cloud 订阅）/ fonts.com。<br>
    若都不满意，还可试：Herr Von Muellerhoff、Mrs Saint Delafield、Monsieur La Doulaise。
  </div>
</body>
</html>
"""
    out = os.path.join(FONTS, "_compare.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"已生成 {out}")
    print(f"  候选字体 {len(rows)} 个，文件 {len(html) // 1024} KB")


if __name__ == "__main__":
    main()
