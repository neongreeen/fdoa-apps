"use strict";

/* 投資スタディ（独立ページ・閲覧専用）
   正本＝_MOMO/投資_スタディ.md → Mac側publishスクリプトが fdoa-app-data/study.md へ。
   ここはそれを読んで表示するだけ（編集UIは持たない＝正本1箇所の原則）。
   トークンは全FDOAアプリ共通キー（fdoa_gh_token）＝Sim等で接続済みなら設定不要。 */

const CONFIG={
  github:{owner:"neongreeen",repo:"fdoa-app-data",branch:"main"},
  studyFile:"study.md",
  tokenKey:"fdoa_gh_token",
  legacyTokenKeys:["fdoa_bukken_gh_token"],
};

const $=(s,root=document)=>root.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

const reader=createCloudReader({
  owner:CONFIG.github.owner,repo:CONFIG.github.repo,branch:CONFIG.github.branch,
  tokenKey:CONFIG.tokenKey,legacyTokenKeys:CONFIG.legacyTokenKeys,
});

/* ---------- 最小Markdownレンダラ（Simスタディタブから移植＋リンク・見出しID・目次収集を追加） ---------- */
function mdInline(text){
  return esc(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g,"<s>$1</s>")
    .replace(/`([^`]+)`/g,"<code>$1</code>");
}
function mdToHtml(md,toc){
  const lines=String(md||"").split("\n");let html="",i=0,sec=0;
  while(i<lines.length){
    const ln=lines[i];
    if(/^\s*$/.test(ln)){i++;continue;}
    if(/^---+\s*$/.test(ln)){html+="<hr>";i++;continue;}
    let m;
    if((m=ln.match(/^(#{1,4})\s+(.*)$/))){
      const level=m[1].length,id="sec-"+(++sec);
      if(toc&&level<=2)toc.push({id,level,text:m[2].replace(/[*`]/g,"")});
      html+=`<h${level} id="${id}">${mdInline(m[2])}</h${level}>`;i++;continue;
    }
    if(/^```/.test(ln)){
      i++;const code=[];
      while(i<lines.length&&!/^```/.test(lines[i])){code.push(lines[i]);i++;}
      i++;html+=`<pre>${esc(code.join("\n"))}</pre>`;continue;
    }
    if(/^>\s?/.test(ln)){
      const q=[];while(i<lines.length&&/^>\s?/.test(lines[i])){q.push(lines[i].replace(/^>\s?/,""));i++;}
      html+=`<blockquote>${q.map(l=>/^\s*$/.test(l)?"":`<p>${mdInline(l)}</p>`).join("")}</blockquote>`;continue;
    }
    if(/^\s*\d+\.\s+/.test(ln)){
      let list="<ol>";
      while(i<lines.length&&/^\s*\d+\.\s+/.test(lines[i])){list+=`<li>${mdInline(lines[i].replace(/^\s*\d+\.\s+/,""))}</li>`;i++;}
      html+=list+"</ol>";continue;
    }
    if(/^\|/.test(ln)){
      const rows=[];while(i<lines.length&&/^\|/.test(lines[i])){rows.push(lines[i]);i++;}
      const cells=row=>row.replace(/^\||\|$/g,"").split("|").map(cell=>mdInline(cell.trim()));
      let table='<div class="tblwrap"><table>';
      rows.forEach((row,rowIndex)=>{
        if(/^\|[\s:|-]+\|?$/.test(row))return;
        const tag=rowIndex===0?"th":"td";
        table+="<tr>"+cells(row).map(cell=>`<${tag}>${cell}</${tag}>`).join("")+"</tr>";
      });
      html+=table+"</table></div>";continue;
    }
    if(/^\s*-\s+/.test(ln)){
      let list="<ul>";
      while(i<lines.length&&/^\s*-\s+/.test(lines[i])){list+=`<li>${mdInline(lines[i].replace(/^\s*-\s+/,""))}</li>`;i++;}
      html+=list+"</ul>";continue;
    }
    html+=`<p>${mdInline(ln)}</p>`;i++;
  }
  return html;
}

/* ---------- 読み込みと描画 ---------- */
async function loadStudy(){
  const body=$("#studyBody");
  if(!reader.hasToken()){
    $("#tokenPanel").hidden=false;
    body.innerHTML='<p class="muted">GitHub同期を接続すると表示されます（上の接続パネルへ）</p>';
    return;
  }
  $("#tokenPanel").hidden=true;
  body.innerHTML='<p class="muted">読み込み中…</p>';
  try{
    const md=await reader.fetchText(CONFIG.studyFile);
    if(!md){body.innerHTML='<p class="muted">study.md が見つかりません（Mac側のpublishスクリプト未実行の可能性）</p>';return;}
    const dateLine=md.match(/^最終更新：.*$/m);
    if(dateLine)$("#studyMeta").textContent=`正本＝Mac（百指導員が更新・閲覧専用）　${dateLine[0]}`;
    const toc=[];
    body.innerHTML=mdToHtml(md.replace(/^# .*$/m,"").replace(/^最終更新：.*$/m,""),toc);
    renderToc(toc);
  }catch(error){
    if(error.auth){
      $("#tokenPanel").hidden=false;
      body.innerHTML='<p class="muted">トークンが無効です（401）。接続し直してください</p>';
    }else{
      body.innerHTML='<p class="muted">読み込みに失敗（'+esc(error.message||error)+'）。再読込で再試行</p>';
    }
  }
}
function renderToc(toc){
  const panel=$("#tocPanel"),nav=$("#tocBody");
  if(!toc.length){panel.hidden=true;return;}
  nav.innerHTML=toc.map(item=>
    `<a class="${item.level===1?"toc-part":"toc-chapter"}" href="#${item.id}">${esc(item.text)}</a>`
  ).join("");
  panel.hidden=false;
}

$("#btnReload").addEventListener("click",loadStudy);
$("#tokenConnect").addEventListener("click",()=>{
  const token=$("#tokenInput").value.trim();
  if(!token)return;
  reader.connect(token);
  $("#tokenInput").value="";
  loadStudy();
});
loadStudy();
