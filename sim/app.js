"use strict";

/* Trade Sim（ペーパートレード）
   仮想資金50万円で裁量トレードを「禁止でなく測定」するためのアプリ。
   実弾のProgress Portfolioとはデータも画面も完全分離（仮想と実弾を混ぜない）。

   設計の芯：
   - 記録するのは約定した事実（銘柄・株数・買値/売値・理由・日時）と、
     その瞬間のベンチマーク値（TOPIX・S&P500・為替）のスナップショットだけ。
     変動する時価・評価額は保存せず、表示のたび最新quoteで計算する（PPと同じ原則）。
   - ベンチマーク＝取引ごとの「分身」。買った日に同額をTOPIX/S&P500に入れ、
     決済した日に分身も決済する（保有中は放置）。自分の裁量 vs 何もしない、が取引単位で比べられる。
   - 株価はfdoa-app-dataのprices.json（30分毎自動更新）＋リロード時の更新依頼（PPの機構を流用）。
     チャートはhistory.json（日次終値）から毎回再構成する。 */

const CONFIG={
  github:{owner:"neongreeen",repo:"fdoa-app-data",branch:"main"},
  file:"sim.json",
  priceFile:"prices.json",
  historyFile:"history.json",
  tokenKey:"fdoa_gh_token",
  legacyTokenKeys:["fdoa_bukken_gh_token"],
  storageKey:"fdoa_sim_v1",
  schemaVersion:1,
  startCash:500000,
  instrumentFiles:["../progress/data/instruments-curated.json","../progress/data/instruments-jp.json","../progress/data/instruments-us.json"],
};

/* チャート3系列の色（datavizバリデータ合格・CVD対応。凡例＋線端の直接ラベルで色単独にしない） */
const SERIES={
  me:{label:"自分",color:"#2a78d6"},
  topix:{label:"TOPIX分身",color:"#eb6834"},
  gspc:{label:"S&P500分身",color:"#1baf7a"},
};

const $=(s,root=document)=>root.querySelector(s);
const $$=(s,root=document)=>[...root.querySelectorAll(s)];
const uid=(p="id")=>`${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const yen=v=>"¥"+Math.round(v).toLocaleString("ja-JP");
const yenSigned=v=>(v>=0?"+":"−")+"¥"+Math.abs(Math.round(v)).toLocaleString("ja-JP");
const pctSigned=v=>(v>=0?"+":"−")+Math.abs(v).toFixed(1)+"%";
const cls=v=>v>=0?"pos":"neg";
const todayJst=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const fmtDate=d=>{const m=String(d||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${Number(m[2])}/${Number(m[3])}`:String(d||"");};
const fmtPrice=(v,currency)=>currency==="USD"?"$"+Number(v).toLocaleString("en-US",{maximumFractionDigits:2}):Number(v).toLocaleString("ja-JP",{maximumFractionDigits:1})+"円";

/* 撤退ラインは%で入力し、金額に換算して保存する（表示・バッジ判定は金額のまま）。
   丸め＝円は整数（100円未満の低位株のみ小数1桁）・ドルは小数2桁 */
const pctToPrice=(basePrice,pct,direction,currency)=>{
  const raw=basePrice*(1+direction*pct/100);
  if(currency==="USD") return +raw.toFixed(2);
  return basePrice<100?+raw.toFixed(1):Math.round(raw);
};
const priceToPct=(basePrice,linePrice)=>+Math.abs((linePrice/basePrice-1)*100).toFixed(2);
/* %入力欄の下に出す換算表示。入力が正の数の間だけ「＝◯円」を出す */
function showPctPrice(el,basePrice,pctValue,direction,currency){
  const pct=Number(pctValue);
  el.textContent=basePrice>0&&pct>0&&(direction>0||pct<100)?`＝${fmtPrice(pctToPrice(basePrice,pct,direction,currency),currency)}`:"";
}

/* ---------- データ ---------- */

function seed(){
  return{
    meta:{schemaVersion:CONFIG.schemaVersion,savedAt:null},
    settings:{startCash:CONFIG.startCash,startedAt:null},
    trades:[],
  };
}

function sanitizeBench(b){
  if(!b||typeof b!=="object") return null;
  const topix=Number(b.topix),gspc=Number(b.gspc),usdJpy=Number(b.usdJpy);
  if(!Number.isFinite(topix)||!Number.isFinite(gspc)||!Number.isFinite(usdJpy)) return null;
  return{topix,gspc,usdJpy};
}

function normalize(data){
  if(!data||typeof data!=="object") return seed();
  const base=seed();
  return{
    meta:{schemaVersion:CONFIG.schemaVersion,savedAt:data.meta?.savedAt||null},
    settings:{
      startCash:Number(data.settings?.startCash)>0?Number(data.settings.startCash):base.settings.startCash,
      startedAt:data.settings?.startedAt||null,
    },
    trades:(Array.isArray(data.trades)?data.trades:[]).map(t=>{
      const quantity=Number(t.quantity),buyPrice=Number(t.buyPrice);
      if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(buyPrice)||buyPrice<=0) return null;
      const sold=Number.isFinite(Number(t.sellPrice))&&Number(t.sellPrice)>0&&t.sellDate;
      return{
        id:t.id||uid("trade"),
        name:String(t.name||"名称未設定"),
        ticker:String(t.ticker||"").toUpperCase(),
        country:t.country==="US"?"US":"JP",
        currency:t.currency==="USD"?"USD":"JPY",
        market:String(t.market||""),
        quantity,buyPrice,
        buyDate:String(t.buyDate||"").slice(0,10),
        buyReason:String(t.buyReason||""),
        buyFx:Number.isFinite(Number(t.buyFx))?Number(t.buyFx):null,
        buyBench:sanitizeBench(t.buyBench),
        // 撤退ライン（3行テストの②。銘柄と同じ通貨・任意）
        stopLine:Number(t.stopLine)>0?Number(t.stopLine):null,
        targetLine:Number(t.targetLine)>0?Number(t.targetLine):null,
        sellPrice:sold?Number(t.sellPrice):null,
        sellDate:sold?String(t.sellDate).slice(0,10):null,
        sellReason:sold?String(t.sellReason||""):null,
        sellFx:sold&&Number.isFinite(Number(t.sellFx))?Number(t.sellFx):null,
        sellBench:sold?sanitizeBench(t.sellBench):null,
        createdAt:t.createdAt||new Date().toISOString(),
        revokedAt:t.revokedAt||null,
      };
    }).filter(Boolean),
  };
}

let db=normalize((()=>{try{return JSON.parse(localStorage.getItem(CONFIG.storageKey));}catch(e){return null;}})());
let PRICE_DATA=null;
let HISTORY_DATA=null;
let priceLoading=false,priceLoadedAt=0;
let INSTRUMENTS=[];
let selectedInstrument=null;
let sellTradeId=null;
let toastTimer=null;

