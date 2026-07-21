"use strict";

/* Progress Portfolio v0.3「ボード・ファースト」
   現在状態は stocks に保存せず、各銘柄の最新 decision から算出する。
   記録＝カードをタップ→行き先の状態を選ぶ→一言（判断フォームは廃止）。
   「買った/売った」は状態遷移そのものが表す。記録は上書きせず追加する。
   保存の原則：保有事実（数量・取得単価＝約定した過去の事実）は保存する。
   変動する時価・評価額・損益は保存せず、表示のたびに保有×最新quoteで計算する。 */

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
    {id:"status_hold",label:"ガチホ",color:"#48675f",active:true,order:10,isDefault:true,boardColumn:1},
    {id:"status_profit_watch",label:"利確様子見",color:"#9b6f2f",active:true,order:20,isDefault:false,boardColumn:2},
    {id:"status_loss_watch",label:"損切り様子見",color:"#a65242",active:true,order:30,isDefault:false,boardColumn:3},
    {id:"status_buy_watch",label:"買い見込み／再買い",color:"#4a637e",active:true,order:40,isDefault:false,boardColumn:4},
  ],
  reasonTags:[
    {id:"sub_no_change",label:"前提に変化なし",active:true,order:10,isDefault:false},
    {id:"sub_support_break",label:"支持線割れ",active:true,order:20,isDefault:false},
    {id:"sub_price_target",label:"注目価格へ接近",active:true,order:30,isDefault:false},
    {id:"sub_price_discovery",label:"価格発見中",active:true,order:40,isDefault:false},
    {id:"sub_overheat",label:"過熱／過度な悲観",active:true,order:50,isDefault:false},
    {id:"sub_material",label:"新しい材料",active:true,order:60,isDefault:false},
    {id:"sub_earnings",label:"決算",active:true,order:70,isDefault:false},
  ],
  reviewPresets:[
    {id:"review_today",label:"今日",days:0,active:true,order:10,isDefault:false},
    {id:"review_tomorrow",label:"明日",days:1,active:true,order:20,isDefault:true},
    {id:"review_3days",label:"3日後",days:3,active:true,order:30,isDefault:false},
    {id:"review_week",label:"1週間後",days:7,active:true,order:40,isDefault:false},
    {id:"review_month",label:"1か月後",days:30,active:true,order:50,isDefault:false},
  ],
};

const STATUS_FALLBACK_COLORS=["#7a6a8a","#4f7d7d","#8a5f74"];
const STATUS_NONE_COLOR="#6e6e73";

function sanitizeHexColor(value){
  return /^#[0-9a-fA-F]{6}$/.test(String(value||""))?String(value).toLowerCase():"";
}

function defaultStatusColor(statusId,index=0){
  const preset=DEFAULT_MASTERS.statuses.find(item=>item.id===statusId);
  return preset?.color||STATUS_FALLBACK_COLORS[index%STATUS_FALLBACK_COLORS.length];
}

function readableTextColor(hexColor){
  const hex=sanitizeHexColor(hexColor);
  if(!hex) return "#ffffff";
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  const luma=(0.299*r+0.587*g+0.114*b)/255;
  return luma>0.62?"#1d1d1f":"#ffffff";
}

function statusColor(statusOrId){
  const item=typeof statusOrId==="string"?master("statuses",statusOrId):statusOrId;
  if(!item) return STATUS_NONE_COLOR;
  const index=Math.max(0,ordered("statuses",true).findIndex(entry=>entry.id===item.id));
  return sanitizeHexColor(item.color)||defaultStatusColor(item.id,index);
}

function seed(){
  return{
    meta:{schemaVersion:CONFIG.schemaVersion,savedAt:null},
    stocks:[],
    decisions:[],
    executions:[],
    holdingsLog:[],
    reviews:[],
    masters:clone(DEFAULT_MASTERS),
    settings:{},
  };
}

/* 保有事実の保存形。数量が正の実数でなければ「保有なし」として捨てる */
function sanitizeHolding(value){
  if(!value||typeof value!=="object") return null;
  const quantity=Number(value.quantity);
  if(!Number.isFinite(quantity)||quantity<=0) return null;
  const costPrice=Number(value.costPrice);
  return{
    quantity,
    costPrice:Number.isFinite(costPrice)&&costPrice>0?costPrice:null,
    costLabel:value.costLabel==="参考単価"?"参考単価":"取得単価",
    acquisitionDate:String(value.acquisitionDate||"").slice(0,20),
    updatedAt:value.updatedAt||null,
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
      // 資産クラス：銘柄マスターが株も投信も持つ（将来のクラス追加も同じ型で受ける）
      assetClass:stock.assetClass==="fund"?"fund":"stock",
      isin:String(stock.isin||"").toUpperCase(),
      // quoteの価格が何単位あたりか（株=1・投信=1万口あたり円）。評価額＝数量×price÷quoteUnit
      quoteUnit:Number.isFinite(Number(stock.quoteUnit))&&Number(stock.quoteUnit)>0?Number(stock.quoteUnit):(stock.assetClass==="fund"?10000:1),
      market:String(stock.market||""),
      currency:String(stock.currency||""),
      country:String(stock.country||""),
      companyUrl:safeExternalUrl(stock.companyUrl),
      irUrl:safeExternalUrl(stock.irUrl),
      note:String(stock.note||""),
      noteUpdatedAt:stock.noteUpdatedAt||null,
      holding:sanitizeHolding(stock.holding),
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
      revokedAt:execution.revokedAt||null,
    })),
    // 保有履歴（append-only）：SBI取込みで保有事実が変わった時だけ追記。
    // 将来の資産推移・積立実績の分析は、このログ×history.json（日次価格）から再構成する
    holdingsLog:(Array.isArray(data.holdingsLog)?data.holdingsLog:[]).map(entry=>({
      id:entry.id||uid("hlog"),
      stockId:entry.stockId,
      quantity:Number(entry.quantity),
      costPrice:entry.costPrice==null?null:Number(entry.costPrice),
      costLabel:entry.costLabel==="参考単価"?"参考単価":"取得単価",
      acquisitionDate:String(entry.acquisitionDate||"").slice(0,20),
      capturedAt:entry.capturedAt,
      source:String(entry.source||"sbi"),
    })).filter(entry=>entry.stockId&&Number.isFinite(entry.quantity)&&entry.quantity>0&&entry.capturedAt),
    reviews:(Array.isArray(data.reviews)?data.reviews:[])
      .map(review=>({id:review.id||uid("review"),checkedAt:review.checkedAt}))
      .filter(review=>review.checkedAt),
    masters:{},
    settings:data.settings&&typeof data.settings==="object"?data.settings:{},
  };
  Object.keys(DEFAULT_MASTERS).forEach(kind=>{
    // 理由タグは初回、旧・補助理由マスターをIDごと引き継ぐ（旧ログもタグ検索に掛かる）
    const source=kind==="reasonTags"&&!Array.isArray(data.masters?.reasonTags)&&Array.isArray(data.masters?.subReasons)
      ?data.masters.subReasons
      :(data.masters&&Array.isArray(data.masters[kind])?data.masters[kind]:base.masters[kind]);
    result.masters[kind]=source.map((item,index)=>({
      ...item,
      id:item.id||uid(kind.slice(0,3)),
      label:String(item.label||"名称未設定"),
      active:item.active!==false,
      order:Number.isFinite(Number(item.order))?Number(item.order):(index+1)*10,
      isDefault:item.isDefault===true,
      ...(kind==="reviewPresets"?{days:Number.isFinite(Number(item.days))?Number(item.days):1}:{}),
      ...(kind==="statuses"?{color:sanitizeHexColor(item.color)||defaultStatusColor(item.id,index)}:{}),
    }));
  });
  // 廃止済みマスター（判断・理由・補助理由）は旧ログの表示互換のためデータ内に温存する
  ["actions","reasons","subReasons"].forEach(kind=>{
    if(data.masters&&Array.isArray(data.masters[kind])&&data.masters[kind].length) result.masters[kind]=data.masters[kind];
  });
  // ボード表示列が未指定の既存データは従来ルール（表示順の1〜3番目＝各列・4番目以降＝4列目）で補完
  result.masters.statuses.slice().sort((a,b)=>Number(a.order)-Number(b.order)).forEach((status,index)=>{
    const column=Number(status.boardColumn);
    status.boardColumn=Number.isInteger(column)&&column>=1&&column<=4?column:Math.min(index+1,4);
  });
  // 保有履歴が空でstocksに保有があれば初回だけ現在値から起こす（履歴の起点を作る）
  if(!result.holdingsLog.length){
    result.stocks.forEach(stock=>{
      if(!stock.holding) return;
      result.holdingsLog.push({
        id:uid("hlog"),stockId:stock.id,
        quantity:stock.holding.quantity,costPrice:stock.holding.costPrice,
        costLabel:stock.holding.costLabel,acquisitionDate:stock.holding.acquisitionDate,
        capturedAt:stock.holding.updatedAt||new Date().toISOString(),source:"sbi",
      });
    });
  }
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
let SBI_PRICE_DATA=null;
let priceLoadedAt=0;
let priceLoading=false;
let lastSbiImportId="";
let lastSbiFailId="";
let lastSbiDebugText="";

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
function stockById(id){return DB.stocks.find(stock=>stock.id===id)||null;}
function executionFor(decisionId){return DB.executions.find(execution=>execution.decisionId===decisionId)||null;}
function decisionTime(decision){return new Date(decision.decidedAt||decision.createdAt||0).getTime();}
function latestDecision(stockId){
  return DB.decisions.filter(decision=>decision.stockId===stockId&&!decision.revokedAt).sort((a,b)=>decisionTime(b)-decisionTime(a))[0]||null;
}

