/* =====================================================================
   FDOA 共通クラウド保存部品（GitHub Contents API）
   3アプリ（マスター管理・物件進捗管理・時給プロジェクト管理）で共用。
   保存先をGitHubからよそへ引っ越す日は、このファイル1個を差し替えれば
   全アプリの引っ越しが完了する（アプリ本体は保存先を知らない）。

   使い方：
     const store = createCloudStore({
       owner:'…', repo:'…', branch:'main', path:'xxx.json',
       tokenKey:'fdoa_gh_token',            // 全アプリ共通のトークン保存キー
       legacyTokenKeys:['…'],               // 旧キー（あれば読むだけ）
       label:'マスター',                     // コミットメッセージ用
       getData:  () => db,                  // 保存するデータを返す
       adoptRemote: data => {…},            // リモートをこの端末に採用する
       onState: (state,msg) => {…},         // off/loading/dirty/saving/saved/offline/error
     });
     store.init();       // 起動時：新しい方を採用
     store.queueSync();  // 保存のたびに呼ぶ（少し待ってまとめてpush）
   ===================================================================== */
'use strict';
function createCloudStore(cfg){
  const LT=cfg.legacyTokenKeys||[];
  let token=localStorage.getItem(cfg.tokenKey)||LT.map(k=>localStorage.getItem(k)).find(Boolean)||'';
  let sha=null;      // 最後に確認したリモートファイルのSHA（上書き事故防止）
  let stamp=null;    // 最後に同期したリモートのsavedAt（他端末保存の検知用）
  let timer=null,pushing=false,pending=false;
  const state=(s,m)=>cfg.onState&&cfg.onState(s,m);
  const savedAtOf=d=>(d&&d.meta&&d.meta.savedAt)||null;

  function b64enc(s){const b=new TextEncoder().encode(s);let bin='';for(let i=0;i<b.length;i+=0x8000)bin+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(bin);}
  function b64dec(s){const bin=atob(s.replace(/\s/g,''));const b=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)b[i]=bin.charCodeAt(i);return new TextDecoder().decode(b);}
  function api(method,path,body){
    const url='https://api.github.com/repos/'+cfg.owner+'/'+cfg.repo+'/contents/'+path+(method==='GET'?'?ref='+cfg.branch+'&_='+Date.now():'');
    return fetch(url,{method,cache:'no-store',
      headers:{'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'},
      body:body?JSON.stringify(body):undefined});
  }
  async function pull(){ // 自ファイルのリモート取得（shaも更新）
    const res=await api('GET',cfg.path);
    if(res.status===404)return{missing:true};
    if(res.status===401)throw new Error('トークンが無効（401）');
    if(!res.ok)throw new Error('GitHub応答 '+res.status);
    const j=await res.json();
    sha=j.sha;
    let data=null;
    try{data=JSON.parse(b64dec(j.content));}catch(e){}
    return{data};
  }
  function adopt(data){stamp=savedAtOf(data);cfg.adoptRemote(data);state('saved');}
  function queueSync(){
    if(!token)return;
    state('dirty');clearTimeout(timer);timer=setTimeout(push,1500);
  }
  async function push(){
    if(!token)return;
    if(pushing){pending=true;return;}
    pushing=true;state('saving');
    try{
      const cur=await pull(); // 最新SHA取得＋他端末保存の検知
      const remoteStamp=savedAtOf(cur.data);
      if(remoteStamp&&stamp!==null&&remoteStamp!==stamp){
        if(confirm('他の端末で保存されたデータがクラウドにある。\nOK＝クラウドの内容を読み込む（この端末の直近の変更は消える）\nキャンセル＝この端末の内容でクラウドを上書き')){
          adopt(cur.data);pushing=false;pending=false;return;
        }
      }
      const db=cfg.getData();
      const content=JSON.stringify(db,null,1);
      const sentStamp=savedAtOf(db); // 送信中にsave()が走ってもズレないよう「送った中身」のsavedAtを控える（自分の保存を他端末と誤認する競合の防止）
      const body={message:'保存：'+(cfg.label||cfg.path)+' '+new Date().toLocaleString('ja-JP'),content:b64enc(content),branch:cfg.branch};
      if(sha)body.sha=sha;
      const res=await api('PUT',cfg.path,body);
      if(!res.ok)throw new Error('保存失敗（'+res.status+'）');
      const j=await res.json();
      sha=j.content.sha;stamp=sentStamp;
      state('saved');
    }catch(e){
      state(navigator.onLine?'error':'offline',navigator.onLine?e.message:'');
    }
    pushing=false;
    if(pending){pending=false;push();}
  }
  async function init(){ // 起動時：ローカルとリモートの新しい方を採用
    if(!token){state('off');return;}
    state('loading');
    try{
      const r=await pull();
      if(r.missing||!r.data){push();return;} // クラウドが空→ローカルを上げる
      const remoteStamp=savedAtOf(r.data)||'';
      const localStamp=savedAtOf(cfg.getData())||'';
      if(remoteStamp>localStamp)adopt(r.data);
      else if(localStamp>remoteStamp){stamp=remoteStamp;push();}
      else{stamp=remoteStamp;state('saved');}
    }catch(e){state(navigator.onLine?'error':'offline',navigator.onLine?e.message:'');}
  }
  async function fetchFile(path){ // 同リポジトリの他ファイルを読むだけ（参照チェック用）
    if(!token)return null;
    const res=await api('GET',path);
    if(!res.ok)return null;
    const j=await res.json();
    try{return JSON.parse(b64dec(j.content));}catch(e){return null;}
  }
  window.addEventListener('online',()=>{if(token)push();});
  return{
    init,queueSync,syncNow:init,push,fetchFile,
    hasToken:()=>!!token,
    connect(t){token=t;localStorage.setItem(cfg.tokenKey,t);sha=null;stamp=null;return init();},
    disconnect(){token='';localStorage.removeItem(cfg.tokenKey);LT.forEach(k=>localStorage.removeItem(k));sha=null;stamp=null;state('off');},
  };
}