function save(){
  db.meta.savedAt=new Date().toISOString();
  localStorage.setItem(CONFIG.storageKey,JSON.stringify(db));
  store.queueSync();
}

const store=createCloudStore({
  owner:CONFIG.github.owner,repo:CONFIG.github.repo,branch:CONFIG.github.branch,path:CONFIG.file,
  tokenKey:CONFIG.tokenKey,legacyTokenKeys:CONFIG.legacyTokenKeys,label:"Trade Sim",
  getData:()=>db,
  adoptRemote:data=>{db=normalize(data);localStorage.setItem(CONFIG.storageKey,JSON.stringify(db));renderAll();},
  onState:(state,msg)=>{
    const badge=$("#syncBadge"),status=$("#syncStatus");
    const map={off:"ローカル保存",loading:"同期中…",dirty:"変更あり",saving:"保存中…",saved:"クラウド同期",offline:"オフライン",error:"同期エラー"};
    badge.textContent=map[state]||state;
    status.textContent=state==="off"?"未接続":(map[state]||state)+(msg?`（${msg}）`:"");
  },
});

/* ---------- 計算 ---------- */

const activeTrades=()=>db.trades.filter(t=>!t.revokedAt);
const openTrades=()=>activeTrades().filter(t=>!t.sellDate);
const closedTrades=()=>activeTrades().filter(t=>t.sellDate);

function buyCostJpy(t){return t.quantity*t.buyPrice*(t.currency==="USD"?t.buyFx||0:1);}
function sellProceedsJpy(t){return t.quantity*t.sellPrice*(t.currency==="USD"?t.sellFx||0:1);}

function currentCash(){
  return db.settings.startCash
    -activeTrades().reduce((sum,t)=>sum+buyCostJpy(t),0)
    +closedTrades().reduce((sum,t)=>sum+sellProceedsJpy(t),0);
}

function quoteFor(ticker){return PRICE_DATA?.quotes?.[String(ticker||"").toUpperCase()]||null;}
function currentUsdJpy(){const v=Number(PRICE_DATA?.usdJpy);return Number.isFinite(v)?v:null;}

/* 保有中の現在値（quote未取得は買値で仮置き＝損益0表示＋注記） */
function positionNow(t){
  const quote=quoteFor(t.ticker);
  const price=Number.isFinite(Number(quote?.price))?Number(quote.price):t.buyPrice;
  const fx=t.currency==="USD"?(currentUsdJpy()??t.buyFx??0):1;
  return{price,hasQuote:!!quote,valueJpy:t.quantity*price*fx,changePct:Number.isFinite(Number(quote?.changePct))?Number(quote.changePct):null};
}

function myTotalNow(){
  return currentCash()+openTrades().reduce((sum,t)=>sum+positionNow(t).valueJpy,0);
}

/* 分身の損益（円）。決済済みは売った日のベンチ値で確定、保有中は現在値 */
function twinPnl(t,which){
  if(!t.buyBench) return null;
  const cost=buyCostJpy(t);
  const exit=t.sellBench||{topix:Number(quoteFor("TOPIX")?.price),gspc:Number(quoteFor("GSPC")?.price),usdJpy:currentUsdJpy()};
  if(which==="topix"){
    if(!Number.isFinite(exit.topix)) return null;
    return cost*(exit.topix/t.buyBench.topix-1);
  }
  if(!Number.isFinite(exit.gspc)||!Number.isFinite(exit.usdJpy)) return null;
  return cost*((exit.gspc*exit.usdJpy)/(t.buyBench.gspc*t.buyBench.usdJpy)-1);
}

function twinTotalNow(which){
  let total=db.settings.startCash;
  for(const t of activeTrades()){
    const pnl=twinPnl(t,which);
    if(pnl!=null) total+=pnl;
  }
  return total;
}

function tradePnlJpy(t){
  if(t.sellDate) return sellProceedsJpy(t)-buyCostJpy(t);
  return positionNow(t).valueJpy-buyCostJpy(t);
}

/* ---------- 描画 ---------- */

function renderSummary(){
  const total=myTotalNow();
  const start=db.settings.startCash;
  const twinT=twinTotalNow("topix");
  const twinS=twinTotalNow("gspc");
  const tile=(key,value,sub,me)=>`<div class="sim-tile${me?" me":""}">
    <div class="t-label"><i style="display:inline-block;width:10px;height:3px;border-radius:2px;background:${SERIES[key].color}"></i>${esc(SERIES[key].label)}</div>
    <div class="t-value">${yen(value)}</div>
    <div class="t-sub">${sub}</div>
  </div>`;
  $("#summaryTiles").innerHTML=
    tile("me",total,`スタート50万比 <span class="${cls(total-start)}">${yenSigned(total-start)}（${pctSigned((total/start-1)*100)}）</span>`,true)+
    tile("topix",twinT,`自分との差 <span class="${cls(total-twinT)}">${yenSigned(total-twinT)}</span>`)+
    tile("gspc",twinS,`自分との差 <span class="${cls(total-twinS)}">${yenSigned(total-twinS)}</span>`);
  const priceTime=PRICE_DATA?.updatedAt?new Date(PRICE_DATA.updatedAt).toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):null;
  $("#summaryMeta").textContent=priceTime
    ?`参考株価 ${priceTime}取得（約20分遅延）・分身＝同じ日に同額を指数に入れた場合`
    :"株価未取得（GitHub同期を接続すると価格が付きます）";
}

/* ---------- チャート（history.jsonの日次終値から毎回再構成） ---------- */

function historyClose(ticker,date,fallback){
  const rows=HISTORY_DATA?.quotes?.[ticker];
  if(!rows) return fallback;
  let best=null;
  for(const d of Object.keys(rows)){
    if(d<=date&&(best==null||d>best)) best=d;
  }
  return best!=null?rows[best]:fallback;
}
function historyFx(date,fallback){
  const rows=HISTORY_DATA?.usdJpy||{};
  let best=null;
  for(const d of Object.keys(rows)){
    if(d<=date&&(best==null||d>best)) best=d;
  }
  return best!=null?rows[best]:fallback;
}

