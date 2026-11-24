/*! 账本插件的主页：统计图。
 *
 * 分两页：
 *   主页 /plugins/ledger/          卡片 + 每日柱状图 + 模型排名，不提供天数切换
 *   详情 /plugins/ledger/detail    1/7/30 天切换 + 明细表（原 renderBody）
 *
 * 主页不扫日志：骨架先吐出去，数据走 /plugins/ledger/days 取。
 * 原来整页要读几千个执行文件，7 秒才响应；宿主把插件页放进 iframe，
 * 父页面在这期间重渲染就会把 iframe 换掉，于是永远是白卡。
 * 所以这里只有一段固定 HTML，加上一个 fetch。
 */

/** 主页骨架 + 图表脚本。数据没回来时显示灰色占位柱。 */
type PriceRow = { input?: number; output?: number; cached?: number };

export function chartShell(price: Record<string, PriceRow> = {}, verified = ""): string {
  const priceCount = Object.keys(price ?? {}).length;
  // textarea 里放 JSON，尖括号和 & 要转义，否则会把标签提前闭合。
  const priceText = JSON.stringify(price ?? {}, null, 2)
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>账本</title>
<style>
:root{color-scheme:light dark;--accent:#5b7cfa;--accent-2:#8f88e8;--line:rgba(128,128,128,.28)}
body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;margin:0;padding:20px 22px 40px;max-width:1120px}
h1{font-size:18px;margin:0 0 4px}
p.sub{margin:0 0 18px;opacity:.65;font-size:13px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 22px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.card small{display:block;font-size:12px;opacity:.7;margin:0 0 6px}
.card .val{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.card .foot{font-size:11.5px;opacity:.55;margin-top:4px}
h2{font-size:14px;margin:0}
.panel{border-top:1px solid var(--line);padding-top:14px;margin:0 0 22px}
.panel-head{display:flex;align-items:baseline;gap:10px;margin:0 0 12px}
.badge{font-size:11.5px;opacity:.6;border:1px solid var(--line);border-radius:20px;padding:1px 9px}
.hour-chart{display:flex;gap:10px;padding:6px 0 22px}
.hour-yaxis{display:flex;flex-direction:column;justify-content:space-between;font-size:11px;opacity:.6;padding:0 0 18px;min-width:54px;text-align:right}
.hour-plot{flex:1;position:relative}
.hour-grid{position:absolute;inset:0 0 18px}
.hour-grid i{position:absolute;left:0;right:0;border-top:1px dashed var(--line)}
.hour-bars{display:flex;align-items:flex-end;gap:6px;height:170px;padding:0 0 18px}
.hour-bar{flex:1;position:relative;display:flex;align-items:flex-end;height:100%}
.hour-stack{width:100%;display:flex;flex-direction:column-reverse;height:100%;justify-content:flex-start}
.hour-seg{display:block;width:100%;border-radius:3px 3px 0 0}
.hour-mark{position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:10.5px;opacity:.55;font-style:normal;white-space:nowrap}
.hour-bar.day-zero .hour-stack{height:2px;background:var(--line);border-radius:2px}
.hour-tip{display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);z-index:5;
  background:var(--bg,#fff);border:1px solid var(--line);border-radius:7px;padding:8px 10px;min-width:150px;
  box-shadow:0 6px 20px rgba(0,0,0,.12);font-size:12px;white-space:nowrap}
.hour-tip.flip{left:auto;right:0;transform:none}
.hour-bar:hover .hour-tip{display:block}
.hour-tip strong{display:block;font-size:12px;margin:0 0 5px}
.hour-tip-row{display:flex;align-items:center;gap:6px;opacity:.85}
.hour-tip-row b{margin-left:auto;font-weight:600}
.hour-tip-row i{width:8px;height:8px;border-radius:2px;display:inline-block}
.hour-tip-row.empty{opacity:.5}
.usage-ranking{display:flex;flex-direction:column;gap:9px}
.rank{display:grid;grid-template-columns:minmax(120px,240px) 1fr auto;gap:10px;align-items:center;font-size:12.5px}
.rank-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rank-track{height:8px;background:var(--line);border-radius:5px;overflow:hidden}
.rank-fill{height:100%;background:var(--accent);border-radius:5px}
.rank-value{opacity:.7;font-variant-numeric:tabular-nums;white-space:nowrap}
.skel-card .val{color:transparent;background:var(--line);border-radius:4px;width:70%}
.skel-bars{display:flex;align-items:flex-end;gap:6px;height:170px}
.skel-bars i{flex:1;background:var(--line);border-radius:3px 3px 0 0;opacity:.5}
.metric-tabs{display:inline-flex;gap:2px;border:1px solid var(--line);border-radius:20px;padding:2px;margin-left:auto}
.metric-tabs button{font:inherit;font-size:11.5px;border:0;background:none;color:inherit;opacity:.6;
  padding:2px 10px;border-radius:20px;cursor:pointer}
.metric-tabs button.on{background:var(--accent);color:#fff;opacity:1}
a.more{font-size:12.5px;text-decoration:none;color:var(--accent)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;opacity:.8;margin:0 0 8px}
.legend-item{display:inline-flex;align-items:center;gap:5px}
.legend-item i{width:9px;height:9px;border-radius:2px;display:inline-block}
.legend-more{opacity:.6}
.hour-stack{gap:1px}
.price-panel{margin:24px 0 0;border-top:1px solid var(--line);padding-top:14px}
.price-panel summary{cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px}
.price-panel textarea{width:100%;box-sizing:border-box;margin:10px 0 0;padding:9px 11px;border:1px solid var(--line);
  border-radius:6px;font:12.5px/1.55 ui-monospace,Consolas,monospace;background:transparent;color:inherit;resize:vertical}
.price-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 2px}
.price-actions .file{display:inline-block;padding:5px 11px;border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:12.5px}
.price-actions .file input{display:none}
.price-actions button{font:inherit;font-size:12.5px;padding:5px 13px;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
.price-msg{font-size:12.5px;opacity:.7}
.price-msg.ok{color:#2f9e6a;opacity:1}
.price-msg.err{color:#d24a4a;opacity:1}
</style>
<body>
<h1>账本</h1>
<p class="sub">读执行日志统计真实用量，只读；不改宿主的任何文件。<br><b>金额是自填价目表重算的参考值，不是服务商官方价格，也不是账单</b>——价目表可在本页下方编辑或导入，由使用者自行维护；没配价目的模型显示「—」。
<a class="more" href="/plugins/ledger/detail">看明细 →</a></p>
<div id="chart">
  <div class="stats-grid">${
    [0, 1, 2, 3].map(() => '<div class="card skel-card"><small>&nbsp;</small><div class="val">0</div><div class="foot">&nbsp;</div></div>').join("")
  }</div>
  <div class="panel"><div class="panel-head"><h2>每日输入 token</h2></div>
  <div class="skel-bars">${
    [38, 62, 45, 81, 55, 92, 48].map((h) => `<i style="height:${h}%"></i>`).join("")
  }</div></div>
</div>
<details class="price-panel" id="price-panel">
  <summary>价目表<span class="badge">${priceCount} 个模型</span></summary>
  <p class="sub" style="margin:8px 0 10px">单位「美元 / 百万 token」。键写 <code>provider|模型条目id</code> 或 <code>provider|模型名</code>；没配的模型金额显示「—」。<b>这是自填价目，不是服务商官方价，也不是账单。</b> 核验日期：${verified || "无"}</p>
  <div class="price-actions">
    <label class="file">选择文件…<input type="file" id="price-file" accept=".json,application/json"></label>
    <button type="button" id="price-save">保存</button>
    <span id="price-msg" class="price-msg"></span>
  </div>
  <textarea id="price-json" rows="12" spellcheck="false">${priceText}</textarea>
</details>
<script>
(function(){
  var file=document.getElementById("price-file"), area=document.getElementById("price-json"),
      btn=document.getElementById("price-save"), msg=document.getElementById("price-msg");
  if(!file||!area||!btn||!msg) return;
  file.addEventListener("change",function(){
    var f=file.files&&file.files[0]; if(!f) return;
    var r=new FileReader();
    r.onload=function(){ area.value=String(r.result||""); msg.textContent="已读入 "+f.name; msg.className="price-msg ok"; };
    r.onerror=function(){ msg.textContent="读文件失败"; msg.className="price-msg err"; };
    r.readAsText(f,"utf-8");
  });
  btn.addEventListener("click",function(){
    var data;
    try{ data=JSON.parse(area.value); }
    catch(e){ msg.textContent="JSON 有问题："+e.message; msg.className="price-msg err"; return; }
    msg.textContent="保存中…"; msg.className="price-msg";
    fetch("/plugins/ledger/price",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({price:data})})
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(j.ok){ msg.textContent="已保存 "+j.count+" 个模型的价目"; msg.className="price-msg ok";
          setTimeout(function(){ location.reload(); },900); }
        else { msg.textContent="没存成："+(j.error||"未知"); msg.className="price-msg err"; }
      })
      .catch(function(e){ msg.textContent="请求失败："+e; msg.className="price-msg err"; });
  });
})();
</script>
<script>
var box = document.getElementById("chart");
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function n(v){return Number(v||0).toLocaleString("en-US");}
function short(v){
  v = Number(v||0);
  if (v >= 1e9) return (v/1e9).toFixed(v>=1e10?0:1)+"B";
  if (v >= 1e6) return (v/1e6).toFixed(v>=1e7?0:1)+"M";
  if (v >= 1e3) return (v/1e3).toFixed(v>=1e4?0:1)+"K";
  return String(Math.round(v));
}
function money(v){return "$" + Number(v||0).toFixed(4);}
function moneyTick(v){
  v = Number(v||0);
  if (v >= 1000) return "$" + (v/1000).toFixed(v>=10000?0:1) + "k";
  if (v >= 10) return "$" + v.toFixed(0);
  if (v >= 1) return "$" + v.toFixed(1);
  return "$" + v.toFixed(2);
}
function nice(v){
  if (!(v>0)) return 1;
  var e = Math.pow(10, Math.floor(Math.log(v)/Math.LN10)), f = v/e;
  var m = f<=1?1: f<=2?2: f<=2.5?2.5: f<=5?5:10;
  return m*e;
}
function cards(s){
  var rate = s.input ? (s.cached/s.input*100).toFixed(1) : "0.0";
  var list = [
    ["请求", n(s.rounds) + " 次", "日志里落盘的每一次"],
    ["输入 token", short(s.input), "每轮重发的上下文"],
    ["输出 token", short(s.output), "模型写出来的部分"],
    ["缓存命中", rate + "%", "命中部分按零头计价"],
    ["参考金额", money(s.cost), "按你填的价目重算"]
  ];
  return '<div class="stats-grid">' + list.map(function(c){
    return '<div class="card"><small>' + c[0] + '</small><div class="val">' + esc(c[1]) +
      '</div><div class="foot">' + esc(c[2]) + '</div></div>';
  }).join("") + '</div>';
}
function dayChart(days, metric){
  if (!days.length) return '<p class="sub">这几天没有记录。</p>';
  var isCost = metric === "cost";
  function val(d){ return isCost ? (d.cost == null ? 0 : Number(d.cost)) : (Number(d.input)||0); }
  function fmt(v){ return isCost ? money(v) : short(v); }
  function tick(v){ return isCost ? moneyTick(v) : short(v); }
  var raw = Math.max.apply(null, days.map(val).concat([0]));
  var step = nice(raw/4), top = step*4;
  var ticks = [4,3,2,1,0].map(function(i){return tick(step*i);});
  var grid = [4,3,2,1].map(function(i){return '<i style="bottom:'+i*25+'%"></i>';}).join("");
  var every = days.length > 14 ? Math.ceil(days.length/6) : 1;
  var bars = days.map(function(d, i){
    var v = val(d);
    var h = v ? Math.max(1.5, v/top*100) : 0;
    var flip = i > days.length*0.72 ? " flip" : "";
    var segs = (d.parts||[]).map(function(p){
      var pv = isCost ? (p.cost == null ? 0 : Number(p.cost)) : (Number(p.input)||0);
      if (!pv) return "";
      var ph = Math.max(0.8, pv/top*100);
      return '<span class="hour-seg" style="height:'+ph.toFixed(3)+'%;background:'+modelColor(p.name)+'" title="'+esc(p.name)+'"></span>';
    }).join("");
    var fill = h ? (segs || '<span class="hour-seg" style="height:'+h.toFixed(3)+'%;background:var(--accent)"></span>') : "";
    var tip = v
      ? '<div class="hour-tip'+flip+'"><strong>'+esc(d.day)+' · '+fmt(v)+'</strong>'+
        (d.parts||[]).map(function(p){
          var pv = isCost ? (p.cost == null ? "—" : money(p.cost)) : short(p.input);
          return '<span class="hour-tip-row"><i style="background:'+modelColor(p.name)+'"></i>'+esc(p.name)+'<b>'+pv+'</b></span>';
        }).join("")+
        '<span class="hour-tip-row">输出<b>'+short(d.output)+'</b></span>'+
        '<span class="hour-tip-row">调用<b>'+n(d.rounds)+' 次</b></span>'+
        '<span class="hour-tip-row">参考<b>'+(d.cost == null ? "—" : money(d.cost))+'</b></span></div>'
      : '<div class="hour-tip'+flip+'"><strong>'+esc(d.day)+'</strong><span class="hour-tip-row empty">无记录</span></div>';
    var mark = (i % every === 0) ? '<em class="hour-mark">'+String(d.day).slice(5)+'</em>' : "";
    return '<div class="hour-bar'+(v?"":" day-zero")+'"><div class="hour-stack">'+fill+'</div>'+mark+tip+'</div>';
  }).join("");
  return '<div class="hour-chart"><div class="hour-yaxis">' +
    ticks.map(function(t){return "<span>"+t+"</span>";}).join("") +
    '</div><div class="hour-plot"><div class="hour-grid">'+grid+
    '</div><div class="hour-bars">'+bars+'</div></div></div>';
}
function modelColor(name){
  var h = 0;
  for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function hour24Chart(hours, metric){
  var isCost = metric === "cost";
  function val(d){ return isCost ? (d.cost == null ? 0 : Number(d.cost)) : (Number(d.input)||0); }
  function fmt(v){ return isCost ? money(v) : short(v); }
  function tick(v){ return isCost ? moneyTick(v) : short(v); }
  // 后端给的就是 24 格、按时间升序，直接照排；没有 label 的老数据自己补一个。
  var slots = (hours || []).map(function(h){
    return h && h.label ? h : Object.assign({}, h, { label: String(h.hour).padStart(2, "0") + ":00" });
  });
  if (!slots.length) return '<p class="sub">过去 24 小时没有记录。</p>';
  var raw = Math.max.apply(null, slots.map(val).concat([0]));
  if (!raw) return '<p class="sub">过去 24 小时没有记录。</p>';
  var step = nice(raw/4), top = step*4;
  var ticks = [4,3,2,1,0].map(function(i){return tick(step*i);});
  var grid = [4,3,2,1].map(function(i){return '<i style="bottom:'+i*25+'%"></i>';}).join("");
  var names = [];
  slots.forEach(function(d){ (d.parts||[]).forEach(function(p){ if (names.indexOf(p.name) < 0) names.push(p.name); }); });
  var bars = slots.map(function(d, i){
    var v = val(d);
    var flip = i > 17 ? " flip" : "";
    var segs = (d.parts||[]).map(function(p){
      var pv = isCost ? (p.cost == null ? 0 : Number(p.cost)) : (Number(p.input)||0);
      if (!pv) return "";
      var ph = Math.max(0.8, pv/top*100);
      return '<span class="hour-seg" style="height:'+ph.toFixed(3)+'%;background:'+modelColor(p.name)+'" title="'+esc(p.name)+'"></span>';
    }).join("");
    var tip = d.rounds
      ? '<div class="hour-tip'+flip+'"><strong>'+esc(d.label)+' · '+fmt(v)+'</strong>' +
        (d.parts||[]).map(function(p){
          var pv = isCost ? (p.cost == null ? "—" : money(p.cost)) : short(p.input);
          return '<span class="hour-tip-row"><i style="background:'+modelColor(p.name)+'"></i>'+esc(p.name)+'<b>'+pv+'</b></span>';
        }).join("") +
        '<span class="hour-tip-row">调用<b>'+n(d.rounds)+' 次</b></span>' +
        '<span class="hour-tip-row">参考<b>'+(d.cost == null ? "—" : money(d.cost))+'</b></span></div>'
      : '<div class="hour-tip'+flip+'"><strong>'+esc(d.label)+'</strong><span class="hour-tip-row empty">无记录</span></div>';
    var mark = (i % 3 === 0) ? '<em class="hour-mark">'+esc(d.label).replace(":00","")+'</em>' : "";
    return '<div class="hour-bar'+(d.rounds?"":" day-zero")+'"><div class="hour-stack">'+segs+'</div>'+mark+tip+'</div>';
  }).join("");
  var legend = names.length > 1
    ? '<div class="legend">' + names.slice(0, 8).map(function(nm){
        return '<span class="legend-item"><i style="background:'+modelColor(nm)+'"></i>'+esc(nm)+'</span>';
      }).join("") + (names.length > 8 ? '<span class="legend-more">+' + (names.length - 8) + '</span>' : "") + '</div>'
    : "";
  return legend + '<div class="hour-chart"><div class="hour-yaxis">' +
    ticks.map(function(t){return "<span>"+t+"</span>";}).join("") +
    '</div><div class="hour-plot"><div class="hour-grid">'+grid+
    '</div><div class="hour-bars">'+bars+'</div></div></div>';
}
function ranking(models){
  if (!models.length) return "";
  var top = models.slice(0, 8);
  var max = Math.max.apply(null, top.map(function(m){return Number(m.input)||0;}).concat([1]));
  return '<div class="usage-ranking">' + top.map(function(m){
    var w = Math.max(3, Math.round((Number(m.input)||0)/max*100));
    var name = m.provider + "|" + (m.label || m.modelId);
    return '<div class="rank"><span class="rank-name" title="'+esc(name)+'">'+esc(name)+'</span>'+
      '<div class="rank-track"><div class="rank-fill" style="width:'+w+'%"></div></div>'+
      '<span class="rank-value">'+n(m.rounds)+' 次 · '+short(m.input)+'</span></div>';
  }).join("") + "</div>";
}
var PALETTE = ["#5b7cfa","#8f88e8","#4fb3a3","#e0a04a","#d4727c","#6aa6d8","#9c8f5e","#7d7f8c"];
var last = null;
function render(d, metric){
  last = d;
  var isCost = metric === "cost";
  var tabs = '<span class="metric-tabs">' +
    '<button data-metric="input" class="'+(isCost?"":"on")+'">输入 token</button>' +
    '<button data-metric="cost" class="'+(isCost?"on":"")+'">参考金额</button></span>';
  box.innerHTML = cards(d.summary) +
    '<div class="panel"><div class="panel-head"><h2>过去 24 小时</h2>'+tabs+
    '<span class="badge">按钟点 · 分模型</span></div>'+hour24Chart(d.summary.byHour24||[], metric)+
    '<p class="sub">窗口内每次请求按发生时刻归到钟点，最近 24 小时；一根柱子里按模型分段堆叠。</p></div>' +
    '<div class="panel"><div class="panel-head"><h2>每日'+(isCost?"参考金额":"输入 token")+'</h2>'+
    '<span class="badge">最近 7 天</span></div>'+dayChart(d.summary.byDay||[], metric)+
    '<p class="sub">'+(isCost
      ? "按价目表重算的参考值，不是账单；没配价目的模型不计。"
      : "输入是每轮重发的上下文，钱基本花在这里。")+'</p></div>' +
    '<div class="panel"><div class="panel-head"><h2>模型排名</h2><span class="badge">按输入 token</span></div>'+
    ranking(d.summary.byModelTotal||d.summary.byModel||[])+'</div>';
  [].forEach.call(box.querySelectorAll("[data-metric]"), function(b){
    b.onclick = function(){ if (last) render(last, b.getAttribute("data-metric")); };
  });
}
fetch("/plugins/ledger/days?days=7", {cache:"no-store"})
  .then(function(r){return r.json();})
  .then(function(d){
    if (!d || !d.ok) { box.innerHTML = '<p class="sub">读不到数据：'+esc((d&&d.error)||"未知错误")+'</p>'; return; }
    render(d, "input");
  })
  .catch(function(e){ box.innerHTML = '<p class="sub">读不到数据：'+esc(e)+'</p>'; });
</script>`;
}
