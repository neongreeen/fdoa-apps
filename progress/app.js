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
      // 口座区分：iDeCo（60歳拘束）は同じ投信でも別ブロック・別保有として扱う
      account:stock.account==="ideco"?"ideco":"",
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

/* 保有数の表示：株は「株」・投信は「口」（明細金額の表示は保有ボードだけ＝2026-07-22情報選別） */
function formatHoldingQuantity(value,isFund){
  const quantity=Number(value);
  if(!Number.isFinite(quantity)) return "—";
  return `${quantity.toLocaleString("ja-JP",{maximumFractionDigits:6})}${isFund?"口":"株"}`;
}

/* ブロック分類：現物株／投信（NISA・特定）／iDeCo（60歳拘束） */
function blockOf(stock){
  if(stock.account==="ideco") return "ideco";
  return stock.assetClass==="fund"?"fund":"equity";
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
      block:blockOf(stock),
      quantity:holding.quantity,
      costPrice:hasCost?cost:null,
      price:hasQuote?price:null,
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

/* 資産タブ＝「いくら持ってて儲かってるか」に答える1枚（2026-07-22設計）。
   3タイル＋構成比バー＋保有ボード10列（現物株／投信／iDeCoの3ブロック＋小計行＋総合計行）。
   明細の金額列はこのボードにしか出さない（各ボードは1つの問いにだけ答える）。
   計算は「保存した保有事実 × 最新quote」＝時価・評価額・損益は保存しない。 */
const BLOCK_META=[
  {key:"equity",label:"現物株",short:"現物株",color:null},
  {key:"fund",label:"投資信託（つみたて）",short:"投信",color:"#6e6e73"},
  {key:"ideco",label:"iDeCo",short:"iDeCo",note:"60歳まで引き出せない年金枠（SBIベネフィット・月1回取込み）",color:"#7a6a8a"},
];

function sumOrNull(list,pick){
  const values=list.map(pick);
  return values.length&&values.every(value=>value!=null)?values.reduce((sum,value)=>sum+value,0):null;
}

/* 構成比バーの銘柄名：帯に収まらなければ頭文字→それも無理なら消す（非表示中は幅が測れないので実測できる時だけ） */
function fitBarLabels(container){
  const barNode=$(".portfolio-bar",container);
  if(!barNode||container.offsetParent===null||barNode.clientWidth<=0) return;
  $$(".pf-seg",container).forEach(seg=>{
    const label=$(".pf-seg-label",seg);
    if(!label||label.scrollWidth<=seg.clientWidth-4) return;
    label.textContent=[...label.textContent.trim()][0]||"";
    label.classList.add("pf-seg-initial");
    if(label.scrollWidth>seg.clientWidth-2) label.remove();
  });
}

function renderAssets(){
  const body=$("#assetsBody");
  if(!body) return;
  const {positions,usdJpy,quoteSources}=computeHoldingPositions();
  if(!positions.length){
    $("#assetsMeta").textContent="";
    body.innerHTML='<div class="empty-compact">SBIのポートフォリオ画面から取込みをすると、保有資産の全景がここに出ます（投信は銘柄マスターへの登録が必要）</div>';
    return;
  }
  const converted=positions.filter(item=>item.valueJpy!=null);
  const unconverted=positions.filter(item=>item.valueJpy==null);
  const totalJpy=converted.reduce((sum,item)=>sum+item.valueJpy,0);
  const totalPl=sumOrNull(converted,item=>item.profitLossJpy);
  const totalCost=totalPl==null?null:totalJpy-totalPl;
  const totalPlPct=totalCost>0?totalPl/totalCost*100:null;
  const dayItems=converted.filter(item=>item.dayChangeJpy!=null);
  const totalDay=dayItems.length?dayItems.reduce((sum,item)=>sum+item.dayChangeJpy,0):null;
  const dayBase=dayItems.reduce((sum,item)=>sum+item.valueJpy,0)-(totalDay||0);
  const totalDayPct=totalDay!=null&&dayBase>0?totalDay/dayBase*100:null;
  const usTotalUsd=positions.filter(item=>item.currency==="USD").reduce((sum,item)=>sum+item.marketValue,0);
  const byBlock=key=>converted.filter(item=>item.block===key);
  const breakdown=BLOCK_META.map(meta=>{
    const sum=byBlock(meta.key).reduce((total,item)=>total+item.valueJpy,0);
    return sum>0?`${meta.short} ${formatMoney(sum,"JPY")}`:"";
  }).filter(Boolean).join("　");
  const plDirection=totalPl>0?"up":totalPl<0?"down":"flat";
  const dayDirection=totalDay>0?"up":totalDay<0?"down":"flat";

  const tiles=`<div class="portfolio-summary">
    <div class="summary-card"><span class="summary-label">総資産（円換算・iDeCo込み）</span><span class="summary-value">${esc(formatMoney(Math.round(totalJpy),"JPY"))}</span><span class="summary-sub">${esc(breakdown)}</span></div>
    <div class="summary-card"><span class="summary-label">評価損益</span><span class="summary-value pf-num ${plDirection}">${esc(formatMoney(totalPl==null?null:Math.round(totalPl),"JPY",true))}</span><span class="summary-sub">${totalPlPct!=null?`取得額比 ${esc(formatSignedPercent(totalPlPct))}`:"—"}</span></div>
    <div class="summary-card"><span class="summary-label">今日の動き</span><span class="summary-value pf-num ${dayDirection}">${esc(formatMoney(totalDay==null?null:Math.round(totalDay),"JPY",true))}</span><span class="summary-sub">${totalDayPct!=null?`前営業日比 ${esc(formatSignedPercent(totalDayPct))}`:"—"}</span></div>
  </div>`;

  // 構成比バー3本：個別株のみ／投信のみ／全体（iDeCo込み・2026-07-23ヨシアキ指示）。
  // 色＝個別株は判断状態色・投信はファンドごとの固定色・iDeCoは紫灰。%は各バーの中での構成比
  const FUND_COLORS=["#5b7ea6","#6f8f7a","#a08558","#8a7a9c","#a37070","#7d8a94"];
  const fundColor=new Map(byBlock("fund").slice().sort((a,b)=>b.valueJpy-a.valueJpy)
    .map((item,index)=>[item.stock.id,FUND_COLORS[index%FUND_COLORS.length]]));
  const colorOf=item=>item.block==="equity"?statusColor(item.status)
    :item.block==="ideco"?"#7a6a8a"
    :fundColor.get(item.stock.id)||"#6e6e73";
  const barRow=(label,items,keepOrder=false)=>{
    if(!items.length) return "";
    const barTotal=items.reduce((sum,item)=>sum+item.valueJpy,0);
    if(barTotal<=0) return "";
    const ordered=keepOrder?items:items.slice().sort((a,b)=>b.valueJpy-a.valueJpy);
    const segments=ordered.map(item=>{
      const share=(item.valueJpy/barTotal*100).toFixed(1);
      const color=colorOf(item);
      // iDeCoは同名ファンドがNISA側にもいる＝帯でもiDeCoだと分かる表記に（2026-07-23ヨシアキ指示）
      const segName=item.block==="ideco"?`iDeCo｜${item.stock.name}`:item.stock.name;
      return `<span class="pf-seg" style="flex-grow:${Math.max(item.valueJpy,1)};background:${color}" title="${esc(segName)} ${share}%・${esc(formatMoney(item.valueJpy,"JPY"))}"><span class="pf-seg-label" style="color:${readableTextColor(color)}">${esc(segName)}</span></span>`;
    }).join("");
    return `<div class="pf-bar-row"><span class="pf-bar-label">${esc(label)}</span><div class="portfolio-bar" role="img" aria-label="${esc(label)}の構成比">${segments}</div></div>`;
  };
  // 全体バーはブロック順（現物→投信→iDeCo・各ブロック内は大きい順）＝保有ボードと同じ並び
  const allItems=BLOCK_META.flatMap(meta=>byBlock(meta.key).slice().sort((a,b)=>b.valueJpy-a.valueJpy));
  const bar=`<div class="pf-bars">${barRow("個別株",byBlock("equity"))+barRow("投信",byBlock("fund"))+barRow("全体",allItems,true)}</div>`;

  // 保有ボード（10列＝銘柄/保有数/取得単価/現在単価/前日比/前日比%/損益/損益%/評価額/構成比%）
  const head=`<div class="hb-row hb-head" aria-hidden="true">
    <span>銘柄</span><span>保有数</span><span>取得単価</span><span>現在単価</span><span>前日比</span><span>前日比%</span><span>損益</span><span>損益%</span><span>評価額</span><span>構成比</span>
  </div>`;
  const dir=value=>value>0?"up":value<0?"down":"flat";
  const rowHtml=(item,blockJpy)=>{
    const isFund=item.stock.assetClass==="fund";
    // 構成比は2段階：各行はブロック内%（小計行に全体比%が出る）
    const share=item.valueJpy!=null&&blockJpy>0?`${(item.valueJpy/blockJpy*100).toFixed(1)}%`:"—";
    const cells=`<span class="hb-name"><span class="stock-name">${esc(item.stock.name)}</span><span class="stock-symbol">${esc(item.block==="ideco"?"iDeCo":(isFund?"投信":item.stock.ticker))}</span></span>
      <span class="hb-num">${esc(formatHoldingQuantity(item.quantity,isFund))}</span>
      <span class="hb-num">${esc(item.costPrice!=null?formatMoney(item.costPrice,item.currency):"—")}</span>
      <span class="hb-num">${esc(item.price!=null?formatMoney(item.price,item.currency):"—")}</span>
      <span class="hb-num ${dir(item.dayChangeJpy)}">${esc(item.dayChangeJpy!=null?formatMoney(item.dayChangeJpy,"JPY",true):"—")}</span>
      <span class="hb-num ${dir(item.dayChangePct)}">${esc(formatSignedPercent(item.dayChangePct))}</span>
      <span class="hb-num ${dir(item.profitLossJpy)}">${esc(item.profitLossJpy!=null?formatMoney(item.profitLossJpy,"JPY",true):"—")}</span>
      <span class="hb-num ${dir(item.profitLossPct)}">${esc(formatSignedPercent(item.profitLossPct))}</span>
      <span class="hb-num hb-value">${esc(item.valueJpy!=null?formatMoney(item.valueJpy,"JPY"):formatMoney(item.marketValue,item.currency))}</span>
      <span class="hb-num hb-share">${esc(share)}</span>`;
    // 現物株は判断対象＝タップで記録モーダル。投信・iDeCoは静的行
    return item.block==="equity"
      ?`<button type="button" class="hb-row" data-stock="${esc(item.stock.id)}" title="タップして判断を記録">${cells}</button>`
      :`<div class="hb-row hb-static">${cells}</div>`;
  };
  const summaryRow=(label,list,shareText,extraClass)=>{
    const conv=list.filter(item=>item.valueJpy!=null);
    const value=conv.reduce((sum,item)=>sum+item.valueJpy,0);
    const dayList=conv.filter(item=>item.dayChangeJpy!=null);
    const day=dayList.length?dayList.reduce((sum,item)=>sum+item.dayChangeJpy,0):null;
    const dayBaseSum=dayList.reduce((sum,item)=>sum+item.valueJpy,0)-(day||0);
    const dayPct=day!=null&&dayBaseSum>0?day/dayBaseSum*100:null;
    const pl=sumOrNull(conv,item=>item.profitLossJpy);
    const cost=pl==null?null:value-pl;
    const plPct=cost>0?pl/cost*100:null;
    return `<div class="hb-row hb-sum ${extraClass||""}">
      <span class="hb-name">${esc(label)}</span>
      <span class="hb-num"></span><span class="hb-num"></span><span class="hb-num"></span>
      <span class="hb-num ${dir(day)}">${esc(day!=null?formatMoney(day,"JPY",true):"—")}</span>
      <span class="hb-num ${dir(dayPct)}">${esc(formatSignedPercent(dayPct))}</span>
      <span class="hb-num ${dir(pl)}">${esc(pl!=null?formatMoney(pl,"JPY",true):"—")}</span>
      <span class="hb-num ${dir(plPct)}">${esc(formatSignedPercent(plPct))}</span>
      <span class="hb-num hb-value">${esc(formatMoney(Math.round(value),"JPY"))}</span>
      <span class="hb-num hb-share">${esc(shareText)}</span>
    </div>`;
  };
  const blocks=BLOCK_META.map(meta=>{
    const list=positions.filter(item=>item.block===meta.key);
    if(!list.length) return "";
    const blockJpy=list.filter(item=>item.valueJpy!=null).reduce((sum,item)=>sum+item.valueJpy,0);
    // 小計行の構成比＝ブロックの全体比%（2段階構成比の上段）
    const blockShare=totalJpy>0?`全体の${(blockJpy/totalJpy*100).toFixed(1)}%`:"—";
    const rows=list.slice().sort((a,b)=>(b.valueJpy??0)-(a.valueJpy??0)).map(item=>rowHtml(item,blockJpy)).join("");
    return `<div class="hb-block-title">${esc(meta.label)}${meta.note?`<small>${esc(meta.note)}</small>`:""}</div>${rows}${summaryRow(`${meta.short}小計`,list,blockShare)}`;
  }).join("");
  const board=`<div class="hb-scroll"><div class="holding-board">${head}${blocks}${summaryRow("総合計",positions,"100%","hb-grand")}</div></div>`;

  const noQuote=positions.filter(item=>!item.hasQuote);
  const note=[
    unconverted.length?`<p class="pf-note">※ ${esc(unconverted.map(item=>item.stock.name).join("・"))} は円換算レート未取得のため合計・構成比に含めていません</p>`:"",
    noQuote.length?`<p class="pf-note">※ ${esc(noQuote.map(item=>item.stock.name).join("・"))} は現在値未取得のため取得単価で表示しています（損益・前日は非表示）</p>`:"",
    positions.some(item=>item.stock.assetClass==="fund")?'<p class="pf-note">※ 投信の基準価額は投信協会公表値（前営業日分・夕方更新）。iDeCoの取得単価は購入金額÷口数から算出</p>':"",
  ].join("");

  $("#assetsMeta").textContent=holdingsMetaText(positions,quoteSources,usdJpy,usTotalUsd);
  body.innerHTML=tiles+bar+board+note;
  $$(".hb-row[data-stock]",body).forEach(button=>button.addEventListener("click",()=>openRecordModal(button.dataset.stock)));
  fitBarLabels($("#view-assets"));
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

/* 取込みを受け付けるサイト：SBI証券＋iDeCo（SBIベネフィットシステムズ系）。
   未許可サイトから来た時は診断に送信元が残る＝そのドメインをここへ足せば対応完了 */
const IMPORT_HOSTS=[/(^|\.)sbisec\.co\.jp$/,/(^|\.)benefit401k\.jp$/,/(^|\.)sbibenefit\.co\.jp$/];
function allowedImportOrigin(origin){
  try{
    const url=new URL(origin);
    return url.protocol==="https:"&&IMPORT_HOSTS.some(pattern=>pattern.test(url.hostname));
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
      return (joined.includes("銘柄")||joined.includes("ファンド")||joined.includes("商品"))&&(joined.includes("現在値")||joined.includes("基準価額")||joined.includes("基準価格")||joined.includes("時価単価"));
    });
    if(headerIndex<0) return;
    const headers=rows[headerIndex].map(cell=>key(cell));
    const find=predicate=>headers.findIndex(predicate);
    const instrumentIndex=find(text=>text.includes("銘柄")||text.includes("ファンド")||text.includes("商品"));
    const priceIndex=find(text=>text.includes("現在値")||text.includes("基準価額")||text.includes("基準価格")||text.includes("時価単価"));
    // iDeCo（SBIベネフィットの資産状況）＝「時価単価」「残高数量」「購入金額」の語彙で判別（2026-07-21スクショより・実機未検証）
    const isIdecoTable=headers.some(text=>text.includes("時価単価"))||headers.some(text=>text==="購入金額"||text==="取得金額");
    // SBIパソコン版は投信も「現在値」表記＝価格の見出しでは判別できない。「ファンド名」列の有無で判別する（2026-07-21実機診断）
    const isFundTable=isIdecoTable||headers.some(text=>text.includes("ファンド名"))||(priceIndex>=0&&(headers[priceIndex].includes("基準価額")||headers[priceIndex].includes("基準価格")));
    if(instrumentIndex<0||priceIndex<0||instrumentIndex===priceIndex) return;
    const acquisitionDateIndex=find(text=>text.includes("買付日"));
    const quantityIndex=find(text=>text==="数量"||text==="保有数量"||text==="株数"||text==="保有株数"||text==="口数"||text==="保有口数"||text.includes("残高数量"));
    const costIndex=find(text=>text==="取得単価"||text==="参考単価"||text==="平均取得単価"||text==="個別元本");
    const costTotalIndex=find(text=>text==="購入金額"||text==="取得金額");
    const changePctIndex=find(text=>text.includes("前日比")&&text.includes("%"));
    const changeIndex=find(text=>text.includes("前日比")&&!text.includes("%"));
    const profitLossPctIndex=find(text=>text.includes("損益")&&(text.includes("%")||text.includes("率")));
    const profitLossIndex=find(text=>(text==="損益"||text.includes("評価損益"))&&!text.includes("%")&&!text.includes("率"));
    const marketValueIndex=find(text=>text==="評価額"||text==="時価評価額"||text==="資産残高");
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
        isIdeco:isIdecoTable,
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
      // iDeCoは取得単価の列がない＝購入金額（累計）÷口数×1万口で1万口あたり単価に換算
      if(isIdecoTable&&entry.costPrice==null){
        const costTotal=pick(costTotalIndex);
        if(costTotal!=null&&Number.isFinite(entry.quantity)&&entry.quantity>0){
          entry.costPrice=+(costTotal/entry.quantity*10000).toFixed(2);
          entry.costLabel="取得単価";
        }
      }
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

function matchFundByName(name,ideco=false){
  const target=normalizeFundName(name);
  if(!target) return null;
  return DB.stocks.find(stock=>{
    if(stock.active===false||stock.assetClass!=="fund") return false;
    // 同じファンドでもiDeCoは別保有＝口座区分が一致する登録だけに当てる
    if((stock.account==="ideco")!==ideco) return false;
    const registered=normalizeFundName(stock.name);
    return registered&&(target.includes(registered)||registered.includes(target));
  })||null;
}

function applySbiQuotes(list,message){
  const captured=new Date(message.capturedAt||Date.now());
  if(Number.isNaN(captured.getTime())) return null;
  const capturedAt=captured.toISOString();
  const quotes={};
  const holdings=[];
  list.forEach(raw=>{
    const rawTicker=String(raw?.ticker||"").trim().toUpperCase();
    const stock=raw?.isIdeco
      ?matchFundByName(raw?.name,true)
      :rawTicker
        ?DB.stocks.find(item=>item.active!==false&&item.account!=="ideco"&&item.ticker.toUpperCase()===rawTicker)
        :matchFundByName(raw?.name,false);
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
    holdings.push({
      stockId:stock.id,
      quantity:optionalNumber(raw?.quantity),
      costPrice:optionalNumber(raw?.costPrice),
      costLabel:raw?.costLabel==="参考単価"?"参考単価":"取得単価",
      acquisitionDate:String(raw?.acquisitionDate||"").slice(0,20),
    });
  });
  return {quotes,holdings,capturedAt};
}

/* SBI取込み＝保有事実の更新手段。数量・取得単価・買付日だけを保存する（時価・損益は保存しない）。
   取込みに含まれない銘柄の保有は触らない（画面が国内株だけ等の部分取込みで消さないため）。
   数量か単価が変わった時はholdingsLog（append-only）にも追記＝将来の資産推移の材料 */
function saveHoldingsFromSbi(applied){
  let count=0;
  (applied.holdings||[]).forEach(entry=>{
    const holding=sanitizeHolding({
      quantity:entry.quantity,costPrice:entry.costPrice,costLabel:entry.costLabel,
      acquisitionDate:entry.acquisitionDate,updatedAt:applied.capturedAt,
    });
    if(!holding) return;
    const stock=stockById(entry.stockId);
    if(!stock||stock.active===false) return;
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
  if(!allowedImportOrigin(event.origin)||!message||message.type!=="progress-portfolio:sbi-quotes"||!Array.isArray(message.quotes)) return;
  if(message.id&&message.id===lastSbiImportId) return;
  if(commitSbiImport(applySbiQuotes(message.quotes,message),message)) return;
  if(message.id&&message.id===lastSbiFailId) return;
  lastSbiFailId=String(message.id||"");
  showToast("SBIから一致する株式を読み取れませんでした","error");
}

function receiveSbiTables(event){
  const message=event.data;
  if(!message||message.type!=="progress-portfolio:sbi-tables"||!Array.isArray(message.tables)) return;
  if(!allowedImportOrigin(event.origin)){
    // 新サイト（iDeCo等）対応：送信元ドメインを診断に残す。データは適用しない
    lastSbiDebugText=`未許可のサイトからの取込みを受信しました（適用していません）\n送信元: ${event.origin}\nページ: ${String(message.pageUrl||"不明")}\nこの診断を百に渡すと、対応サイトに追加できます`;
    renderSbiDebug(lastSbiDebugText);
    showToast("対応外のサイトからの取込みでした。同期・バックアップ画面に診断を出しました","error");
    return;
  }
  if(message.id&&(message.id===lastSbiImportId||message.id===lastSbiFailId)) return;
  const tables=message.tables.filter(rows=>Array.isArray(rows)&&rows.every(cells=>Array.isArray(cells))).slice(0,150);
  const parsed=parseSbiTables(tables);
  // 成功・失敗にかかわらず直近の受信内容を保持（同期・バックアップ画面の「直近の取込みを診断表示」用）
  lastSbiDebugText=sbiDebugText({...message,tables},parsed);
  if(commitSbiImport(applySbiQuotes(parsed,message),message)){
    // 読めたのに銘柄マスター未登録で捨てた投信は、黙って落とさず一覧を出す（登録への導線）
    const unmatchedFunds=parsed.filter(raw=>raw.isFund&&!matchFundByName(raw.name,!!raw.isIdeco));
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
  // 表示時間は文章の長さに比例（短文2.2秒〜長文8秒）。読み切る前に消えない
  const duration=Math.min(8000,Math.max(2200,String(message).length*130));
  toastTimer=setTimeout(()=>{node.className="toast";},duration);
}

function statusPill(id){
  const item=master("statuses",id);
  return item?`<span class="status-pill" style="background:${statusColor(id)}">${esc(item.label)}</span>`:`<span class="status-pill">未分類</span>`;
}

function currentView(){return $("nav button.active")?.dataset.view||"today";}

function showView(name){
  $$("nav button[data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===name));
  $$("main .view").forEach(view=>view.classList.toggle("active",view.id===`view-${name}`));
  // 最後に見ていたタブを記憶（再読み込みで観察・判断に戻らないように。端末ごとのUI設定＝同期しない）
  try{localStorage.setItem("pp_last_view",name);}catch(error){}
  // 構成比バーは非表示中に描くと帯ラベルの幅が測れないため、資産タブを見るたびに描き直す
  if(name==="assets") renderAssets();
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

/* ===== EXC統合（2026-07-22設計・observeタブ2段積みの上段＋カード補強＋ログ統合の材料） =====
   正本＝fdoa-app-data/extra-charge.md・stock-rules.md（18:30の自動監視が更新）。
   ここは読むだけ。パーサーは旧extraページから移植（書式が育っても拾える範囲だけ拾う）。 */

function mdInline(text){
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
    .replace(/`([^`]+)`/g,"<code>$1</code>");
}

/* 最小Markdownレンダラ（見出し・表・箇条書き・区切り線・段落・太字・code）＝規定全文の折りたたみ表示用 */
function mdToHtml(md){
  const lines=String(md||"").split("\n");let html="",i=0;
  while(i<lines.length){
    const ln=lines[i];
    if(/^\s*$/.test(ln)){i++;continue;}
    if(/^---+\s*$/.test(ln)){html+="<hr>";i++;continue;}
    let m;
    if((m=ln.match(/^(#{1,4})\s+(.*)$/))){html+=`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`;i++;continue;}
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

// 文書を3分割：規定本文／現在の状態／履歴（発砲履歴・売買履歴）
function splitDoc(md){
  const si=md.search(/^## 現在の状態.*$/m);
  if(si<0)return{rule:md.replace(/^# .*$/m,"").trim(),status:"",history:""};
  const rule=md.slice(0,si).replace(/---+\s*$/,"").replace(/^# .*$/m,"").trim();
  const rest=md.slice(si).replace(/^## 現在の状態.*$/m,"");
  const hi=rest.search(/^## .*$/m);
  let status=rest,history="";
  if(hi>=0){status=rest.slice(0,hi);history=rest.slice(hi).trim();}
  status=status.replace(/---+\s*\n*$/,"").trim();
  return{rule,status,history};
}

// 状態セクションを「### 見出し」ごとに分ける
function docSections(status){
  const marks=[];const re=/^###\s+(.+)$/gm;let m;
  while((m=re.exec(status)))marks.push({head:m[1].trim(),idx:m.index,end:re.lastIndex});
  return marks.map((mk,i)=>({head:mk.head,body:status.slice(mk.end,i+1<marks.length?marks[i+1].idx:undefined).trim()}));
}

const PHASE_EMOJI={"🔴":"danger","🟡":"warn","🟢":"ok"};

// 1サブセクション→タイルのデータ。書式が育っても拾える範囲だけ拾う（欠けは無視）
function parseTile(sec){
  const ci=sec.head.indexOf("：");
  const name=(ci>=0?sec.head.slice(0,ci):sec.head).replace(/\*/g,"").trim();
  let phaseRaw=ci>=0?sec.head.slice(ci+1).trim():"";
  const emoji=Object.keys(PHASE_EMOJI).find(e=>phaseRaw.includes(e))||"";
  const phase=phaseRaw.replace(emoji,"").replace(/（[^）]*）/g,"").trim();
  const b=sec.body;
  const t={name,emoji,phase,phaseClass:emoji?PHASE_EMOJI[emoji]:"",body:b,big:"",bigLabel:"",rows:[]};
  let m;
  // 物差し1：高値からの下落率（指数＝半年高値／個別株＝90日高値）
  if((m=b.match(/(半年高値|90日高値)[^%\n]*?比[：:]?\s*\*{0,2}(-?\d+(?:\.\d+)?)\s*\*{0,2}\s*%/))){
    t.big=m[2]+"%";t.bigLabel=m[1]+"比";t.dd=parseFloat(m[2]);
  }
  // 物差し1の別書式：「**-3.5%**（…半年高値比…）」＝数字が先に来るパターン（2026-07-22のTOPIX行）
  if(!t.big&&(m=b.match(/(-?\d+(?:\.\d+)?)\s*%\*{0,2}\s*（[^）]*?(半年高値|90日高値)比/))){
    t.big=m[1]+"%";t.bigLabel=m[2]+"比";t.dd=parseFloat(m[1]);
  }
  // 物差し2：SPCXの底カウント
  if(!t.big&&(m=b.match(/カウント[：:]\s*\*{0,2}(\d+)\s*営業日\*{0,2}\s*／\s*(\d+)\s*営業日/))){
    t.big=m[1]+"/"+m[2];t.bigLabel="底カウント（営業日）";
  }
  // 封筒（発射済みの弾は🎯付き・取り消し線）
  if((m=b.match(/①\s*([\d,]+)[^②]*②\s*([\d,]+)[^③]*③\s*([\d,]+)[^④]*④\s*([\d,]+)/))){
    const fired={};let f;const fre=/第([1-4])弾[：:][^\n]*発射済み/g;
    while((f=fre.exec(b)))fired[f[1]]=true;
    t.env=[m[1],m[2],m[3],m[4]].map((amt,i)=>({amt,fired:!!fired[i+1]}));
  }else if(/封筒未作成/.test(b))t.envNote="封筒未作成";
  // 次のライン（DDが取れていれば残り距離ptを添える）
  if((m=b.match(/次のライン[：:]\s*(.+)/))){
    let line=m[1].replace(/\*/g,"").trim();
    const lm=line.match(/(-\d+(?:\.\d+)?)\s*%/);
    if(lm&&typeof t.dd==="number"){
      const dist=t.dd-parseFloat(lm[1]);
      if(dist>0)line="あと"+dist.toFixed(1)+"pt｜"+line;
    }
    t.next=line;
  }
  // 通知ライン（個別株・円ドル両対応）
  if((m=b.match(/通知ライン\s*\*{0,2}(\$?[\d,.]+)\s*(円)?\*{0,2}\s*(（-?\d+%）)?/))){
    let line=m[1]+(m[2]||"")+(m[3]||"");
    const lm=(m[3]||"").match(/(-\d+(?:\.\d+)?)%/);
    if(lm&&typeof t.dd==="number"){
      const dist=t.dd-parseFloat(lm[1]);
      if(dist>0)line="あと"+dist.toFixed(1)+"pt｜"+line;
    }
    t.notify=line;
  }
  if((m=b.match(/DDが\s*(-?\d+(?:\.\d+)?%)\s*以内へ回復/)))t.recover=m[1]+"回復で局面解除";
  // 下落理由メモ（4色＝重さ分類）
  if((m=b.match(/理由[：:]\s*(🔴|🟡|🟢|🔵)\s*(.+)/)))
    t.reason={sev:{"🔴":"red","🟡":"yellow","🟢":"green","🔵":"blue"}[m[1]],text:m[2].replace(/\*/g,"").trim()};
  // 連れ安／単独安の機械判定（18:30タスクが自動記入）
  if((m=b.match(/判定[：:]\s*(単独安|連れ安)\s*（?([^）\n]*)）?/)))
    t.verdict={kind:m[1],detail:m[2].trim()};
  return t;
}

function parseAmmo(sec){
  const t={body:sec.body};let m;
  if((m=sec.body.match(/円弾[：:][^\n]*＝\s*\*{0,2}([\d,]+)\s*円/)))t.yen=m[1]+"円";
  if((m=sec.body.match(/ドル弾[^：:\n]*[：:][^\n]*?(US\$[^（\n]+)/)))t.usd=m[1].trim();
  return t;
}

// 状態セクション冒頭の「最終チェック」行
function parseStamp(status){
  const head=status.split(/^###/m)[0];
  const m=head.match(/最終チェック[：:]\s*([^\n]+)/);
  return m?m[1].trim():"";
}

// 表示順＝下落率の深い順（深く下げているものほど上）
function sortTiles(tiles){
  return tiles.slice().sort((a,b)=>
    (typeof a.dd==="number"?a.dd:-Infinity)-(typeof b.dd==="number"?b.dd:-Infinity));
}

// 履歴md（発砲履歴・売買履歴）の表→行データ。1行目＝ヘッダーは捨てる
function parseHistoryTable(md){
  const rows=[];
  String(md||"").split("\n").forEach(line=>{
    if(!/^\|/.test(line)||/^\|[\s:|-]+\|?$/.test(line)) return;
    rows.push(line.replace(/^\||\|$/g,"").split("|").map(cell=>cell.replace(/\*/g,"").trim()));
  });
  return rows.slice(1).filter(cells=>/^\d{4}-\d{2}-\d{2}/.test(cells[0]||""));
}

let EXTRA_STATE=null;
let extraLoadedAt=0;
let extraLoading=false;
const extraReader=createCloudReader({
  owner:CONFIG.github.owner,repo:CONFIG.github.repo,branch:CONFIG.github.branch,
  tokenKey:CONFIG.tokenKey,legacyTokenKeys:CONFIG.legacyTokenKeys,
});

function parseExtraDocs(ec,sp){
  const state={idxTiles:[],stkTiles:[],ammo:null,stamps:[],excLog:[],tradeLog:[],ruleHtml:"",stockRuleHtml:""};
  if(ec){
    const doc=splitDoc(ec);
    state.ruleHtml=mdToHtml(doc.rule);
    state.excLog=parseHistoryTable(doc.history).map(cells=>({
      date:cells[0]||"",event:cells[1]||"",index:cells[2]||"",amount:cells[3]||"",
      target:cells[4]||"",dd:cells[5]||"",note:cells[6]||"",
    }));
    try{
      const secs=docSections(doc.status);
      const ammoSec=secs.find(sec=>/弾薬庫/.test(sec.head));
      state.idxTiles=secs.filter(sec=>sec!==ammoSec).map(parseTile);
      if(ammoSec) state.ammo=parseAmmo(ammoSec);
      const stamp=parseStamp(doc.status);
      if(stamp) state.stamps.push(`指数：${stamp}`);
    }catch(error){console.warn("EXC状態のタイル化に失敗",error);}
  }
  if(sp){
    const doc=splitDoc(sp);
    state.stockRuleHtml=mdToHtml(doc.rule);
    state.tradeLog=parseHistoryTable(doc.history).map(cells=>({
      date:cells[0]||"",name:cells[1]||"",event:cells[2]||"",quantity:cells[3]||"",
      price:cells[4]||"",pl:cells[5]||"",memo:cells[6]||"",
    }));
    try{
      state.stkTiles=docSections(doc.status).map(parseTile);
      const stamp=parseStamp(doc.status);
      if(stamp) state.stamps.push(`個別株：${stamp}`);
    }catch(error){console.warn("銘柄別ルール状態のタイル化に失敗",error);}
  }
  return state;
}

async function loadExtraDocs(){
  if(extraLoading||!extraReader.hasToken()) return;
  extraLoading=true;
  try{
    const [ec,sp]=await Promise.all([
      extraReader.fetchText("extra-charge.md"),
      extraReader.fetchText("stock-rules.md"),
    ]);
    EXTRA_STATE=parseExtraDocs(ec,sp);
  }catch(error){
    console.warn("EXC文書の読み込みに失敗",error);
  }
  extraLoadedAt=Date.now();
  extraLoading=false;
  renderExc();
  renderBoard();
  renderLog();
}

// 観察ボードのカード用：この銘柄に対応する個別株タイル（DD%・理由色・判定バッジの供給元）
function tileForStock(stock){
  if(!EXTRA_STATE||!EXTRA_STATE.stkTiles.length) return null;
  const name=String(stock.name||"");
  const ticker=String(stock.ticker||"").toUpperCase();
  return EXTRA_STATE.stkTiles.find(tile=>tile.name.toUpperCase()===ticker||name.includes(tile.name)||tile.name.includes(name))||null;
}

/* 観察タブ上段＝機械（EXC）：指数DD・封筒残弾・次ライン距離。金額の明細は出さない（保有ボードの仕事） */
function renderExc(){
  const panel=$("#excPanel");
  if(!panel) return;
  if(!EXTRA_STATE||!EXTRA_STATE.idxTiles.length){
    panel.hidden=true;
    $("#excBody").innerHTML="";
    return;
  }
  const LIVE_KEY={"TOPIX":"TOPIX","S&P500":"GSPC"};
  const tiles=sortTiles(EXTRA_STATE.idxTiles).map(t=>{
    const rows=[];
    if(t.env)rows.push('<span class="lbl">封筒</span>'+t.env.map((e,i)=>`<span class="${e.fired?"env-fired":""}">${["①","②","③","④"][i]}${esc(e.amt)}${e.fired?"🎯":""}</span>`).join(" "));
    if(t.envNote)rows.push('<span class="lbl">封筒</span>'+esc(t.envNote));
    if(t.next)rows.push('<span class="lbl">次</span>'+esc(t.next));
    const live=PRICE_DATA?.quotes?.[LIVE_KEY[t.name]];
    if(live&&Number.isFinite(Number(live.changePct))){
      const pct=(live.changePct>0?"+":"")+live.changePct+"%";
      rows.push('<span class="lbl">今日</span>'+esc(pct)+`<small>（${esc(formatPriceTime(live.marketTime||live.fetchedAt))}）</small>`);
    }
    return `<div class="exc-tile phase-${t.phaseClass||"none"}">
      <div class="exc-tile-top"><span class="exc-tile-name">${esc(t.name)}</span>${t.emoji||t.phase?`<span class="exc-pill">${esc((t.emoji?t.emoji+" ":"")+t.phase)}</span>`:""}</div>
      ${t.big?`<div class="exc-big">${esc(t.big)}</div><div class="exc-sub">${esc(t.bigLabel)}</div>`:""}
      <div class="exc-rows">${rows.map(row=>`<div class="exc-row">${row}</div>`).join("")}</div>
    </div>`;
  }).join("");
  const ammo=EXTRA_STATE.ammo
    ?`<div class="exc-ammo">🧨 弾薬庫：円弾 <strong>${esc(EXTRA_STATE.ammo.yen||"—")}</strong>・ドル弾 <strong>${esc(EXTRA_STATE.ammo.usd||"—")}</strong></div>`
    :"";
  const folds=[
    EXTRA_STATE.ruleHtml?`<details class="exc-fold"><summary>発動規定（全文）</summary><div class="md">${EXTRA_STATE.ruleHtml}</div></details>`:"",
    EXTRA_STATE.stockRuleHtml?`<details class="exc-fold"><summary>銘柄別ルール（全文）</summary><div class="md">${EXTRA_STATE.stockRuleHtml}</div></details>`:"",
  ].join("");
  $("#excMeta").textContent=EXTRA_STATE.stamps.length?`最終チェック — ${EXTRA_STATE.stamps.join("／")}（物差しは18:30終値）`:"";
  $("#excBody").innerHTML=`<div class="exc-tiles">${tiles}</div>`+ammo+folds;
  panel.hidden=false;
}

function renderBoard(){
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

/* 観察カード＝判断情報だけ（金額なし・2026-07-22情報選別）。
   状態色は列＝ボード構造が語る。DD%・理由色・連れ安/単独安バッジは18:30更新の正本mdから */
function stockCard(stock,decision){
  const memo=decision?.memo
    ||master("reasonTags",decision?.reasonTagId)?.label
    ||master("subReasons",decision?.subReasonId)?.label
    ||"まだログがありません";
  const tile=tileForStock(stock);
  let excInfo="";
  if(tile){
    const sev={danger:"down",warn:"warn",ok:"up"}[tile.phaseClass]||"";
    const bits=[];
    if(tile.big) bits.push(`<span class="card-dd ${sev}">${esc(tile.big)}</span><span class="card-dd-label">${esc(tile.bigLabel)}</span>`);
    if(tile.verdict) bits.push(`<span class="verdict-badge ${tile.verdict.kind==="単独安"?"solo":"tsure"}" title="${esc(tile.verdict.detail)}">${esc(tile.verdict.kind)}</span>`);
    if(bits.length) excInfo+=`<span class="card-exc">${bits.join("")}</span>`;
    if(tile.reason) excInfo+=`<span class="card-reason rs-${tile.reason.sev}" title="下落理由メモ（18:30自動更新）">${esc(tile.reason.text)}</span>`;
  }
  return `<button type="button" class="stock-card" data-stock="${esc(stock.id)}" title="タップして記録">
    <span class="stock-card-top"><span class="stock-identity"><span class="stock-name" title="${esc(stock.name)}">${esc(stock.name)}</span><span class="stock-symbol">${esc(stock.ticker)}</span></span><span class="stock-card-when">${decision?esc(formatDate(decision.decidedAt,true)):"未記録"}</span></span>
    <span class="stock-card-memo">${esc(memo)}</span>
    ${excInfo}
    <span class="stock-card-bottom"><span class="stock-card-date">${stock.note?'<span class="note-flag" role="button" title="ノートを開く">📝</span>':""}${decision?.nextReviewDate?`次回 ${formatDate(`${decision.nextReviewDate}T12:00:00`)}`:""}</span></span>
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

const KIND_CHIP={
  decision:'<span class="kind-chip kd">判断</span>',
  trade:'<span class="kind-chip kt">売買</span>',
  exc:'<span class="kind-chip ke">EXC</span>',
};

/* ログタブ＝判断・売買・EXC発砲/再装填を1本の時系列に統合（2026-07-22設計）。
   判断＝アプリのdecisions（取り消し可）。売買・EXC＝正本md（stock-rules.md／extra-charge.md）の履歴表を読むだけ。 */
function renderLog(){
  const kindFilter=$("#fKind")?.value||"";
  const stockId=$("#fStock").value,statusId=$("#fStatus").value,tagId=$("#fTag").value;
  const stockName=stockId?stockById(stockId)?.name||"":"";
  const entries=[];

  // 判断（decisions）
  let decisions=DB.decisions.slice();
  if(stockId) decisions=decisions.filter(item=>item.stockId===stockId);
  if(statusId) decisions=decisions.filter(item=>item.statusId===statusId);
  if(tagId) decisions=decisions.filter(item=>(item.reasonTagId||item.subReasonId)===tagId);
  if(!kindFilter||kindFilter==="decision"){
    decisions.forEach(decision=>entries.push({kind:"decision",time:decisionTime(decision),decision}));
  }
  // 売買・EXC：状態/タグの絞り込み中は出さない（判断専用の条件のため）。銘柄絞り込みは名前で当てる
  const mdAllowed=!statusId&&!tagId;
  if(mdAllowed&&(!kindFilter||kindFilter==="trade")){
    (EXTRA_STATE?.tradeLog||[]).forEach(row=>{
      if(stockName&&!(row.name.includes(stockName)||stockName.includes(row.name))) return;
      entries.push({kind:"trade",time:new Date(`${row.date}T12:00:00`).getTime(),row});
    });
  }
  if(mdAllowed&&!stockId&&(!kindFilter||kindFilter==="exc")){
    (EXTRA_STATE?.excLog||[]).forEach(row=>{
      entries.push({kind:"exc",time:new Date(`${row.date}T12:00:00`).getTime(),row});
    });
  }
  entries.sort((a,b)=>b.time-a.time);
  $("#logCount").textContent=`${entries.length}件`;
  if(!entries.length){$("#logList").innerHTML='<div class="empty-compact">条件に合うログはありません</div>';return;}
  const sources=transitionSources();
  $("#logList").innerHTML=entries.map(entry=>{
    if(entry.kind==="trade"){
      const row=entry.row;
      const detail=[row.quantity&&row.price?`${row.quantity} × ${row.price}`:row.quantity||row.price,row.pl&&row.pl!=="—"?`損益 ${row.pl}`:""].filter(Boolean).join("　");
      return `<div class="log-row log-md-row">
        <div class="timeline-date">${esc(formatDate(row.date))}</div>
        <div class="stock-identity"><div class="stock-name" title="${esc(row.name)}">${esc(row.name)}</div></div>
        <div class="log-transition">${KIND_CHIP.trade}<span class="md-event">${esc(row.event)}</span></div>
        <div class="log-detail"><div class="log-memo">${esc(detail||"—")}</div>${row.memo?`<div class="log-reason">${esc(row.memo)}</div>`:""}</div>
        <div class="log-execution"></div>
        <div class="log-revoke"><span class="md-source" title="正本＝stock-rules.mdの売買履歴">正本md</span></div>
      </div>`;
    }
    if(entry.kind==="exc"){
      const row=entry.row;
      const detail=[row.amount,row.target?`→ ${row.target}`:"",row.dd?`発動時DD ${row.dd}`:""].filter(Boolean).join("　");
      return `<div class="log-row log-md-row">
        <div class="timeline-date">${esc(formatDate(row.date))}</div>
        <div class="stock-identity"><div class="stock-name" title="${esc(row.index)}">${esc(row.index||"指数")}</div></div>
        <div class="log-transition">${KIND_CHIP.exc}<span class="md-event">${esc(row.event)}</span></div>
        <div class="log-detail"><div class="log-memo">${esc(detail||"—")}</div>${row.note?`<div class="log-reason">${esc(row.note)}</div>`:""}</div>
        <div class="log-execution"></div>
        <div class="log-revoke"><span class="md-source" title="正本＝extra-charge.mdの発砲履歴">正本md</span></div>
      </div>`;
    }
    const decision=entry.decision;
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
      <div class="log-transition">${KIND_CHIP.decision}${transition}</div>
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
  renderExc();
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
  [$("#fKind"),$("#fStock"),$("#fStatus"),$("#fTag")].forEach(select=>select.addEventListener("change",renderLog));
  $("#clearFilters").addEventListener("click",()=>{$("#fKind").value="";$("#fStock").value="";$("#fStatus").value="";$("#fTag").value="";renderLog();});
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
// 前回開いていたタブは、renderAll（既定タブを描画→記憶を上書きする）より先に読んでおく
const lastView=(()=>{try{return localStorage.getItem("pp_last_view");}catch(error){return null;}})();
renderAll();
if(lastView&&$(`nav button[data-view="${lastView}"]`)) showView(lastView);
// 旧extraページからの転送など、#observe等のハッシュ指定は記憶より優先
const hashView=location.hash.replace("#","");
if(hashView&&$(`nav button[data-view="${hashView}"]`)) showView(hashView);
store.init().then(loadPriceData).then(loadExtraDocs);
loadInstrumentData().catch(error=>{
  console.warn(error);
  $("#instrumentSource").textContent="手動登録のみ";
});
window.addEventListener("focus",()=>{
  if(Date.now()-priceLoadedAt>5*60*1000) loadPriceData();
  if(Date.now()-extraLoadedAt>5*60*1000) loadExtraDocs();
});
// バックグラウンドで開かれた場合、全景の帯ラベル調整は幅が測れず未実施のまま→見えた時に描き直す
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState==="visible") renderAssets();
});
setInterval(loadPriceData,15*60*1000);
setInterval(loadExtraDocs,15*60*1000);