function buildSeries(){
  const trades=activeTrades();
  if(!trades.length) return null;
  const firstDate=trades.map(t=>t.buyDate).sort()[0];
  const today=todayJst();
  const dateSet=new Set(trades.flatMap(t=>[t.buyDate,t.sellDate].filter(Boolean)));
  for(const d of Object.keys(HISTORY_DATA?.quotes?.TOPIX||{})) if(d>=firstDate&&d<=today) dateSet.add(d);
  dateSet.add(today);
  const dates=[...dateSet].filter(d=>d>=firstDate&&d<=today).sort();
  const me=[],topix=[],gspc=[];
  for(const d of dates){
    const fxD=historyFx(d,currentUsdJpy());
    let cash=db.settings.startCash,posValue=0,twinT=0,twinS=0;
    for(const t of trades){
      if(t.buyDate>d) continue;
      const cost=buyCostJpy(t);
      cash-=cost;
      const soldByD=t.sellDate&&t.sellDate<=d;
      if(soldByD) cash+=sellProceedsJpy(t);
      else{
        const close=historyClose(t.ticker,d,t.buyPrice);
        posValue+=t.quantity*close*(t.currency==="USD"?(fxD??t.buyFx??0):1);
      }
      if(t.buyBench){
        const bT=soldByD&&t.sellBench?t.sellBench.topix:historyClose("TOPIX",d,t.buyBench.topix);
        const bG=soldByD&&t.sellBench?t.sellBench.gspc:historyClose("GSPC",d,t.buyBench.gspc);
        const bFx=soldByD&&t.sellBench?t.sellBench.usdJpy:(fxD??t.buyBench.usdJpy);
        twinT+=cost*(bT/t.buyBench.topix-1);
        twinS+=cost*((bG*bFx)/(t.buyBench.gspc*t.buyBench.usdJpy)-1);
      }
    }
    me.push(cash+posValue);
    topix.push(db.settings.startCash+twinT);
    gspc.push(db.settings.startCash+twinS);
  }
  return{dates,me,topix,gspc};
}

let chartState=null; // ツールチップ用に直近の描画内容を持つ（データは保存しない）

