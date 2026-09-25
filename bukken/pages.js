/* =====================================================================
   物件ページ（物件進捗管理の「物件ページ」タブ）
   データ＝非公開の fdoa-app-data/projects/<物件ID>/（page.json・img/・files/・replies.json）
   更新＝fdoa-app-data の tools/project_page.py（百・リタ共通）。このファイルは表示と返事だけ。
   トークンは3アプリ共通の fdoa_gh_token（データ管理タブで接続）。
   ===================================================================== */
'use strict';
(function(){
const GH={owner:'neongreeen',repo:'fdoa-app-data',branch:'main'};
const TOKEN_KEY='fdoa_gh_token';
const LAST_KEY='fdoa_bukken_page_last';
const root=document.getElementById('pagesRoot');
if(!root)return;
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=()=>{try{return localStorage.getItem(TOKEN_KEY)||'';}catch(e){return'';}};
const blobCache={};
let current=null,repliesSha=null,replies=[];

function url(path){return 'https://api.github.com/repos/'+GH.owner+'/'+GH.repo+'/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?ref='+GH.branch+'&_='+Date.now();}
async function gh(path,accept){
  const res=await fetch(url(path),{cache:'no-store',headers:{'Authorization':'Bearer '+token(),'Accept':accept||'application/vnd.github.raw'}});
  if(res.status===401)throw new Error('トークンが無効（データ管理タブで接続し直して）');
  if(res.status===404)return null;
  if(!res.ok)throw new Error('GitHub応答 '+res.status);
  return res;
}
async function json(path){const r=await gh(path);return r?r.json():null;}
async function blobUrl(path){
  if(blobCache[path])return blobCache[path];
  const r=await gh(path);if(!r)throw new Error('ファイルが無い：'+path);
  const u=URL.createObjectURL(await r.blob());blobCache[path]=u;return u;
}
function b64(s){const b=new TextEncoder().encode(s);let bin='';for(let i=0;i<b.length;i+=0x8000)bin+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(bin);}

/* ---------- 一覧 ---------- */
async function start(){
  if(!token()){root.innerHTML='<div class="card"><h2>物件ページ</h2><p class="note">この端末はまだGitHubにつながっていない。「データ管理」タブでトークンを接続すると、物件ページが見られる。</p></div>';return;}
  root.innerHTML='<div class="card"><p class="note">読み込み中…</p></div>';
  try{
    const idx=await json('projects/index.json');
    const items=((idx&&idx.items)||[]).filter(i=>!i.archived);
    if(!items.length){root.innerHTML='<div class="card"><h2>物件ページ</h2><p class="note">物件ページはまだ無い。</p></div>';return;}
    let last='';try{last=localStorage.getItem(LAST_KEY)||'';}catch(e){}
    const pick=items.find(i=>i.projectId===last)||items[0];
    renderShell(items,pick.projectId);
    await openPage(pick.projectId);
  }catch(e){root.innerHTML='<div class="card"><p class="note" style="color:var(--danger)">'+esc(e.message)+'</p></div>';}
}
function renderShell(items,sel){
  root.innerHTML='<div class="pg-pick">'+items.map(i=>
    '<button type="button" class="pg-chip'+(i.projectId===sel?' on':'')+'" data-pid="'+esc(i.projectId)+'"><b>'+esc(i.title)+'</b><small>'+esc(i.current||'')+'</small></button>').join('')+
    '</div><div id="pgBody"></div>';
  root.querySelectorAll('.pg-chip').forEach(b=>b.onclick=()=>{
    root.querySelectorAll('.pg-chip').forEach(x=>x.classList.toggle('on',x===b));
    openPage(b.dataset.pid);
  });
}

/* ---------- 1物件 ---------- */
async function openPage(pid){
  const body=document.getElementById('pgBody');
  body.innerHTML='<div class="card"><p class="note">読み込み中…</p></div>';
  try{localStorage.setItem(LAST_KEY,pid);}catch(e){}
  try{
    const p=await json('projects/'+pid+'/page.json');
    if(!p)throw new Error('page.json が無い');
    current={pid,p};
    body.innerHTML=renderPage(p);
    bind(pid,p);
    loadReplies(pid);
  }catch(e){body.innerHTML='<div class="card"><p class="note" style="color:var(--danger)">'+esc(e.message)+'</p></div>';}
}
function action(a){return '<li class="pg-act"><span class="pg-who'+(a.who==='ヨシアキ'?' y':'')+'">'+esc(a.who)+'</span><div><p>'+esc(a.title)+'</p>'+(a.detail?'<small>'+esc(a.detail)+'</small>':'')+'</div></li>';}
function renderPage(p){
  const st=p.stage||{},steps=st.steps||[];
  const docs=(p.documents||[]).map((d,i)=>'<tr><td>'+esc(d.name)+'</td><td><span class="pg-st '+esc(d.status||'')+'">'+esc(d.statusLabel||'')+'</span></td><td>'+
    (d.file?'<button type="button" class="btn sm sec pg-pdf" data-file="'+esc(d.file)+'">PDFを開く</button>':'')+
    (d.updated?'<small>元PDF更新 '+esc(d.updated)+'</small>':'')+(d.note?'<small>'+esc(d.note)+'</small>':'')+'</td></tr>').join('');
  const imgs=(p.images&&p.images.items)||[];
  return ''+
  '<div class="card pg-head">'+
    (p.eyebrow?'<div class="pg-eyebrow">'+esc(p.eyebrow)+'</div>':'')+
    '<h2 class="pg-title">'+esc(p.title)+'</h2>'+
    '<div class="pg-meta"><span>更新 <b>'+esc(p.updatedAt||'')+'</b></span>'+(p.meta||[]).map(m=>'<span>'+esc(m.label)+' <b>'+esc(m.value)+'</b></span>').join('')+'</div>'+
    '<div class="pg-stage"><h3>'+esc(st.headline||'')+'</h3>'+(st.note?'<p class="note">'+esc(st.note)+'</p>':'')+
      '<ol class="pg-steps">'+steps.map((s,i)=>'<li data-state="'+esc(s.state||'todo')+'"'+(s.state==='current'?' aria-current="step"':'')+'><b>'+(i+1)+' '+esc(s.name)+'</b><small>'+esc(s.note||'')+'</small></li>').join('')+'</ol></div>'+
  '</div>'+
  '<div class="card"><h2>今やること</h2><ul class="pg-acts">'+(p.actions||[]).map(action).join('')+'</ul>'+
    (p.later&&p.later.actions&&p.later.actions.length?'<details class="pg-later"><summary>'+esc(p.later.title||'その後')+'</summary><ul class="pg-acts">'+p.later.actions.map(action).join('')+'</ul></details>':'')+
  '</div>'+
  (docs?'<div class="card"><h2>書類</h2><div class="tblwrap"><table class="pg-docs"><thead><tr><th>書類</th><th>状態</th><th>ファイル</th></tr></thead><tbody>'+docs+'</tbody></table></div></div>':'')+
  (imgs.length?'<div class="card"><details class="pg-imgs" id="pgImgs"><summary>'+esc(p.images.title||'画像で確認')+'（'+imgs.length+'枚）</summary>'+(p.images.note?'<p class="note">'+esc(p.images.note)+'</p>':'')+
    '<div class="pg-grid">'+imgs.map(im=>'<figure><button type="button" class="pg-img" data-file="'+esc(im.file)+'"><img alt="'+esc(im.caption)+'"></button><figcaption>'+esc(im.caption)+'</figcaption></figure>').join('')+'</div></details></div>':'')+
  (p.drafts||[]).map((d,i)=>'<div class="card"><h2>'+esc(d.title)+'</h2>'+(d.note?'<p class="note">'+esc(d.note)+'</p>':'')+
    '<div class="pg-draft"><div class="pg-draftbar"><span>宛先 <b>'+esc(d.to||'')+'</b></span><button type="button" class="btn sm pg-copy" data-i="'+i+'">本文をコピー</button></div><pre id="pgDraft'+i+'">'+esc(d.body)+'</pre></div></div>').join('')+
  '<div class="card"><h2>返事・メモ</h2><p class="note">ここに書くと百とリタが読んで反映する（GitHubに保存）。</p>'+
    '<div class="pg-reply"><textarea id="pgReplyText" placeholder="例：メール送った／持参日は9/30"></textarea><button type="button" class="btn" id="pgReplyBtn">送る</button></div>'+
    '<p class="note" id="pgReplyState"></p><ul class="pg-replies" id="pgReplies"></ul></div>'+
  (p.footer?'<p class="note pg-foot">'+esc(p.footer)+'</p>':'');
}
function bind(pid,p){
  const base='projects/'+pid+'/';
  document.querySelectorAll('#pgBody .pg-pdf').forEach(b=>b.onclick=async()=>{
    const w=window.open('','_blank');const label=b.textContent;b.textContent='読み込み中…';
    try{const u=await blobUrl(base+b.dataset.file);if(w)w.location=u;else location.href=u;}
    catch(e){if(w)w.close();alert(e.message);}finally{b.textContent=label;}
  });
  const det=document.getElementById('pgImgs');
  if(det)det.addEventListener('toggle',async()=>{
    if(!det.open)return;
    for(const btn of det.querySelectorAll('.pg-img')){
      const img=btn.querySelector('img');if(img.src)continue;
      try{img.src=await blobUrl(base+btn.dataset.file);}catch(e){img.alt='読み込めない';}
      btn.onclick=()=>window.open(img.src,'_blank');
    }
  });
  document.querySelectorAll('#pgBody .pg-copy').forEach(b=>b.onclick=async()=>{
    const pre=document.getElementById('pgDraft'+b.dataset.i);
    try{await navigator.clipboard.writeText(pre.textContent);b.textContent='コピーした';}
    catch(e){const r=document.createRange();r.selectNodeContents(pre);const s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='選択した（長押しでコピー）';}
    setTimeout(()=>b.textContent='本文をコピー',2500);
  });
  document.getElementById('pgReplyBtn').onclick=()=>sendReply(pid);
}

/* ---------- 返事（projects/<id>/replies.json） ---------- */
async function loadReplies(pid){
  try{
    const r=await gh('projects/'+pid+'/replies.json','application/vnd.github+json');
    if(r){const j=await r.json();repliesSha=j.sha;replies=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\s/g,'')),c=>c.charCodeAt(0)))).items||[];}
    else{repliesSha=null;replies=[];}
    drawReplies();
  }catch(e){document.getElementById('pgReplyState').textContent=e.message;}
}
function drawReplies(){
  const ul=document.getElementById('pgReplies');if(!ul)return;
  ul.innerHTML=replies.slice().reverse().map(r=>'<li><small>'+esc(r.at)+' '+esc(r.who)+(r.done?'・反映済み':'')+'</small><p>'+esc(r.text)+'</p></li>').join('');
}
async function sendReply(pid){
  const ta=document.getElementById('pgReplyText'),st=document.getElementById('pgReplyState');
  const text=ta.value.trim();if(!text)return;
  st.textContent='送信中…';
  try{
    await loadReplies(pid);
    const at=new Date().toLocaleString('ja-JP',{hour12:false});
    const items=replies.concat([{at,who:'ヨシアキ',text,done:false}]);
    const body={message:'返事：'+pid,content:b64(JSON.stringify({schemaVersion:1,items},null,1)),branch:GH.branch};
    if(repliesSha)body.sha=repliesSha;
    const res=await fetch(url('projects/'+pid+'/replies.json').split('?')[0],{method:'PUT',headers:{'Authorization':'Bearer '+token(),'Accept':'application/vnd.github+json'},body:JSON.stringify(body)});
    if(!res.ok)throw new Error('送れなかった（'+res.status+'）。もう一度押して');
    repliesSha=(await res.json()).content.sha;replies=items;ta.value='';st.textContent='送った（'+at+'）';drawReplies();
  }catch(e){st.textContent=e.message;st.style.color='var(--danger)';}
}

window.fdoaPagesStart=start;
start();
})();
