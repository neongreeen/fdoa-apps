(()=>{
  /* 送信専用スタブ（v0.4〜）：画面の表を丸ごとProgress Portfolioへ送るだけ。
     どの列をどう読むかの解析はアプリ本体（app.js）側にある。
     SBIの画面が変わってもこのブックマークは貼り替え不要——アプリ側を直せば全端末に効く。 */
  const cellText=cell=>String(cell.innerText||"").slice(0,200);
  const grab=doc=>[...doc.querySelectorAll("table")].slice(0,120).map(table=>[...table.rows].slice(0,400).map(row=>[...row.cells].slice(0,60).map(cellText)));
  let tables=[];
  try{tables=grab(document);}catch(error){}
  [...document.querySelectorAll("iframe,frame")].slice(0,20).forEach(frame=>{
    try{if(frame.contentDocument)tables=tables.concat(grab(frame.contentDocument));}catch(error){}
  });
  tables=tables.filter(rows=>rows.length>=2);
  if(!tables.length){alert("この画面に読み取れる表が見つかりませんでした。SBIのポートフォリオ画面で実行してください");return;}
  let target=window.opener&&!window.opener.closed?window.opener:window.__progressPortfolioTarget;
  if(!target||target.closed){
    target=window.open("https://neongreeen.github.io/fdoa-apps/progress/","_blank");
    window.__progressPortfolioTarget=target;
  }
  if(!target){alert("Progress Portfolioを開けませんでした");return;}
  const payload={type:"progress-portfolio:sbi-tables",id:`sbi_${Date.now()}`,capturedAt:new Date().toISOString(),pageUrl:location.href.slice(0,300),tables};
  const send=()=>target.postMessage(payload,"https://neongreeen.github.io");
  [100,500,1200,2200].forEach(delay=>setTimeout(send,delay));
  target.focus();
})();
