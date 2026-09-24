# -*- coding: utf-8 -*-
"""
生成 src/update-dialog.html —— 自动检查更新的弹窗页
样式：白底圆角卡 + 黑色鲸鱼 + 花体品牌字 + 蓝色胶囊按钮
状态机：latest / available / downloading / error，由主进程通过 window.updateAPI 驱动
"""
import base64
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, "assets", "whale.svg")
OUT = os.path.join(ROOT, "src", "update-dialog.html")

# 品牌字体查找顺序：用户放入的 Shelley 优先，找不到再回退到免费替代。
# 把字体文件丢进 assets/fonts/ 即可生效（支持 woff2 / otf / ttf）。
FONT_CANDIDATES = [
    ("shelley-allegro", "Shelley LT Allegro Script"),
    ("italianno", "Italianno"),
]
_FONT_FORMATS = [
    ("woff2", "font/woff2", "woff2"),
    ("otf", "font/otf", "opentype"),
    ("ttf", "font/ttf", "truetype"),
]


def resolve_font():
    """返回 (路径, 显示名, mime, format)"""
    for key, label in FONT_CANDIDATES:
        for ext, mime, fmt in _FONT_FORMATS:
            p = os.path.join(ROOT, "assets", "fonts", f"{key}.{ext}")
            if os.path.exists(p):
                return p, label, mime, fmt
    raise SystemExit(
        "assets/fonts/ 下没有可用的品牌字体。\n"
        "请放入字体文件，例如 assets/fonts/shelley-allegro.otf"
    )


