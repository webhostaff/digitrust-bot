'use strict';

/**
 * The remote-login page for Canva.
 *
 * Opening a browser on a server and typing a password into it is the hard part
 * of "log in once". This serves a tiny page, gated by the same AGENT_TOKEN as
 * the assistant, that streams the server's Canva login screen as a picture and
 * sends the owner's taps and typing back to it. The owner logs in exactly as on
 * their own machine; only the resulting Canva cookies are kept, by canvaBot.
 *
 * It is a page, not an API for anyone: without the token every route is 401,
 * and it does nothing unless CANVA_AUTOMATION is on.
 */

const express = require('express');
const canva = require('./canvaBot');

function mount(router, ACCESS_TOKEN) {
  const guard = (req, res, next) => {
    if ((req.query.t || req.get('X-Agent-Token')) !== ACCESS_TOKEN) return res.status(401).send('Unauthorized');
    next();
  };
  const api = express.json();

  router.get('/canva/login', guard, (req, res) => res.type('html').send(PAGE.split('__T__').join(ACCESS_TOKEN)));

  router.post('/canva/start', guard, api, async (req, res) => res.json(await canva.startLogin()));
  router.get('/canva/shot', guard, async (req, res) => {
    const img = await canva.loginShot();
    if (!img) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(img);
  });
  router.post('/canva/click', guard, api, async (req, res) => { await canva.loginClick(+req.body.x || 0, +req.body.y || 0); res.json({ ok: true }); });
  router.post('/canva/type', guard, api, async (req, res) => { await canva.loginType(String(req.body.text || '')); res.json({ ok: true }); });
  router.post('/canva/key', guard, api, async (req, res) => { await canva.loginKey(String(req.body.key || 'Enter')); res.json({ ok: true }); });
  router.post('/canva/finish', guard, api, async (req, res) => res.json(await canva.finishLogin()));
  router.post('/canva/cancel', guard, api, async (req, res) => { await canva.endLogin(); res.json({ ok: true }); });
  router.get('/canva/status', guard, async (req, res) => res.json(await canva.status()));
}

const PAGE = `<!DOCTYPE html><html lang="ar"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Canva login · Yamen</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0e14;color:#eef1f6;font:15px/1.5 -apple-system,system-ui,"Noto Sans Arabic",Tahoma,sans-serif;
  display:flex;flex-direction:column;height:100vh}
header{padding:10px 12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #242b38;background:#10151d}
header b{flex:1;font-size:15px}
button{font:inherit;border:none;border-radius:10px;padding:9px 12px;cursor:pointer}
.g{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}
.s{background:#1a2130;color:#c3cbd9;border:1px solid #242b38}
#wrap{flex:1;position:relative;overflow:hidden;display:grid;place-items:center;background:#05070b}
#screen{max-width:100%;max-height:100%;cursor:pointer;touch-action:manipulation}
#hint{position:absolute;top:10px;left:10px;right:10px;background:#1e1b4b;border:1px solid #3730a3;color:#dbeafe;
  padding:9px 12px;border-radius:10px;font-size:13px}
#kbd{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #242b38;background:#10151d}
#kbd input{flex:1;background:#0b1019;border:1px solid #242b38;color:#fff;border-radius:10px;padding:10px 12px;font-size:16px}
.tip{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:30px;color:#8b95a7}
#done{display:none}
.ok{color:#86efac}.bad{color:#fca5a5}
</style></head><body>
<header>
  <b>🔐 Canva — تسجيل الدخول</b>
  <button class="s" id="refresh">↻</button>
  <button class="g" id="save">✅ حفظ الجلسة</button>
</header>
<div id="wrap">
  <div class="tip" id="tip">…</div>
  <img id="screen" style="display:none">
  <div id="hint" style="display:none">اضغط على الشاشة كيف ما تعمل عادي. للكتابة استعمل الخانة لتحت.</div>
</div>
<div id="kbd" style="display:none">
  <input id="text" placeholder="اكتب هوني (إيميل / باسوورد / كود)…" autocomplete="off">
  <button class="g" id="send">⏎</button>
</div>
<script>
const T='__T__';
const api=(p)=>p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(T);
const post=(p,b)=>fetch(api(p),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
const $=(id)=>document.getElementById(id);
let live=false, timer=null;

async function start(){
  $('tip').style.display='grid'; $('screen').style.display='none'; $('hint').style.display='none'; $('kbd').style.display='none';
  $('tip').innerHTML='⏳ يحل Canva… (ينجم ياخذ 20 ثانية أول مرة)';
  let r;
  try{
    const resp=await post('canva/start');
    const txt=await resp.text();
    try{ r=JSON.parse(txt); }
    catch(_){ r={ok:false,error:'النسخة المنشورة قديمة — صفحة Canva موجودة أما مسار /canva/start مش موجود. أعمل Redeploy كامل (موش Restart) للنسخة الجديدة.'}; }
  }
  catch(e){ r={ok:false,error:'ما وصلش للسيرفر: '+e.message}; }
  if(!r.ok){
    $('tip').innerHTML='<div style="max-width:440px"><div style="font-size:40px">⚠️</div>'+
      '<p class="bad" style="font-size:15px">'+(r.error||'ما نجّمش يحل المتصفّح')+'</p>'+
      '<p style="font-size:13px;color:#8b95a7">أغلب سبب: مكتبات Chromium ناقصة في السيرفر. أعمل Redeploy في Railway باش يتركّبو، ومبعد عاود.</p>'+
      '<button class="g" onclick="start()" style="margin-top:6px">↻ عاود</button></div>';
    return;
  }
  live=true; $('tip').style.display='none'; $('screen').style.display='block'; $('hint').style.display='block'; $('kbd').style.display='flex';
  loop();
}
function loop(){ clearInterval(timer); timer=setInterval(refresh, 1200); refresh(); }
async function refresh(){ if(!live) return; $('screen').src=api('canva/shot')+'&_='+Date.now(); }
$('refresh').onclick=refresh;
$('screen').onclick=async(e)=>{
  const r=$('screen').getBoundingClientRect();
  await post('canva/click',{x:(e.clientX-r.left)/r.width, y:(e.clientY-r.top)/r.height});
  setTimeout(refresh,500);
};
$('send').onclick=async()=>{ const v=$('text').value; if(!v) return; await post('canva/type',{text:v}); await post('canva/key',{key:'Enter'}); $('text').value=''; setTimeout(refresh,600); };
$('text').addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); $('send').click(); }});
$('save').onclick=async()=>{
  $('save').textContent='⏳'; const r=await (await post('canva/finish')).json();
  if(r.ok){ live=false; clearInterval(timer); document.body.innerHTML='<div class="tip"><div><div style="font-size:44px">✅</div><br>تسجّل الدخول. توا الدعوات باش تصير أوتوماتيك.<br>تنجم تسكّر الصفحة.</div></div>'; }
  else { $('save').textContent='✅ حفظ الجلسة'; alert('مازال: '+(r.error||'')); refresh(); }
};
window.addEventListener('beforeunload',()=>{ navigator.sendBeacon && navigator.sendBeacon(api('canva/cancel')); });
start();
</script></body></html>`;

module.exports = { mount };