function renderChart(){
  $("#chartLegend").innerHTML=["me","topix","gspc"].map(k=>`<span class="lg"><i style="background:${SERIES[k].color}"></i>${esc(SERIES[k].label)}</span>`).join("");
  const series=buildSeries();
  chartState=null;
  if(!series){
    $("#chartBody").innerHTML='<div class="chart-empty">最初の取引を記録すると、ここに3本の線が育ちます</div>';
    return;
  }
  const W=940,H=280,padL=64,padR=86,padT=14,padB=30;
  const {dates}=series;
  const all=[...series.me,...series.topix,...series.gspc];
  let min=Math.min(...all),max=Math.max(...all);
  if(max-min<1000){min-=1000;max+=1000;}
  const span=max-min;min-=span*0.08;max+=span*0.08;
  const x=i=>dates.length===1?(padL+(W-padL-padR)/2):padL+(W-padL-padR)*i/(dates.length-1);
  const y=v=>padT+(H-padT-padB)*(1-(v-min)/(max-min));
  // Y軸目盛り：1-2-5系のきりのいい間隔で4〜6本
  const rawStep=(max-min)/5;
  const mag=Math.pow(10,Math.floor(Math.log10(rawStep)));
  const step=[1,2,5,10].map(m=>m*mag).find(s=>s>=rawStep)||rawStep;
  const ticks=[];
  for(let v=Math.ceil(min/step)*step;v<=max;v+=step) ticks.push(v);
  const gridHtml=ticks.map(v=>`<line x1="${padL}" x2="${W-padR}" y1="${y(v)}" y2="${y(v)}" stroke="#eeeeeb" stroke-width="1"/>
    <text x="${padL-8}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="#6e6e73">${(v/10000).toFixed(v%10000===0?0:1)}万</text>`).join("");
  const xTickIdx=dates.length<=4?dates.map((_,i)=>i):[0,Math.round((dates.length-1)/3),Math.round((dates.length-1)*2/3),dates.length-1];
  const xHtml=[...new Set(xTickIdx)].map(i=>`<text x="${x(i)}" y="${H-8}" text-anchor="middle" font-size="10" fill="#6e6e73">${fmtDate(dates[i])}</text>`).join("");
  const line=values=>values.map((v,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const seriesKeys=["topix","gspc","me"]; // 自分の線を最後に描いて最前面に
  const linesHtml=seriesKeys.map(k=>{
    const values=series[k];
    const path=dates.length===1?"":`<path d="${line(values)}" fill="none" stroke="${SERIES[k].color}" stroke-width="${k==="me"?2.5:2}" stroke-linejoin="round" stroke-linecap="round"/>`;
    const dot=`<circle cx="${x(values.length-1)}" cy="${y(values[values.length-1])}" r="3.2" fill="${SERIES[k].color}"/>`;
    return path+dot;
  }).join("");
  // 線端の直接ラベル（重なりは14px間隔で押し広げる）
  const ends=["me","topix","gspc"].map(k=>({k,y:y(series[k][series[k].length-1])})).sort((a,b)=>a.y-b.y);
  for(let i=1;i<ends.length;i++) if(ends[i].y-ends[i-1].y<14) ends[i].y=ends[i-1].y+14;
  const labelHtml=ends.map(e=>`<text x="${W-padR+8}" y="${e.y+4}" font-size="11" font-weight="600" fill="${SERIES[e.k].color}">${esc(SERIES[e.k].label)}</text>`).join("");
  $("#chartBody").innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="自分とベンチマーク分身の資産推移">
    ${gridHtml}${xHtml}${linesHtml}${labelHtml}
    <line id="chartCrosshair" y1="${padT}" y2="${H-padB}" stroke="#c9c9c4" stroke-width="1" visibility="hidden"/>
  </svg>`;
  chartState={dates,series,x,y,padL,padR,W};
}

function chartPointer(event){
  if(!chartState) return;
  const svg=$("#chartBody svg");
  const rect=svg.getBoundingClientRect();
  const relX=(event.clientX-rect.left)/rect.width*chartState.W;
  const {dates,series,x}=chartState;
  let idx=0,best=Infinity;
  dates.forEach((_,i)=>{const dist=Math.abs(x(i)-relX);if(dist<best){best=dist;idx=i;}});
  const ch=$("#chartCrosshair");
  ch.setAttribute("x1",x(idx));ch.setAttribute("x2",x(idx));ch.setAttribute("visibility","visible");
  const tip=$("#chartTooltip");
  tip.innerHTML=`<div class="tt-date">${esc(dates[idx])}</div>`+["me","topix","gspc"].map(k=>
    `<div class="tt-row"><i style="background:${SERIES[k].color}"></i>${esc(SERIES[k].label)} <b>${yen(series[k][idx])}</b></div>`).join("");
  tip.hidden=false;
  const wrapRect=$("#chartWrap").getBoundingClientRect();
  const px=x(idx)/chartState.W*rect.width;
  tip.style.left=Math.min(Math.max(px+12,0),wrapRect.width-tip.offsetWidth-4)+"px";
  tip.style.top="10px";
}
function chartPointerEnd(){
  $("#chartTooltip").hidden=true;
  const ch=$("#chartCrosshair");
  if(ch) ch.setAttribute("visibility","hidden");
}

function renderPositions(){
  const list=openTrades().sort((a,b)=>b.buyDate.localeCompare(a.buyDate)||b.createdAt.localeCompare(a.createdAt));
  $("#positionsCount").textContent=list.length?`${list.length}件`:"";
  if(!list.length){
    $("#positionsBody").innerHTML='<div class="empty">保有なし。上の「買う」から最初のペーパートレードをどうぞ</div>';
    return;
  }
  const rows=list.map(t=>{
    const now=positionNow(t);
    const cost=buyCostJpy(t);
    const pnl=now.valueJpy-cost;
    const pnlPct=cost?pnl/cost*100:0;
    const twinT=twinPnl(t,"topix");
    const days=Math.max(0,Math.round((new Date(todayJst())-new Date(t.buyDate))/86400000));
    // 撤退ライン到達の判定は参考株価がある時だけ（買値フォールバックで誤発火させない）
    const hitStop=now.hasQuote&&t.stopLine!=null&&now.price<=t.stopLine;
    const hitTarget=now.hasQuote&&t.targetLine!=null&&now.price>=t.targetLine;
    const lineBadge=hitStop?'<span class="badge stb-ss line-hit">損切りライン到達</span>'
      :hitTarget?'<span class="badge stb-s line-hit">利確検討ライン到達</span>':"";
    const lineText=(t.stopLine==null&&t.targetLine==null)
      ?'<span class="muted">未設定</span>'
      :`${t.stopLine!=null?`損 ${fmtPrice(t.stopLine,t.currency)}`:""}${t.stopLine!=null&&t.targetLine!=null?"<br>":""}${t.targetLine!=null?`利 ${fmtPrice(t.targetLine,t.currency)}`:""}`;
    return`<tr>
      <td><div class="trade-name">${esc(t.name)}<small>${esc(t.ticker)}</small>${lineBadge}</div>
        <div class="trade-reason"><b>買</b> ${esc(t.buyReason)}</div></td>
      <td class="num">${t.quantity.toLocaleString("ja-JP")}株</td>
      <td class="num">${fmtPrice(t.buyPrice,t.currency)}<br><span class="muted">${fmtDate(t.buyDate)}・${days}日</span></td>
      <td class="num">${now.hasQuote?fmtPrice(now.price,t.currency):"<span class='muted'>取得待ち</span>"}${now.changePct!=null?`<br><span class="muted ${cls(now.changePct)}">前日${pctSigned(now.changePct)}</span>`:""}</td>
      <td class="num line-cell" data-lines="${esc(t.id)}" title="タップでライン変更">${lineText}</td>
      <td class="num"><span class="${cls(pnl)}">${yenSigned(pnl)}</span><br><span class="muted ${cls(pnl)}">${pctSigned(pnlPct)}</span></td>
      <td class="num">${twinT!=null?`<span class="${cls(pnl-twinT)}">${yenSigned(pnl-twinT)}</span>`:"—"}</td>
      <td><div class="row-actions"><button type="button" class="btn sec sm" data-sell="${esc(t.id)}">売る</button>
        ${fixableBuy(t)?`<button type="button" class="link-danger" data-fix="${esc(t.id)}">修正</button>`:""}
        <button type="button" class="link-danger" data-revoke="${esc(t.id)}">取消</button></div></td>
    </tr>`;
  }).join("");
  $("#positionsBody").innerHTML=`<table><thead><tr>
    <th>銘柄・購入動機</th><th class="num">株数</th><th class="num">買値</th><th class="num">現在値</th><th class="num">撤退ライン</th><th class="num">損益</th><th class="num">対TOPIX</th><th></th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  $$("#positionsBody [data-sell]").forEach(b=>b.addEventListener("click",()=>openSellModal(b.dataset.sell)));
  $$("#positionsBody [data-fix]").forEach(b=>b.addEventListener("click",()=>openFixModal(b.dataset.fix)));
  $$("#positionsBody [data-revoke]").forEach(b=>b.addEventListener("click",()=>revokeTrade(b.dataset.revoke)));
  $$("#positionsBody [data-lines]").forEach(cell=>cell.addEventListener("click",()=>openLineModal(cell.dataset.lines)));
}

function renderClosed(){
  const list=closedTrades().sort((a,b)=>b.sellDate.localeCompare(a.sellDate)||b.createdAt.localeCompare(a.createdAt));
  $("#closedCount").textContent=list.length?`${list.length}件`:"";
  if(!list.length){
    $("#closedBody").innerHTML='<div class="empty">まだ決済した取引はありません</div>';
    return;
  }
  const rows=list.map(t=>{
    const pnl=tradePnlJpy(t);
    const cost=buyCostJpy(t);
    const twinT=twinPnl(t,"topix"),twinS=twinPnl(t,"gspc");
    const days=Math.max(0,Math.round((new Date(t.sellDate)-new Date(t.buyDate))/86400000));
    return`<tr>
      <td><div class="trade-name">${esc(t.name)}<small>${esc(t.ticker)}</small></div>
        <div class="trade-reason"><b>買</b> ${esc(t.buyReason)}<br><b>売</b> ${esc(t.sellReason)}</div></td>
      <td class="num">${t.quantity.toLocaleString("ja-JP")}株</td>
      <td class="num">${fmtPrice(t.buyPrice,t.currency)}→${fmtPrice(t.sellPrice,t.currency)}<br><span class="muted">${fmtDate(t.buyDate)}→${fmtDate(t.sellDate)}・${days}日</span></td>
      <td class="num"><span class="${cls(pnl)}">${yenSigned(pnl)}</span><br><span class="muted ${cls(pnl)}">${pctSigned(cost?pnl/cost*100:0)}</span></td>
      <td class="num">${twinT!=null?`<span class="${cls(pnl-twinT)}">${yenSigned(pnl-twinT)}</span>`:"—"}</td>
      <td class="num">${twinS!=null?`<span class="${cls(pnl-twinS)}">${yenSigned(pnl-twinS)}</span>`:"—"}</td>
      <td><div class="row-actions">${fixableSell(t)?`<button type="button" class="link-danger" data-fix="${esc(t.id)}">修正</button>`:""}
        <button type="button" class="link-danger" data-revoke="${esc(t.id)}">取消</button></div></td>
    </tr>`;
  }).join("");
  $("#closedBody").innerHTML=`<table><thead><tr>
    <th>銘柄・理由</th><th class="num">株数</th><th class="num">買→売</th><th class="num">損益</th><th class="num">対TOPIX</th><th class="num">対S&amp;P500</th><th></th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  $$("#closedBody [data-fix]").forEach(b=>b.addEventListener("click",()=>openFixModal(b.dataset.fix)));
  $$("#closedBody [data-revoke]").forEach(b=>b.addEventListener("click",()=>revokeTrade(b.dataset.revoke)));
}

function quarterOf(date){
  const m=String(date||"").match(/^(\d{4})-(\d{2})/);
  if(!m) return "";
  return`${m[1]}Q${Math.floor((Number(m[2])-1)/3)+1}`;
}

function renderQuarters(){
  const closed=closedTrades();
  if(!closed.length){
    $("#quarterBody").innerHTML='<div class="empty">決済が貯まると、四半期ごとの勝率・平均損益・ベンチマーク差がここに出ます</div>';
    return;
  }
  const groups=new Map();
  for(const t of closed){
    const q=quarterOf(t.sellDate);
    if(!groups.has(q)) groups.set(q,[]);
    groups.get(q).push(t);
  }
  const row=(label,list)=>{
    const pnls=list.map(tradePnlJpy);
    const wins=pnls.filter(v=>v>0).length;
    const avg=pnls.reduce((a,b)=>a+b,0)/list.length;
    const diffs=which=>{
      const values=list.map(t=>{const tw=twinPnl(t,which);return tw==null?null:tradePnlJpy(t)-tw;}).filter(v=>v!=null);
      return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
    };
    const dT=diffs("topix"),dS=diffs("gspc");
    return`<tr>
      <td><strong>${esc(label)}</strong></td>
      <td class="num">${list.length}件</td>
      <td class="num">${Math.round(wins/list.length*100)}%（${wins}勝${list.length-wins}敗）</td>
      <td class="num"><span class="${cls(avg)}">${yenSigned(avg)}</span></td>
      <td class="num">${dT!=null?`<span class="${cls(dT)}">${yenSigned(dT)}</span>`:"—"}</td>
      <td class="num">${dS!=null?`<span class="${cls(dS)}">${yenSigned(dS)}</span>`:"—"}</td>
    </tr>`;
  };
  const quarterRows=[...groups.keys()].sort().reverse().map(q=>row(q,groups.get(q))).join("");
  $("#quarterBody").innerHTML=`<table><thead><tr>
    <th>四半期</th><th class="num">決済</th><th class="num">勝率</th><th class="num">平均損益</th><th class="num">対TOPIX平均</th><th class="num">対S&amp;P500平均</th>
  </tr></thead><tbody>${quarterRows}${groups.size>1?row("全期間",closed):""}</tbody></table>
  <p class="note">対指数＝各取引と同じ日に同額を指数に入れた分身との差の平均。プラス＝指数に勝った</p>`;
}

/* ---------- 買う ---------- */

function renderBuyPanel(){
  $("#cashLabel").textContent=`現金残 ${yen(currentCash())}`;
  const box=$("#selectedBox");
  if(!selectedInstrument){box.hidden=true;box.innerHTML="";updateBuyPreview();return;}
  const quote=quoteFor(selectedInstrument.ticker);
  box.hidden=false;
  box.innerHTML=`<div><span class="sel-name">${esc(selectedInstrument.name)}<small>${esc(selectedInstrument.ticker)}・${esc(selectedInstrument.market||"市場未設定")}・${esc(selectedInstrument.currency)}</small></span></div>
    <span class="sel-quote">${quote?`現在値 ${fmtPrice(quote.price,selectedInstrument.currency)}（20分遅延）`:"現在値なし（買うと自動取得が始まる）"}</span>
    <button type="button" class="sel-clear" id="selClear">選び直す</button>`;
  $("#selClear").addEventListener("click",()=>{selectedInstrument=null;$("#buyPrice").value="";renderBuyPanel();});
  $("#buyPriceUnit").textContent=selectedInstrument.currency==="USD"?"（ドル）":"（円）";
  if(quote&&!$("#buyPrice").value) $("#buyPrice").value=quote.price;
  updateBuyPreview();
}

function updateBuyPreview(){
  const preview=$("#buyCostPreview");
  // %入力の下に円/ドル換算をライブ表示
  const basePrice=Number($("#buyPrice").value);
  const currency=selectedInstrument?.currency==="USD"?"USD":"JPY";
  showPctPrice($("#buyStopPrice"),basePrice,$("#buyStop").value,-1,currency);
  showPctPrice($("#buyTargetPrice"),basePrice,$("#buyTarget").value,+1,currency);
  if(!selectedInstrument){preview.textContent="";return;}
  const qty=Number($("#buyQty").value),price=Number($("#buyPrice").value);
  if(!Number.isFinite(qty)||qty<=0||!Number.isFinite(price)||price<=0){preview.textContent="";return;}
  const fx=selectedInstrument.currency==="USD"?currentUsdJpy():1;
  if(fx==null){preview.textContent="為替未取得のため円換算できません";return;}
  const cost=qty*price*fx;
  const over=cost>currentCash();
  preview.innerHTML=`約定代金 <strong>${yen(cost)}</strong>${selectedInstrument.currency==="USD"?`（${fx.toFixed(2)}円/$）`:""}${over?' <span class="neg">→ 現金不足</span>':""}`;
}

function benchSnapshot(){
  const topix=Number(quoteFor("TOPIX")?.price),gspc=Number(quoteFor("GSPC")?.price),usdJpy=currentUsdJpy();
  if(!Number.isFinite(topix)||!Number.isFinite(gspc)||!Number.isFinite(usdJpy)) return null;
  return{topix,gspc,usdJpy};
}

function submitBuy(event){
  event.preventDefault();
  if(!selectedInstrument){showToast("先に銘柄を検索して選んでください","error");return;}
  const qty=Math.floor(Number($("#buyQty").value));
  const price=Number($("#buyPrice").value);
  const stopPct=Number($("#buyStop").value);
  const targetPct=Number($("#buyTarget").value);
  const reason=$("#buyReason").value.trim();
  if(!Number.isFinite(qty)||qty<=0){showToast("株数は1以上の整数で","error");return;}
  if(!Number.isFinite(price)||price<=0){showToast("買値を入れてください（現在値未取得の銘柄は手入力）","error");return;}
  // 3点セット必須（2026-07-24ヨシアキ指示）：動機・損切り・利確が揃わないと買えない。ラインは%で入力→金額で保存
  if(!(stopPct>0)){showToast("損切りラインが空。撤退の考えを先に決めるのがルールです（買値の−%で入力）","error");$("#buyStop").focus();return;}
  if(stopPct>=100){showToast("損切り-100%以上は株価がマイナスになっちゃう。%を見直して","error");$("#buyStop").focus();return;}
  if(!(targetPct>0)){showToast("利確検討ラインが空。出口の目安まで決めてから買います（買値の＋%で入力）","error");$("#buyTarget").focus();return;}
  if(!reason){showToast("購入動機がまだ空。理由の言語化がこのアプリの魂です","error");$("#buyReason").focus();return;}
  const lineCurrency=selectedInstrument.currency==="USD"?"USD":"JPY";
  const stopLine=pctToPrice(price,stopPct,-1,lineCurrency);
  const targetLine=pctToPrice(price,targetPct,+1,lineCurrency);
  const bench=benchSnapshot();
  if(!bench){showToast("ベンチマーク（TOPIX・S&P500・為替）が未取得のため記録できません。同期接続を確認して","error");return;}
  const fx=selectedInstrument.currency==="USD"?bench.usdJpy:null;
  const cost=qty*price*(fx||1);
  if(cost>currentCash()+0.5){showToast(`現金不足：約定代金${yen(cost)} ＞ 現金残${yen(currentCash())}`,"error");return;}
  const hadQuote=!!quoteFor(selectedInstrument.ticker);
  db.trades.push({
    id:uid("trade"),
    name:selectedInstrument.name,ticker:String(selectedInstrument.ticker).toUpperCase(),
    country:selectedInstrument.country==="US"?"US":"JP",
    currency:selectedInstrument.currency==="USD"?"USD":"JPY",
    market:selectedInstrument.market||"",
    quantity:qty,buyPrice:price,buyDate:todayJst(),buyReason:reason,
    buyFx:fx,buyBench:bench,stopLine,targetLine,
    sellPrice:null,sellDate:null,sellReason:null,sellFx:null,sellBench:null,
    createdAt:new Date().toISOString(),revokedAt:null,
  });
  if(!db.settings.startedAt) db.settings.startedAt=todayJst();
  save();
  selectedInstrument=null;
  $("#buyQty").value="";$("#buyPrice").value="";$("#buyStop").value="";$("#buyTarget").value="";$("#buyReason").value="";
  renderAll();
  showToast(`買いを記録しました：${qty}株・${yen(cost)}`);
  // 初取引の銘柄はsim.jsonのpushで株価取得が走る（prices.ymlトリガー）→数分後に取り込む
  if(!hadQuote){setTimeout(loadPriceData,50000);setTimeout(loadPriceData,110000);}
}

/* ---------- 当日修正（入力間違いの救済・2026-07-24ヨシアキ指示） ----------
   買い＝buyDateが今日の保有中だけ、売り＝sellDateが今日の決済済みだけ修正できる。
   翌日以降の訂正は「取消して記録し直す」＝過去の記録は事実として固定する */

let fixTradeId=null;

function fixableBuy(t){return !t.sellDate&&t.buyDate===todayJst();}
function fixableSell(t){return !!t.sellDate&&t.sellDate===todayJst();}

function openFixModal(tradeId){
  const t=db.trades.find(item=>item.id===tradeId);
  if(!t) return;
  const isSell=fixableSell(t);
  if(!isSell&&!fixableBuy(t)) return;
  fixTradeId=tradeId;
  $("#fixModalTitle").textContent=`${t.name} の${isSell?"売り":"買い"}記録を修正`;
  $("#fixBuyFields").hidden=isSell;
  $("#fixSellFields").hidden=!isSell;
  const unit=t.currency==="USD"?"（ドル）":"（円）";
  if(isSell){
    $("#fixSellPriceUnit").textContent=unit;
    $("#fixSellPrice").value=t.sellPrice;
    $("#fixSellReason").value=t.sellReason||"";
  }else{
    $("#fixPriceUnit").textContent=unit;
    $("#fixQty").value=t.quantity;
    $("#fixPrice").value=t.buyPrice;
    $("#fixStop").value=t.stopLine!=null?priceToPct(t.buyPrice,t.stopLine):"";
    $("#fixTarget").value=t.targetLine!=null?priceToPct(t.buyPrice,t.targetLine):"";
    $("#fixReason").value=t.buyReason||"";
    updateFixPreview();
  }
  $("#fixModal").hidden=false;
}

function updateFixPreview(){
  const t=db.trades.find(item=>item.id===fixTradeId);
  if(!t||t.sellDate) return;
  showPctPrice($("#fixStopPrice"),Number($("#fixPrice").value),$("#fixStop").value,-1,t.currency);
  showPctPrice($("#fixTargetPrice"),Number($("#fixPrice").value),$("#fixTarget").value,+1,t.currency);
}

function submitFix(){
  const t=db.trades.find(item=>item.id===fixTradeId);
  if(!t) return;
  if(fixableSell(t)){
    const price=Number($("#fixSellPrice").value);
    const reason=$("#fixSellReason").value.trim();
    if(!Number.isFinite(price)||price<=0){showToast("売値を入れてください","error");return;}
    if(!reason){showToast("売った理由が空です","error");return;}
    t.sellPrice=price;t.sellReason=reason;
  }else if(fixableBuy(t)){
    const qty=Math.floor(Number($("#fixQty").value));
    const price=Number($("#fixPrice").value);
    const stopPct=Number($("#fixStop").value);
    const targetPct=Number($("#fixTarget").value);
    const reason=$("#fixReason").value.trim();
    if(!Number.isFinite(qty)||qty<=0){showToast("株数は1以上の整数で","error");return;}
    if(!Number.isFinite(price)||price<=0){showToast("買値を入れてください","error");return;}
    if(!(stopPct>0)||stopPct>=100){showToast("損切りラインは買値の−%（0〜100）で必須です","error");return;}
    if(!(targetPct>0)){showToast("利確検討ラインは買値の＋%で必須です","error");return;}
    if(!reason){showToast("購入動機が空です","error");return;}
    const stopLine=pctToPrice(price,stopPct,-1,t.currency);
    const targetLine=pctToPrice(price,targetPct,+1,t.currency);
    const fx=t.currency==="USD"?t.buyFx||0:1;
    const newCost=qty*price*fx;
    // 現金チェック：この取引の旧コストを戻した上で新コストが収まるか
    if(newCost>currentCash()+buyCostJpy(t)+0.5){showToast(`現金不足：修正後の約定代金${yen(newCost)}が仮想資金を超えます`,"error");return;}
    t.quantity=qty;t.buyPrice=price;t.stopLine=stopLine;t.targetLine=targetLine;t.buyReason=reason;
  }else{closeFixModal();return;}
  save();
  closeFixModal();
  renderAll();
  showToast("記録を修正しました");
}

function closeFixModal(){fixTradeId=null;$("#fixModal").hidden=true;}

/* ---------- 撤退ラインの変更（保有中のみ・変更履歴は持たない＝現在の作戦だけを保存） ---------- */

let lineTradeId=null;

function openLineModal(tradeId){
  const t=db.trades.find(item=>item.id===tradeId);
  if(!t||t.sellDate) return;
  lineTradeId=tradeId;
  $("#lineModalTitle").textContent=`${t.name} の撤退ライン`;
  $("#lineModalSub").textContent=`買値${fmtPrice(t.buyPrice,t.currency)}からの%で入力（例：5＝${fmtPrice(pctToPrice(t.buyPrice,5,-1,t.currency),t.currency)}で損切り）`;
  $("#lineStop").value=t.stopLine!=null?priceToPct(t.buyPrice,t.stopLine):"";
  $("#lineTarget").value=t.targetLine!=null?priceToPct(t.buyPrice,t.targetLine):"";
  updateLinePreview();
  $("#lineModal").hidden=false;
  $("#lineStop").focus();
}

function updateLinePreview(){
  const t=db.trades.find(item=>item.id===lineTradeId);
  if(!t) return;
  showPctPrice($("#lineStopPrice"),t.buyPrice,$("#lineStop").value,-1,t.currency);
  showPctPrice($("#lineTargetPrice"),t.buyPrice,$("#lineTarget").value,+1,t.currency);
}

function submitLines(){
  const t=db.trades.find(item=>item.id===lineTradeId);
  if(!t) return;
  const stopPct=Number($("#lineStop").value);
  const targetPct=Number($("#lineTarget").value);
  if(stopPct>=100){showToast("損切り-100%以上は入力できません","error");return;}
  t.stopLine=stopPct>0?pctToPrice(t.buyPrice,stopPct,-1,t.currency):null;
  t.targetLine=targetPct>0?pctToPrice(t.buyPrice,targetPct,+1,t.currency):null;
  save();
  closeLineModal();
  renderPositions();
  showToast("撤退ラインを保存しました");
}

function closeLineModal(){lineTradeId=null;$("#lineModal").hidden=true;}

/* ---------- 売る ---------- */

function openSellModal(tradeId){
  const t=db.trades.find(item=>item.id===tradeId);
  if(!t) return;
  sellTradeId=tradeId;
  const now=positionNow(t);
  $("#sellModalTitle").textContent=`${t.name} を売る`;
  $("#sellModalSub").textContent=`${t.quantity.toLocaleString("ja-JP")}株・買値${fmtPrice(t.buyPrice,t.currency)}（${fmtDate(t.buyDate)}）`;
  $("#sellPriceUnit").textContent=t.currency==="USD"?"（ドル）":"（円）";
  $("#sellPrice").value=now.hasQuote?now.price:"";
  $("#sellReason").value="";
  updateSellPreview();
  $("#sellModal").hidden=false;
  $("#sellReason").focus();
}

function updateSellPreview(){
  const t=db.trades.find(item=>item.id===sellTradeId);
  const preview=$("#sellPreview");
  if(!t){preview.textContent="";return;}
  const price=Number($("#sellPrice").value);
  if(!Number.isFinite(price)||price<=0){preview.textContent="";return;}
  const fx=t.currency==="USD"?currentUsdJpy():1;
  if(fx==null){preview.textContent="為替未取得のため円換算できません";return;}
  const pnl=t.quantity*price*fx-buyCostJpy(t);
  preview.innerHTML=`この売値だと損益 <strong class="${cls(pnl)}">${yenSigned(pnl)}</strong>`;
}

function submitSell(){
  const t=db.trades.find(item=>item.id===sellTradeId);
  if(!t) return;
  const price=Number($("#sellPrice").value);
  const reason=$("#sellReason").value.trim();
  if(!Number.isFinite(price)||price<=0){showToast("売値を入れてください","error");return;}
  if(!reason){showToast("売った理由がまだ空。利確でも損切りでも、根拠をひとこと","error");$("#sellReason").focus();return;}
  const bench=benchSnapshot();
  if(!bench){showToast("ベンチマークが未取得のため記録できません。同期接続を確認して","error");return;}
  t.sellPrice=price;
  t.sellDate=todayJst();
  t.sellReason=reason;
  t.sellFx=t.currency==="USD"?bench.usdJpy:null;
  t.sellBench=bench;
  save();
  closeSellModal();
  renderAll();
  showToast(`売りを記録しました：損益${yenSigned(tradePnlJpy(t))}`);
}

function closeSellModal(){sellTradeId=null;$("#sellModal").hidden=true;}

function revokeTrade(tradeId){
  const t=db.trades.find(item=>item.id===tradeId);
  if(!t) return;
  if(!confirm(`「${t.name} ${t.quantity}株」の記録を取り消しますか？\n（誤入力の訂正用。行は残さず成績から除外されます）`)) return;
  t.revokedAt=new Date().toISOString();
  save();
  renderAll();
  showToast("取引を取り消しました");
}

/* ---------- 銘柄検索（PPと同じ静的データを流用） ---------- */

function normalizeSearchText(value){
  return String(value||"").normalize("NFKC").toLowerCase().replace(/[\s　]+/g,"");
}

async function loadInstrumentData(){
  const results=await Promise.allSettled(CONFIG.instrumentFiles.map(async path=>{
    const response=await fetch(path,{cache:"no-cache"});
    if(!response.ok) throw new Error(`${path}: ${response.status}`);
    const payload=await response.json();
    if(!Array.isArray(payload.instruments)) throw new Error(`${path}: invalid data`);
    return payload.instruments;
  }));
  const unique=new Map();
  results.flatMap(r=>r.status==="fulfilled"?r.value:[]).forEach(item=>{
    const key=`${item.country||""}:${item.market||""}:${String(item.ticker||"").toUpperCase()}`;
    if(!unique.has(key)) unique.set(key,item);
  });
  INSTRUMENTS=[...unique.values()].map(item=>({...item,searchText:normalizeSearchText(`${item.ticker} ${item.name} ${item.market||""}`)}));
}

function searchInstruments(query){
  const term=normalizeSearchText(query);
  if(!term) return [];
  return INSTRUMENTS
    .filter(item=>item.searchText.includes(term))
    .sort((a,b)=>{
      const aT=normalizeSearchText(a.ticker),bT=normalizeSearchText(b.ticker);
      const aN=normalizeSearchText(a.name),bN=normalizeSearchText(b.name);
      const rank=(t,n)=>t===term?0:t.startsWith(term)?1:n===term?2:n.startsWith(term)?3:4;
      const rA=rank(aT,aN),rB=rank(bT,bN);
      return rA-rB||(rA===3?aN.length-bN.length:0)||aT.localeCompare(bT,"en")||a.name.localeCompare(b.name,"ja");
    })
    .slice(0,8);
}

function renderInstrumentResults(){
  const query=$("#instrumentQuery").value;
  const list=searchInstruments(query);
  if(!normalizeSearchText(query)){$("#instrumentResults").innerHTML="";return;}
  if(!list.length){
    $("#instrumentResults").innerHTML='<div class="instrument-empty">見つかりません（この検索は株式・ETFのみ）</div>';
    return;
  }
  $("#instrumentResults").innerHTML=list.map((item,index)=>`<button type="button" class="instrument-result" data-index="${index}">
    <span><strong>${esc(item.name)}</strong><small>${esc(item.ticker)}・${esc(item.market||"市場未設定")}</small></span>
    <span class="instrument-country">${esc(item.country||"")}</span>
  </button>`).join("");
  $$(".instrument-result",$("#instrumentResults")).forEach(button=>button.addEventListener("click",()=>{
    selectedInstrument=list[Number(button.dataset.index)];
    $("#instrumentQuery").value="";
    $("#instrumentResults").innerHTML="";
    $("#buyPrice").value="";
    renderBuyPanel();
    $("#buyQty").focus();
  }));
}

/* ---------- 価格データ（PPの機構を流用） ---------- */

async function loadPriceData(){
  if(priceLoading||!store.hasToken()) return;
  priceLoading=true;
  try{
    const [prices,history]=await Promise.all([store.fetchFile(CONFIG.priceFile),store.fetchFile(CONFIG.historyFile)]);
    PRICE_DATA=prices&&prices.quotes?prices:null;
    HISTORY_DATA=history&&history.quotes?history:null;
  }catch(error){
    console.warn("Price data load failed",error);
  }
  priceLoadedAt=Date.now();
  priceLoading=false;
  renderAll();
}

/* リロード時の株価更新依頼：fdoa-app-dataのprice-request.txtへ合図をpush→Actionsが即取得。
   スロットルのlocalStorageキーはPPと共有（同一オリジン）＝PPとSimを続けて開いても合図は10分に1回 */
const PRICE_REQUEST_PATH="price-request.txt";
const PRICE_REQUEST_THROTTLE_KEY="pp_price_request_at";
async function requestFreshPrices(){
  try{
    const token=localStorage.getItem(CONFIG.tokenKey);
    if(!token) return;
    const last=Number(localStorage.getItem(PRICE_REQUEST_THROTTLE_KEY)||0);
    if(Date.now()-last<10*60*1000) return;
    if(PRICE_DATA?.updatedAt&&Date.now()-new Date(PRICE_DATA.updatedAt).getTime()<10*60*1000) return;
    localStorage.setItem(PRICE_REQUEST_THROTTLE_KEY,String(Date.now()));
    const base=`https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/${PRICE_REQUEST_PATH}`;
    const headers={Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json"};
    const current=await fetch(`${base}?ref=${CONFIG.github.branch}&_=${Date.now()}`,{headers,cache:"no-store"});
    const sha=current.ok?(await current.json()).sha:undefined;
    const body={message:"price-request: Trade Simリロード時の株価更新依頼",branch:CONFIG.github.branch,content:btoa(new Date().toISOString())};
    if(sha) body.sha=sha;
    const put=await fetch(base,{method:"PUT",headers,body:JSON.stringify(body)});
    if(!put.ok){console.warn("株価更新依頼のpushに失敗",put.status);return;}
    const before=PRICE_DATA?.updatedAt||"";
    let tries=0;
    const poll=async()=>{
      tries+=1;
      await loadPriceData();
      if((PRICE_DATA?.updatedAt||"")!==before&&PRICE_DATA?.updatedAt){
        showToast("株価を最新にしました");
        return;
      }
      if(tries<8) setTimeout(poll,25000);
    };
    setTimeout(poll,35000);
  }catch(error){console.warn("株価更新依頼に失敗",error);}
}

/* ---------- 共通 ---------- */

function showToast(message,type="ok"){
  const node=$("#toast");
  node.textContent=message;
  node.className=`toast show${type==="error"?" error":""}`;
  clearTimeout(toastTimer);
  const duration=Math.min(8000,Math.max(2200,String(message).length*130));
  toastTimer=setTimeout(()=>{node.className="toast";},duration);
}

function renderAll(){
  renderSummary();
  renderChart();
  renderBuyPanel();
  renderPositions();
  renderClosed();
  renderQuarters();
}

/* ---------- 配線・起動 ---------- */

$("#instrumentQuery").addEventListener("input",renderInstrumentResults);
$("#buyForm").addEventListener("submit",submitBuy);
$("#buyQty").addEventListener("input",updateBuyPreview);
$("#buyPrice").addEventListener("input",updateBuyPreview);
$("#buyStop").addEventListener("input",updateBuyPreview);
$("#buyTarget").addEventListener("input",updateBuyPreview);
["fixPrice","fixStop","fixTarget"].forEach(id=>$("#"+id).addEventListener("input",updateFixPreview));
["lineStop","lineTarget"].forEach(id=>$("#"+id).addEventListener("input",updateLinePreview));
$("#sellPrice").addEventListener("input",updateSellPreview);
$("#sellSave").addEventListener("click",submitSell);
$("#sellModalClose").addEventListener("click",closeSellModal);
$("#sellModal").addEventListener("click",event=>{if(event.target===$("#sellModal")) closeSellModal();});
$("#lineSave").addEventListener("click",submitLines);
$("#lineModalClose").addEventListener("click",closeLineModal);
$("#lineModal").addEventListener("click",event=>{if(event.target===$("#lineModal")) closeLineModal();});
$("#fixSave").addEventListener("click",submitFix);
$("#fixModalClose").addEventListener("click",closeFixModal);
$("#fixModal").addEventListener("click",event=>{if(event.target===$("#fixModal")) closeFixModal();});
$("#navSync").addEventListener("click",()=>$("#syncPanel").scrollIntoView({behavior:"smooth"}));
$("#chartWrap").addEventListener("pointermove",chartPointer);
$("#chartWrap").addEventListener("pointerdown",chartPointer);
$("#chartWrap").addEventListener("pointerleave",chartPointerEnd);

$("#repoLabel").textContent=`${CONFIG.github.owner}/${CONFIG.github.repo}/${CONFIG.file}`;
$("#ghConnectBtn").addEventListener("click",()=>{
  const token=$("#ghTokenInput").value.trim();
  if(!token){showToast("トークンを入れてください","error");return;}
  store.connect(token).then(()=>{$("#ghTokenInput").value="";loadPriceData().then(requestFreshPrices);});
});
$("#ghSyncNowBtn").addEventListener("click",()=>{store.syncNow();loadPriceData();});
$("#ghDisconnectBtn").addEventListener("click",()=>{
  if(confirm("この端末からGitHub同期を切断しますか？")){store.disconnect();PRICE_DATA=null;HISTORY_DATA=null;renderAll();}
});
$("#btnJsonExport").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(db,null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`trade-sim-${todayJst()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#jsonImport").addEventListener("change",event=>{
  const file=event.target.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      db=normalize(JSON.parse(reader.result));
      save();
      renderAll();
      showToast("JSONから復元しました");
    }catch(error){showToast("JSONを読めませんでした","error");}
  };
  reader.readAsText(file);
  event.target.value="";
});

renderAll();
store.init().then(loadPriceData).then(requestFreshPrices);
loadInstrumentData().then(()=>{}).catch(error=>console.warn("銘柄一覧の読込に失敗",error));
window.addEventListener("focus",()=>{if(Date.now()-priceLoadedAt>5*60*1000) loadPriceData();});
setInterval(loadPriceData,15*60*1000);