def load_font_face():
    """把字体以 base64 内联，避免依赖用户是否装了该字体。返回 (css, 显示名)"""
    p, label, mime, fmt = resolve_font()
    b64 = base64.b64encode(open(p, "rb").read()).decode("ascii")
    css = (
        "@font-face{font-family:'BrandScript';font-weight:400;font-display:block;"
        f"src:url(data:{mime};base64,{b64}) format('{fmt}');}}"
    )
    return css, label

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>检查更新</title>
<style>
  __FONT_FACE__
  :root{
    --ink:#0B1020; --muted:#6B7280;
    --brand:#2563EB; --brand-2:#3B82F6;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;overflow:hidden}
  body{
    background:rgba(12,17,32,.34);
    display:flex;align-items:center;justify-content:center;
    font-family:"Segoe UI","Microsoft YaHei",-apple-system,sans-serif;
    color:var(--ink);user-select:none;-webkit-app-region:drag;
  }

  .card{
    width:412px;background:#fff;border-radius:18px;
    padding:32px 30px 24px;text-align:center;
    box-shadow:0 20px 54px rgba(10,15,30,.30);
    animation:pop .3s cubic-bezier(.2,.9,.3,1.1) both;
  }
  @keyframes pop{from{opacity:0;transform:scale(.94) translateY(10px)}to{opacity:1;transform:none}}

  .whale{width:58px;height:58px;margin:0 auto 12px}
  .whale svg{width:100%;height:100%;display:block}

  .brand{
    font-size:34px;font-weight:400;line-height:1.15;margin-bottom:8px;
    font-family:"BrandScript",cursive,serif;
    color:var(--ink);
  }

  .msg{font-size:14px;color:var(--muted);line-height:1.65;margin-bottom:22px;min-height:22px}
  .msg b{color:#111827;font-weight:600}
  .notes{
    font-size:12.5px;color:#4B5563;background:#F6F7F9;border-radius:10px;
    padding:12px 14px;margin-bottom:20px;text-align:left;max-height:120px;overflow:auto;
    white-space:pre-wrap;line-height:1.6;
  }
  .notes:empty{display:none}

  /* 下载进度 */
  .track{
    width:100%;height:6px;border-radius:99px;background:#EEF0F4;
    overflow:hidden;margin-bottom:16px;
  }
  .track i{
    display:block;height:100%;width:0;border-radius:99px;
    background:linear-gradient(90deg,var(--brand-2),var(--brand));
    transition:width .3s ease;
  }

  .actions{display:flex;gap:10px;justify-content:center;-webkit-app-region:no-drag}
  /* 圆角按参考图：小圆角矩形，不做胶囊 */
  button{
    border:0;cursor:pointer;font-family:inherit;font-size:14px;font-weight:500;
    padding:9px 22px;border-radius:8px;transition:filter .15s,background .15s;
  }
  .primary{
    background:linear-gradient(180deg,var(--brand-2),var(--brand));
    color:#fff;box-shadow:0 4px 14px rgba(37,99,235,.30);
  }
  .primary:hover{filter:brightness(1.08)}
  .primary:disabled{opacity:.6;cursor:default;filter:none}
  .ghost{background:#F3F4F6;color:#374151}
  .ghost:hover{background:#E5E7EB}

  .hidden{display:none !important}

  @media (prefers-reduced-motion:reduce){
    .card{animation-duration:.01ms}
  }
</style>
</head>
<body>
  <div class="card">
    <div class="whale" aria-label="DeepSeek Harness">
      <svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="nonzero" fill="#000" d="__WHALE_PATH__"/>
      </svg>
    </div>

    <div class="brand">Deepseek Harness</div>

    <!-- 提示文案（各状态复用） -->
    <div class="msg" id="msg">正在检查更新…</div>

    <!-- 更新说明（仅 available 时显示） -->
    <div class="notes hidden" id="notes"></div>

    <!-- 下载进度（仅 downloading 时显示） -->
    <div class="track hidden" id="track"><i id="bar"></i></div>

    <div class="actions">
      <button class="ghost hidden" id="btn-secondary">稍后</button>
      <button class="primary" id="btn-primary">知道了</button>
    </div>
  </div>

<script>
(function () {
  var api = window.updateAPI;
  var $ = function (id) { return document.getElementById(id); };
  var msgEl = $('msg'), notesEl = $('notes'), trackEl = $('track'), barEl = $('bar');
  var btnP = $('btn-primary'), btnS = $('btn-secondary');
  var state = 'checking';

  function render(s, data) {
    data = data || {};
    state = s;
    notesEl.classList.toggle('hidden', !(s === 'available' && data.notes));
    trackEl.classList.toggle('hidden', s !== 'downloading');
    btnS.classList.toggle('hidden', !(s === 'available' || s === 'error'));

    if (s === 'checking') {
      msgEl.textContent = '正在检查更新…';
      btnP.textContent = '知道了'; btnP.disabled = true;
    } else if (s === 'latest') {
      msgEl.innerHTML = '当前已是最新版本 (<b>v' + (data.version || '') + '</b>)';
      btnP.textContent = '知道了'; btnP.disabled = false;
    } else if (s === 'available') {
      msgEl.innerHTML = '发现新版本 <b>v' + (data.version || '') + '</b>';
      notesEl.textContent = data.notes || '';
      btnP.textContent = '立即更新'; btnP.disabled = false;
      btnS.textContent = '稍后';
    } else if (s === 'downloading') {
      msgEl.textContent = '正在下载更新… ' + Math.round((data.progress || 0) * 100) + '%';
      barEl.style.width = Math.round((data.progress || 0) * 100) + '%';
      btnP.textContent = '下载中'; btnP.disabled = true;
    } else if (s === 'error') {
      msgEl.textContent = '检查更新失败：' + (data.message || '网络不可用');
      btnP.textContent = '重试'; btnP.disabled = false;
      btnS.textContent = '关闭';
    }
  }

  btnP.addEventListener('click', function () {
    if (!api) return;
    if (state === 'available') api.startDownload && api.startDownload();
    else if (state === 'error') api.retry && api.retry();
    else api.close && api.close();
  });
  btnS.addEventListener('click', function () {
    if (api && api.close) api.close();
  });

  if (api) {
    if (api.onState) api.onState(render);
    if (api.getState) { var st = api.getState(); if (st) render(st.state, st); }
  } else {
    // 独立预览：依次演示四种状态
    var demo = [
      [0,    'checking',    {}],
      [1200, 'latest',      { version: '0.1.1-rc.2' }],
      [2600, 'available',   { version: '0.1.2', notes: '· 修复托盘在深色任务栏下不可见\\n· 更新通道支持腾讯云 COS 回落' }],
      [4200, 'downloading', { progress: 0.62 }]
    ];
    demo.forEach(function (it) {
      setTimeout(function () { render(it[1], it[2]); }, it[0]);
    });
  }
})();
</script>
</body>
</html>
"""


def main():
    svg = open(SVG, encoding="utf-8").read()
    ds = re.findall(r'<path[^>]*\sd="([^"]+)"', svg)
    if not ds:
        raise SystemExit("whale.svg 里没找到 path d")
    font_face, font_label = load_font_face()
    html = TEMPLATE.replace("__WHALE_PATH__", ds[0])
    html = html.replace("__FONT_FACE__", font_face)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"已生成 {OUT}  ({len(html) // 1024} KB)")
    print(f"  内嵌字体: {font_label}")


if __name__ == "__main__":
    main()
