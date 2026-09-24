# -*- coding: utf-8 -*-
"""
生成 src/splash.html —— 开机美化页（白底 + 黑色鲸鱼 + 花体品牌字"真实书写"动画）

品牌字不再是 HTML 文本 + mask 扫描，而是：
1. build 时用 fontTools 把字形轮廓转成 SVG path（含 kern，见 gen_brand_script.py）
2. 浏览器端按"恒定笔速"逐字描绘（stroke-dashoffset），
   长字母耗时多、短字母耗时少 —— 这才是真人写字的节奏
3. 笔尖圆点用 getPointAtLength 实时跟随；墨迹随书写进度同步显现，
   收笔后描边淡出、只留填充 —— 类似 ink 从"湿"到"落定"
4. ?t=秒 调试参数可确定性渲染到任意时刻（供无头截图验证）
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_brand_script import brand_paths, brand_svg_markup  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, "assets", "whale.svg")
OUT = os.path.join(ROOT, "src", "splash.html")
FONT = os.path.join(ROOT, "assets", "fonts", "shelley-allegro.woff2")

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>DeepseekHarness</title>
<style>
  :root{
    --ink:#0B1020;
    --muted:#6B7280;
    --bg:#FFFFFF;
    --hover:#F0F2F5;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;overflow:hidden}
  body{
    background:var(--bg);color:var(--ink);
    font-family:"Segoe UI","Microsoft YaHei",-apple-system,sans-serif;
    display:flex;align-items:center;justify-content:center;
    user-select:none;-webkit-app-region:drag;position:relative;
  }

  /* 右上角窗口控制（无边框窗口自绘，行为由主进程提供） */
  .win-ctl{position:absolute;top:0;right:0;display:flex;-webkit-app-region:no-drag}
  .win-ctl button{
    width:46px;height:32px;border:0;background:transparent;color:#9AA3B2;
    cursor:pointer;font-size:14px;line-height:32px;font-family:inherit;
  }
  .win-ctl button:hover{background:var(--hover);color:#1B1F27}
  .win-ctl button.close:hover{background:#E5484D;color:#fff}

  .stack{display:flex;flex-direction:column;align-items:center}

  /* 鲸鱼：先淡入落位，再进入呼吸 */
  .whale{width:136px;height:136px;margin-bottom:14px;
    animation:whaleIn .55s cubic-bezier(.2,.8,.3,1) both,
              breathe 3s ease-in-out .55s infinite}
  .whale svg{width:100%;height:100%;display:block}
  @keyframes whaleIn{
    from{opacity:0;transform:scale(.88)}
    to{opacity:1;transform:scale(1)}
  }
  @keyframes breathe{
    0%,100%{transform:scale(1);opacity:.96}
    50%{transform:scale(1.04);opacity:1}
  }

  /* ── 品牌字：真实笔迹书写 ──
     默认（JS 未接管前）是完整填充字 —— 任何异常都不会让文字消失。
     JS 接管后逐字描边（恒定笔速）→ 墨迹同步显现 → 描边淡出。 */
  /* ── 品牌字：真·逐线条书写 ──
     两层：gl-fill = 整字填充（写完才出现），gl-tr = 一根根独立的轮廓线。
     默认（JS 未接管）gl-fill 可见、gl-tr 隐藏 —— 任何异常都还是完整的一个字。 */
  .brand{display:block;margin-bottom:18px;overflow:visible}
  .brand .gl-fill{fill:var(--ink);stroke:none}
  .brand .gl-tr{
    fill:none;stroke:var(--ink);
    stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;
    opacity:0;
  }
  .brand.no-anim .gl-fill{fill-opacity:1 !important}
  .brand.no-anim .gl-tr{opacity:0 !important}
  body.freeze *{animation:none !important}
  .brand{display:block;margin-bottom:18px;overflow:visible}

  /* 状态行：等书写完成后由 JS 加 .ready 揭示 */
  .status{
    font-size:13px;color:var(--muted);height:20px;
    display:flex;align-items:center;gap:9px;
    opacity:0;transform:translateY(7px);
    transition:opacity .6s cubic-bezier(.2,.8,.3,1),transform .6s cubic-bezier(.2,.8,.3,1);
  }
  body.ready .status{opacity:1;transform:none}
  .status .swap{transition:opacity .16s ease}
  .dots{display:inline-flex;gap:4px}
  .dots i{width:5px;height:5px;border-radius:50%;background:#B6BDC9;animation:blink 1.4s infinite}
  .dots i:nth-child(2){animation-delay:.18s}
  .dots i:nth-child(3){animation-delay:.36s}
  @keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}

  .version{
    position:absolute;bottom:12px;left:0;right:0;text-align:center;
    font-size:10.5px;color:#C2C8D2;letter-spacing:.4px;
  }

  body.closing{animation:fadeOut .3s ease forwards}
  @keyframes fadeOut{to{opacity:0}}

  @media (prefers-reduced-motion:reduce){
    *{animation-duration:.01ms !important;animation-iteration-count:1 !important}
    .status{opacity:1;transform:none;transition:none}
  }
</style>
</head>
<body>
  <div class="win-ctl">
    <button id="btn-min" title="最小化">&#9472;</button>
    <button id="btn-close" class="close" title="关闭">&#10005;</button>
  </div>

  <div class="stack">
    <div class="whale" aria-label="DeepSeek Harness">
      <svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="nonzero" fill="#000" d="__WHALE_PATH__"/>
      </svg>
    </div>

    __BRAND_SVG__

    <div class="status">
      <span class="swap" id="status">正在启动服务</span>
      <span class="dots"><i></i><i></i><i></i></span>
    </div>
  </div>

  <div class="version" id="version"></div>

<script>
(function () {
  var statusEl = document.getElementById('status');
  var api = window.splashAPI;

  function setText(t) {
    if (statusEl.textContent === t) return;
    statusEl.style.opacity = 0;
    setTimeout(function () {
      statusEl.textContent = t;
      statusEl.style.opacity = 1;
    }, 160);
  }
  // onFinish 是"请求关闭"而不是"立即关闭"（SPEC §4 / D2）：
  // 先加 .closing 播放 300ms 淡出，结束后才真正调用 close()。
  function finish() {
    if (document.body.classList.contains('closing')) return;   // 幂等
    document.body.classList.add('closing');
    setTimeout(function () {
      if (api && api.close) api.close();
    }, 300);
  }

  function bind(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }
  bind('btn-min',   function () { if (api && api.minimize) api.minimize(); });
  bind('btn-close', function () { if (api && api.close)    api.close(); });

  /* ── 品牌字书写动画 ─────────────────────────────
     逐"线条"书写：每个字被拆成一根根独立轮廓线，一根一根写，
     字内笔画之间是小幅提笔、字之间提笔稍长；每根线的快慢有轻微抖动，
     线条内部还有慢落笔→中段快→收笔缓的呼吸感。
     一个字的全部线条写完后才开始"落墨"（填充淡入、笔迹淡出）。
     任何异常都通过 .no-anim 回落到完整填充字，绝不卡在空白上。 */
  var svg = document.getElementById('brand');
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var qs = new URLSearchParams(location.search);
  var tParam = parseFloat(qs.get('t'));
  var ready = false;

  function markReady() {
    if (ready) return;
    ready = true;
    document.body.classList.add('ready');
  }

  if (svg && !reduced) {
    try {
      var groups = [].slice.call(svg.querySelectorAll('g.g'));
      var nib = svg.querySelector('#nib');

      // 展开成"线条"序列：每个绘制单元 = 一根轮廓线
      var units = [], fills = [], trByGlyph = [];
      groups.forEach(function (g, gi) {
        var fillEl = g.querySelector('.gl-fill');
        var trs = [].slice.call(g.querySelectorAll('.gl-tr'));
        fills.push(fillEl);
        trByGlyph.push(trs);
        trs.forEach(function (el) {
          units.push({ el: el, len: el.getTotalLength(), gi: gi });
        });
      });
      var total = units.reduce(function (a, u) { return a + u.len; }, 0);

      // 笔速（px/s）——越小写得越慢；字内 G_LINE / 字间 G_GLYPH 提笔停顿
      var PEN_SPEED = 1150;
      var G_LINE = 0.035, G_GLYPH = 0.075, n = units.length;

      // 每根线的快慢抖动（确定性伪随机），避免整齐像机器
      var seed = 20240923;
      function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
      var jit = units.map(function () { return 0.82 + 0.38 * rnd(); });

      var gaps = [];
      for (var gi2 = 0; gi2 < n; gi2++) {
        gaps.push(gi2 + 1 < n && units[gi2 + 1].gi === units[gi2].gi ? G_LINE : G_GLYPH);
      }
      var gapTotal = gaps.reduce(function (a, b) { return a + b; }, 0);
      var weighted = units.reduce(function (a, u, i) { return a + u.len * jit[i]; }, 0);
      // span = 含提笔停顿的总书写时长，钳制 2.0~4.6s
      var span = Math.min(4.6, Math.max(2.0, total / PEN_SPEED + gapTotal * 0.8));
      var speed = weighted / (span - gapTotal);

      var starts = [], durs = [], glyphEnd = [], acc = 0;
      units.forEach(function (u, i) {
        starts.push(acc);
        var d = u.len * jit[i] / speed;
        durs.push(d);
        acc += d + gaps[i];
        glyphEnd[u.gi] = acc - gaps[i];   // 该字最后一笔收笔的时刻
        u.el.style.opacity = '1';
        u.el.style.strokeDasharray = u.len + ' ' + u.len;
        u.el.style.strokeDashoffset = u.len;
      });
      fills.forEach(function (el) { el.style.fillOpacity = '0'; });
      var writeEnd = acc - G_GLYPH + 0.34;

      // 每根线内部的节奏：慢落笔 → 中段快 → 收笔缓
      var EASE = 0.55;
      function strokeShape(x) {
        return (1 - EASE) * x + EASE * 0.5 * (1 - Math.cos(Math.PI * x));
      }

      function paint(elapsed) {
        var penEl = null, penAt = 0;
        for (var i = 0; i < n; i++) {
          var u = units[i], p = (elapsed - starts[i]) / durs[i];
          if (p <= 0) continue;                              // 还没轮到
          if (p >= 1) { u.el.style.strokeDashoffset = '0'; continue; }  // 这根已写完
          var q = strokeShape(p);
          u.el.style.strokeDashoffset = String(u.len * (1 - q));
          u.el.style.strokeWidth = String(2.95 - 0.85 * q);  // 压感：落笔重、收笔轻
          penEl = u.el; penAt = u.len * q;
        }
        // 每个字：全部线条写完后，墨落定 —— 填充淡入，笔迹同步淡出
        for (var gi = 0; gi < groups.length; gi++) {
          var f = (elapsed - glyphEnd[gi]) / 0.30;
          if (f <= 0) continue;
          var fo = f >= 1 ? 1 : f;
          fills[gi].style.fillOpacity = String(fo);
          var to = 1 - (f - 0.10) / 0.30;
          to = to > 1 ? 1 : (to < 0 ? 0 : to);
          var trs = trByGlyph[gi];
          for (var k = 0; k < trs.length; k++) trs[k].style.opacity = String(to);
        }
        if (nib) {
          if (penEl) {
            var pt = penEl.getPointAtLength(penAt);
            nib.setAttribute('transform',
              'translate(' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1) + ')');
            nib.style.opacity = '1';
          } else {
            nib.style.opacity = '0';
          }
        }
        if (elapsed >= writeEnd) markReady();
      }

      if (!isNaN(tParam)) {
        document.body.classList.add('freeze');           // 截图验证：停掉 CSS 动画
        document.title = 'lines=' + n + ' total=' + Math.round(total) +
                         'px span=' + span.toFixed(2) + 's speed=' + Math.round(speed) + 'px/s';
        paint(tParam >= 99 ? writeEnd + 1 : tParam);     // 调试：?t=秒 确定性渲染
        markReady();
      } else {
        var t0 = null;
        var frame = function (ts) {
          if (t0 === null) t0 = ts;
          var el = (ts - t0) / 1000 + 0.25;            // 鲸鱼先落位 0.25s 再落笔
          paint(el);
          if (el < writeEnd) {
            requestAnimationFrame(frame);
          } else {
            if (nib) nib.style.opacity = '0';
            markReady();
          }
        };
        requestAnimationFrame(frame);
      }
    } catch (e) {
      if (svg) svg.classList.add('no-anim');   // 异常：还原成完整的字
      markReady();
    }
  } else {
    markReady();
  }
  setTimeout(markReady, 5000);   // 兜底：状态行最迟 5s 必须出现

  if (api) {
    if (api.onStatus) api.onStatus(setText);
    if (api.onFinish) api.onFinish(finish);
    if (api.getVersion) {
      var v = api.getVersion();
      if (v) document.getElementById('version').textContent = 'v' + v;
    }
  } else {
    // 独立双击预览：走一遍文案序列，方便单独调视觉
    var demo = [
      [0,    '正在启动服务'],
      [900,  '正在连接本地服务'],
      [1900, '正在加载插件'],
      [2900, '即将就绪']
    ];
    demo.forEach(function (it) {
      setTimeout(function () { setText(it[1]); }, it[0]);
    });
    // 预览模式不伪造版本号（版本号一律由 getVersion() 从 package.json 注入）
    document.getElementById('version').textContent = '预览模式';
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
    bp = brand_paths(FONT)
    markup = brand_svg_markup(bp)
    html = TEMPLATE.replace("__WHALE_PATH__", ds[0])
    html = html.replace("__BRAND_SVG__", markup)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"已生成 {OUT}")
    print(f"  内嵌 path 长度: {len(ds[0])} 字符")
    print(f"  品牌字 SVG: {bp['w']}x{bp['h']}, "
          f"{len(bp['glyphs'])} 字 / {sum(len(g['strokes']) for g in bp['glyphs'])} 条独立线条")
    print(f"  HTML 总大小: {len(html) // 1024} KB")


if __name__ == "__main__":
    main()
