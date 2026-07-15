"use strict";

/* Progress Portfolio v0.2
   現在状態は stocks に保存せず、各銘柄の最新 decision から算出する。
   判断は上書きせず追加し、売買 execution は判断にだけ紐付ける。 */

const CONFIG={
  github:{owner:"neongreeen",repo:"fdoa-app-data",branch:"main"},
  file:"progress.json",
  priceFile:"prices.json",
  tokenKey:"fdoa_gh_token",
  legacyTokenKeys:["fdoa_bukken_gh_token"],
  storageKey:"progress_portfolio_v1",
  schemaVersion:2,
  instrumentFiles:["data/instruments-curated.json","data/instruments-jp.json","data/instruments-us.json"],
};

const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const uid=(prefix="id")=>`${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
const clone=value=>JSON.parse(JSON.stringify(value));

const DEFAULT_MASTERS={
  statuses:[
    {id:"status_hold",label:"ガチホ",active:true,order:10,isDefault:true},
    {id:"status_profit_watch",label:"利確様子見",active:true,order:20,isDefault:false},
    {id:"status_loss_watch",label:"損切り様子見",active:true,order:30,isDefault:false},
    {id:"status_buy_watch",label:"買い見込み／再買い",active:true,order:40,isDefault:false},
  ],
  actions:[
    {id:"action_continue",label:"継続",executionSide:null,active:true,order:10,isDefault:true},
    {id:"action_wait",label:"様子見",executionSide:null,active:true,order:20,isDefault:false},
    {id:"action_buy",label:"買う",executionSide:"buy",active:true,order:30,isDefault:false},
    {id:"action_rebuy",label:"再買い",executionSide:"buy",active:true,order:40,isDefault:false},
    {id:"action_sell",label:"売る",executionSide:"sell",active:true,order:50,isDefault:false},
    {id:"action_partial_sell",label:"一部売却",executionSide:"sell",active:true,order:60,isDefault:false},
    {id:"action_pass",label:"見送る",executionSide:null,active:true,order:70,isDefault:false},
  ],
  reasons:[
    {id:"reason_company",label:"企業動向",active:true,order:10,isDefault:true},
    {id:"reason_market",label:"市場心理",active:true,order:20,isDefault:false},
    {id:"reason_chart",label:"チャート",active:true,order:30,isDefault:false},
    {id:"reason_volume",label:"出来高",active:true,order:40,isDefault:false},
    {id:"reason_board",label:"板",active:true,order:50,isDefault:false},
    {id:"reason_earnings",label:"決算",active:true,order:60,isDefault:false},
    {id:"reason_macro",label:"マクロ",active:true,order:70,isDefault:false},
  ],
  subReasons:[
    {id:"sub_no_change",label:"前提に変化なし",active:true,order:10,isDefault:true},
    {id:"sub_support_break",label:"支持線割れ",active:true,order:20,isDefault:false},
    {id:"sub_price_target",label:"注目価格へ接近",active:true,order:30,isDefault:false},
    {id:"sub_price_discovery",label:"価格発見中",active:true,order:40,isDefault:false},
    {id:"sub_overheat",label:"過熱／過度な悲観",active:true,order:50,isDefault:false},
    {id:"sub_material",label:"新しい材料",active:true,order:60,isDefault:false},
    {id:"sub_execution",label:"実行条件を満たした",active:true,order:70,isDefault:false},
  ],
  reviewPresets:[
    {id:"review_today",label:"今日",days:0,active:true,order:10,isDefault:false},
    {id:"review_tomorrow",label:"明日",days:1,active:true,order:20,isDefault:true},
    {id:"review_3days",label:"3日後",days:3,active:true,order:30,isDefault:false},
    {id:"review_week",label:"1週間後",days:7,active:true,order:40,isDefault:false},
    {id:"review_month",label:"1か月後",days:30,active:true,order:50,isDefault:false},
  ],
};

function seed(){
  return{
    meta:{schemaVersion:CONFIG.schemaVersion,savedAt:null},
    stocks:[],
    decisions:[],
    executions:[],
    masters:clone(DEFAULT_MASTERS),
    settings:{},
  };
}

function normalize(data){
  if(!data||typeof data!=="object") return seed();
  const base=seed();
  const result={
    meta:{schemaVersion:CONFIG.schemaVersion,savedAt:data.meta?.savedAt||null},
    stocks:(Array.isArray(data.stocks)?data.stocks:[]).map(stock=>({
      id:stock.id||uid("stock"),
      name:String(stock.name||"名称未設定"),
      ticker:String(stock.ticker||"").toUpperCase(),
      market:String(stock.market||""),
      currency:String(stock.currency||""),
      country:String(stock.country||""),
      companyUrl:safeExternalUrl(stock.companyUrl),
      irUrl:safeExternalUrl(stock.irUrl),
      active:stock.active!==false,
      createdAt:stock.createdAt||new Date().toISOString(),
      updatedAt:stock.updatedAt||stock.createdAt||new Date().toISOString(),
    })),
    decisions:Array.isArray(data.decisions)?data.decisions:[],
    executions:(Array.isArray(data.executions)?data.executions:[]).map(execution=>({
      id:execution.id||uid("execution"),
      decisionId:execution.decisionId,
      stockId:execution.stockId,
      executedAt:execution.executedAt,
      createdAt:execution.createdAt||execution.executedAt,
    })),
    masters:{},
    settings:data.settings&&typeof data.settings==="object"?data.settings:{},
  };
  Object.keys(DEFAULT_MASTERS).forEach(kind=>{
    const list=data.masters&&Array.isArray(data.masters[kind])?data.masters[kind]:base.masters[kind];
    result.masters[kind]=list.map((item,index)=>({
      ...item,
      id:item.id||uid(kind.slice(0,3)),
      label:String(item.label||"名称未設定"),
      active:item.active!==false,
      order:Number.isFinite(Number(item.order))?Number(item.order):(index+1)*10,
      isDefault:item.isDefault===true,
      ...(kind==="actions"?{executionSide:["buy","sell"].includes(item.executionSide)?item.executionSide:null}:{}),
      ...(kind==="reviewPresets"?{days:Number.isFinite(Number(item.days))?Number(item.days):1}:{}),
    }));
  });
  return result;
}

function load(){
  try{
    const data=JSON.parse(localStorage.getItem(CONFIG.storageKey));
    return normalize(data);
  }catch(error){
    return seed();
  }
}

let DB=load();
let store=null;
let toastTimer=null;
let INSTRUMENTS=[];
let instrumentMeta=[];
let PRICE_DATA=null;
let priceLoadedAt=0;
let priceLoading=false;

function save(){
  DB.meta.schemaVersion=CONFIG.schemaVersion;
  DB.meta.savedAt=new Date().toISOString();
  localStorage.setItem(CONFIG.storageKey,JSON.stringify(DB));
  if(store) store.queueSync();
}

function adoptRemote(data){
  DB=normalize(data);
  localStorage.setItem(CONFIG.storageKey,JSON.stringify(DB));
  renderAll();
}

function ordered(kind,includeInactive=true){
  return (DB.masters[kind]||[])
    .filter(item=>includeInactive||item.active)
    .slice()
    .sort((a,b)=>Number(a.order)-Number(b.order));
}

function master(kind,id){return (DB.masters[kind]||[]).find(item=>item.id===id)||null;}
function defaultMaster(kind){return ordered(kind,false).find(item=>item.isDefault)||ordered(kind,false)[0]||null;}
function stockById(id){return DB.stocks.find(stock=>stock.id===id)||null;}
function executionFor(decisionId){return DB.executions.find(execution=>execution.decisionId===decisionId)||null;}
function decisionTime(decision){return new Date(decision.decidedAt||decision.createdAt||0).getTime();}
function latestDecision(stockId){
  return DB.decisions.filter(decision=>decision.stockId===stockId).sort((a,b)=>decisionTime(b)-decisionTime(a))[0]||null;
}
function activeStocks(){return DB.stocks.filter(stock=>stock.active!==false).slice().sort((a,b)=>a.name.localeCompare(b.name,"ja"));}

function localDate(date=new Date()){
  const y=date.getFullYear();
  const m=String(date.getMonth()+1).padStart(2,"0");
  const d=String(date.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}

function localDateTime(date=new Date()){
  const hh=String(date.getHours()).padStart(2,"0");
  const mm=String(date.getMinutes()).padStart(2,"0");
  return `${localDate(date)}T${hh}:${mm}`;
}

function addDays(days){
  const date=new Date();
  date.setHours(12,0,0,0);
  date.setDate(date.getDate()+Number(days||0));
  return localDate(date);
}

function formatDate(value,withTime=false){
  if(!value) return "—";
  const date=new Date(value);
  if(Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP",withTime?{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}:{year:"numeric",month:"numeric",day:"numeric"}).format(date);
}

function formatPriceTime(value){
  if(!value) return "";
  const date=new Date(value);
  if(Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(date);
}

function formatMarketTime(value){
  if(!value) return "";
  const date=new Date(value);
  if(Number.isNaN(date.getTime())) return "";
  const sameDay=localDate(date)===localDate();
  return new Intl.DateTimeFormat("ja-JP",sameDay?{hour:"2-digit",minute:"2-digit"}:{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(date);
}

function quoteFor(stock){
  if(!stock||!PRICE_DATA?.quotes) return null;
  return PRICE_DATA.quotes[String(stock.ticker||"").toUpperCase()]||null;
}

function formatQuotePrice(quote){
  if(!quote||!Number.isFinite(Number(quote.price))) return "";
  const currency=quote.currency||"";
  const digits=currency==="JPY"?(Number(quote.price)%1===0?0:1):2;
  try{
    return new Intl.NumberFormat("ja-JP",{style:"currency",currency:currency||"USD",minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Number(quote.price));
  }catch(error){
    return Number(quote.price).toLocaleString("ja-JP");
  }
}

function quoteHtml(stock,className="stock-quote"){
  const quote=quoteFor(stock);
  if(!quote) return "";
  const change=Number(quote.changePct);
  const changeText=Number.isFinite(change)?`${change>0?"+":""}${change.toFixed(2)}%`:"";
  const direction=change>0?"up":change<0?"down":"flat";
  return `<span class="${className}" title="${esc(PRICE_DATA.source||"参考株価")}・前営業日比・市場時刻 ${esc(formatPriceTime(quote.marketTime||quote.fetchedAt))}"><strong>${esc(formatQuotePrice(quote))}</strong>${changeText?`<span class="price-change ${direction}">${esc(changeText)}</span>`:""}</span>`;
}

function marketTimeFor(stocks,country){
  const times=stocks
    .filter(stock=>stock.country===country)
    .map(stock=>quoteFor(stock)?.marketTime)
    .filter(Boolean)
    .map(value=>new Date(value))
    .filter(date=>!Number.isNaN(date.getTime()));
  if(!times.length) return "";
  return formatMarketTime(new Date(Math.max(...times.map(date=>date.getTime()))));
}

async function loadPriceData(){
  if(priceLoading||!store?.hasToken()) return;
  priceLoading=true;
  try{
    const data=await store.fetchFile(CONFIG.priceFile);
    PRICE_DATA=data&&data.quotes&&typeof data.quotes==="object"?data:null;
  }catch(error){
    PRICE_DATA=null;
    console.warn("Price data load failed",error);
  }
  priceLoadedAt=Date.now();
  priceLoading=false;
  renderBoard();
  renderStockTable();
}

function safeExternalUrl(value){
  if(!value) return "";
  try{
    const url=new URL(String(value));
    return ["http:","https:"].includes(url.protocol)?url.href:"";
  }catch(error){return "";}
}

function openSbiWindow(url){
  const safeUrl=safeExternalUrl(url);
  if(!safeUrl) return false;
  const availableLeft=Number.isFinite(Number(window.screen.availLeft))?Number(window.screen.availLeft):0;
  const availableTop=Number.isFinite(Number(window.screen.availTop))?Number(window.screen.availTop):0;
  const availableWidth=Number(window.screen.availWidth)||1440;
  const availableHeight=Number(window.screen.availHeight)||900;
  const width=Math.round(availableWidth/2);
  const left=availableLeft+availableWidth-width;
  const features=[
    "popup=yes",
    `width=${width}`,
    `height=${availableHeight}`,
    `left=${left}`,
    `top=${availableTop}`,
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");
  const popup=window.open("about:blank","_blank",features);
  if(!popup) return false;
  try{
    popup.resizeTo(width,availableHeight);
    popup.moveTo(left,availableTop);
    popup.opener=null;
    popup.location.replace(safeUrl);
    popup.focus();
  }catch(error){
    popup.location.href=safeUrl;
  }
  return true;
}

function normalizeSearchText(value){
  return String(value||"").normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g," ").trim();
}

async function loadInstrumentData(){
  const results=await Promise.allSettled(CONFIG.instrumentFiles.map(async path=>{
    const response=await fetch(path,{cache:"no-cache"});
    if(!response.ok) throw new Error(`${path}: ${response.status}`);
    const payload=await response.json();
    if(!Array.isArray(payload.instruments)) throw new Error(`${path}: invalid data`);
    instrumentMeta.push({source:payload.source||path,sourceUpdatedAt:payload.sourceUpdatedAt||null,generatedAt:payload.generatedAt||null,count:payload.instruments.length});
    return payload.instruments;
  }));
  const unique=new Map();
  results.flatMap(result=>result.status==="fulfilled"?result.value:[]).forEach(item=>{
    const key=`${item.country||""}:${item.market||""}:${String(item.ticker||"").toUpperCase()}`;
    if(!unique.has(key)) unique.set(key,item);
  });
  INSTRUMENTS=[...unique.values()].map(item=>({...item,searchText:normalizeSearchText(`${item.ticker} ${item.name} ${item.market||""}`)}));
  const failed=results.filter(result=>result.status==="rejected").length;
  $("#instrumentSource").textContent=INSTRUMENTS.length?`${INSTRUMENTS.length.toLocaleString("ja-JP")}銘柄${failed?"・一部読込失敗":""}`:"手動登録のみ";
  $("#instrumentSource").title=instrumentMeta.map(item=>`${item.source} ${item.sourceUpdatedAt||item.generatedAt||"更新日不明"}`).join(" / ");
  renderInstrumentResults();
  if(failed) console.warn("Instrument data load failed",results.filter(result=>result.status==="rejected"));
}

function searchInstruments(query){
  const term=normalizeSearchText(query);
  if(!term) return [];
  return INSTRUMENTS
    .filter(item=>item.searchText.includes(term))
    .sort((a,b)=>{
      const aTicker=normalizeSearchText(a.ticker),bTicker=normalizeSearchText(b.ticker);
      const aName=normalizeSearchText(a.name),bName=normalizeSearchText(b.name);
      const rank=(ticker,name)=>ticker===term?0:ticker.startsWith(term)?1:name===term?2:name.startsWith(term)?3:4;
      const rankA=rank(aTicker,aName),rankB=rank(bTicker,bName);
      return rankA-rankB||(rankA===3?aName.length-bName.length:0)||aTicker.localeCompare(bTicker,"en")||a.name.localeCompare(b.name,"ja");
    })
    .slice(0,8);
}

function renderInstrumentResults(){
  const query=$("#instrumentQuery").value;
  const list=searchInstruments(query);
  if(!normalizeSearchText(query)){ $("#instrumentResults").innerHTML="";return; }
  if(!list.length){
    $("#instrumentResults").innerHTML='<div class="instrument-empty">見つかりません。下の欄へ手入力できます。</div>';
    return;
  }
  $("#instrumentResults").innerHTML=list.map((item,index)=>`<button type="button" class="instrument-result" data-index="${index}">
    <span><strong>${esc(item.name)}</strong><small>${esc(item.ticker)}・${esc(item.market||"市場未設定")}</small></span>
    <span class="instrument-country">${esc(item.country||"")}</span>
  </button>`).join("");
  $$(".instrument-result",$("#instrumentResults")).forEach(button=>button.addEventListener("click",()=>selectInstrument(list[Number(button.dataset.index)])));
}

function selectInstrument(item){
  if(!item) return;
  $("#sName").value=item.name||"";
  $("#sTicker").value=item.ticker||"";
  $("#sMarket").value=item.market||"";
  $("#sCurrency").value=item.currency||"USD";
  $("#sCountry").value=item.country||"";
  $("#sCompanyUrl").value=item.companyUrl||"";
  $("#sIrUrl").value=item.irUrl||"";
  $("#instrumentQuery").value="";
  $("#instrumentResults").innerHTML="";
  $("#sCompanyUrl").focus();
}

function showToast(message,type="ok"){
  const node=$("#toast");
  node.textContent=message;
  node.className=`toast show${type==="error"?" error":""}`;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{node.className="toast";},2200);
}

function optionHtml(items,selected,placeholder=""){
  const rows=[];
  if(placeholder) rows.push(`<option value="">${esc(placeholder)}</option>`);
  items.forEach(item=>rows.push(`<option value="${esc(item.id)}"${item.id===selected?" selected":""}>${esc(item.label)}${item.active===false?"（停止）":""}</option>`));
  return rows.join("");
}

function selectItems(kind,selected){
  return ordered(kind,true).filter(item=>item.active||item.id===selected);
}

function statusColor(id){
  const palette=["#48675f","#9b6f2f","#a65242","#4a637e","#6e5b7e","#5f6870"];
  const index=Math.max(0,ordered("statuses",true).findIndex(item=>item.id===id));
  return palette[index%palette.length];
}

function statusPill(id){
  const item=master("statuses",id);
  return item?`<span class="status-pill" style="background:${statusColor(id)}">${esc(item.label)}</span>`:`<span class="status-pill">未分類</span>`;
}

function actionPill(id){
  const item=master("actions",id);
  return item?`<span class="action-pill">${esc(item.label)}</span>`:`<span class="action-pill">未設定</span>`;
}

function currentView(){return $("nav button.active")?.dataset.view||"today";}

function showView(name){
  $$("nav button[data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===name));
  $$("main .view").forEach(view=>view.classList.toggle("active",view.id===`view-${name}`));
  window.scrollTo({top:0,behavior:"smooth"});
}

function renderDecisionOptions(preserve=true){
  const selected=preserve?{
    stock:$("#dStock").value,status:$("#dStatus").value,action:$("#dAction").value,
    reason:$("#dReason").value,subReason:$("#dSubReason").value,review:$("#dReviewPreset").value,
  }:{};
  $("#dStock").innerHTML=optionHtml(activeStocks().map(stock=>({id:stock.id,label:`${stock.name}  ${stock.ticker}`})),selected.stock,"銘柄を選択");
  $("#dStatus").innerHTML=optionHtml(selectItems("statuses",selected.status),selected.status);
  $("#dAction").innerHTML=optionHtml(selectItems("actions",selected.action),selected.action);
  $("#dReason").innerHTML=optionHtml(selectItems("reasons",selected.reason),selected.reason);
  $("#dSubReason").innerHTML=optionHtml(selectItems("subReasons",selected.subReason),selected.subReason);
  $("#dReviewPreset").innerHTML=optionHtml(selectItems("reviewPresets",selected.review),selected.review);

  if(!selectItems("statuses",selected.status).some(item=>item.id===selected.status)) $("#dStatus").value=defaultMaster("statuses")?.id||"";
  if(!selectItems("actions",selected.action).some(item=>item.id===selected.action)) $("#dAction").value=defaultMaster("actions")?.id||"";
  if(!selectItems("reasons",selected.reason).some(item=>item.id===selected.reason)) $("#dReason").value=defaultMaster("reasons")?.id||"";
  if(!selectItems("subReasons",selected.subReason).some(item=>item.id===selected.subReason)) $("#dSubReason").value=defaultMaster("subReasons")?.id||"";
  if(!selectItems("reviewPresets",selected.review).some(item=>item.id===selected.review)) $("#dReviewPreset").value=defaultMaster("reviewPresets")?.id||"";
  updateExecutionFields();
}

function applyStockDefaults(stockId){
  const decision=latestDecision(stockId);
  $("#dStatus").value=decision?.statusId||defaultMaster("statuses")?.id||"";
  $("#dAction").value=defaultMaster("actions")?.id||"";
  $("#dReason").value=defaultMaster("reasons")?.id||"";
  $("#dSubReason").value=defaultMaster("subReasons")?.id||"";
  $("#dReviewPreset").value=defaultMaster("reviewPresets")?.id||"";
  $("#dMemo").value="";
  $("#dExecutionState").value="pending";
  $("#dExecutedAt").value="";
  $("#formState").textContent=decision?`前回 ${formatDate(decision.decidedAt,true)}`:"初回判断";
  $("#formState").className="save-state ready";
  updateExecutionFields();
}

function updateExecutionFields(){
  const action=master("actions",$("#dAction").value);
  const canExecute=Boolean(action?.executionSide);
  $("#dExecutionState").disabled=!canExecute;
  if(!canExecute) $("#dExecutionState").value="pending";
  const enabled=canExecute&&$("#dExecutionState").value==="executed";
  [$("#dExecutedAt")].forEach(input=>{
    input.disabled=!enabled;
    input.closest(".execution-field").classList.toggle("disabled",!enabled);
  });
  if(enabled&&!$("#dExecutedAt").value) $("#dExecutedAt").value=localDateTime();
}

function renderBoard(){
  const stocks=activeStocks();
  const jpTime=marketTimeFor(stocks,"JP");
  const usTime=marketTimeFor(stocks,"US");
  const marketTimes=[jpTime&&`日本株：${jpTime}頃`,usTime&&`米株：${usTime}頃`].filter(Boolean);
  $("#stockCount").textContent=marketTimes.join("　")||`${stocks.length}銘柄`;
  $("#stockCount").title=marketTimes.length?`${PRICE_DATA.source||"参考株価"}・実際の市場時刻`:"";
  const statuses=ordered("statuses",true);
  const grouped=new Map(statuses.map(status=>[status.id,[]]));
  const unclassified=[];
  stocks.forEach(stock=>{
    const decision=latestDecision(stock.id);
    if(decision&&grouped.has(decision.statusId)) grouped.get(decision.statusId).push({stock,decision});
    else unclassified.push({stock,decision});
  });
  let html=statuses.map(status=>{
    const list=grouped.get(status.id)||[];
    return `<div class="status-column">
      <div class="status-column-head"><span class="status-column-title">${esc(status.label)}${status.active?"":"（停止）"}</span><span class="status-column-count">${list.length}</span></div>
      ${list.length?list.map(({stock,decision})=>stockCard(stock,decision)).join(""):'<div class="empty-compact">該当なし</div>'}
    </div>`;
  }).join("");
  if(unclassified.length){
    html+=`<div class="no-status-column"><strong>まだ状態を決めていない銘柄</strong><div class="no-status-list">${unclassified.map(({stock,decision})=>stockCard(stock,decision)).join("")}</div></div>`;
  }
  $("#statusBoard").innerHTML=html||'<div class="empty-compact">銘柄を追加すると、ここに表示されます</div>';
  $$(".stock-card",$("#statusBoard")).forEach(button=>button.addEventListener("click",()=>goToDecision(button.dataset.stock)));
}

function stockCard(stock,decision){
  return `<button type="button" class="stock-card" data-stock="${esc(stock.id)}">
    <span class="stock-card-top"><span class="stock-identity"><span class="stock-name" title="${esc(stock.name)}">${esc(stock.name)}</span><span class="stock-symbol">${esc(stock.ticker)}</span></span><span class="stock-card-action">${esc(master("actions",decision?.actionId)?.label||"判断する")}</span></span>
    <span class="stock-card-memo">${esc(decision?.memo||master("subReasons",decision?.subReasonId)?.label||"まだログがありません")}</span>
    <span class="stock-card-bottom">${quoteHtml(stock,"stock-card-quote")}<span class="stock-card-date">次回 ${decision?.nextReviewDate?formatDate(`${decision.nextReviewDate}T12:00:00`):"未設定"}</span></span>
  </button>`;
}

function renderStockTable(){
  if(!DB.stocks.length){$("#stockTable").innerHTML="";return;}
  $("#stockTable").innerHTML=DB.stocks.slice().sort((a,b)=>a.name.localeCompare(b.name,"ja")).map(stock=>`<div class="stock-table-row${stock.active===false?" inactive":""}">
    <div class="stock-identity"><div class="stock-name">${esc(stock.name)}</div><div class="stock-symbol">${esc(stock.ticker)}</div></div>
    ${quoteHtml(stock,"stock-table-quote")||'<span class="stock-table-quote empty-quote">—</span>'}
    <div class="stock-market">${esc(stock.market||"—")}</div>
    <div class="stock-currency">${esc(stock.currency||"—")}</div>
    <div class="stock-links">${stock.companyUrl?`<a href="${esc(stock.companyUrl)}" target="_blank" rel="noopener noreferrer">企業</a>`:""}${stock.irUrl?`<a href="${esc(stock.irUrl)}" target="_blank" rel="noopener noreferrer">IR</a>`:""}${!stock.companyUrl&&!stock.irUrl?"—":""}</div>
    <div class="stock-observation-state">${stock.active===false?"休止":"観察中"}</div>
    <button type="button" class="btn sec sm toggle-stock" data-stock="${esc(stock.id)}">${stock.active===false?"再開":"休止"}</button>
  </div>`).join("");
  $$(".toggle-stock",$("#stockTable")).forEach(button=>button.addEventListener("click",()=>{
    const stock=stockById(button.dataset.stock);
    if(!stock) return;
    stock.active=stock.active===false;
    stock.updatedAt=new Date().toISOString();
    save();renderAll();showToast(stock.active?"観察を再開しました":"観察を休止しました");
  }));
}

function renderFilters(){
  const values={stock:$("#fStock").value,status:$("#fStatus").value,action:$("#fAction").value};
  $("#fStock").innerHTML='<option value="">全銘柄</option>'+DB.stocks.slice().sort((a,b)=>a.name.localeCompare(b.name,"ja")).map(stock=>`<option value="${esc(stock.id)}">${esc(stock.name)}</option>`).join("");
  $("#fStatus").innerHTML='<option value="">全状態</option>'+ordered("statuses",true).map(item=>`<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("");
  $("#fAction").innerHTML='<option value="">全判断</option>'+ordered("actions",true).map(item=>`<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("");
  $("#fStock").value=values.stock;$("#fStatus").value=values.status;$("#fAction").value=values.action;
}

function renderLog(){
  let list=DB.decisions.slice().sort((a,b)=>decisionTime(b)-decisionTime(a));
  const stockId=$("#fStock").value,statusId=$("#fStatus").value,actionId=$("#fAction").value;
  if(stockId) list=list.filter(item=>item.stockId===stockId);
  if(statusId) list=list.filter(item=>item.statusId===statusId);
  if(actionId) list=list.filter(item=>item.actionId===actionId);
  $("#logCount").textContent=`${list.length}件`;
  if(!list.length){$("#logList").innerHTML='<div class="empty-compact">条件に合うログはありません</div>';return;}
  $("#logList").innerHTML=list.map(decision=>{
    const stock=stockById(decision.stockId);
    const execution=executionFor(decision.id);
    const action=master("actions",decision.actionId);
    const side=action?.executionSide;
    return `<div class="log-row">
      <div class="timeline-date">${formatDate(decision.decidedAt,true)}</div>
      <div class="stock-identity"><div class="stock-name" title="${esc(stock?.name||"不明な銘柄")}">${esc(stock?.name||"不明な銘柄")}</div><div class="stock-symbol">${esc(stock?.ticker||"")}</div></div>
      <div class="log-status">${statusPill(decision.statusId)}</div>
      <div>${actionPill(decision.actionId)}</div>
      <div class="log-detail"><div class="log-memo">${esc(decision.memo||"—")}</div><div class="log-reason">${esc(master("reasons",decision.reasonId)?.label||"—")} ／ ${esc(master("subReasons",decision.subReasonId)?.label||"—")} ／ 次回 ${decision.nextReviewDate?formatDate(`${decision.nextReviewDate}T12:00:00`):"—"}</div></div>
      <div class="log-execution">${execution?`<span class="side-pill ${side}">${side==="buy"?"買付":"売却"}</span> ${formatDate(execution.executedAt,true)}`:"未実行"}</div>
    </div>`;
  }).join("");
}

const MASTER_META={
  statuses:{title:"状態",prefix:"status"},
  actions:{title:"判断",prefix:"action",extra:"side"},
  reasons:{title:"理由",prefix:"reason"},
  subReasons:{title:"補助理由",prefix:"sub"},
  reviewPresets:{title:"次回確認",prefix:"review",extra:"days"},
};

function renderMasterSections(){
  $("#masterSections").innerHTML=Object.entries(MASTER_META).map(([kind,meta])=>{
    const rows=ordered(kind,true).map(item=>masterRow(kind,item,meta)).join("");
    return `<section class="master-section" data-kind="${kind}">
      <div class="master-section-head"><h3>${meta.title}</h3><span class="muted">${DB.masters[kind].length}項目</span></div>
      <div class="master-list">${rows}</div>
      <div class="master-add">
        <label class="field"><span>新しい${meta.title}</span><input class="master-add-label" type="text" maxlength="50" placeholder="名称"></label>
        ${masterExtraInput(meta,null,true)}
        <button type="button" class="btn sec sm add-master">追加</button>
      </div>
    </section>`;
  }).join("");

  $$(".save-master").forEach(button=>button.addEventListener("click",()=>saveMasterRow(button.closest(".master-row"))));
  $$(".add-master").forEach(button=>button.addEventListener("click",()=>addMasterItem(button.closest(".master-section"))));
}

function masterRow(kind,item,meta){
  return `<div class="master-row" data-id="${esc(item.id)}" data-kind="${kind}">
    <input class="master-label" type="text" maxlength="50" value="${esc(item.label)}" aria-label="表示名">
    <input class="master-order" type="number" step="1" value="${Number(item.order)}" aria-label="表示順">
    <label class="master-check"><input class="master-active" type="checkbox"${item.active?" checked":""}>使用</label>
    <label class="master-check"><input class="master-default" type="radio" name="default-${kind}"${item.isDefault?" checked":""}>既定</label>
    ${masterExtraInput(meta,item,false)}
    <button type="button" class="btn sec sm master-save save-master">保存</button>
  </div>`;
}

function masterExtraInput(meta,item,isAdd){
  const className=isAdd?"master-add-extra":"master-extra";
  if(meta.extra==="side") return `<label class="field ${className}"><span>${isAdd?"売買方向":""}</span><select data-extra="side"><option value=""${!item?.executionSide?" selected":""}>実行なし</option><option value="buy"${item?.executionSide==="buy"?" selected":""}>買い</option><option value="sell"${item?.executionSide==="sell"?" selected":""}>売り</option></select></label>`;
  if(meta.extra==="days") return `<label class="field ${className}"><span>${isAdd?"日数":""}</span><input data-extra="days" type="number" step="1" min="0" value="${item?Number(item.days):1}"></label>`;
  return `<div class="${className} master-extra-empty"></div>`;
}

function saveMasterRow(row){
  const kind=row.dataset.kind;
  const item=master(kind,row.dataset.id);
  if(!item) return;
  const label=$(".master-label",row).value.trim();
  if(!label){showToast("名称を入力してください","error");return;}
  item.label=label;
  item.order=Number($(".master-order",row).value)||0;
  item.active=$(".master-active",row).checked;
  if($(".master-default",row).checked){DB.masters[kind].forEach(entry=>entry.isDefault=entry.id===item.id);}
  const extra=$("[data-extra]",row);
  if(kind==="actions") item.executionSide=extra.value||null;
  if(kind==="reviewPresets") item.days=Math.max(0,Number(extra.value)||0);
  save();renderAll();showView("master");showToast(`${MASTER_META[kind].title}を保存しました`);
}

function addMasterItem(section){
  const kind=section.dataset.kind;
  const meta=MASTER_META[kind];
  const label=$(".master-add-label",section).value.trim();
  if(!label){showToast("名称を入力してください","error");return;}
  const maxOrder=Math.max(0,...DB.masters[kind].map(item=>Number(item.order)||0));
  const item={id:uid(meta.prefix),label,active:true,order:maxOrder+10,isDefault:!DB.masters[kind].some(entry=>entry.isDefault&&entry.active)};
  const extra=$("[data-extra]",$(".master-add",section));
  if(kind==="actions") item.executionSide=extra.value||null;
  if(kind==="reviewPresets") item.days=Math.max(0,Number(extra.value)||0);
  DB.masters[kind].push(item);
  save();renderAll();showView("master");showToast(`${meta.title}を追加しました`);
}

function renderAll(){
  const view=currentView();
  renderDecisionOptions(true);
  renderBoard();
  renderStockTable();
  renderFilters();
  renderLog();
  renderMasterSections();
  renderSettings();
  showView(view);
}

function renderSettings(){
  const url=safeExternalUrl(DB.settings.sbiPortfolioUrl);
  $("#sbiPortfolioUrl").value=url;
  $("#sbiQuickLink").href=url||"#";
  $("#sbiQuickLink").textContent=url?"SBIを開く":"SBIを設定";
  $("#testSbiUrl").hidden=!url;
  $("#testSbiUrl").href=url||"#";
}

function goToDecision(stockId){
  showView("observe");
  $("#dStock").value=stockId;
  applyStockDefaults(stockId);
  $(".decision-panel").scrollIntoView({behavior:"smooth",block:"start"});
}

function submitDecision(event){
  event.preventDefault();
  const stockId=$("#dStock").value;
  const stock=stockById(stockId);
  if(!stock){showToast("銘柄を選択してください","error");return;}
  const review=master("reviewPresets",$("#dReviewPreset").value);
  if(!review){showToast("次回確認を選択してください","error");return;}
  const now=new Date().toISOString();
  const decision={
    id:uid("decision"),stockId,decidedAt:now,
    statusId:$("#dStatus").value,
    actionId:$("#dAction").value,
    reasonId:$("#dReason").value,
    subReasonId:$("#dSubReason").value,
    memo:$("#dMemo").value.trim(),
    nextReviewDate:addDays(review.days),
    createdAt:now,
  };
  if(!decision.statusId||!decision.actionId||!decision.reasonId||!decision.subReasonId){showToast("選択項目を確認してください","error");return;}

  const action=master("actions",decision.actionId);
  const executed=$("#dExecutionState").value==="executed";
  let execution=null;
  if(executed){
    if(!action?.executionSide){showToast("売買を伴う判断を選択してください","error");return;}
    const executedAt=$("#dExecutedAt").value;
    if(!executedAt){showToast("実行日時を入力してください","error");return;}
    execution={id:uid("execution"),decisionId:decision.id,stockId,executedAt:new Date(executedAt).toISOString(),createdAt:now};
  }

  DB.decisions.push(decision);
  if(execution) DB.executions.push(execution);
  save();
  renderAll();
  $("#dStock").value=stockId;
  applyStockDefaults(stockId);
  $("#formState").textContent="保存済み";
  showToast(execution?"判断と実行を保存しました":"判断を保存しました");
}

function submitStock(event){
  event.preventDefault();
  const name=$("#sName").value.trim();
  const ticker=$("#sTicker").value.trim().toUpperCase();
  if(!name||!ticker){showToast("銘柄名とティッカーは必須です","error");return;}
  if(DB.stocks.some(stock=>stock.ticker.toUpperCase()===ticker&&stock.active!==false)&&!confirm(`${ticker} はすでに登録されています。追加しますか？`)) return;
  const now=new Date().toISOString();
  const companyUrl=safeExternalUrl($("#sCompanyUrl").value.trim());
  const irUrl=safeExternalUrl($("#sIrUrl").value.trim());
  if($("#sCompanyUrl").value.trim()&&!companyUrl){showToast("企業サイトのURLを確認してください","error");return;}
  if($("#sIrUrl").value.trim()&&!irUrl){showToast("IRページのURLを確認してください","error");return;}
  DB.stocks.push({
    id:uid("stock"),name,ticker,market:$("#sMarket").value.trim(),currency:$("#sCurrency").value,
    country:$("#sCountry").value,companyUrl,irUrl,active:true,createdAt:now,updatedAt:now,
  });
  save();
  event.target.reset();$("#sCurrency").value="USD";$("#sCountry").value="";
  renderAll();showView("stocks");showToast("銘柄を追加しました");
}

function exportJson(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download=`progress-portfolio_${localDate()}.json`;
  document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(link.href);
  showToast("JSONを書き出しました");
}

async function importJson(event){
  const file=event.target.files?.[0];
  if(!file) return;
  try{
    const parsed=JSON.parse(await file.text());
    if(!Array.isArray(parsed.stocks)||!Array.isArray(parsed.decisions)||!Array.isArray(parsed.executions)) throw new Error("Progress PortfolioのJSONではありません");
    if(!confirm("現在のデータを、読み込んだJSONで置き換えますか？")) return;
    DB=normalize(parsed);save();renderAll();showView("sync");showToast("JSONから復元しました");
  }catch(error){showToast(error.message||"JSONを読み込めませんでした","error");}
  finally{event.target.value="";}
}

function updateSyncState(state,message=""){
  const labels={off:"未接続",loading:"確認中",dirty:"未同期",saving:"保存中",saved:"同期済み",offline:"オフライン",error:"同期エラー"};
  const label=labels[state]||state;
  $("#syncBadge").textContent=label;
  $("#syncStatus").textContent=message?`${label}：${message}`:label;
  $("#syncStatus").className=`sync-status ${state==="saved"?"ok":state==="error"?"error":""}`;
}

function bindEvents(){
  $$("nav button[data-view]").forEach(button=>button.addEventListener("click",()=>showView(button.dataset.view)));
  $("#decisionForm").addEventListener("submit",submitDecision);
  $("#stockForm").addEventListener("submit",submitStock);
  $("#instrumentQuery").addEventListener("input",renderInstrumentResults);
  $("#dStock").addEventListener("change",event=>applyStockDefaults(event.target.value));
  $("#dAction").addEventListener("change",updateExecutionFields);
  $("#dExecutionState").addEventListener("change",updateExecutionFields);
  [$("#fStock"),$("#fStatus"),$("#fAction")].forEach(select=>select.addEventListener("change",renderLog));
  $("#clearFilters").addEventListener("click",()=>{$("#fStock").value="";$("#fStatus").value="";$("#fAction").value="";renderLog();});
  $("#btnJsonExport").addEventListener("click",exportJson);
  $("#jsonImport").addEventListener("change",importJson);
  $("#saveSbiUrl").addEventListener("click",()=>{
    const raw=$("#sbiPortfolioUrl").value.trim();
    const url=safeExternalUrl(raw);
    if(raw&&!url){showToast("SBIのURLを確認してください","error");return;}
    DB.settings.sbiPortfolioUrl=url;
    save();renderSettings();showToast("SBIへのリンクを保存しました");
  });
  $("#sbiQuickLink").addEventListener("click",event=>{
    event.preventDefault();
    if(openSbiWindow(DB.settings.sbiPortfolioUrl)) return;
    showView("master");$("#sbiPortfolioUrl").focus();
  });
  $("#testSbiUrl").addEventListener("click",event=>{
    event.preventDefault();
    openSbiWindow(DB.settings.sbiPortfolioUrl);
  });
  $("#ghConnectBtn").addEventListener("click",async()=>{
    const token=$("#ghTokenInput").value.trim();
    if(!token){showToast("アクセストークンを入力してください","error");return;}
    await store.connect(token);$("#ghTokenInput").value="";await loadPriceData();
  });
  $("#ghSyncNowBtn").addEventListener("click",async()=>{await store.syncNow();await loadPriceData();});
  $("#ghDisconnectBtn").addEventListener("click",()=>{if(confirm("この端末からGitHub同期を切断しますか？")){store.disconnect();PRICE_DATA=null;renderBoard();renderStockTable();}});
}

store=createCloudStore({
  owner:CONFIG.github.owner,repo:CONFIG.github.repo,branch:CONFIG.github.branch,path:CONFIG.file,
  tokenKey:CONFIG.tokenKey,legacyTokenKeys:CONFIG.legacyTokenKeys,label:"Progress Portfolio",
  getData:()=>DB,adoptRemote,onState:updateSyncState,
});

$("#repoLabel").textContent=`${CONFIG.github.owner}/${CONFIG.github.repo}/${CONFIG.file}`;
bindEvents();
renderAll();
store.init().then(loadPriceData);
loadInstrumentData().catch(error=>{
  console.warn(error);
  $("#instrumentSource").textContent="手動登録のみ";
});
window.addEventListener("focus",()=>{
  if(Date.now()-priceLoadedAt>5*60*1000) loadPriceData();
});
setInterval(loadPriceData,15*60*1000);