/* 判断の取り消し：行は消さず revokedAt を立てて時系列に残す（訂正は新しい判断として記録） */
function revokeDecision(decisionId){
  const decision=DB.decisions.find(item=>item.id===decisionId);
  if(!decision||decision.revokedAt) return;
  const stock=stockById(decision.stockId);
  if(!confirm(`${stock?.name||"この銘柄"}の記録を取り消しますか？\n行は消えず「取り消し済み」として残ります。訂正する場合は取り消した後、ボードのカードから新しく記録してください。`)) return;
  const now=new Date().toISOString();
  decision.revokedAt=now;
  DB.executions.forEach(execution=>{
    if(execution.decisionId===decisionId&&!execution.revokedAt) execution.revokedAt=now;
  });
  save();renderAll();showToast("判断を取り消しました");
}
function activeStocks(){return DB.stocks.filter(stock=>stock.active!==false).slice().sort((a,b)=>a.name.localeCompare(b.name,"ja"));}

function localDate(date=new Date()){
  const y=date.getFullYear();
  const m=String(date.getMonth()+1).padStart(2,"0");
  const d=String(date.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
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
  if(!stock) return null;
  const ticker=String(stock.ticker||"").toUpperCase();
  return SBI_PRICE_DATA?.quotes?.[ticker]||PRICE_DATA?.quotes?.[ticker]||null;
}

function quoteSource(stock){
  const ticker=String(stock?.ticker||"").toUpperCase();
  return SBI_PRICE_DATA?.quotes?.[ticker]?SBI_PRICE_DATA.source:(PRICE_DATA?.source||"参考株価");
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

function formatMoney(value,currency="USD",signed=false){
  if(value==null||value==="") return "—";
  const amount=Number(value);
  if(!Number.isFinite(amount)) return "—";
  const digits=currency==="JPY"?(amount%1===0?0:1):2;
  let formatted;
  try{
    formatted=new Intl.NumberFormat("ja-JP",{style:"currency",currency,minimumFractionDigits:digits,maximumFractionDigits:digits}).format(amount);
  }catch(error){
    formatted=amount.toLocaleString("ja-JP",{minimumFractionDigits:digits,maximumFractionDigits:digits});
  }
  return signed&&amount>0?`+${formatted}`:formatted;
}

function formatSignedPercent(value){
  if(value==null||value==="") return "—";
  const percent=Number(value);
  if(!Number.isFinite(percent)) return "—";
  return `${percent>0?"+":""}${percent.toFixed(2)}%`;
}

function formatQuantity(value){
  if(value==null||value==="") return "—";
  const quantity=Number(value);
  if(!Number.isFinite(quantity)) return "—";
  return `${quantity.toLocaleString("ja-JP",{maximumFractionDigits:6})}株`;
}

function formatSbiAcquisitionDate(value){
  const text=String(value||"").trim();
  if(!text||/^[-/]+$/.test(text)) return "—";
  return text.replace(/^0+(\d)/,"$1").replace(/\/0+(\d)/g,"/$1");
}

function sbiPositionHtml(stock){
  const ticker=String(stock?.ticker||"").toUpperCase();
  const position=SBI_PRICE_DATA?.quotes?.[ticker];
  if(!position) return "";
  const currency=position.currency||stock.currency||"USD";
  const profitLoss=Number(position.profitLoss);
  const profitLossPct=Number(position.profitLossPct);
  const dailyChangePct=Number(position.changePct);
  const costPrice=position.costPrice==null?NaN:Number(position.costPrice);
  const quantity=position.quantity==null?NaN:Number(position.quantity);
  const acquisitionAmount=costPrice*quantity;
  const direction=profitLoss>0?"up":profitLoss<0?"down":"flat";
  const dailyDirection=dailyChangePct>0?"up":dailyChangePct<0?"down":"flat";
  const costLabel=position.costLabel==="参考単価"?"参考単価":"取得単価";
  return `<span class="sbi-position" title="SBI証券のポートフォリオ画面から一時反映。再読み込みすると消えます">
    <span class="sbi-position-main">
      <span class="sbi-metric"><span class="sbi-metric-label">現在</span><strong>${esc(formatMoney(position.price,currency))}</strong></span>
      <span class="sbi-metric sbi-profit ${direction}"><span class="sbi-metric-label">損益</span><strong>${esc(formatMoney(profitLoss,currency,true))}（${esc(formatSignedPercent(profitLossPct))}）</strong></span>
    </span>
    <span class="sbi-position-details">
      <span class="sbi-metric"><span class="sbi-metric-label">前日</span><strong class="${dailyDirection}">${esc(formatSignedPercent(dailyChangePct))}</strong></span>
      <span class="sbi-metric"><span class="sbi-metric-label">${esc(costLabel)}</span><strong>${esc(formatMoney(position.costPrice,currency))}</strong></span>
      <span class="sbi-metric"><span class="sbi-metric-label">取得額</span><strong>${esc(formatMoney(Number.isFinite(acquisitionAmount)?acquisitionAmount:null,currency))}</strong></span>
      <span class="sbi-metric"><span class="sbi-metric-label">保有</span><strong>${esc(formatQuantity(position.quantity))}</strong></span>
      <span class="sbi-metric"><span class="sbi-metric-label">買付</span><strong>${esc(formatSbiAcquisitionDate(position.acquisitionDate))}</strong></span>
      <span class="sbi-metric"><span class="sbi-metric-label">評価</span><strong>${esc(formatMoney(position.marketValue,currency))}</strong></span>
    </span>
  </span>`;
}

function jpyAmount(value,currency,usdJpy){
  const amount=Number(value);
  if(!Number.isFinite(amount)) return null;
  if(currency==="JPY") return amount;
  if(currency==="USD"&&Number.isFinite(usdJpy)) return Math.round(amount*usdJpy);
  return null;
}

/* 保有×最新quoteの評価計算（全景・資産タブ共用）。
   quoteUnit＝quote価格が何単位あたりか（株=1・投信=1万口）。評価額＝数量×price÷quoteUnit */
function computeHoldingPositions(){
  const usdJpy=Number(PRICE_DATA?.usdJpy);
  const quoteSources=new Set();
  const positions=activeStocks().map(stock=>{
    const holding=stock.holding;
    if(!holding) return null;
    const unit=Number(stock.quoteUnit)>0?Number(stock.quoteUnit):1;
    const quote=quoteFor(stock);
    const price=Number(quote?.price);
    const hasQuote=Number.isFinite(price)&&price>0;
    // quoteが無い銘柄は取得単価で仮表示（損益・前日比は出さない）。それも無ければ表示不能
    const effectivePrice=hasQuote?price:holding.costPrice;
    if(!Number.isFinite(effectivePrice)||effectivePrice<=0) return null;
    if(hasQuote) quoteSources.add(SBI_PRICE_DATA?.quotes?.[String(stock.ticker||"").toUpperCase()]?"SBI一時反映":(quote.source==="投信協会"?"投信協会":"参考株価"));
    const currency=stock.currency||quote?.currency||"USD";
    const marketValue=effectivePrice*holding.quantity/unit;
    const decision=latestDecision(stock.id);
    const status=master("statuses",decision?.statusId);
    const cost=Number(holding.costPrice);
    const hasCost=Number.isFinite(cost)&&cost>0;
    const profitLoss=hasQuote&&hasCost?(price-cost)*holding.quantity/unit:null;
    const change=Number(quote?.change);
    // 円換算値は計算段階で整数に丸める（投信の口数計算＝数量×価格÷1万口で端数が出るため）
    const roundJpy=value=>value==null?null:Math.round(value);
    return{
      stock,status,currency,marketValue,hasQuote,
      valueJpy:roundJpy(jpyAmount(marketValue,currency,usdJpy)),
      profitLossJpy:profitLoss==null?null:roundJpy(jpyAmount(profitLoss,currency,usdJpy)),
      profitLossPct:profitLoss==null?null:(price-cost)/cost*100,
      dayChangeJpy:hasQuote&&Number.isFinite(change)?roundJpy(jpyAmount(change*holding.quantity/unit,currency,usdJpy)):null,
      dayChangePct:hasQuote&&quote.changePct!=null&&Number.isFinite(Number(quote.changePct))?Number(quote.changePct):null,
      holdingUpdatedAt:holding.updatedAt,
    };
  }).filter(Boolean);
  return {positions,usdJpy,quoteSources};
}

/* 「保有はいつ時点か・現在値はどこ由来か」のメタ表示（全景・資産タブ共用） */
function holdingsMetaText(positions,quoteSources,usdJpy,usTotalUsd){
  const holdingTimes=positions.map(item=>new Date(item.holdingUpdatedAt||NaN).getTime()).filter(time=>!Number.isNaN(time));
  const holdingLabel=holdingTimes.length?`保有 ${formatMarketTime(new Date(Math.max(...holdingTimes)).toISOString())}のSBI取込み時点`:"保有 SBI取込みで更新";
  const sourceLabel=quoteSources.size?`現在値 ${[...quoteSources].join("＋")}`:"現在値未取得";
  const rate=Number.isFinite(usdJpy)&&usTotalUsd>0?`・換算 ${usdJpy.toFixed(2)}円/$`:"";
  return `${holdingLabel}・${sourceLabel}${rate}`;
}

/* ポートフォリオ全景（常設・個別株のみ）。投信を含む全体は「資産」タブ。
   保存した保有事実 × 最新quote（SBI一時反映があれば優先→無ければ参考株価）で表示のたびに計算する。
   評価額・損益は計算結果であり保存しない（保存するのは保有事実だけ）。 */
function renderPortfolio(){
  const panel=$("#portfolioPanel");
  if(!panel) return;
  const statuses=ordered("statuses",true);
  const statusOrder=new Map(statuses.map((status,index)=>[status.id,index]));
  const computed=computeHoldingPositions();
  const usdJpy=computed.usdJpy;
  const quoteSources=computed.quoteSources;
  const positions=computed.positions.filter(item=>item.stock.assetClass!=="fund");
  if(!positions.length){panel.hidden=true;$("#portfolioBody").innerHTML="";return;}

  positions.sort((a,b)=>{
    const orderA=a.status?statusOrder.get(a.status.id)??99:99;
    const orderB=b.status?statusOrder.get(b.status.id)??99:99;
    if(orderA!==orderB) return orderA-orderB;
    return (b.valueJpy??0)-(a.valueJpy??0);
  });

  const converted=positions.filter(item=>item.valueJpy!=null);
  const unconverted=positions.filter(item=>item.valueJpy==null);
  const totalJpy=converted.reduce((sum,item)=>sum+item.valueJpy,0);
  const totalPlJpy=converted.every(item=>item.profitLossJpy!=null)?converted.reduce((sum,item)=>sum+item.profitLossJpy,0):null;
  const totalCostJpy=totalPlJpy==null?null:totalJpy-totalPlJpy;
  const totalPlPct=totalCostJpy>0?totalPlJpy/totalCostJpy*100:null;
  const dayItems=converted.filter(item=>item.dayChangeJpy!=null);
  const totalDayJpy=dayItems.length?dayItems.reduce((sum,item)=>sum+item.dayChangeJpy,0):null;
  const dayBaseJpy=dayItems.reduce((sum,item)=>sum+item.valueJpy,0)-(totalDayJpy||0);
  const totalDayPct=totalDayJpy!=null&&dayBaseJpy>0?totalDayJpy/dayBaseJpy*100:null;
  const jpTotal=converted.filter(item=>item.currency==="JPY").reduce((sum,item)=>sum+item.valueJpy,0);
  const usTotalUsd=positions.filter(item=>item.currency==="USD").reduce((sum,item)=>sum+item.marketValue,0);

  const plDirection=totalPlJpy>0?"up":totalPlJpy<0?"down":"flat";
  const dayDirection=totalDayJpy>0?"up":totalDayJpy<0?"down":"flat";
  const breakdown=[jpTotal>0?`日本株 ${formatMoney(jpTotal,"JPY")}`:"",usTotalUsd>0?`米国株 ${formatMoney(usTotalUsd,"USD")}`:""].filter(Boolean).join("　");

  const tiles=`<div class="portfolio-summary">
    <div class="summary-card"><span class="summary-label">評価額合計（円換算）</span><span class="summary-value">${esc(formatMoney(Math.round(totalJpy),"JPY"))}</span><span class="summary-sub">${esc(breakdown)}</span></div>
    <div class="summary-card"><span class="summary-label">評価損益</span><span class="summary-value pf-num ${plDirection}">${esc(formatMoney(totalPlJpy==null?null:Math.round(totalPlJpy),"JPY",true))}</span><span class="summary-sub">${totalPlPct!=null?`取得額比 ${esc(formatSignedPercent(totalPlPct))}`:"—"}</span></div>
    <div class="summary-card"><span class="summary-label">今日の動き</span><span class="summary-value pf-num ${dayDirection}">${esc(formatMoney(totalDayJpy==null?null:Math.round(totalDayJpy),"JPY",true))}</span><span class="summary-sub">${totalDayPct!=null?`前営業日比 ${esc(formatSignedPercent(totalDayPct))}`:"—"}</span></div>
  </div>`;

  const bar=converted.length?`<div class="portfolio-bar" role="img" aria-label="評価額の構成比">${converted.map(item=>{
    const share=totalJpy>0?item.valueJpy/totalJpy*100:0;
    const color=statusColor(item.status);
    const label=`<span class="pf-seg-label" style="color:${readableTextColor(color)}">${esc(item.stock.name)}</span>`;
    return `<span class="pf-seg" style="flex-grow:${Math.max(item.valueJpy,1)};background:${color}" title="${esc(item.stock.name)} ${share.toFixed(1)}%・${esc(formatMoney(item.valueJpy,"JPY"))}・${esc(item.status?.label||"状態未定")}">${label}</span>`;
  }).join("")}</div>`:"";

  const head=`<div class="pf-row pf-head" aria-hidden="true">
    <span></span><span>銘柄</span><span class="pf-status">状態</span><span class="pf-share">構成比</span><span class="pf-day">前日</span><span class="pf-pl">損益</span><span class="pf-value">評価額</span>
  </div>`;
  const rows=`<div class="portfolio-rows">${head}${positions.map(item=>{
    const share=item.valueJpy!=null&&totalJpy>0?`${(item.valueJpy/totalJpy*100).toFixed(1)}%`:"—";
    const dayDir=item.dayChangePct>0?"up":item.dayChangePct<0?"down":"flat";
    const plDir=item.profitLossPct>0?"up":item.profitLossPct<0?"down":"flat";
    const plAmount=item.profitLossJpy!=null?formatMoney(item.profitLossJpy,"JPY",true):"—";
    const value=item.valueJpy!=null?formatMoney(item.valueJpy,"JPY"):formatMoney(item.marketValue,item.currency);
    return `<button type="button" class="pf-row" data-stock="${esc(item.stock.id)}">
      <span class="pf-dot" style="background:${statusColor(item.status)}"></span>
      <span class="pf-name"><span class="stock-name">${esc(item.stock.name)}</span><span class="stock-symbol">${esc(item.stock.ticker)}</span></span>
      <span class="pf-status">${esc(item.status?.label||"状態未定")}</span>
      <span class="pf-share">${esc(share)}</span>
      <span class="pf-num pf-day ${dayDir}">${esc(formatSignedPercent(item.dayChangePct))}</span>
      <span class="pf-num pf-pl ${plDir}">${esc(plAmount)}<small>${esc(formatSignedPercent(item.profitLossPct))}</small></span>
      <span class="pf-value">${esc(value)}</span>
    </button>`;
  }).join("")}</div>`;

  const noQuote=positions.filter(item=>!item.hasQuote);
  const note=[
    unconverted.length?`<p class="pf-note">※ ${esc(unconverted.map(item=>item.stock.name).join("・"))} は円換算レート未取得のため合計・構成比に含めていません</p>`:"",
    noQuote.length?`<p class="pf-note">※ ${esc(noQuote.map(item=>item.stock.name).join("・"))} は現在値未取得のため取得単価で表示しています（損益・前日は非表示）</p>`:"",
  ].join("");
  $("#portfolioMeta").textContent=holdingsMetaText(positions,quoteSources,usdJpy,usTotalUsd);
  $("#portfolioBody").innerHTML=tiles+bar+rows+note;
  panel.hidden=false;
  // 帯に収まらない銘柄名は頭文字に縮め、それも無理なら消す（ツールチップで見る）。
  // 非表示・バックグラウンドタブだと幅が0に測れて全ラベルが消えるため、実測できる時だけ実行
  //（再表示時はshowViewとvisibilitychangeが描き直す。未実測の間はCSSの…省略で切れるだけ）
  const barNode=$(".portfolio-bar",panel);
  if(panel.offsetParent!==null&&barNode&&barNode.clientWidth>0){
    $$(".pf-seg",panel).forEach(seg=>{
      const label=$(".pf-seg-label",seg);
      if(!label||label.scrollWidth<=seg.clientWidth-4) return;
      label.textContent=[...label.textContent.trim()][0]||"";
      label.classList.add("pf-seg-initial");
      if(label.scrollWidth>seg.clientWidth-2) label.remove();
    });
  }
  $$(".pf-row",panel).forEach(button=>button.addEventListener("click",()=>openRecordModal(button.dataset.stock)));
}

/* 資産タブ＝投信（構造への賭け）＋個別株（反応ルール）の全保有を1画面で。
   計算は全景と同じ「保存保有×最新quote」。ここでも時価は何も保存しない */
function renderAssets(){
  const body=$("#assetsBody");
  if(!body) return;
  const {positions,usdJpy,quoteSources}=computeHoldingPositions();
  if(!positions.length){
    $("#assetsMeta").textContent="";
    body.innerHTML='<div class="empty-compact">SBIのポートフォリオ画面から取込みをすると、保有資産の全景がここに出ます（投信は銘柄マスターへの登録が必要）</div>';
    return;
  }
  const funds=positions.filter(item=>item.stock.assetClass==="fund");
  const equities=positions.filter(item=>item.stock.assetClass!=="fund");
  const converted=positions.filter(item=>item.valueJpy!=null);
  const unconverted=positions.filter(item=>item.valueJpy==null);
  const sumJpy=list=>list.filter(item=>item.valueJpy!=null).reduce((sum,item)=>sum+item.valueJpy,0);
  const totalJpy=sumJpy(positions);
  const fundJpy=sumJpy(funds);
  const equityJpy=sumJpy(equities);
  const totalPlJpy=converted.length&&converted.every(item=>item.profitLossJpy!=null)?converted.reduce((sum,item)=>sum+item.profitLossJpy,0):null;
  const totalCostJpy=totalPlJpy==null?null:totalJpy-totalPlJpy;
  const totalPlPct=totalCostJpy>0?totalPlJpy/totalCostJpy*100:null;
  const dayItems=converted.filter(item=>item.dayChangeJpy!=null);
  const totalDayJpy=dayItems.length?dayItems.reduce((sum,item)=>sum+item.dayChangeJpy,0):null;
  const dayBaseJpy=dayItems.reduce((sum,item)=>sum+item.valueJpy,0)-(totalDayJpy||0);
  const totalDayPct=totalDayJpy!=null&&dayBaseJpy>0?totalDayJpy/dayBaseJpy*100:null;
  const usTotalUsd=positions.filter(item=>item.currency==="USD").reduce((sum,item)=>sum+item.marketValue,0);
  const plDirection=totalPlJpy>0?"up":totalPlJpy<0?"down":"flat";
  const dayDirection=totalDayJpy>0?"up":totalDayJpy<0?"down":"flat";
  const breakdown=[fundJpy>0?`投信 ${formatMoney(fundJpy,"JPY")}`:"",equityJpy>0?`個別株 ${formatMoney(equityJpy,"JPY")}`:""].filter(Boolean).join("　");

  const tiles=`<div class="portfolio-summary">
    <div class="summary-card"><span class="summary-label">総資産（円換算・SBI証券分）</span><span class="summary-value">${esc(formatMoney(Math.round(totalJpy),"JPY"))}</span><span class="summary-sub">${esc(breakdown)}</span></div>
    <div class="summary-card"><span class="summary-label">評価損益</span><span class="summary-value pf-num ${plDirection}">${esc(formatMoney(totalPlJpy==null?null:Math.round(totalPlJpy),"JPY",true))}</span><span class="summary-sub">${totalPlPct!=null?`取得額比 ${esc(formatSignedPercent(totalPlPct))}`:"—"}</span></div>
    <div class="summary-card"><span class="summary-label">今日の動き</span><span class="summary-value pf-num ${dayDirection}">${esc(formatMoney(totalDayJpy==null?null:Math.round(totalDayJpy),"JPY",true))}</span><span class="summary-sub">${totalDayPct!=null?`前営業日比 ${esc(formatSignedPercent(totalDayPct))}`:"—"}</span></div>
  </div>`;

  const head=`<div class="pf-row pf-head" aria-hidden="true">
    <span></span><span>銘柄</span><span class="pf-status">区分</span><span class="pf-share">構成比</span><span class="pf-day">前日</span><span class="pf-pl">損益</span><span class="pf-value">評価額</span>
  </div>`;
  const row=item=>{
    const isFund=item.stock.assetClass==="fund";
    const share=item.valueJpy!=null&&totalJpy>0?`${(item.valueJpy/totalJpy*100).toFixed(1)}%`:"—";
    const dayDir=item.dayChangePct>0?"up":item.dayChangePct<0?"down":"flat";
    const plDir=item.profitLossPct>0?"up":item.profitLossPct<0?"down":"flat";
    const plAmount=item.profitLossJpy!=null?formatMoney(item.profitLossJpy,"JPY",true):"—";
    const value=item.valueJpy!=null?formatMoney(item.valueJpy,"JPY"):formatMoney(item.marketValue,item.currency);
    const inner=`<span class="pf-dot" style="background:${isFund?STATUS_NONE_COLOR:statusColor(item.status)}"></span>
      <span class="pf-name"><span class="stock-name">${esc(item.stock.name)}</span><span class="stock-symbol">${esc(isFund?"投信":item.stock.ticker)}</span></span>
      <span class="pf-status">${esc(isFund?"積立":(item.status?.label||"状態未定"))}</span>
      <span class="pf-share">${esc(share)}</span>
      <span class="pf-num pf-day ${dayDir}">${esc(formatSignedPercent(item.dayChangePct))}</span>
      <span class="pf-num pf-pl ${plDir}">${esc(plAmount)}<small>${esc(formatSignedPercent(item.profitLossPct))}</small></span>
      <span class="pf-value">${esc(value)}</span>`;
    // 投信は判断対象ではない＝記録モーダルへ繋がない（個別株だけタップ可）
    return isFund?`<div class="pf-row asset-row-static">${inner}</div>`
      :`<button type="button" class="pf-row" data-stock="${esc(item.stock.id)}">${inner}</button>`;
  };
  const bySize=list=>list.slice().sort((a,b)=>(b.valueJpy??0)-(a.valueJpy??0));
  const section=(title,list)=>list.length
    ?`<h3 class="asset-group-title">${esc(title)}<small>${esc(formatMoney(sumJpy(list),"JPY"))}</small></h3><div class="portfolio-rows">${head}${bySize(list).map(row).join("")}</div>`
    :"";

  const noQuote=positions.filter(item=>!item.hasQuote);
  const note=[
    unconverted.length?`<p class="pf-note">※ ${esc(unconverted.map(item=>item.stock.name).join("・"))} は円換算レート未取得のため合計・構成比に含めていません</p>`:"",
    noQuote.length?`<p class="pf-note">※ ${esc(noQuote.map(item=>item.stock.name).join("・"))} は現在値未取得のため取得単価で表示しています（損益・前日は非表示）</p>`:"",
    funds.length?'<p class="pf-note">※ 投信の基準価額は投信協会公表値（前営業日分・夕方更新）です</p>':"",
  ].join("");

  $("#assetsMeta").textContent=holdingsMetaText(positions,quoteSources,usdJpy,usTotalUsd);
  body.innerHTML=tiles+section("投資信託（積み立て）",funds)+section("個別株",equities)+note;
  $$(".pf-row[data-stock]",body).forEach(button=>button.addEventListener("click",()=>openRecordModal(button.dataset.stock)));
}

function quoteHtml(stock,className="stock-quote"){
  const quote=quoteFor(stock);
  if(!quote) return "";
  const change=Number(quote.changePct);
  const changeText=Number.isFinite(change)?`${change>0?"+":""}${change.toFixed(2)}%`:"";
  const direction=change>0?"up":change<0?"down":"flat";
  return `<span class="${className}" title="${esc(quoteSource(stock))}・前営業日比・市場時刻 ${esc(formatPriceTime(quote.marketTime||quote.fetchedAt))}"><strong>${esc(formatQuotePrice(quote))}</strong>${changeText?`<span class="price-change ${direction}">${esc(changeText)}</span>`:""}</span>`;
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

function zonedTimeParts(value,timeZone){
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone,year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
}

function zonedMarketClose(parts,timeZone,hour,minute,dayOffset=0){
  const date=new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()+dayOffset);
  const day=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"})
    .formatToParts(date)
    .reduce((result,part)=>{if(part.type!=="literal") result[part.type]=part.value;return result;},{});
  const offset=timeZone==="Asia/Tokyo"?"+09:00":(() => {
    const utcGuess=new Date(`${day.year}-${day.month}-${day.day}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00Z`);
    const local=zonedTimeParts(utcGuess,timeZone);
    const localAsUtc=Date.UTC(Number(local.year),Number(local.month)-1,Number(local.day),Number(local.hour),Number(local.minute));
    const minutesOffset=Math.round((localAsUtc-utcGuess.getTime())/60000);
    const sign=minutesOffset>=0?"+":"-";
    const absolute=Math.abs(minutesOffset);
    return `${sign}${String(Math.floor(absolute/60)).padStart(2,"0")}:${String(absolute%60).padStart(2,"0")}`;
  })();
  return new Date(`${day.year}-${day.month}-${day.day}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00${offset}`).toISOString();
}

function marketTimeForSbi(stock,capturedAt,fallback){
  const captured=new Date(capturedAt);
  if(Number.isNaN(captured.getTime())) return fallback||null;
  const timeZone=stock.country==="JP"?"Asia/Tokyo":stock.country==="US"?"America/New_York":null;
  if(!timeZone) return fallback||captured.toISOString();
  const parts=zonedTimeParts(captured,timeZone);
  const weekday=!['Sat','Sun'].includes(parts.weekday);
  const minutes=Number(parts.hour)*60+Number(parts.minute);
  if(stock.country==="JP"){
    if(weekday&&minutes>=9*60&&minutes<=15*60+30) return captured.toISOString();
    if(weekday&&minutes>15*60+30) return zonedMarketClose(parts,timeZone,15,30);
    const dayOffset=parts.weekday==="Mon"?-3:parts.weekday==="Sun"?-2:-1;
    return zonedMarketClose(parts,timeZone,15,30,dayOffset);
  }
  if(stock.country==="US"){
    if(weekday&&minutes>=9*60+30&&minutes<=16*60) return captured.toISOString();
    if(weekday&&minutes>16*60) return zonedMarketClose(parts,timeZone,16,0);
    const dayOffset=parts.weekday==="Mon"?-3:parts.weekday==="Sun"?-2:-1;
    return zonedMarketClose(parts,timeZone,16,0,dayOffset);
  }
  return fallback||captured.toISOString();
}

function isSbiOrigin(origin){
  try{
    const url=new URL(origin);
    return url.protocol==="https:"&&(url.hostname==="sbisec.co.jp"||url.hostname.endsWith(".sbisec.co.jp"));
  }catch(error){return false;}
}

/* v0.4：SBI取込みの解析はアプリ側で行う。ブックマークは表データを送るだけの送信係。
   SBIの画面構成が変わったらparseSbiTablesを直す＝ブックマーク貼り替え不要で全端末に効く。 */
function parseSbiTables(tables){
  const clean=value=>String(value||"").normalize("NFKC").replace(/\s+/g," ").trim();
  const key=value=>clean(value).replace(/\s+/g,"");
  const toNumber=value=>{
    const normalized=clean(value).replace(/[,%￥¥$円]/g,"").replace(/[−–—]/g,"-").replace(/^\+/,"");
    if(!normalized) return null;
    const result=Number(normalized);
    return Number.isFinite(result)?result:null;
  };
  const tickerOf=text=>{
    const cleaned=clean(text);
    const patterns=[
      /(?:^|\s)(\d[0-9A-Z]{3})(?:\s|$)/,
      /[（(](\d[0-9A-Z]{3})[)）]/,
      /(?:^|\s)([A-Z]{1,6}(?:[.-][A-Z0-9]+)?)(?:\s|$)/,
      /[（(]([A-Z]{1,6}(?:[.-][A-Z0-9]+)?)[)）]/,
    ];
    for(const pattern of patterns){
      const match=cleaned.match(pattern);
      if(match) return match[1].toUpperCase();
    }
    return null;
  };
  const quotes={};
  tables.forEach(rows=>{
    // 株式の表＝銘柄×現在値。投信の表＝ファンド名（または銘柄）×基準価額。どちらも受ける
    const headerIndex=rows.findIndex(cells=>{
      if(cells.length<4) return false;
      const joined=key(cells.join("|"));
      return (joined.includes("銘柄")||joined.includes("ファンド"))&&(joined.includes("現在値")||joined.includes("基準価額")||joined.includes("基準価格"));
    });
    if(headerIndex<0) return;
    const headers=rows[headerIndex].map(cell=>key(cell));
    const find=predicate=>headers.findIndex(predicate);
    const instrumentIndex=find(text=>text.includes("銘柄")||text.includes("ファンド"));
    const priceIndex=find(text=>text.includes("現在値")||text.includes("基準価額")||text.includes("基準価格"));
    // SBIパソコン版は投信も「現在値」表記＝価格の見出しでは判別できない。「ファンド名」列の有無で判別する（2026-07-21実機診断）
    const isFundTable=headers.some(text=>text.includes("ファンド名"))||(priceIndex>=0&&(headers[priceIndex].includes("基準価額")||headers[priceIndex].includes("基準価格")));
    if(instrumentIndex<0||priceIndex<0||instrumentIndex===priceIndex) return;
    const acquisitionDateIndex=find(text=>text.includes("買付日"));
    const quantityIndex=find(text=>text==="数量"||text==="保有数量"||text==="株数"||text==="保有株数"||text==="口数"||text==="保有口数");
    const costIndex=find(text=>text==="取得単価"||text==="参考単価"||text==="平均取得単価"||text==="個別元本");
    const changePctIndex=find(text=>text.includes("前日比")&&text.includes("%"));
    const changeIndex=find(text=>text.includes("前日比")&&!text.includes("%"));
    const profitLossPctIndex=find(text=>text.includes("損益")&&text.includes("%"));
    const profitLossIndex=find(text=>(text==="損益"||text.includes("評価損益"))&&!text.includes("%"));
    const marketValueIndex=find(text=>text==="評価額"||text==="時価評価額");
    rows.slice(headerIndex+1).forEach(cells=>{
      if(cells.length<=Math.max(instrumentIndex,priceIndex)) return;
      const rawName=clean(cells[instrumentIndex]);
      // 投信行にはティッカーが無い＝ファンド名で照合する（applySbiQuotes側でマスターと突き合わせ）。
      // 株式の表はティッカー必須（合計行などのゴミ行を拾わない）
      const ticker=isFundTable?null:tickerOf(rawName);
      const price=toNumber(cells[priceIndex]);
      if((isFundTable?!rawName:!ticker)||price==null||price<=0) return;
      const pick=index=>index>=0&&cells[index]!=null?toNumber(cells[index]):null;
      const entry={
        ticker,
        name:rawName,
        isFund:isFundTable,
        price,
        change:pick(changeIndex),
        changePct:pick(changePctIndex),
        acquisitionDate:acquisitionDateIndex>=0&&cells[acquisitionDateIndex]?clean(cells[acquisitionDateIndex]):"",
        quantity:pick(quantityIndex),
        costPrice:pick(costIndex),
        costLabel:costIndex>=0?headers[costIndex]:"",
        profitLoss:pick(profitLossIndex),
        profitLossPct:pick(profitLossPctIndex),
        marketValue:pick(marketValueIndex),
      };
      const mapKey=ticker||`fund:${rawName}`;
      const existing=quotes[mapKey];
      // 同じ銘柄が預り区分ごとに複数行出る（例：成長投資枠＋つみたて投資枠）→ 数量を合算・取得単価は数量加重平均
      if(existing&&Number.isFinite(existing.quantity)&&existing.quantity>0&&Number.isFinite(entry.quantity)&&entry.quantity>0){
        const totalQuantity=existing.quantity+entry.quantity;
        const sumOrNull=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?+(a+b).toFixed(2):null;
        const mergedCost=Number.isFinite(existing.costPrice)&&Number.isFinite(entry.costPrice)
          ?+((existing.costPrice*existing.quantity+entry.costPrice*entry.quantity)/totalQuantity).toFixed(2)
          :(Number.isFinite(entry.costPrice)?entry.costPrice:existing.costPrice);
        const mergedProfitLoss=sumOrNull(existing.profitLoss,entry.profitLoss);
        const mergedMarketValue=sumOrNull(existing.marketValue,entry.marketValue);
        const costBase=Number.isFinite(mergedCost)&&mergedCost>0?mergedCost*totalQuantity:null;
        quotes[mapKey]={
          ...entry,
          quantity:totalQuantity,
          costPrice:mergedCost,
          profitLoss:mergedProfitLoss,
          profitLossPct:mergedProfitLoss!=null&&costBase?+(mergedProfitLoss/(costBase/(entry.isFund?10000:1))*100).toFixed(2):null,
          marketValue:mergedMarketValue,
          acquisitionDate:existing.acquisitionDate||entry.acquisitionDate,
        };
      }else{
        quotes[mapKey]=entry;
      }
    });
  });
  return Object.values(quotes);
}

function sbiDebugText(message,parsed){
  const stockRows=parsed.filter(quote=>!quote.isFund);
  const fundRows=parsed.filter(quote=>quote.isFund);
  const lines=[
    `取込み時刻: ${new Date().toLocaleString("ja-JP")}`,
    `ページ: ${String(message.pageUrl||"不明")}`,
    `受信した表: ${message.tables.length}個`,
    `株式として読めた行: ${stockRows.length}件${stockRows.length?`（${stockRows.map(q=>q.ticker).join(", ")}）`:""}`,
    `投信として読めた行: ${fundRows.length}件${fundRows.length?`（${fundRows.map(q=>q.name).join(" / ")}）`:""}`,
  ];
  message.tables.forEach((rows,i)=>{
    rows.forEach((cells,j)=>{
      if(lines.length>=80) return;
      const text=cells.join(" | ").replace(/\s+/g," ").trim();
      if(text&&(j===0||/銘柄|現在値|前日比|評価額|取得単価|ファンド|基準価額|基準価格|口数/.test(text))) lines.push(`表${i+1}行${j+1}: ${text.slice(0,160)}`);
    });
  });
  return lines.join("\n");
}

function renderSbiDebug(text){
  const box=$("#sbiDebug");
  if(!box) return;
  $("#sbiDebugText").value=text;
  box.hidden=false;
}

/* 投信の照合：SBI画面のファンド名とマスターの名前を正規化して部分一致。
   表記ゆれ（全角半角・空白・括弧）はNFKC＋記号除去で吸収する */
function normalizeFundName(value){
  return String(value||"").normalize("NFKC").toLowerCase().replace(/[\s()（）\[\]【】・･･'’&＆-]/g,"");
}

function matchFundByName(name){
  const target=normalizeFundName(name);
  if(!target) return null;
  return DB.stocks.find(stock=>{
    if(stock.active===false||stock.assetClass!=="fund") return false;
    const registered=normalizeFundName(stock.name);
    return registered&&(target.includes(registered)||registered.includes(target));
  })||null;
}

function applySbiQuotes(list,message){
  const captured=new Date(message.capturedAt||Date.now());
  if(Number.isNaN(captured.getTime())) return null;
  const capturedAt=captured.toISOString();
  const quotes={};
  list.forEach(raw=>{
    const rawTicker=String(raw?.ticker||"").trim().toUpperCase();
    const stock=rawTicker
      ?DB.stocks.find(item=>item.active!==false&&item.ticker.toUpperCase()===rawTicker)
      :matchFundByName(raw?.name);
    const price=Number(raw?.price);
    if(!stock||!Number.isFinite(price)||price<=0) return;
    const ticker=stock.ticker.toUpperCase();
    const base=PRICE_DATA?.quotes?.[ticker]||{};
    const change=raw?.change==null?NaN:Number(raw.change);
    const changePct=raw?.changePct==null?NaN:Number(raw.changePct);
    const optionalNumber=value=>{
      if(value==null||value==="") return null;
      const number=Number(value);
      return Number.isFinite(number)?number:null;
    };
    quotes[ticker]={
      ...base,
      symbol:base.symbol||ticker,
      name:base.name||stock.name,
      currency:stock.currency||base.currency,
      quoteUnit:stock.quoteUnit||base.quoteUnit||1,
      price,
      change:Number.isFinite(change)?change:null,
      changePct:Number.isFinite(changePct)?changePct:null,
      acquisitionDate:String(raw?.acquisitionDate||"").slice(0,20),
      quantity:optionalNumber(raw?.quantity),
      costPrice:optionalNumber(raw?.costPrice),
      costLabel:raw?.costLabel==="参考単価"?"参考単価":"取得単価",
      profitLoss:optionalNumber(raw?.profitLoss),
      profitLossPct:optionalNumber(raw?.profitLossPct),
      marketValue:optionalNumber(raw?.marketValue),
      marketTime:marketTimeForSbi(stock,capturedAt,base.marketTime),
      fetchedAt:capturedAt,
      source:"SBI証券",
    };
  });
  return {quotes,capturedAt};
}

/* SBI取込み＝保有事実の更新手段。数量・取得単価・買付日だけを保存する（時価・損益は保存しない）。
   取込みに含まれない銘柄の保有は触らない（画面が国内株だけ等の部分取込みで消さないため）。
   数量か単価が変わった時はholdingsLog（append-only）にも追記＝将来の資産推移の材料 */
function saveHoldingsFromSbi(applied){
  let count=0;
  Object.entries(applied.quotes).forEach(([ticker,quote])=>{
    const holding=sanitizeHolding({
      quantity:quote.quantity,costPrice:quote.costPrice,costLabel:quote.costLabel,
      acquisitionDate:quote.acquisitionDate,updatedAt:applied.capturedAt,
    });
    if(!holding) return;
    const stock=DB.stocks.find(item=>item.active!==false&&String(item.ticker||"").toUpperCase()===ticker);
    if(!stock) return;
    const changed=!stock.holding
      ||stock.holding.quantity!==holding.quantity
      ||stock.holding.costPrice!==holding.costPrice;
    stock.holding=holding;
    stock.updatedAt=applied.capturedAt;
    if(changed){
      DB.holdingsLog.push({
        id:uid("hlog"),stockId:stock.id,
        quantity:holding.quantity,costPrice:holding.costPrice,
        costLabel:holding.costLabel,acquisitionDate:holding.acquisitionDate,
        capturedAt:applied.capturedAt,source:"sbi",
      });
    }
    count+=1;
  });
  if(count) save();
  return count;
}

function commitSbiImport(applied,message){
  const count=applied?Object.keys(applied.quotes).length:0;
  if(!count) return false;
  lastSbiImportId=String(message.id||applied.capturedAt);
  SBI_PRICE_DATA={updatedAt:applied.capturedAt,source:"SBI証券（画面から一時反映）",quotes:applied.quotes};
  const savedHoldings=saveHoldingsFromSbi(applied);
  renderBoard();
  renderAssets();
  renderStockTable();
  showToast(savedHoldings
    ?`SBIから${count}銘柄を反映し、保有情報${savedHoldings}件を保存しました`
    :`SBIから${count}銘柄を一時反映しました`);
  return true;
}

/* 旧ブックマーク（解析済みquotesを送ってくる版）との互換用 */
function receiveSbiQuotes(event){
  const message=event.data;
  if(!isSbiOrigin(event.origin)||!message||message.type!=="progress-portfolio:sbi-quotes"||!Array.isArray(message.quotes)) return;
  if(message.id&&message.id===lastSbiImportId) return;
  if(commitSbiImport(applySbiQuotes(message.quotes,message),message)) return;
  if(message.id&&message.id===lastSbiFailId) return;
  lastSbiFailId=String(message.id||"");
  showToast("SBIから一致する株式を読み取れませんでした","error");
}

function receiveSbiTables(event){
  const message=event.data;
  if(!isSbiOrigin(event.origin)||!message||message.type!=="progress-portfolio:sbi-tables"||!Array.isArray(message.tables)) return;
  if(message.id&&(message.id===lastSbiImportId||message.id===lastSbiFailId)) return;
  const tables=message.tables.filter(rows=>Array.isArray(rows)&&rows.every(cells=>Array.isArray(cells))).slice(0,150);
  const parsed=parseSbiTables(tables);
  // 成功・失敗にかかわらず直近の受信内容を保持（同期・バックアップ画面の「直近の取込みを診断表示」用）
  lastSbiDebugText=sbiDebugText({...message,tables},parsed);
  if(commitSbiImport(applySbiQuotes(parsed,message),message)){
    // 読めたのに銘柄マスター未登録で捨てた投信は、黙って落とさず一覧を出す（登録への導線）
    const unmatchedFunds=parsed.filter(raw=>raw.isFund&&!matchFundByName(raw.name));
    if(unmatchedFunds.length){
      renderSbiDebug([
        "未登録の投資信託（銘柄マスターに登録すると資産タブに入ります）：",
        ...unmatchedFunds.map(quote=>`・${quote.name}`),
        "",
        "この一覧を百に渡すと、登録に必要な協会コードとISINコードを調べて返します",
      ].join("\n"));
      showToast(`投信${unmatchedFunds.length}本が未登録のため取込みから外しました。同期・バックアップ画面に一覧があります`);
    }
    return;
  }
  lastSbiFailId=String(message.id||"");
  renderSbiDebug(lastSbiDebugText);
  showToast(parsed.length
    ?"SBIの表は読み取れましたが登録銘柄と一致しませんでした。同期・バックアップ画面に診断を出しました"
    :"SBIの表を読み取れませんでした。同期・バックアップ画面に診断を出しました","error");
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
  renderAssets();
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
    if(!isSbiOrigin(new URL(safeUrl).origin)) popup.opener=null;
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

function statusPill(id){
  const item=master("statuses",id);
  return item?`<span class="status-pill" style="background:${statusColor(id)}">${esc(item.label)}</span>`:`<span class="status-pill">未分類</span>`;
}

function currentView(){return $("nav button.active")?.dataset.view||"today";}

function showView(name){
  $$("nav button[data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===name));
  $$("main .view").forEach(view=>view.classList.toggle("active",view.id===`view-${name}`));
  // 全景は常設。非表示中に描くと帯ラベルの幅が測れないため、表示のたびに描き直す
  if(name==="observe") renderPortfolio();
  window.scrollTo({top:0,behavior:"smooth"});
}

/* 記録モーダル：カードをタップ→行き先の状態を選ぶ→一言→保存（2〜3タップ） */
let RECORD={stockId:null,statusId:null,tagId:null,reviewId:null};

function openRecordModal(stockId){
  const stock=stockById(stockId);
  if(!stock) return;
  const decision=latestDecision(stockId);
  const currentStatus=decision&&master("statuses",decision.statusId)?decision.statusId:null;
  RECORD={stockId,statusId:currentStatus,tagId:null,reviewId:null};
  $("#recordModalTitle").innerHTML=`${esc(stock.name)} <small>${esc(stock.ticker)}</small>`;
  $("#recordModalSub").textContent=decision?`前回 ${formatDate(decision.decidedAt,true)}`:"初回の記録";
  $("#recordNoteBtn").textContent=noteButtonLabel(stock);
  $("#recordMemo").value="";
  renderRecordModal();
  $("#recordModal").hidden=false;
  document.body.classList.add("modal-open");
}

function closeRecordModal(){
  $("#recordModal").hidden=true;
  document.body.classList.remove("modal-open");
}

function renderRecordModal(){
  const current=latestDecision(RECORD.stockId)?.statusId||null;
  $("#recordStatuses").innerHTML=ordered("statuses",false).map(status=>{
    const color=statusColor(status);
    const selected=status.id===RECORD.statusId;
    const style=selected?`background:${color};border-color:${color};color:${readableTextColor(color)}`:"";
    return `<button type="button" class="record-status${selected?" selected":""}" data-id="${esc(status.id)}" style="${style}">
      ${selected?"":`<span class="status-head-dot" style="background:${color}"></span>`}${esc(status.label)}${status.id===current?'<small class="record-current">いま</small>':""}
    </button>`;
  }).join("");
  $("#recordTags").innerHTML=ordered("reasonTags",false).map(tag=>`<button type="button" class="record-chip${tag.id===RECORD.tagId?" selected":""}" data-id="${esc(tag.id)}">${esc(tag.label)}</button>`).join("");
  $("#recordReviews").innerHTML=[{id:"",label:"なし"},...ordered("reviewPresets",false)].map(preset=>`<button type="button" class="record-chip${(RECORD.reviewId||"")===preset.id?" selected":""}" data-id="${esc(preset.id)}">${esc(preset.label)}</button>`).join("");
  const from=current?master("statuses",current):null;
  const to=RECORD.statusId?master("statuses",RECORD.statusId):null;
  $("#recordPreview").innerHTML=!to
    ?'<span class="record-preview-hint">行き先の状態を選んでください</span>'
    :!from
    ?`${statusPill(to.id)}<span class="transition-note">新規</span>`
    :from.id===to.id
    ?`${statusPill(to.id)}<span class="transition-note">継続</span>`
    :`${statusPill(from.id)}<span class="transition-arrow">→</span>${statusPill(to.id)}`;
  $("#recordSave").disabled=!to;
}

/* 銘柄ノート：銘柄ごとの研究文書（長文OK・上書き編集・過去版はgit履歴が保持） */
let NOTE_STOCK_ID=null;

function noteButtonLabel(stock){
  return stock?.note?"ノートを開く":"ノートを書く";
}

function openNoteModal(stockId){
  const stock=stockById(stockId);
  if(!stock) return;
  NOTE_STOCK_ID=stockId;
  $("#noteModalTitle").innerHTML=`${esc(stock.name)} <small>${esc(stock.ticker)}</small>`;
  $("#noteModalSub").textContent=stock.noteUpdatedAt?`最終更新 ${formatDate(stock.noteUpdatedAt,true)}`:"銘柄の分析・仮説を書き溜める場所。何度でも上書きできます";
  $("#noteText").value=stock.note||"";
  $("#noteModal").hidden=false;
  document.body.classList.add("modal-open");
}

function closeNoteModal(){
  $("#noteModal").hidden=true;
  NOTE_STOCK_ID=null;
  if($("#recordModal").hidden) document.body.classList.remove("modal-open");
}

function saveNote(){
  const stock=stockById(NOTE_STOCK_ID);
  if(!stock) return;
  const text=$("#noteText").value.replace(/\s+$/,"");
  const changed=text!==(stock.note||"");
  if(changed){
    stock.note=text;
    stock.noteUpdatedAt=new Date().toISOString();
    stock.updatedAt=stock.noteUpdatedAt;
    save();
  }
  closeNoteModal();
  renderAll();
  if(!$("#recordModal").hidden&&RECORD.stockId===stock.id) $("#recordNoteBtn").textContent=noteButtonLabel(stock);
  showToast(changed?`${stock.name}のノートを保存しました`:"変更はありませんでした");
}

function saveRecord(){
  const stock=stockById(RECORD.stockId);
  const status=master("statuses",RECORD.statusId);
  if(!stock||!status){showToast("行き先の状態を選んでください","error");return;}
  const previous=latestDecision(stock.id);
  const review=RECORD.reviewId?master("reviewPresets",RECORD.reviewId):null;
  const now=new Date().toISOString();
  DB.decisions.push({
    id:uid("decision"),stockId:stock.id,decidedAt:now,createdAt:now,
    statusId:status.id,
    memo:$("#recordMemo").value.trim(),
    reasonTagId:RECORD.tagId||null,
    nextReviewDate:review?addDays(review.days):null,
  });
  save();
  closeRecordModal();
  renderAll();
  const fromLabel=previous?master("statuses",previous.statusId)?.label:null;
  showToast(!fromLabel?`${stock.name}：${status.label} を記録しました`
    :fromLabel===status.label?`${stock.name}：${status.label} のまま継続を記録しました`
    :`${stock.name}：${fromLabel} → ${status.label} を記録しました`);
}

function renderBoard(){
  renderPortfolio();
  const lastReview=DB.reviews.slice().sort((a,b)=>new Date(b.checkedAt)-new Date(a.checkedAt))[0];
  $("#lastCheckLabel").textContent=lastReview?`最終確認 ${formatDate(lastReview.checkedAt,true)}`:"";
  const stocks=activeStocks();
  const jpTime=marketTimeFor(stocks,"JP");
  const usTime=marketTimeFor(stocks,"US");
  const marketTimes=[jpTime&&`日本株：${jpTime}頃`,usTime&&`米株：${usTime}頃`].filter(Boolean);
  $("#stockCount").textContent=marketTimes.join("　")||`${stocks.length}銘柄`;
  const source=SBI_PRICE_DATA?.source||PRICE_DATA?.source||"参考株価";
  $("#stockCount").title=marketTimes.length?`${source}・実際の市場時刻`:"";
  const statuses=ordered("statuses",true);
  const grouped=new Map(statuses.map(status=>[status.id,[]]));
  const unclassified=[];
  stocks.forEach(stock=>{
    const decision=latestDecision(stock.id);
    if(decision&&grouped.has(decision.statusId)) grouped.get(decision.statusId).push({stock,decision});
    else unclassified.push({stock,decision});
  });
  const statusBox=status=>{
    const list=grouped.get(status.id)||[];
    return `<div class="status-column${list.length?"":" is-empty"}">
      <div class="status-column-head"><span class="status-column-title"><span class="status-head-dot" style="background:${statusColor(status)}"></span>${esc(status.label)}${status.active?"":"（停止）"}</span><span class="status-column-count">${list.length}</span></div>
      ${list.length?list.map(({stock,decision})=>stockCard(stock,decision)).join(""):'<div class="empty-compact">該当なし</div>'}
    </div>`;
  };
  // 表示列＝状態マスターのboardColumn（1〜4）。同じ列は表示順の小さい順に縦積み（設定＝項目マスター）
  const columns=[[],[],[],[]];
  statuses.forEach(status=>{
    const column=Math.min(4,Math.max(1,Number(status.boardColumn)||4));
    columns[column-1].push(status);
  });
  let html=columns.filter(col=>col.length).map(col=>`<div class="board-col">${col.map(statusBox).join("")}</div>`).join("");
  if(unclassified.length){
    html+=`<div class="no-status-column"><strong>まだ状態を決めていない銘柄</strong><div class="no-status-list">${unclassified.map(({stock,decision})=>stockCard(stock,decision)).join("")}</div></div>`;
  }
  $("#statusBoard").innerHTML=html||'<div class="empty-compact">銘柄を追加すると、ここに表示されます</div>';
  $$(".stock-card",$("#statusBoard")).forEach(button=>button.addEventListener("click",()=>openRecordModal(button.dataset.stock)));
  // 📝はノートへの直行便（カード本体のタップ＝記録モーダルはそのまま）
  $$(".note-flag",$("#statusBoard")).forEach(flag=>flag.addEventListener("click",event=>{
    event.stopPropagation();
    openNoteModal(event.target.closest(".stock-card").dataset.stock);
  }));
}

function stockCard(stock,decision){
  const sbiPosition=sbiPositionHtml(stock);
  const memo=decision?.memo
    ||master("reasonTags",decision?.reasonTagId)?.label
    ||master("subReasons",decision?.subReasonId)?.label
    ||"まだログがありません";
  return `<button type="button" class="stock-card" data-stock="${esc(stock.id)}" title="タップして記録">
    <span class="stock-card-top"><span class="stock-identity"><span class="stock-name" title="${esc(stock.name)}">${esc(stock.name)}</span><span class="stock-symbol">${esc(stock.ticker)}</span></span><span class="stock-card-when">${decision?esc(formatDate(decision.decidedAt,true)):"未記録"}</span></span>
    <span class="stock-card-memo">${esc(memo)}</span>
    ${sbiPosition}
    <span class="stock-card-bottom">${sbiPosition?'<span class="sbi-source-label">SBI一時反映</span>':quoteHtml(stock,"stock-card-quote")}<span class="stock-card-date">${stock.note?'<span class="note-flag" role="button" title="ノートを開く">📝</span>':""}${decision?.nextReviewDate?`次回 ${formatDate(`${decision.nextReviewDate}T12:00:00`)}`:""}</span></span>
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
  const values={stock:$("#fStock").value,status:$("#fStatus").value,tag:$("#fTag").value};
  $("#fStock").innerHTML='<option value="">全銘柄</option>'+DB.stocks.slice().sort((a,b)=>a.name.localeCompare(b.name,"ja")).map(stock=>`<option value="${esc(stock.id)}">${esc(stock.name)}</option>`).join("");
  $("#fStatus").innerHTML='<option value="">全状態</option>'+ordered("statuses",true).map(item=>`<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("");
  $("#fTag").innerHTML='<option value="">全タグ</option>'+ordered("reasonTags",true).map(item=>`<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("");
  $("#fStock").value=values.stock;$("#fStatus").value=values.status;$("#fTag").value=values.tag;
}

/* 各記録の「遷移元」＝同じ銘柄の直前の有効（未取り消し）記録の状態。取り消すと後続の矢印も繋ぎ直る */
function transitionSources(){
  const byStock=new Map();
  DB.decisions.slice().sort((a,b)=>decisionTime(a)-decisionTime(b)).forEach(decision=>{
    if(!byStock.has(decision.stockId)) byStock.set(decision.stockId,[]);
    byStock.get(decision.stockId).push(decision);
  });
  const sources=new Map();
  byStock.forEach(list=>{
    let lastValid=null;
    list.forEach(decision=>{
      sources.set(decision.id,lastValid?lastValid.statusId:null);
      if(!decision.revokedAt) lastValid=decision;
    });
  });
  return sources;
}

function legacyDetailText(decision){
  const bits=[];
  if(decision.actionId) bits.push(`判断 ${master("actions",decision.actionId)?.label||"—"}`);
  if(decision.reasonId) bits.push(master("reasons",decision.reasonId)?.label||"");
  if(decision.subReasonId) bits.push(master("subReasons",decision.subReasonId)?.label||"");
  return bits.filter(Boolean).join("・");
}

function renderLog(){
  let list=DB.decisions.slice().sort((a,b)=>decisionTime(b)-decisionTime(a));
  const stockId=$("#fStock").value,statusId=$("#fStatus").value,tagId=$("#fTag").value;
  if(stockId) list=list.filter(item=>item.stockId===stockId);
  if(statusId) list=list.filter(item=>item.statusId===statusId);
  if(tagId) list=list.filter(item=>(item.reasonTagId||item.subReasonId)===tagId);
  $("#logCount").textContent=`${list.length}件`;
  if(!list.length){$("#logList").innerHTML='<div class="empty-compact">条件に合うログはありません</div>';return;}
  const sources=transitionSources();
  $("#logList").innerHTML=list.map(decision=>{
    const stock=stockById(decision.stockId);
    const execution=executionFor(decision.id);
    const side=master("actions",decision.actionId)?.executionSide;
    const from=sources.get(decision.id);
    const transition=from==null
      ?`${statusPill(decision.statusId)}<span class="transition-note">新規</span>`
      :from===decision.statusId
      ?`${statusPill(decision.statusId)}<span class="transition-note">継続</span>`
      :`${statusPill(from)}<span class="transition-arrow">→</span>${statusPill(decision.statusId)}`;
    const tagLabel=decision.reasonTagId?master("reasonTags",decision.reasonTagId)?.label:"";
    const metaBits=[
      tagLabel?`#${tagLabel}`:legacyDetailText(decision),
      decision.nextReviewDate?`次回 ${formatDate(`${decision.nextReviewDate}T12:00:00`)}`:"",
    ].filter(Boolean);
    return `<div class="log-row${decision.revokedAt?" revoked":""}">
      <div class="timeline-date">${formatDate(decision.decidedAt,true)}</div>
      <div class="stock-identity"><div class="stock-name" title="${esc(stock?.name||"不明な銘柄")}">${esc(stock?.name||"不明な銘柄")}</div><div class="stock-symbol">${esc(stock?.ticker||"")}</div></div>
      <div class="log-transition">${transition}</div>
      <div class="log-detail"><div class="log-memo">${esc(decision.memo||"—")}</div>${metaBits.length?`<div class="log-reason">${esc(metaBits.join(" ／ "))}</div>`:""}</div>
      <div class="log-execution">${execution?`<span class="side-pill ${side}">${side==="buy"?"買付":"売却"}</span> ${formatDate(execution.executedAt,true)}`:""}</div>
      <div class="log-revoke">${decision.revokedAt?`<span class="revoked-label">取り消し済み<br>${formatDate(decision.revokedAt,true)}</span>`:`<button type="button" class="btn sec sm revoke-decision" data-id="${esc(decision.id)}">取り消す</button>`}</div>
    </div>`;
  }).join("");
  $$(".revoke-decision",$("#logList")).forEach(button=>button.addEventListener("click",()=>revokeDecision(button.dataset.id)));
}

const MASTER_META={
  statuses:{title:"状態（ボードの列）",prefix:"status",extra:"color"},
  reasonTags:{title:"理由タグ",prefix:"tag"},
  reviewPresets:{title:"次回確認",prefix:"review",extra:"days"},
};

function renderMasterSections(){
  $("#masterSections").innerHTML=Object.entries(MASTER_META).map(([kind,meta])=>{
    const rows=ordered(kind,true).map(item=>masterRow(kind,item,meta)).join("");
    return `<section class="master-section" data-kind="${kind}">
      <div class="master-section-head"><h3>${meta.title}</h3><span class="muted">${DB.masters[kind].length}項目</span></div>
      ${kind==="statuses"?'<p class="master-hint">表示列＝観察ボードの何列目（1〜4）に出すか。同じ列に複数入れると縦に積まれ、列の中は「表示順」の小さい順に上から並びます。</p>':""}
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
    ${masterExtraInput(meta,item,false)}
    <button type="button" class="btn sec sm master-save save-master">保存</button>
  </div>`;
}

function masterExtraInput(meta,item,isAdd){
  const className=isAdd?"master-add-extra":"master-extra";
  if(meta.extra==="days") return `<label class="field ${className}"><span>${isAdd?"日数":""}</span><input data-extra="days" type="number" step="1" min="0" value="${item?Number(item.days):1}"></label>`;
  if(meta.extra==="color"){
    const value=item?statusColor(item):STATUS_FALLBACK_COLORS[DB.masters.statuses.length%STATUS_FALLBACK_COLORS.length];
    const column=item?Math.min(4,Math.max(1,Number(item.boardColumn)||4)):4;
    const options=[1,2,3,4].map(n=>`<option value="${n}"${n===column?" selected":""}>${n}列目</option>`).join("");
    return `<div class="${className} master-extra-status">
      <label class="field"><span>色</span><input data-extra="color" type="color" value="${esc(value)}" title="観察ボード・ポートフォリオ全景で使う色"></label>
      <label class="field"><span>表示列</span><select data-extra="column" title="観察ボードの何列目に出すか。同じ列は表示順の小さい順に上から並びます">${options}</select></label>
    </div>`;
  }
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
  if(kind==="reviewPresets") item.days=Math.max(0,Number($("[data-extra]",row).value)||0);
  if(kind==="statuses"){
    const color=$('[data-extra="color"]',row);
    const column=$('[data-extra="column"]',row);
    if(color) item.color=sanitizeHexColor(color.value)||item.color;
    if(column) item.boardColumn=Math.min(4,Math.max(1,Number(column.value)||4));
  }
  save();renderAll();showView("master");showToast(`${MASTER_META[kind].title}を保存しました`);
}

function addMasterItem(section){
  const kind=section.dataset.kind;
  const meta=MASTER_META[kind];
  const label=$(".master-add-label",section).value.trim();
  if(!label){showToast("名称を入力してください","error");return;}
  const maxOrder=Math.max(0,...DB.masters[kind].map(item=>Number(item.order)||0));
  const item={id:uid(meta.prefix),label,active:true,order:maxOrder+10,isDefault:false};
  const addArea=$(".master-add",section);
  if(kind==="reviewPresets") item.days=Math.max(0,Number($("[data-extra]",addArea).value)||0);
  if(kind==="statuses"){
    item.color=sanitizeHexColor($('[data-extra="color"]',addArea)?.value)||defaultStatusColor(item.id,DB.masters.statuses.length);
    item.boardColumn=Math.min(4,Math.max(1,Number($('[data-extra="column"]',addArea)?.value)||4));
  }
  DB.masters[kind].push(item);
  save();renderAll();showView("master");showToast(`${meta.title}を追加しました`);
}

function renderAll(){
  const view=currentView();
  renderBoard();
  renderAssets();
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

function submitStock(event){
  event.preventDefault();
  const name=$("#sName").value.trim();
  const ticker=$("#sTicker").value.trim().toUpperCase();
  const assetClass=$("#sAssetClass").value==="fund"?"fund":"stock";
  const isin=$("#sIsin").value.trim().toUpperCase();
  if(!name||!ticker){showToast("銘柄名とティッカーは必須です","error");return;}
  // 投信は基準価額の自動取得（投信協会CSV）に協会コード＋ISINの両方が必要
  if(assetClass==="fund"&&!/^JP[0-9A-Z]{10}$/.test(isin)){showToast("投資信託はISINコード（JPで始まる12桁）が必要です","error");return;}
  if(DB.stocks.some(stock=>stock.ticker.toUpperCase()===ticker&&stock.active!==false)&&!confirm(`${ticker} はすでに登録されています。追加しますか？`)) return;
  const now=new Date().toISOString();
  const companyUrl=safeExternalUrl($("#sCompanyUrl").value.trim());
  const irUrl=safeExternalUrl($("#sIrUrl").value.trim());
  if($("#sCompanyUrl").value.trim()&&!companyUrl){showToast("企業サイトのURLを確認してください","error");return;}
  if($("#sIrUrl").value.trim()&&!irUrl){showToast("IRページのURLを確認してください","error");return;}
  DB.stocks.push({
    id:uid("stock"),name,ticker,
    assetClass,isin:assetClass==="fund"?isin:"",quoteUnit:assetClass==="fund"?10000:1,
    market:$("#sMarket").value.trim(),currency:$("#sCurrency").value,
    country:$("#sCountry").value,companyUrl,irUrl,active:true,createdAt:now,updatedAt:now,
  });
  save();
  event.target.reset();$("#sCurrency").value="USD";$("#sCountry").value="";toggleFundFields();
  renderAll();showView("stocks");showToast("銘柄を追加しました");
}

/* 投信を選んだ時だけISIN欄を出す（通貨・国も日本の投信の既定に寄せる） */
function toggleFundFields(){
  const isFund=$("#sAssetClass").value==="fund";
  $$(".fund-only-field").forEach(field=>{field.hidden=!isFund;});
  $("#sTicker").placeholder=isFund?"協会コード8桁（例：03311187）":"例：AAPL";
  if(isFund){$("#sCurrency").value="JPY";$("#sCountry").value="JP";}
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
  $("#stockForm").addEventListener("submit",submitStock);
  $("#sAssetClass").addEventListener("change",toggleFundFields);
  $("#instrumentQuery").addEventListener("input",renderInstrumentResults);
  [$("#fStock"),$("#fStatus"),$("#fTag")].forEach(select=>select.addEventListener("change",renderLog));
  $("#clearFilters").addEventListener("click",()=>{$("#fStock").value="";$("#fStatus").value="";$("#fTag").value="";renderLog();});
  $("#recordModalClose").addEventListener("click",closeRecordModal);
  $("#recordModal").addEventListener("click",event=>{if(event.target===$("#recordModal")) closeRecordModal();});
  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape") return;
    if(!$("#noteModal").hidden) closeNoteModal();
    else if(!$("#recordModal").hidden) closeRecordModal();
  });
  $("#recordNoteBtn").addEventListener("click",()=>openNoteModal(RECORD.stockId));
  $("#noteModalClose").addEventListener("click",closeNoteModal);
  $("#noteModal").addEventListener("click",event=>{if(event.target===$("#noteModal")) closeNoteModal();});
  $("#noteSave").addEventListener("click",saveNote);
  $("#recordSave").addEventListener("click",saveRecord);
  $("#recordMemo").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();if(!$("#recordSave").disabled) saveRecord();}});
  $("#recordStatuses").addEventListener("click",event=>{
    const button=event.target.closest("[data-id]");
    if(!button) return;
    RECORD.statusId=button.dataset.id;
    renderRecordModal();
  });
  $("#recordTags").addEventListener("click",event=>{
    const button=event.target.closest("[data-id]");
    if(!button) return;
    RECORD.tagId=RECORD.tagId===button.dataset.id?null:button.dataset.id;
    renderRecordModal();
  });
  $("#recordReviews").addEventListener("click",event=>{
    const button=event.target.closest("[data-id]");
    if(!button) return;
    RECORD.reviewId=button.dataset.id||null;
    renderRecordModal();
  });
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
  $("#ghDisconnectBtn").addEventListener("click",()=>{if(confirm("この端末からGitHub同期を切断しますか？")){store.disconnect();PRICE_DATA=null;SBI_PRICE_DATA=null;renderBoard();renderStockTable();}});
  $("#btnFullCheck").addEventListener("click",()=>{
    DB.reviews.push({id:uid("review"),checkedAt:new Date().toISOString()});
    save();renderBoard();
    showToast("全体確認を記録しました。変わった銘柄だけ個別に判断を記録してください");
  });
  $("#btnCopyBookmarklet").addEventListener("click",async()=>{
    try{
      const response=await fetch("sbi-bookmarklet.js",{cache:"no-cache"});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const code=await response.text();
      await navigator.clipboard.writeText(`javascript:${encodeURIComponent(code)}`);
      showToast("取込みコードをコピーしました。ブックマークのURL欄に貼り付けてください");
    }catch(error){
      showToast("コピーに失敗しました。ページを再読み込みして試してください","error");
    }
  });
  $("#btnShowSbiDebug")?.addEventListener("click",()=>{
    renderSbiDebug(lastSbiDebugText||"このページを開いてからの取込みはまだありません。SBIの画面で取込みブックマークを実行してから、もう一度押してください");
  });
  $("#btnCopySbiDebug")?.addEventListener("click",async()=>{
    try{
      await navigator.clipboard.writeText($("#sbiDebugText").value);
      showToast("診断をコピーしました。百に貼り付けて渡してください");
    }catch(error){
      showToast("コピーに失敗しました。テキストを直接選択してコピーしてください","error");
    }
  });
}

store=createCloudStore({
  owner:CONFIG.github.owner,repo:CONFIG.github.repo,branch:CONFIG.github.branch,path:CONFIG.file,
  tokenKey:CONFIG.tokenKey,legacyTokenKeys:CONFIG.legacyTokenKeys,label:"Progress Portfolio",
  getData:()=>DB,adoptRemote,onState:updateSyncState,
});

$("#repoLabel").textContent=`${CONFIG.github.owner}/${CONFIG.github.repo}/${CONFIG.file}`;
window.name="progress-portfolio";
window.addEventListener("message",receiveSbiQuotes);
window.addEventListener("message",receiveSbiTables);
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
// バックグラウンドで開かれた場合、全景の帯ラベル調整は幅が測れず未実施のまま→見えた時に描き直す
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState==="visible") renderPortfolio();
});
setInterval(loadPriceData,15*60*1000);
