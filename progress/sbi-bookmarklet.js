(()=>{
  const clean=value=>String(value||"").normalize("NFKC").replace(/\s+/g," ").trim();
  const key=value=>clean(value).replace(/\s+/g,"");
  const number=value=>{
    const normalized=clean(value).replace(/[,%￥¥$]/g,"").replace(/[−–—]/g,"-").replace(/^\+/,"");
    const result=Number(normalized);
    return Number.isFinite(result)?result:null;
  };
  const quotes={};
  [...document.querySelectorAll("table")].forEach(table=>{
    const rows=[...table.rows];
    const headerIndex=rows.findIndex(row=>{
      const text=key(row.innerText);
      return text.includes("銘柄(コード)")&&text.includes("現在値")&&text.includes("前日比(%)");
    });
    if(headerIndex<0) return;
    const headers=[...rows[headerIndex].cells].map(cell=>key(cell.innerText));
    const instrumentIndex=headers.findIndex(text=>text.includes("銘柄")&&text.includes("コード"));
    const priceIndex=headers.findIndex(text=>text==="現在値");
    const changeIndex=headers.findIndex(text=>text==="前日比");
    const changePctIndex=headers.findIndex(text=>text.includes("前日比")&&text.includes("%"));
    if(Math.min(instrumentIndex,priceIndex,changeIndex,changePctIndex)<0) return;
    rows.slice(headerIndex+1).forEach(row=>{
      const cells=[...row.cells];
      if(cells.length<=Math.max(instrumentIndex,priceIndex,changeIndex,changePctIndex)) return;
      const instrument=clean(cells[instrumentIndex].innerText);
      const ticker=(instrument.match(/(?:^|\s)(\d{4}[A-Z]?|[A-Z]{1,6}(?:[.-][A-Z0-9]+)?)(?:\s|$)/)||[])[1];
      const price=number(cells[priceIndex].innerText);
      if(!ticker||price==null||price<=0) return;
      quotes[ticker.toUpperCase()]={
        ticker:ticker.toUpperCase(),
        price,
        change:number(cells[changeIndex].innerText),
        changePct:number(cells[changePctIndex].innerText),
      };
    });
  });
  const list=Object.values(quotes);
  if(!list.length){alert("SBIの株式ポートフォリオを読み取れませんでした");return;}
  const target=window.open("https://neongreeen.github.io/fdoa-apps/progress/","progress-portfolio");
  if(!target){alert("Progress Portfolioを開けませんでした");return;}
  const payload={type:"progress-portfolio:sbi-quotes",id:`sbi_${Date.now()}`,capturedAt:new Date().toISOString(),quotes:list};
  const send=()=>target.postMessage(payload,"https://neongreeen.github.io");
  [100,500,1200,2200].forEach(delay=>setTimeout(send,delay));
  target.focus();
})();
