// =========================================================
// 1. CONFIGURATION & STATE
// =========================================================
// 🛑 นำ URL ของ Google Apps Script Web App ที่ Deploy ใหม่มาใส่ตรงนี้ 🛑
const GAS_URL = "https://script.google.com/macros/s/AKfycbwvucmeMFhcN_6wIyOGg33kd6XKKe3K66T311r8nm7GtlA29-qmisdoo5a6Rm5q690V/exec";

// Global Variables
let MAP_POINTS = [];
let mapCoords = {};
let map;
let __PAGE_MODE__ = "PM10";
let AUTO_SWITCH_SEC = 30;
let __AUTO_SWITCH_ENABLED__ = (function(){
  try{ return localStorage.getItem("scada_auto_switch") !== "0"; }catch(e){ return true; }
})();
let __AUTO_SWITCH_TIMER__ = null;
let __AUTO_SWITCH_REMAINING__ = AUTO_SWITCH_SEC; 
let PM10_WARN = 50, PM10_BAD = 120;
let __PM_FETCH_LOCK__ = false;
let __PM10_LATEST__ = {}, __PM10_SERIES__ = {}, __PM10_SERIES_FETCHED_AT__ = {};
let __AI_ROWS__ = [];

// =========================================================
// 2. HELPER API CALLER (แทนที่ google.script.run)
// =========================================================
/**
 * ฟังก์ชันกลางสำหรับเรียกข้อมูลจาก GAS
 */
async function callGasAPI(action, params = {}, method = 'GET', bodyData = null) {
  try {
    let url = new URL(GAS_URL);
    url.searchParams.append('action', action);
    
    // แนบพารามิเตอร์อื่นๆ ในกรณี GET
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
      }
    }

    const options = {
      method: method,
    };

    if (method === 'POST' && bodyData) {
      options.body = JSON.stringify(bodyData);
      options.headers = { "Content-Type": "text/plain;charset=utf-8" };
    }

    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    throw new Error(error.message || "Network Error");
  }
}

// =========================================================
// 3. HELPERS & MEMORY CLEANUP
// =========================================================
function $id(id){ return document.getElementById(id); }
function setText(id,val){ var el=$id(id); if(!el) return false; el.textContent=(val==null?"":val); return true; }
function setHTML(id,html){ var el=$id(id); if(!el) return false; el.innerHTML=(html==null?"":html); return true; }

function destroyAllModalCharts_() {
  if (typeof __VIB_CHARTS__ !== 'undefined') {
    for (var key in __VIB_CHARTS__) {
      if (__VIB_CHARTS__[key]) {
        __VIB_CHARTS__[key].destroy();
        delete __VIB_CHARTS__[key];
      }
    }
  }
  if (typeof __PM10_CHART__ !== 'undefined' && __PM10_CHART__) {
    __PM10_CHART__.destroy();
    __PM10_CHART__ = null;
  }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hardCrashScreen(title,msg,stack){
  try{stopPolling();}catch(_){}
  document.body.innerHTML='<div style="font-family:ui-monospace,Menlo,Consolas,monospace;padding:16px;">'+
    '<h3 style="margin:0 0 10px 0;">'+title+'</h3>'+
    '<div style="color:#ff9f0a;font-weight:900;">'+String(msg||"")+'</div>'+
    '<pre style="white-space:pre-wrap;opacity:.85;margin-top:10px;">'+(stack||"")+'</pre>'+
    '<button onclick="location.reload()" style="margin-top:12px;padding:10px 12px;">Reload</button>'+
    '</div>';
}
window.addEventListener("error",function(e){ hardCrashScreen("SCADA UI crashed",(e&&e.message)||"Unknown",(e&&e.error&&e.error.stack)||""); });
window.addEventListener("unhandledrejection",function(e){ hardCrashScreen("SCADA Promise crashed",(e&&e.reason)||"Unknown",""); });

// =========================================================
// 4. MOBILE MENU & THEME
// =========================================================
(function(){
  var btn = $id("hamburgerBtn");
  var menu = $id("mobileMenu");
  if(!btn || !menu) return;

  function closeMobileMenu(){
    menu.classList.remove("open");
    btn.textContent = "☰";
  }

  function toggleMobileMenu(){
    menu.classList.toggle("open");
    btn.textContent = menu.classList.contains("open") ? "✕" : "☰";
  }

  btn.addEventListener("click", function(e){
    e.preventDefault(); e.stopPropagation(); toggleMobileMenu();
  });

  menu.addEventListener("click", function(e){
    var targetBtn = e.target.closest("button");
    if(!targetBtn) return;
    setTimeout(closeMobileMenu, 120);
  });

  document.addEventListener("click", function(e){
    if(!menu.classList.contains("open")) return;
    if(menu.contains(e.target) || btn.contains(e.target)) return;
    closeMobileMenu();
  });

  document.addEventListener("keydown", function(e){
    if(e.key === "Escape") closeMobileMenu();
  });

  window.addEventListener("resize", function(){
    if(window.innerWidth > 768) closeMobileMenu();
  });
})();

function setTheme(theme){
  document.body.setAttribute("data-theme",theme);
  localStorage.setItem("belt_theme",theme);
  var txt = (theme==="day") ? "☀️ Theme: DAY" : "🌙 Theme: NIGHT";
  ["themeBtnToggle", "themeBtnToggle2"].forEach(function(id){
    var e = document.getElementById(id); 
    if(e) e.textContent = txt;
  });
}
setTheme(localStorage.getItem("belt_theme")||"night");

(function(){
  function bindTheme(id){ 
    var b = document.getElementById(id); 
    if(!b) return; 
    b.addEventListener("click", function(){ 
      var cur = document.body.getAttribute("data-theme")||"night"; 
      setTheme(cur==="day" ? "night" : "day"); 
    }); 
  }
  bindTheme("themeBtnToggle"); 
  bindTheme("themeBtnToggle2");
})();

// =========================================================
// 5. OPERATOR & BEEP & TOAST
// =========================================================
function getOperator(){ return {name:localStorage.getItem("op_name")||"",shift:localStorage.getItem("op_shift")||""}; }
function setOperator(name,shift){
  localStorage.setItem("op_name",(name||"").trim().slice(0,40));
  localStorage.setItem("op_shift",(shift||"").trim().slice(0,20));
  refreshOperatorPill();
}
function refreshOperatorPill(){
  var cur=getOperator(); var pill=$id("opPill"); if(!pill) return;
  pill.textContent=cur.name?("OP: "+cur.name+(cur.shift?" / "+cur.shift:"")):"OP: -";
}
function doOpPrompt(){
  var cur=getOperator();
  Swal.fire({
    title: 'Operator Login',
    html:
      '<input id="swal-input1" class="swal2-input" placeholder="Name" value="'+(cur.name||"")+'">' +
      '<select id="swal-input2" class="swal2-input">' +
      '<option value="เช้า" '+(cur.shift==="เช้า"?"selected":"")+'>กะเช้า (08:00 - 16:00)</option>' +
      '<option value="บ่าย" '+(cur.shift==="บ่าย"?"selected":"")+'>กะบ่าย (16:00 - 00:00)</option>' +
      '<option value="ดึก" '+(cur.shift==="ดึก"?"selected":"")+'>กะดึก (00:00 - 08:00)</option>' +
      '</select>',
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: 'Save',
    preConfirm: () => {
      return [
        document.getElementById('swal-input1').value,
        document.getElementById('swal-input2').value
      ]
    }
  }).then((result) => {
    if (result.isConfirmed) {
      setOperator(result.value[0], result.value[1]);
      showToast("Saved operator", "ok", result.value[0] + " / " + result.value[1]);
    }
  });
}
["opBtn","opBtn2"].forEach(id => { var b=$id(id); if(b) b.addEventListener("click",doOpPrompt); });

function showToast(msg,type,sub){
  type=type||"ok"; sub=sub||"";
  var wrap=$id("toastWrap");
  if(!wrap) return;
  while(wrap.children.length>=3){ if(wrap.firstElementChild) wrap.firstElementChild.remove(); else break; }
  var el=document.createElement("div");
  el.className="toast "+(type==="err"?"err":type==="warn"?"warn":"");
  el.innerHTML='<span class="toastDot"></span><div><div class="tMsg">'+esc(msg)+'</div>'+(sub?'<div class="tSub">'+esc(sub)+'</div>':'')+'</div>';
  wrap.appendChild(el);
  setTimeout(function(){ el.style.opacity="0"; el.style.transform="translateY(-4px)"; },2400);
  setTimeout(function(){ try{el.remove();}catch(e){} },2800);
}

var _failStreak=0;
function setConnBadge(state,txt){
  var b=$id("connBadge"), t=$id("connTxt"); if(!b||!t) return;
  b.className="connBadge "+state; t.textContent=txt;
}

var BEEP_INTERVAL_MS=7000,BEEP_COOLDOWN_MS=1200;
var lastBeepAt=0,beepedOpenIds={},audioCtx=null;
function getBeepEnabled(){ return localStorage.getItem("belt_beep")!=="0"; }
function setBeepEnabled(on){ localStorage.setItem("belt_beep",on?"1":"0"); updateMuteBtn(); }
function updateMuteBtn(){
  var lbl="Beep: "+(getBeepEnabled()?"ON":"MUTE");
  ["muteBtn","muteBtn2"].forEach(function(id){ var b=$id(id); if(b) b.textContent=lbl; });
}
function ensureAudio(){ if(audioCtx) return true; try{audioCtx=new(window.AudioContext||window.webkitAudioContext)();}catch(e){audioCtx=null;return false;} return true; }
function beepOnce(){
  if(!getBeepEnabled()) return; if(!ensureAudio()) return;
  if(audioCtx.state==="suspended") audioCtx.resume().catch(function(){});
  var now=Date.now();
  if(now-lastBeepAt<BEEP_COOLDOWN_MS) return;
  lastBeepAt=now;
  var t0=audioCtx.currentTime;
  function tone(freq,start,dur,gainVal){
    var osc=audioCtx.createOscillator(); var gain=audioCtx.createGain();
    osc.type="square"; osc.frequency.setValueAtTime(freq,start);
    gain.gain.setValueAtTime(0.0001,start); gain.gain.exponentialRampToValueAtTime(gainVal,start+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001,start+dur);
    osc.connect(gain).connect(audioCtx.destination); osc.start(start); osc.stop(start+dur+0.02);
  }
  tone(1100,t0+0.00,0.10,0.18); tone(900,t0+0.14,0.12,0.14);
}
function handleBeepFromData(data){
  if(document.hidden || (__PAGE_MODE__ !== "BELT" && __PAGE_MODE__ !== "AI")) return;  
  if(!data||!data.belts||!data.belts.length) return;
  var hasOpen=false,openNew=false;
  for(var i=0;i<data.belts.length;i++){
    var it=data.belts[i]; if(!it) continue;
    if(it.currentStatus==="ALERT"&&it.currentAlarmType==="OPEN"&&!it.isAcked){
      hasOpen=true;
      var id=String(it.alarmId||it.belt||"");
      if(id&&!beepedOpenIds[id]){beepedOpenIds[id]=1;openNew=true;}
    }
  }
  if(!hasOpen){beepedOpenIds={};return;}
  var now=Date.now();
  if(openNew){beepOnce();return;}
  if(now-lastBeepAt>=BEEP_INTERVAL_MS) beepOnce();
}
["muteBtn","muteBtn2"].forEach(function(id){
  var btn=$id(id); if(!btn) return;
  btn.addEventListener("click",function(){
    var on=!getBeepEnabled(); setBeepEnabled(on); ensureAudio();
    if(audioCtx&&audioCtx.state==="suspended") audioCtx.resume().catch(function(){});
    showToast(on?"Beep ON":"Beep MUTED",on?"warn":"ok");
  });
});
document.addEventListener("click",function(){ ensureAudio(); if(audioCtx&&audioCtx.state==="suspended") audioCtx.resume().catch(function(){}); },{once:true});


// =========================================================
// 6. UI RENDER HELPERS
// =========================================================
function runTag(run){
  var v=(run===1)?1:0;
  return '<span class="runTag '+(v?"run1 runAnim":"run0 stopAnim")+'">'+(v?"RUN 1":"STOP 0")+'</span>';
}
function clsFor(item){
  if(item.currentStatus==="NO_DATA") return {badge:"stale",text:"NO DATA"};
  if(item.currentStatus!=="ALERT") return {badge:"ok",text:"NORMAL"};
  if(item.isAcked){
    if(item.currentAlarmType==="STALE") return {badge:"stale",text:"STALE•ACK"};
    return {badge:"acked",text:"ACK"};
  }
  if(item.currentAlarmType==="OPEN") return {badge:"open",text:"OPEN"};
  if(item.currentAlarmType==="STUCK") return {badge:"stuck",text:"STUCK"};
  if(item.currentAlarmType==="STALE") return {badge:"stale",text:"STALE"};
  return {badge:"other",text:"ALERT"};
}
function buildSwayHtml(item){
  if(!item) return "";
  function toNum(v){if(v===""||v==null) return 0; var n=Number(v); return(isFinite(n)?n:0);}
  function dirBadge(dir){dir=(dir==null)?"":String(dir).trim().toUpperCase(); if(!dir) return ""; return ' <span class="swayDir">DIR: '+esc(dir)+'</span>';}
  function lastMsg_(){ return(item.swayLastMsg==null)?"":String(item.swayLastMsg).trim(); }
  function lastTimeShort_(){
    var raw=(item.swayLastTime==null)?"":String(item.swayLastTime).trim(); if(!raw) return "";
    var onlyTime=raw; if(onlyTime.indexOf(" ")>=0) onlyTime=onlyTime.split(" ").pop().trim();
    return /^\d{1,2}:\d{2}(:\d{2})?$/.test(onlyTime)?onlyTime:"";
  }
  var count=toNum(item.swayCount),streak=toNum(item.swayStreakHours),msgLast=lastMsg_();
  if(count<=0&&streak<=0&&!msgLast) return "";
  var dir=(item.swayDir==null)?"":String(item.swayDir).trim().toUpperCase();
  var main="SWAY"+(dir?(" "+dir):"");
  if(streak>0) main+=" • "+streak+"h"; else if(count>0) main+=" • this hour";
  var lastPart="";
  if(msgLast){var tShort=lastTimeShort_(); lastPart=tShort?(" • last: "+esc(msgLast)+" @ "+esc(tShort)):(" • last: "+esc(msgLast));}
  return '<div class="swayLine mono">'+esc(main)+'<span class="swayMuted">'+esc(lastPart)+'</span>'+dirBadge(dir)+'</div>';
}

function openModal(){ var o=$id("overlay"); if(o) o.style.display="flex"; }
function closeModal(){ 
  var o=$id("overlay"); 
  if(o) o.style.display="none"; 
  destroyAllModalCharts_();
  setHTML("modalBody", "");
}
var c=$id("closeBtn"); if(c) c.addEventListener("click",closeModal);
var ov=$id("overlay"); if(ov) ov.addEventListener("click",function(e){ if(e.target&&e.target.id==="overlay") closeModal(); });
document.addEventListener("keydown",function(e){ if(e.key==="Escape") closeModal(); });


// =========================================================
// 7. AI ENGINE
// =========================================================
function aiToNum_(v){ if(v===null||v===undefined||v==="") return null; var n=Number(v); return isFinite(n)?n:null; }
function aiReasonCause_(type){
  type=String(type||"").toUpperCase();
  if(type==="OPEN") return {cause:"หัวเปิด / limit switch / alignment / วัสดุติดค้าง",action:"ตรวจหัวเปิด, limit switch, alignment และจุดอุดตัน"};
  if(type==="STUCK") return {cause:"sensor หรือกลไกค้าง / ลูกกลิ้งติด / มีสิ่งขัดขวาง",action:"ตรวจ sensor, ลูกกลิ้ง, จุดหมุน และเศษวัสดุ"};
  if(type==="OTHER") return {cause:"สัญญาณผิดปกติหรือ alarm เฉพาะจุด",action:"ตรวจข้อความ alarm, จุดหน้างาน และ source sheet"};
  if(type==="STALE") return {cause:"สื่อสารขาด / source ไม่อัปเดต / ไฟเลี้ยงหรือ network มีปัญหา",action:"ตรวจไฟเลี้ยง, network, source sheet และ heartbeat"};
  return {cause:"แนวโน้มผิดปกติจากข้อมูลหน้างาน",action:"ตรวจข้อมูลจริงและเฝ้าติดตามต่อเนื่อง"};
}
function scoreAiRow_(it){
  it=it||{};
  var score=0, reasons=[];
  
  var status=String(it.currentStatus||"");
  var type=String(it.currentAlarmType||"").toUpperCase();
  var run=Number(it.run||0);
  var swayCount=Number(it.swayCount||0); if(!isFinite(swayCount)) swayCount=0;
  var swayStreak=aiToNum_(it.swayStreakHours);
  var acked=!!it.isAcked;

  if(status==="ALERT"){
    if(type==="OPEN"){ score+=75; reasons.push("หัวเปิด"); }
    else if(type==="STUCK"){ score+=60; reasons.push("ติดค้าง"); }
    else if(type==="OTHER"){ score+=45; reasons.push("alarm อื่น"); }
    else if(type==="STALE"){ score+=20; reasons.push("สัญญาณหาย"); }
    else { score+=35; reasons.push("alarm ไม่ระบุชนิด"); }
  }else if(status==="NO_DATA"){
    score+=15; reasons.push("ไม่มีข้อมูล");
  }

  if(run===1){ 
    if(status==="ALERT"){
      score+=30; 
      reasons.push("อันตราย: เครื่อง RUN ขณะมี Alarm");
      if(type==="STUCK") {
        score+=20;
        reasons.push("🔥 เสี่ยงสายพานไหม้/ขาด (มอเตอร์หมุนแต่สายพานหยุด)");
      }
    } else {
      score+=10; 
      reasons.push("เครื่องยัง RUN");
    }
  }

  if(swayCount>=1){ score+=5; reasons.push("มี sway"); }
  if(swayCount>=3){ score+=8; reasons.push("sway หลายครั้ง"); }
  if(swayCount>=5){ score+=10; reasons.push("sway หนัก"); }
  if(swayStreak!=null && swayStreak>=1){ score+=10; reasons.push("sway ต่อเนื่อง"); }
  if(swayStreak!=null && swayStreak>=3){ score+=15; reasons.push("วิกฤต: sway ต่อเนื่องหลายชั่วโมง"); }

  if(status!=="ALERT" && swayCount>0){
    score+=15; reasons.push("เริ่มมีแนวโน้มผิดปกติ (Pre-Alarm)");
  }
  if(type==="STALE" && run===1){ 
    score+=25; 
    reasons.push("ความเสี่ยงสูง: RUN แต่ข้อมูลหาย"); 
  }
  if(acked && type!=="STALE"){ 
    score-=30; 
    reasons.push("มีการ ACK แล้ว"); 
  }

  score=Math.max(0,Math.min(100,Math.round(score)));
  
  var level="NORMAL";
  if(score>=90) level="CRITICAL";
  else if(score>=70) level="HIGH";
  else if(score>=40) level="MEDIUM";
  else if(score>0) level="LOW";

  var ca=aiReasonCause_(type);
  if(status==="ALERT" && run===1 && type==="STUCK"){
    ca.cause = "🔥 มอเตอร์หมุนแต่สายพานติดขัด (Fire Hazard)";
    ca.action = "🛑 สั่งหยุดเครื่องทันที! ตรวจสอบเศษวัสดุค้างหรือลูกกลิ้งล็อค";
  }else if(status==="ALERT" && run===1 && type==="OPEN"){
    ca.cause = "⚠️ เครื่องเดินแต่หัวเปิด (Spill Hazard)";
    ca.action = "🛑 สั่งหยุดเครื่อง! ระวังวัสดุล้นร่วง ตรวจสอบ Limit Switch";
  }else if(status!=="ALERT" && swayCount>=3){
    ca.cause="แนวโน้มส่ายต่อเนื่องหรือเริ่มมีความผิดปกติ";
    ca.action="ตรวจ alignment, bearing, roller และติดตามซ้ำอย่างใกล้ชิด";
  }else if(status==="NO_DATA"){
    ca.cause="ไม่มีข้อมูลล่าสุดจากแหล่งต้นทาง";
    ca.action="ตรวจ source sheet, gateway และการเชื่อมต่อ";
  }

  return {
    belt:String(it.belt||"-"), group:String(it.group||""), status:status,
    alarmType:type||"-", run:run===1?1:0, score:score, level:level, isAcked:acked,
    swayCount:swayCount, swayStreakHours:swayStreak, cause:ca.cause, action:ca.action,
    reasonText:reasons.join(", "), alarmMsg:String(it.currentAlarmMsg||""),
    sortKey:(level==="CRITICAL"?500:level==="HIGH"?400:level==="MEDIUM"?300:level==="LOW"?200:100)+score
  };
}

function buildAiRows_(data){
  var src=(data&&Array.isArray(data.belts))?data.belts:[];
  var rows=[];
  
  for(var i=0;i<src.length;i++){
    var r=scoreAiRow_(src[i]);
    if(r.score<=0 && r.status!=="ALERT" && r.status!=="NO_DATA") continue;
    rows.push(r);
  }

  if(window.__LAST_VIB_DATA__) {
     function addVibAi(vibData, name, limitWarn, limitDanger) {
       if(!vibData.length) return;
       var latest = vibData[vibData.length-1];
       if(!latest || latest.level === "NORMAL" || latest.level === "IDLE") return;
       if (latest.level.includes("CHECK") && (latest.reason.includes("ค้าง") || latest.reason.includes("Frozen"))) return;

       var currentVib = Number(latest.acc) || 0;
       if (currentVib <= (limitWarn || 30)) return; 

       var level = "LOW";
       var baseScore = latest.score || 50;
       
       if(currentVib > (limitDanger || 60)) { level = "CRITICAL"; baseScore = Math.max(baseScore, 92); }
       else if(currentVib > (limitWarn || 30)) { level = "HIGH"; baseScore = Math.max(baseScore, 75); }
       else if(latest.level.includes("CHECK")) { level = "MEDIUM"; baseScore = Math.max(baseScore, 45); }

       rows.push({
          belt: name, group: "Vibration Gear", status: "ALERT", alarmType: "VIB_" + level, run: 1, 
          score: baseScore, level: level, isAcked: false, cause: latest.reason, action: latest.advice, 
          reasonText: "เกินเกณฑ์ที่ตั้งไว้ (>" + limitWarn + " mm/s)", alarmMsg: "Peak: " + (latest.acc||0).toFixed(2) + " mm/s",
          sortKey: (level==="CRITICAL"?500:level==="HIGH"?400:level==="MEDIUM"?300:level==="LOW"?200:100) + baseScore
       });
     }
     
     function getLimits(posNum) {
        var p = MAP_POINTS.find(function(m){return m.pos === posNum && m.modes && m.modes.includes("VIB");});
        return { w: p ? (p.vibWarn || 30) : 30, d: p ? (p.vibDanger || 60) : 60 };
     }

     if(window.__LAST_VIB_DATA__[1]) {
       var lim = getLimits(1);
       addVibAi(window.__LAST_VIB_DATA__[1].data18, "6522.18", lim.w, lim.d);
       addVibAi(window.__LAST_VIB_DATA__[1].data20, "6522.20", lim.w, lim.d);
     }
     if(window.__LAST_VIB_DATA__[2]) {
       var lim = getLimits(2);
       addVibAi(window.__LAST_VIB_DATA__[2].data18, "6532.18", lim.w, lim.d);
       addVibAi(window.__LAST_VIB_DATA__[2].data20, "6532.20", lim.w, lim.d);
     }
     if(window.__LAST_VIB_DATA__[3]) {
       var lim = getLimits(3);
       addVibAi(window.__LAST_VIB_DATA__[3].data18, "542.22", lim.w, lim.d);
     }
     if(window.__LAST_VIB_DATA__[4]) {
       var lim = getLimits(4);
       addVibAi(window.__LAST_VIB_DATA__[4].data18, "6413.03", lim.w, lim.d);
     }
  }

  if(window.__TREND_VIB_DATA__) {
     var t18 = window.__TREND_VIB_DATA__.data18 || [];
     var t20 = window.__TREND_VIB_DATA__.data20 || [];

     function addVibAiTrend(vibData, name) {
        if(!vibData || vibData.length < 2000) return;
        var chunk = Math.floor(vibData.length / 5); 
        var oldData = vibData.slice(0, chunk);
        var newData = vibData.slice(vibData.length - chunk);

        var oldAvg = oldData.reduce(function(acc, val){ return acc + (val.baseAcc||0); }, 0) / chunk;
        var newAvg = newData.reduce(function(acc, val){ return acc + (val.baseAcc||0); }, 0) / chunk;

        if(oldAvg > 0.03) { 
            var increasePct = ((newAvg - oldAvg) / oldAvg) * 100;
            if(increasePct >= 25 && newAvg >= 20) {
                var isCrit = increasePct >= 50 && newAvg >= 30;
                rows.push({
                   belt: name, group: "Predictive Maint.", status: "WARN", alarmType: "TREND_UP", run: 1, 
                   score: isCrit ? 85 : 65, level: isCrit ? "CRITICAL" : "HIGH", isAcked: false,
                   cause: "📈 ระดับพลังงานการสั่นสะเทือน (RMS) ไต่ระดับเพิ่มขึ้น " + increasePct.toFixed(1) + "%",
                   action: "ตรวจสอบตลับลูกปืน, การหล่อลื่น (จาระบี) และ Alignment เพื่อป้องกัน Break down",
                   reasonText: "AI วิเคราะห์แนวโน้มจาก " + vibData.length + " ข้อมูลย้อนหลัง (5 วัน)",
                   alarmMsg: "RMS เดิม: " + oldAvg.toFixed(3) + "G ➔ ปัจจุบัน: " + newAvg.toFixed(3) + "G",
                   sortKey: isCrit ? 485 : 385
                });
            }
        }
     }
     addVibAiTrend(t18, "6522.18");
     addVibAiTrend(t20, "6522.20");
  }

  if (window.__PM10_LATEST__) {
    for (var pos in window.__PM10_LATEST__) {
      var pm = window.__PM10_LATEST__[pos];
      if (pm && pm.v != null && !isPm10Stale_(pm)) {
        var v = Number(pm.v);
        var displayName = pm.loc ? pm.loc : pos;
        
        if (v >= PM10_BAD) {
          rows.push({
            belt: "PM10 " + displayName, group: "Environment", status: "ALERT", alarmType: "DUST_BAD", run: 0, score: 85, level: "HIGH", isAcked: false, 
            cause: "⚠️ ฝุ่นสะสมหนาแน่นเกินมาตรฐานอันตราย", action: "ตรวจสอบ Bag Filter และระบบพรมน้ำด่วน", reasonText: "เกิน 120 µg/m³", alarmMsg: v.toFixed(0) + " µg/m³", sortKey: 485
          });
        } else if (v >= PM10_WARN) {
          rows.push({
            belt: "PM10 " + displayName, group: "Environment", status: "WARN", alarmType: "DUST_WARN", run: 0, score: 45, level: "MEDIUM", isAcked: false, 
            cause: "ฝุ่นเริ่มฟุ้งกระจายในพื้นที่", action: "ตรวจสอบจุดรั่วไหลของฝุ่น", reasonText: "เกิน 50 µg/m³", alarmMsg: v.toFixed(0) + " µg/m³", sortKey: 345
          });
        }
      }
    }
  }

  rows.sort(function(a,b){ return (b.sortKey||0)-(a.sortKey||0) || String(a.belt).localeCompare(String(b.belt)); });
  window.__AI_ROWS__=rows;
  return rows;
}

function setSectionVisibility_(){
  var mapSec=$id("mapSection"), aiSec=$id("aiSection"), dashSec=$id("vibDashboardSection");
  if(mapSec) mapSec.style.display=(__PAGE_MODE__==="AI" || __PAGE_MODE__==="VIB_DASH")?"none":"block";
  if(aiSec) aiSec.classList.toggle("open", __PAGE_MODE__==="AI");
  if(dashSec) dashSec.style.display=(__PAGE_MODE__==="VIB_DASH")?"block":"none";
}

function renderAiAnalysis_(data){
  var rows=buildAiRows_(data);
  var c={CRITICAL:0,HIGH:0,MEDIUM:0,LOW:0,NORMAL:0};
  for(var i=0;i<rows.length;i++){
    var lv=rows[i].level||"NORMAL";
    c[lv]=(c[lv]||0)+1;
  }
  setText("aiKpiCritical", c.CRITICAL||0);
  setText("aiKpiHigh", c.HIGH||0);
  setText("aiKpiMedium", c.MEDIUM||0);
  setText("aiKpiWatch", (c.LOW||0) + ((data&&Array.isArray(data.belts)) ? data.belts.filter(function(it){return String(it&&it.currentStatus||"")==="NO_DATA";}).length : 0));
  var normalTotal=(data&&Array.isArray(data.belts)) ?
    Math.max(0, data.belts.length - rows.filter(function(r){return r.level!=="NORMAL" && r.group!=="Environment" && r.group!=="Vibration Gear";}).length) : 0;
  setText("aiKpiNormal", normalTotal);
  setText("aiGeneratedAt", "Generated: " + new Date().toLocaleString("th-TH"));

  var tb=$id("aiTbody");
  if(tb){
    if(!rows.length){
      tb.innerHTML='<tr><td colspan="7" class="rMut empty-row">No AI findings</td></tr>';
    }else{
      var html="";
      var topRows=rows.slice(0,15); 
      for(var j=0;j<topRows.length;j++){
        var r=topRows[j];
        var bgStyle = "";
        if (r.level === "CRITICAL") bgStyle = 'style="background:rgba(255,59,48,0.15);"';
        else if (r.level === "HIGH") bgStyle = 'style="background:rgba(255,159,10,0.10);"';

        html+='<tr ' + bgStyle + '>'+
          '<td class="mono"><b>'+esc(String(r.score))+'</b></td>'+
          '<td><span class="aiLevel '+esc(r.level)+'">'+esc(r.level)+'</span></td>'+
          '<td class="mono"><b>'+esc(r.belt)+'</b><div class="aiTiny" style="color:var(--text);">'+esc(r.group||"-")+'</div></td>'+
          '<td class="mono">'+(r.group==="Environment" ? "-" : (r.run===1?'RUN':'STOP'))+(r.isAcked?'<div class="aiTiny">ACK</div>':'')+'</td>'+
          '<td class="mono">'+esc(r.alarmType||"-")+(r.alarmMsg?'<div class="aiTiny" style="color:#ff3b30;">'+esc(r.alarmMsg)+'</div>':'')+'</td>'+
          '<td>'+esc(r.cause)+'</td>'+
          '<td style="color:var(--scada-cyan);">'+esc(r.action)+'</td>'+
        '</tr>';
      }
      tb.innerHTML=html;
    }
  }

  var list=$id("aiReasonList");
  if(list){
    if(!rows.length){
      list.innerHTML='<div class="aiEmpty">No AI findings</div>';
    }else{
      var out="";
      var top=rows.slice(0,5);
      for(var k=0;k<top.length;k++){
        var rr=top[k];
        var borderGlow = rr.level === "CRITICAL" ? "border-color: #ff3b30; box-shadow: 0 0 10px rgba(255,59,48,0.2);" : "";
        out+='<div class="aiReasonItem" style="' + borderGlow + '">'+
          '<div class="aiReasonTop">'+
            '<div class="aiReasonBelt mono">'+esc(rr.belt)+' <span class="aiTiny">'+esc(rr.group||"")+'</span></div>'+
            '<span class="aiLevel '+esc(rr.level)+'">'+esc(rr.level)+' • '+esc(String(rr.score))+'</span>'+
          '</div>'+
          '<div class="aiReasonMsg"><b>Alarm:</b> '+esc(rr.alarmType||"-")+(rr.alarmMsg?(' • '+esc(rr.alarmMsg)):'')+'</div>'+
          '<div class="aiReasonMsg"><b>Why:</b> '+esc(rr.reasonText||rr.cause)+'</div>'+
          '<div class="aiReasonMsg" style="color:var(--scada-cyan);"><b>Action:</b> '+esc(rr.action)+'</div>'+
        '</div>';
      }
      list.innerHTML=out;
    }
  }
}

// =========================================================
// 8. DATA FETCHING (REST API via fetch)
// =========================================================

function fetchHistory(beltName){
  setText("modalTitle","History 24h — "+beltName);
  setHTML("modalBody","<div class='skeleton' style='height:30px;margin-bottom:6px;'></div><div class='skeleton' style='height:20px;margin-bottom:4px;'></div><div class='skeleton' style='height:20px;'></div>");
  openModal();
  
  callGasAPI('getHistory24h', {beltName: beltName})
    .then(data => {
      if(!data||data.ok===false){setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc((data&&data.error)?data.error:"unknown")+'</div>'); return;}
      renderHistory(data);
    })
    .catch(err => {
      setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc(String(err))+'</div>');
    });
}

var _vibPollCount = 0;
function refreshVibStatus_(){
  var timeRange = (_vibPollCount % 30 === 0) ? "5d" : "4h";
  _vibPollCount++;

  callGasAPI('getVibData', {rangeKey: timeRange})
    .then(res => {
      if(!res || res.ok === false) return;
      if(timeRange === "5d") window.__TREND_VIB_DATA__ = res;
      window.__LAST_VIB_DATA__ = res; 

      for(var i=0; i<MAP_POINTS.length; i++){
        var p = MAP_POINTS[i];
        if(p.modes && p.modes.includes("VIB") && p.__el && __PAGE_MODE__ === "VIB") {
          var posData = res[p.pos];
          if(!posData) continue; 

          var d18 = posData.data18 || [];
          var d20 = posData.data20 || [];
          var name18 = posData.name18;
          var name20 = posData.name20;
          
          var latest18 = d18.length > 0 ? d18[d18.length-1] : null;
          var latest20 = d20.length > 0 ? d20[d20.length-1] : null;

          var v18 = latest18 ? (Number(latest18.acc) || 0) : 0;
          var v20 = latest20 ? (Number(latest20.acc) || 0) : 0;
          var warnLimit = p.vibWarn || 30;
          var dangerLimit = p.vibDanger || 60;

          var lv18 = "NORMAL";
          if (v18 > dangerLimit) lv18 = "DANGER";
          else if (v18 > warnLimit) lv18 = "WARN";

          var lv20 = "NORMAL";
          if (v20 > dangerLimit) lv20 = "DANGER";
          else if (v20 > warnLimit) lv20 = "WARN";

          var now = Date.now();
          if(latest18 && (now - latest18.ts > 1200000)) lv18 = "OFFLINE";
          if(latest20 && (now - latest20.ts > 1200000)) lv20 = "OFFLINE";

          var worst = "NORMAL";
          if(lv18 === "DANGER" || lv20 === "DANGER") worst = "DANGER";
          else if(lv18 === "WARN" || lv20 === "WARN") worst = "WARN";
          
          if(name20) {
            if(lv18 === "OFFLINE" && lv20 === "OFFLINE") worst = "OFFLINE";
          } else {
            if(lv18 === "OFFLINE") worst = "OFFLINE";
          }

          var acc18Str = latest18 ? Number(latest18.acc || 0).toFixed(2) + " mm/s" : "-";
          var acc20Str = latest20 ? Number(latest20.acc || 0).toFixed(2) + " mm/s" : "-";

          var cls = (worst === "DANGER") ? "open" : (worst === "WARN" ? "stuck" : (worst === "OFFLINE" ? "stale" : "ok"));
          applyMapDotState_(p.__el, "VIB", cls, true);

          var sumEl = $id("posSum_" + p.pos + "_VIB");
          if(sumEl) sumEl.textContent = worst;

          var bodyEl = $id("posBody_" + p.pos + "_VIB");
          if(bodyEl) {
            var lineCls18 = (lv18 === "DANGER") ? "pos-open" : (lv18 === "WARN" ? "pos-stuck" : (lv18 === "OFFLINE" ? "pos-stale" : "pos-ok"));
            var lineCls20 = (lv20 === "DANGER") ? "pos-open" : (lv20 === "WARN" ? "pos-stuck" : (lv20 === "OFFLINE" ? "pos-stale" : "pos-ok"));
            
            var cardHtml = 
              '<div class="posLine ' + lineCls18 + '">' +
                '<div class="posLeft"><span class="posChip"></span><span>' + name18 + '</span></div>' +
                '<div class="posRight mono"><span>' + acc18Str + '</span></div>' +
              '</div>';
              
            if(name20) {
              cardHtml += 
              '<div class="posLine ' + lineCls20 + '" style="border-top:1px solid rgba(255,255,255,0.07); padding-top:3px; margin-top:3px;">' +
                '<div class="posLeft"><span class="posChip"></span><span>' + name20 + '</span></div>' +
                '<div class="posRight mono"><span>' + acc20Str + '</span></div>' +
              '</div>';
            }
            bodyEl.innerHTML = cardHtml;
          }
        }
      }
      if(__PAGE_MODE__ === "AI" && window.__LAST_DATA__) renderAiAnalysis_(window.__LAST_DATA__);
      setTimeout(adjustCardPositions_, 100);
    })
    .catch(err => console.error("Vib Fetch Error:", err));
}

function fetchVibData(rangeKey, pos) {
  rangeKey = rangeKey || "4h";
  pos = pos || window.__CURRENT_VIB_POS__ || 1; 
  window.__CURRENT_VIB_POS__ = pos;
  
  var titleText = (pos == 2) ? "Vibration & Sound ก้นกะพ้อ CM11_6532" : 
                  (pos == 3) ? "Vibration & Sound CM9_542.22" : 
                  (pos == 4) ? "Vibration & Sound Gyp_6413.03" : "Vibration & Sound ก้นกะพ้อ CM10_6522";
                  
  setText("modalTitle", titleText);
  destroyAllModalCharts_();
  setHTML("modalBody","<div class='skeleton' style='height:40px;margin-bottom:8px;'></div><div class='skeleton' style='height:240px;margin-bottom:8px;'></div><div class='skeleton' style='height:240px;'></div>");
  openModal();

  callGasAPI('getVibData', {rangeKey: rangeKey})
    .then(res => {
      if(!res||res.ok===false){ setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc((res&&res.error)?res.error:"unknown")+'</div>'); return; }
      renderVibModal_(res, rangeKey, pos);
    })
    .catch(err => {
      setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc(String(err))+'</div>');
    });
}

function fetchPm10SnapshotAll_() {
  var pmPoints = [];
  for(var i=0; i<MAP_POINTS.length; i++) {
    if(MAP_POINTS[i].modes && MAP_POINTS[i].modes.includes("PM10")) {
      pmPoints.push(MAP_POINTS[i]);
    }
  }

  if(pmPoints.length === 0) {
    lastPm10FetchTime = 0;
    return;
  }

  for(var j=0; j<pmPoints.length; j++) {
    var pos = pmPoints[j].pos;
    if (!__PM10_LATEST__[pos]) {
       var sumEl = document.getElementById("posSum_" + pos + "_PM10");
       var bodyEl = document.getElementById("posBody_" + pos + "_PM10");
       if(sumEl) sumEl.textContent = "...";
       if(bodyEl) bodyEl.innerHTML = '<div class="posLine pos-stale"><div class="posLeft"><span class="posChip"></span><span>PM10</span></div><div class="posRight mono"><span>Loading...</span></div></div>';
    }
  }

  callGasAPI('getPm10SnapshotAll')
    .then(res => {
       if(res && res.ok && res.data) {
         for (var posKey in res.data) {
           var posNum = Number(posKey);
           var latestData = res.data[posKey]; 
           setPm10Latest_(posNum, latestData);
           updateMapDotPm10_(posNum);
         }
         if(__PAGE_MODE__ === "PM10") {
             updatePosCards_PM10_();
         }
       }
    })
    .catch(err => console.error("PM10 Batch Fetch error: ", err));
}

function fetchPm10ForPos_(pos,forceRefresh){
  var hasCache=hasUsablePm10Series_(pos);
  var canUseCache=hasCache&&!forceRefresh&&isFreshPm10SeriesCache_(pos);

  setText("modalTitle","PM10 • POS "+pos);
  if(canUseCache){
    renderPm10Modal_(pos,{ok:true,rows:__PM10_SERIES__[pos]||[]});
    openModal();
    return;
  }

  if(__PM_FETCH_LOCK__&&hasCache){
    renderPm10Modal_(pos,{ok:true,rows:__PM10_SERIES__[pos]||[]});
    openModal();
    return;
  }
  if(__PM_FETCH_LOCK__){showToast("PM10 busy","warn","please wait…");return;}

  __PM_FETCH_LOCK__=true;
  destroyAllModalCharts_();
  setHTML("modalBody","<div class='skeleton' style='height:80px;margin-bottom:8px;'></div><div class='skeleton' style='height:240px;'></div>");
  openModal();

  callGasAPI('getPm10Latest100', {pos: pos})
    .then(res => {
      __PM_FETCH_LOCK__=false;
      if(!res||res.ok===false){
        if(hasCache){
          renderPm10Modal_(pos,{ok:true,rows:__PM10_SERIES__[pos]||[]});
          showToast("PM10 cached","warn","showing cached data");
          return;
        }
        setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc((res&&res.error)?res.error:"unknown")+'</div>');
        return;
      }
      cachePm10Series_(pos,res.rows||[]);
      updateMapDotPm10_(pos);
      if(__PAGE_MODE__==="PM10") updatePosCards_PM10_();
      renderPm10Modal_(pos,res);
    })
    .catch(err => {
      __PM_FETCH_LOCK__=false;
      if(hasCache){
        renderPm10Modal_(pos,{ok:true,rows:__PM10_SERIES__[pos]||[]});
        showToast("PM10 cached","warn","showing cached data");
        return;
      }
      setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc(String(err))+'</div>');
    });
}

function loadLogo(){
  var img=$id("logoImg"); if(!img) return;
  var cached=null;
  try{ cached=localStorage.getItem("scada_logo"); }catch(e){}
  if(cached){
    img.src=cached; img.style.display="block";
    return;
  }
  callGasAPI('getLogoBase64')
    .then(res => {
      if(!res||res.ok===false) return;
      img.src=res.dataUrl; img.style.display="block";
      try{ localStorage.setItem("scada_logo", res.dataUrl); }catch(e){}
    })
    .catch(err => console.error("Logo fetch error:", err));
}

var REFRESH_SECONDS=(window.innerWidth<=768)?45:30;
var failStreak=0,reloading=false,fetchInFlight=false,pollTimer=null;
function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
function startPolling(){stopPolling();pollTimer=setInterval(fetchStatus,REFRESH_SECONDS*1000);}
function recordFetchOK(){
  if(failStreak>=2) showToast("Connection recovered","ok","fetch ok");
  failStreak=0; setConnBadge("ok","LIVE");
}
function recordFetchFail(reason){
  failStreak++;
  setConnBadge(failStreak>=3?"err":"warn","FAIL "+failStreak);
  showToast("Fetch failed","warn",(reason||"unknown")+" • streak "+failStreak+"/3");
}

var lastPm10FetchTime = 0; 
function fetchStatus(){
  if(reloading||fetchInFlight) return;
  fetchInFlight=true;
  setConnBadge("warn","...");
  var done=false;
  var tmr=setTimeout(function(){if(done) return;done=true;fetchInFlight=false;recordFetchFail("timeout");},20000);
  
  var now = Date.now();
  if(!__PM_FETCH_LOCK__ && (now - lastPm10FetchTime > 60000)) { 
     lastPm10FetchTime = now;
     fetchPm10SnapshotAll_();
  }

  if(__PAGE_MODE__==="VIB" || __PAGE_MODE__==="AI") refreshVibStatus_();

  callGasAPI('getStatusAll')
    .then(data => {
      if(reloading||done) return; done=true; clearTimeout(tmr); fetchInFlight=false;
      setText("lastFetch",new Date().toLocaleString("th-TH"));
      if(!data||data.ok===false){
        if (data && data.error === "SYSTEM_WARMING_UP") {
           showToast("Warming Up", "warn", data.message);
           setConnBadge("warn", "WAIT");
        } else {
           recordFetchFail(data&&data.error?data.error:"server error");
        }
        return;
      }
      recordFetchOK(); 
      render(data);
    })
    .catch(err => {
      if(reloading||done) return; done=true; clearTimeout(tmr); fetchInFlight=false; recordFetchFail(String(err));
    });
}

document.addEventListener("visibilitychange",function(){
  if(document.hidden){
    stopPolling();
    stopAutoSwitch_();
  }else{
    if(reloading) return;
    failStreak=0;fetchInFlight=false;fetchStatus();startPolling();
    if(__AUTO_SWITCH_ENABLED__) startAutoSwitch_();
    if(__PAGE_MODE__==="PM10") fetchPm10SnapshotAll_();
  }
});

// =========================================================
// 9. HISTORY MODAL RENDERING
// =========================================================
function tagHtml(type,isStop){
  if(type==="OPEN") return '<span class="tagOpen">OPEN</span>';
  if(type==="STUCK") return '<span class="tagStuck">STUCK</span>';
  if(type==="SWAY") return '<span class="tagStuck">SWAY</span>';
  if(type==="SLEEP") return isStop?'<span class="tagOther">STOP</span>':'<span class="tagOk">NORMAL</span>';
  if(type==="STALE") return '<span class="tagOther">STALE</span>';
  if(type==="OTHER") return '<span class="tagOther">OTHER</span>';
  return '<span class="tagOther">'+esc(type||"")+'</span>';
}
function rpmCellInfo_(r){
  var raw=(r&&r.rpm!=null)?r.rpm:"";
  var s=(raw===""||raw==null)?"":String(raw).trim();
  var n=(s==="")?null:Number(s); var isNum=(n!=null&&isFinite(n));
  var isZero=false,isRun=false;
  if(isNum){if(n<=0) isZero=true; else isRun=true;}
  var text=(s==="")?"-":s;
  var cls="rpmCell "; if(text==="-") cls+="rpmDash"; else if(isRun) cls+="rpmRun"; else if(isZero) cls+="rpmZero"; else cls+="rpmDash";
  return{text:text,cls:cls,n:n,has:(s!=="")};
}
function renderHistory(history){
  var belt=history.belt,group=history.group||"",rows=history.rows||[];
  var html='<div class="mono" style="color:var(--muted);margin-bottom:9px;">CM: <b>'+esc(group)+'</b></div>';
  if(!rows.length){ html+='<div class="mono" style="color:var(--muted);">No data</div>'; }
  else {
    html+='<table><thead><tr><th style="width:195px;">Time</th><th style="width:100px;">Type</th><th>Msg</th><th style="width:100px;">SWAY</th><th style="width:80px;">DIR</th><th style="width:150px;">RPM</th></tr></thead><tbody>';
    for(var i=0;i<rows.length;i++){
      var r=rows[i]; var rpmInfo=rpmCellInfo_(r);
      var isStop=false;
      if(r.type==="SLEEP"){if(!rpmInfo.has) isStop=true;
      else{var nn=Number(rpmInfo.n); if(!isFinite(nn)||nn<=0) isStop=true;}}
      var dirMini=r.dir?("  DIR:"+esc(r.dir)):""; var msgText=r.msg?(esc(r.msg)+dirMini):(dirMini);
      var sc=(r&&r.swayCountHour!=null)?Number(r.swayCountHour):0; if(!isFinite(sc)) sc=0;
      var sd=(r&&r.swayDirHour!=null)?String(r.swayDirHour).trim().toUpperCase():"";
      function fullDirName(d){if(d==="N") return "NORTH"; if(d==="S") return "SOUTH"; if(d==="E") return "EAST"; if(d==="W") return "WEST"; return "";}
      var scText=(sc>0)?(history.belt||""):"-"; var sdText=(sc>0&&sd)?fullDirName(sd):"-";
      html+='<tr><td>'+esc(r.time)+'</td><td>'+tagHtml(r.type,isStop)+'</td><td>'+msgText+'</td><td class="mono" style="text-align:center;font-weight:900;">'+esc(scText)+'</td><td class="mono" style="text-align:center;font-weight:900;">'+esc(sdText)+'</td><td class="'+esc(rpmInfo.cls)+'">'+esc(rpmInfo.text)+'</td></tr>';
    }
    html+='</tbody></table>';
  }
  setText("modalTitle","History 24h — "+belt+" ("+group+")");
  setHTML("modalBody",html);
}

// =========================================================
// 10. VIBRATION MODAL & CHARTS
// =========================================================
function renderVibModal_(res, currentRange, isGroup2) {
  var pos = isGroup2;
  if (pos === true) pos = 2;
  if (pos === false || !pos) pos = 1;
  pos = parseInt(pos);

  var rawD18 = [], rawD20 = [];
  var name18 = "", name20 = "";
  var posArg = pos; 

  if (pos === 2) {
    rawD18 = res.data32_18 || (res[2] ? res[2].data18 : []);
    rawD20 = res.data32_20 || (res[2] ? res[2].data20 : []);
    name18 = "CM11_6532.18";
    name20 = "CM11_6532.20";
  } else if (pos === 3) {
    rawD18 = res.data3_18 || (res[3] ? res[3].data18 : []);
    rawD20 = [];
    name18 = "CM9_542.22";
    name20 = "";
  } else if (pos === 4) {
    rawD18 = res.data4_18 || (res[4] ? res[4].data18 : []);
    rawD20 = [];
    name18 = "Gyp_6413.03";
    name20 = "";
  } else {
    rawD18 = res.data18 || (res[1] ? res[1].data18 : []);
    rawD20 = res.data20 || (res[1] ? res[1].data20 : []);
    name18 = "CM10_6522.18";
    name20 = "CM10_6522.20";
    posArg = 1;
  }

  currentRange = currentRange || "4h";
  var d18 = downsampleVibData_(rawD18, currentRange);
  var d20 = downsampleVibData_(rawD20, currentRange);

  var html = '<div style="display:flex;flex-direction:column;gap:10px;">';
  html += '<div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); padding:10px 12px; border-radius:10px; border:1px solid var(--border);">';
  html += '<div style="font-weight:900; font-size:13px;">📈 เลือกช่วงเวลาดูแนวโน้ม</div>';
  html += '<select style="background:var(--panel); color:var(--text); border:1px solid var(--border); padding:6px 12px; border-radius:8px; font-weight:bold; cursor:pointer; outline:none;" onchange="fetchVibData(this.value, ' + posArg + ')">';
  html += '<option value="4h" '+(currentRange==="4h"?"selected":"")+'>4 ชั่วโมงล่าสุด (~80 รายการ)</option>';
  html += '<option value="8h" '+(currentRange==="8h"?"selected":"")+'>8 ชั่วโมงย้อนหลัง (~160 รายการ)</option>';
  html += '<option value="12h" '+(currentRange==="12h"?"selected":"")+'>12 ชั่วโมงย้อนหลัง (~240 รายการ)</option>';
  html += '<option value="24h" '+(currentRange==="24h"?"selected":"")+'>1 วันล่าสุด (~480 รายการ)</option>';
  html += '<option value="2d" '+(currentRange==="2d"?"selected":"")+'>2 วันย้อนหลัง (~960 รายการ)</option>';
  html += '<option value="3d" '+(currentRange==="3d"?"selected":"")+'>3 วันย้อนหลัง (~1440 รายการ)</option>';
  html += '</select>';
  html += '</div>';

  var pConfig = MAP_POINTS.find(function(mp) { return mp.pos === posArg && mp.modes.includes("VIB"); });
  var warnLimit = pConfig ? (pConfig.vibWarn || 30) : 30;
  var dangerLimit = pConfig ? (pConfig.vibDanger || 60) : 60;

  function makeVibCard_(title, data, canvasId) {
    var latest = data.length ? data[data.length-1] : null;
    var now = Date.now();
    var isOffline = latest ? (now - latest.ts > 1200000) : true;
    var vVibNum = latest ? (Number(latest.acc) || 0) : 0;
    var statusText = "NORMAL";
    if (isOffline) statusText = "OFFLINE";
    else if (vVibNum > dangerLimit) statusText = "DANGER";
    else if (vVibNum > warnLimit) statusText = "WARN";
    else if (latest && latest.level.includes("IDLE")) statusText = "IDLE";

    var color = (statusText === "DANGER") ? "var(--open)" : ((statusText === "WARN") ? "var(--stuck)" : "var(--ok)");
    if (isOffline) color = "var(--stale)";

    return '<div class="rCard" style="padding:10px; margin-bottom:10px; position:relative; z-index:1;">' +
           '<div style="display:flex; justify-content:space-between; margin-bottom:6px;">' +
           '<div class="mono" style="color:var(--text);font-weight:bold;font-size:14px;">' + title + '</div>' +
           '<div class="mono" style="color:' + color + ';font-weight:bold;">' + statusText + '</div>' +
           '</div>' +
           '<div style="height:240px;width:100%;"><canvas id="' + canvasId + '"></canvas></div>' +
           '</div>';
  }

  html += makeVibCard_(name18, d18, "vibChart18");
  if (name20) {
    html += makeVibCard_(name20, d20, "vibChart20");
  }
  html += '</div>';
  setHTML("modalBody", html);

  setTimeout(function(){
    drawVibDualChart_("vibChart18", d18, d18, d20);
    if (name20) {
      drawVibDualChart_("vibChart20", d20, d18, d20);
    }
  }, 50);
}

function downsampleVibData_(data, rangeKey) {
  if (!data || data.length === 0) return [];
  const MAX_POINTS_ON_CHART = 300; 
  let step = Math.ceil(data.length / MAX_POINTS_ON_CHART);
  if (step <= 1) return data;
  const result = [];
  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step);
    let maxObj = chunk[0];
    let maxAcc = -999;
    let maxSound = -999;
    for (let j = 0; j < chunk.length; j++) {
      const r = chunk[j];
      const acc = Number(r.acc) || 0;
      const sound = Number(r.sound) || 0;
      if (acc > maxAcc) { maxAcc = acc; maxObj = Object.assign({}, r); }
      if (sound > maxSound) maxSound = sound;
      if (r.level.includes("DANGER")) maxObj.level = r.level;
      else if ((r.level.includes("WARN") || r.level.includes("CHECK")) && !maxObj.level.includes("DANGER")) maxObj.level = r.level;
    }
    result.push({
      time: maxObj.time, ts: maxObj.ts, level: maxObj.level, score: maxObj.score, reason: maxObj.reason, advice: maxObj.advice,
      acc: maxAcc, sound: maxSound, temp: maxObj.temp
    });
  }
  return result;
}

var __VIB_CHARTS__ = {};
function drawVibDualChart_(canvasId, data, allD18, allD20) {
  var cvs = document.getElementById(canvasId);
  if(!cvs) return;
  if(__VIB_CHARTS__[canvasId]) { __VIB_CHARTS__[canvasId].destroy(); }

  let globalMaxVib = 0; let globalMaxSound = 0;
  let globalMinVib = Infinity; let globalMinSound = Infinity;

  [allD18, allD20].forEach(function(d) {
    if(d && d.length > 0) {
      let maxV = Math.max.apply(null, d.map(function(r){return r.acc||0}));
      let maxS = Math.max.apply(null, d.map(function(r){return r.sound||0}));
      if (maxV > globalMaxVib) globalMaxVib = maxV;
      if (maxS > globalMaxSound) globalMaxSound = maxS;

      let minV = Math.min.apply(null, d.map(function(r){return r.acc||0}));
      let minS = Math.min.apply(null, d.map(function(r){return r.sound||0}));
      if (minV < globalMinVib) globalMinVib = minV;
      if (minS < globalMinSound) globalMinSound = minS;
    }
  });

  if (globalMinVib === Infinity) globalMinVib = 0;
  if (globalMinSound === Infinity) globalMinSound = 40;

  let targetMaxVib = Math.max(3, globalMaxVib * 1.1);       
  let targetMaxSound = Math.max(90, globalMaxSound + 5);   
  let targetMinVib = Math.max(0, globalMinVib - 0.5); 
  let targetMinSound = Math.max(0, globalMinSound - 5);

  var labels = data.map(function(r){ return r.time; });
  var acc = data.map(function(r){ return r.acc; });
  var sound = data.map(function(r){ return r.sound; });

  var isDark = (document.body.getAttribute("data-theme") || "night") !== "day";
  var gridColor = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)";
  var textColor = isDark ? "#9fb2c9" : "#4b5b70";

  __VIB_CHARTS__[canvasId] = new Chart(cvs, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: "Vibration (mm/s)", data: acc, borderColor: "#e74c3c", backgroundColor: "rgba(231,76,60,0.1)", yAxisID: 'y', tension: 0.1, fill: true, borderWidth: 2, pointRadius: 1 },
        { label: "Sound (dB)", data: sound, borderColor: "#3498db", backgroundColor: "rgba(52,152,219,0.1)", yAxisID: 'y1', tension: 0.1, fill: true, borderWidth: 2, pointRadius: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { 
        legend: { display: false },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
        }
      },
      scales: {
        x: { ticks: { color: textColor, maxTicksLimit: 10 }, grid: { color: gridColor } },
        y: { 
          type: 'linear', position: 'left', ticks: { color: '#e74c3c' }, grid: { color: gridColor }, 
          suggestedMin: targetMinVib, suggestedMax: targetMaxVib  
        },
        y1: { 
          type: 'linear', position: 'right', ticks: { color: '#3498db' }, grid: { drawOnChartArea: false }, 
          suggestedMin: targetMinSound, suggestedMax: targetMaxSound  
        }
      }
    }
  });
}

// =========================================================
// 11. MAP & POPUP RENDERERS
// =========================================================

// คำนวณขอบซ้ายเผื่อให้กล่อง Alarm
function getMapLeftPadding_() {
  if (window.innerWidth <= 768) return 50; 
  var panel = document.getElementById("leftAlarmPanel");
  if (panel && panel.style.display !== "none" && !panel.classList.contains("collapsed")) {
    return 250; 
  }
  return 60; 
}

// =========================================================
// เพิ่มฟังก์ชันจัดตำแหน่ง posCard ไม่ให้ล้นขอบจอ
// =========================================================
function adjustCardPositions_() {
  var canvas = document.getElementById("mapCanvas");
  if (!canvas || typeof map === 'undefined' || !map) return;
  
  var cr = canvas.getBoundingClientRect();
  var currentZoom = map.getZoom();
  var BASE_ZOOM = map.__BASE_ZOOM || 17.5;
  var scaleFactor = Math.pow(2, currentZoom - BASE_ZOOM);

  var leftOffset = getMapLeftPadding_(); 

  for (var i = 0; i < MAP_POINTS.length; i++) {
    var p = MAP_POINTS[i];
    if (p.__card && p.__card.style.display !== "none") {
      var dx = p.labelDx || 0;
      var dy = p.labelDy || 0;
      p.__card.style.transform = "translate(" + dx + "px," + dy + "px)";
      
      var rect = p.__card.getBoundingClientRect();
      var shiftX = 0;
      var shiftY = 0;
      
      if (rect.left < cr.left + leftOffset) shiftX = (cr.left + leftOffset - rect.left) / scaleFactor;
      if (rect.right > cr.right - 12) shiftX = (cr.right - 12 - rect.right) / scaleFactor;
      if (rect.top < cr.top + 12) shiftY = (cr.top + 12 - rect.top) / scaleFactor;
      if (rect.bottom > cr.bottom - 12) shiftY = (cr.bottom - 12 - rect.bottom) / scaleFactor;
      
      if (shiftX !== 0 || shiftY !== 0) {
         p.__card.style.transform = "translate(" + (dx + shiftX) + "px," + (dy + shiftY) + "px)";
      }
    }
  }
}

// =========================================================
// เพิ่มฟังก์ชันสำหรับจัดกรอบแผนที่ให้เห็น POS ครบทุกจุดอัตโนมัติ
// =========================================================
function fitMapToActivePoints_() {
  if (typeof map === 'undefined' || !map) return;
  var bounds = L.latLngBounds();
  var hasPoints = false;
  
  for (var i = 0; i < MAP_POINTS.length; i++) {
    if (MAP_POINTS[i].modes && MAP_POINTS[i].modes.includes(__PAGE_MODE__)) {
      bounds.extend([MAP_POINTS[i].lat, MAP_POINTS[i].lng]);
      hasPoints = true;
    }
  }
  
  var leftPad = getMapLeftPadding_();
  var MAX_Z = 16.8; 
  
  if (hasPoints) {
    map.fitBounds(bounds, { paddingTopLeft: [leftPad, 60], paddingBottomRight: [60, 60], maxZoom: MAX_Z });
    setTimeout(adjustCardPositions_, 300);
  } else if (map.__factoryBounds) {
    map.fitBounds(map.__factoryBounds, { paddingTopLeft: [leftPad, 60], paddingBottomRight: [60, 60], maxZoom: MAX_Z });
  }
}

function ensureMapPopup_(){
  var canvas=$id("mapCanvas");
  if(!canvas) return null;
  var ex=$id("mapPopup"); if(ex) return ex;
  var pop=document.createElement("div");
  pop.id="mapPopup"; pop.className="mapPopup";
  pop.innerHTML='<div class="mapPopupHead"><div class="mapPopupTitle" id="mapPopupTitle">POS</div><button class="mapPopupClose" id="mapPopupClose">✕</button></div><div class="mapPopupBody" id="mapPopupBody"></div>';
  canvas.appendChild(pop);
  pop.addEventListener("click",function(ev){if(ev.stopPropagation) ev.stopPropagation();});
  var closeBtn=$id("mapPopupClose");
  if(closeBtn) closeBtn.addEventListener("click",function(ev){if(ev.stopPropagation) ev.stopPropagation(); hideMapPopup_();});
  canvas.addEventListener("click",function(){hideMapPopup_();});
  return pop;
}
function hideMapPopup_(){ var pop=$id("mapPopup"); if(pop) pop.style.display="none"; }

function buildMiniCardHtml_(item){
  var c=clsFor(item);
  var isStale=(item.currentStatus==="ALERT"&&item.currentAlarmType==="STALE");
  var runHtml=(isStale||item.hideRunTag)?"":runTag(item.run||0);
  var showAlarm=(item.currentStatus==="ALERT"&&item.currentAlarmMsg);
  var lineLabel=(item.currentStatus==="ALERT")?"Alarm time":"Sleep time";
  var lineTime=item.currentTime||"-";
  var swayHtml=buildSwayHtml(item);
  var offlineBadge=isStale?'<span class="badge-offline">OFFLINE</span>':'';
  
  return `
    <div class="miniTitleRow">
      <div class="miniTitle">${esc(item.belt)} ${offlineBadge} ${runHtml}</div>
      <div class="badge ${esc(c.badge)}">${esc(c.text)}</div>
    </div>
    <div class="miniSmall">${esc(lineLabel)}: <span class="mono">${esc(lineTime)}</span></div>
    ${showAlarm ? `<div class="miniAlarm mono">${esc(item.currentAlarmMsg)}</div>` : ''}
    ${swayHtml || ''}
  `;
}

function showPosCards_(pos, anchorEl) {
  if (__PAGE_MODE__ === "PM10") { hideMapPopup_(); fetchPm10ForPos_(pos); return; }
  if (__PAGE_MODE__ === "VIB") { hideMapPopup_(); fetchVibData("6h", pos); return; }

  var pop = ensureMapPopup_();
  if (!pop) return;
  var data = window.__LAST_DATA__;
  var belts = (data && data.belts) ? data.belts : [];
  var map = {};
  for (var i = 0; i < belts.length; i++) { if (belts[i] && belts[i].belt) map[String(belts[i].belt)] = belts[i]; }
  var point = null;
  for (var j = 0; j < MAP_POINTS.length; j++) { if (MAP_POINTS[j].pos === pos) { point = MAP_POINTS[j]; break; } }
  if (!point) return;
  var list = [];
  for (var k = 0; k < point.belts.length; k++) { var name = point.belts[k]; if (map[name]) list.push(map[name]); }
  setText("mapPopupTitle", "POS " + pos + " • " + point.belts.join(", "));
  var body = $id("mapPopupBody"); if (!body) return;
  body.innerHTML = "";
  if (!list.length) {
    body.innerHTML = '<div class="mono" style="color:var(--muted);font-weight:900;">No belt data for this POS</div>';
  } else {
    for (var x = 0; x < list.length; x++) {
      (function(item) {
        var div = document.createElement("div");
        div.className = "miniCard"; div.innerHTML = buildMiniCardHtml_(item);
        div.addEventListener("click", function(ev) { if (ev.stopPropagation) ev.stopPropagation(); hideMapPopup_(); fetchHistory(item.belt); });
        body.appendChild(div);
      })(list[x]);
    }
  }
  var canvas = $id("mapCanvas");
  if (!canvas) return;
  var cr = canvas.getBoundingClientRect();
  var ar = anchorEl ? anchorEl.getBoundingClientRect() : cr;
  pop.style.display = "block";
  var pw = pop.offsetWidth || 280, ph = pop.offsetHeight || 200;
  var dotLeft = ar.left - cr.left, dotTop = ar.top - cr.top;
  var left = dotLeft + 16, top = dotTop + 16;
  if (left + pw > cr.width - 8) left = Math.max(8, dotLeft - pw - 8);
  if (top + ph > cr.height - 8) top = Math.max(8, dotTop - ph - 8);
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  pop.style.left = left + "px"; pop.style.top = top + "px";
}

function buildMapDotsOnce_() {
  var canvas = $id("mapCanvas"); 
  if(!canvas || canvas.__dotsBuilt) return;
  canvas.__dotsBuilt = true;
  ensureMapPopup_();

  callGasAPI('getMapPointsData')
    .then(points => {
      MAP_POINTS = points;
      mapCoords = {};
      points.forEach(p => {
        mapCoords[p.pos] = { lat: p.lat, lng: p.lng };
      });
      initLeafletMap_();
      fetchPm10SnapshotAll_(); 
    })
    .catch(err => console.error("Map points fetch error:", err));
}

function initLeafletMap_() {
  var allBounds = L.latLngBounds();
  var modeBounds = L.latLngBounds();
  var hasAnyPoints = false;
  var hasModePoints = false;

  for (var i = 0; i < MAP_POINTS.length; i++) {
    var p = MAP_POINTS[i];
    if (p.lat && p.lng) {
      allBounds.extend([p.lat, p.lng]);
      hasAnyPoints = true;
      if (p.modes && p.modes.includes(__PAGE_MODE__)) {
        modeBounds.extend([p.lat, p.lng]);
        hasModePoints = true;
      }
    }
  }

  var BASE_ZOOM = 16.5; 
  map = L.map('mapCanvas', {
    zoomControl: false, 
    attributionControl: false,
    zoomSnap: 0.5,       
    wheelPxPerZoomLevel: 120 
  });

  if (hasAnyPoints) { map.__factoryBounds = allBounds; }

  var leftPad = getMapLeftPadding_();
  var MAX_Z = 16.8;

  if (hasModePoints) {
    map.fitBounds(modeBounds, { paddingTopLeft: [leftPad, 60], paddingBottomRight: [60, 60], maxZoom: MAX_Z }); 
    BASE_ZOOM = map.getZoom(); 
  } else if (hasAnyPoints) {
    map.fitBounds(allBounds, { paddingTopLeft: [leftPad, 60], paddingBottomRight: [60, 60], maxZoom: MAX_Z });
    BASE_ZOOM = map.getZoom();
  } else {
    map.setView([14.5, 100.5], 16.5);
  }
  
  map.__BASE_ZOOM = BASE_ZOOM; 
  
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 22,
    maxNativeZoom: 17
  }).addTo(map);

  var markerWrappers = [];

  for(var i=0; i<MAP_POINTS.length; i++) {
    (function(p){
      var wrapper = document.createElement('div');
      wrapper.style.position = 'relative';
      wrapper.style.transformOrigin = "0 0";

      var d = document.createElement("div");
      d.className = "mapDot ok"; 
      d.textContent = String(p.pos);
      p.__el = d;

      var card = document.createElement("div");
      card.className = "posCard"; 
      card.style.transform = "translate("+p.labelDx+"px,"+p.labelDy+"px)";
      card.innerHTML = '<div class="posCardTitle"><div class="t">POS '+p.pos+'</div><div class="sum mono" id="posSum_'+p.pos+'_'+p.modes[0]+'">-</div></div><div class="posCardBody" id="posBody_'+p.pos+'_'+p.modes[0]+'"></div>';
      p.__card = card;

      d.addEventListener("click", function(ev) {
        if(ev.stopPropagation) ev.stopPropagation();
        if (window.innerWidth <= 768) {
          var isHidden = (card.style.display === "none" || !card.style.display);
          for (var m = 0; m < MAP_POINTS.length; m++) {
            if (MAP_POINTS[m].__card) MAP_POINTS[m].__card.style.display = "none";
          }
          card.style.display = isHidden ? "block" : "none";
        } else {
          showPosCards_(p.pos, wrapper);
        }
      });

      card.addEventListener("click", function(ev) {
        if(ev.stopPropagation) ev.stopPropagation();
        showPosCards_(p.pos, wrapper);
      });

      wrapper.appendChild(d);
      wrapper.appendChild(card);
      
      p.__marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'scada-leaflet-marker', html: wrapper, iconSize: [0, 0] })
      });

      if (p.modes && p.modes.includes(__PAGE_MODE__)) {
        p.__marker.addTo(map);
        if (__PAGE_MODE__ === "PM10") {
          p.__card.style.display = "none";
        } else {
          p.__card.style.display = (window.innerWidth <= 768) ? "none" : "block";
        }
      } else { p.__card.style.display = "none"; }

      markerWrappers.push(wrapper);
    })(MAP_POINTS[i]);
  }

  map.on('zoom', function() {
    var currentZoom = map.getZoom();
    var scaleFactor = Math.pow(2, currentZoom - BASE_ZOOM);
    for(var w = 0; w < markerWrappers.length; w++) {
      markerWrappers[w].style.transform = "scale(" + scaleFactor + ")";
    }
    adjustCardPositions_(); 
  });
  map.fire('zoom');
  map.on('move', adjustCardPositions_); 

  map.on('click', function() {
    if(window.innerWidth <= 768) {
      for (var m = 0; m < MAP_POINTS.length; m++) {
        if (MAP_POINTS[m].__card) MAP_POINTS[m].__card.style.display = "none";
      }
    }
  });

  if (__PAGE_MODE__ === "PM10") {
     updateMapDots_PM10_(); updatePosCards_PM10_();
  } else if (__PAGE_MODE__ === "BELT" && window.__LAST_DATA__) {
     updateMapDots_(window.__LAST_DATA__); updatePosCards_(window.__LAST_DATA__);
  }
}

// =========================================================
// 12. PM10 LOGIC & CHARTS
// =========================================================
function pm10Severity_(v){ v=Number(v); if(!isFinite(v)) return "stale"; if(v>=PM10_BAD) return "bad"; if(v>=PM10_WARN) return "warn"; return "ok"; }
var PM10_STALE_MS=60*60*1000;
var PM10_MODAL_CACHE_TTL_MS=2*60*1000;
function parseDMYHMS_(s){
  if(!s) return null;
  var m=String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if(!m) return null;
  return new Date(+m[3],(+m[2])-1,+m[1],+m[4],+m[5],+m[6]);
}
function pm10Ts_(objOrTime){
  if(objOrTime&&typeof objOrTime==="object"){
    var t0=Number(objOrTime.ts);
    if(isFinite(t0)&&t0>0) return t0;
    if(objOrTime.time){
      var d0=parseDMYHMS_(objOrTime.time);
      return d0?d0.getTime():null;
    }
    return null;
  }
  var d=parseDMYHMS_(objOrTime);
  return d?d.getTime():null;
}
function isPm10Stale_(objOrTime){ var ts=pm10Ts_(objOrTime); if(!isFinite(ts)) return true; return(Date.now()-ts)>PM10_STALE_MS; }
function pm10AgeMin_(objOrTime){ var ts=pm10Ts_(objOrTime); if(!isFinite(ts)) return null; return Math.floor((Date.now()-ts)/60000); }
function pickLatestPm10Row_(rows){
  rows=Array.isArray(rows)?rows:[];
  for(var j=rows.length-1;j>=0;j--){
    var row=rows[j];
    if(row&&row.v!=null&&isFinite(Number(row.v))){
      return { v:Number(row.v), time:String(row.time||""), ts:isFinite(Number(row.ts))?Number(row.ts):null };
    }
  }
  return null;
}
function setPm10Latest_(pos, row) { 
  if(row && row.v != null && isFinite(Number(row.v))) { 
    __PM10_LATEST__[pos] = {
      v: Number(row.v),
      time: String(row.time || ""),
      ts: isFinite(Number(row.ts)) ? Number(row.ts) : null,
      loc: row.loc || pos
    }; 
  } else { 
    delete __PM10_LATEST__[pos]; 
  } 
}
function cachePm10Series_(pos,rows){
  __PM10_SERIES__[pos]=Array.isArray(rows)?rows:[];
  __PM10_SERIES_FETCHED_AT__[pos]=Date.now();
  setPm10Latest_(pos,pickLatestPm10Row_(__PM10_SERIES__[pos]));
}
function hasUsablePm10Series_(pos){
  return Array.isArray(__PM10_SERIES__[pos])&&__PM10_SERIES__[pos].length>0;
}
function isFreshPm10SeriesCache_(pos){
  var fetchedAt=Number(__PM10_SERIES_FETCHED_AT__[pos]||0);
  return fetchedAt>0&&(Date.now()-fetchedAt)<=PM10_MODAL_CACHE_TTL_MS;
}
function applyMapDotState_(el, mode, cls, pulse){
  if(!el) return;
  el.className = "mapDot " + cls + (pulse ? (" " + (mode === "PM10" ? "pmPulse" : "beltPulse")) : "");
}
function clearMapDotStateCache_(){
  for(var i=0;i<MAP_POINTS.length;i++){
    var p = MAP_POINTS[i];
    p.__beltStateSig = "";
    p.__pmStateSig = "";
  }
}
function applyPm10Snapshot_(data){
  data=data||{};
  for(var i=0;i<MAP_POINTS.length;i++){
    var pos=MAP_POINTS[i].pos;
    setPm10Latest_(pos,data[pos]||null);
  }
  updateMapDots_PM10_();
  if(__PAGE_MODE__==="PM10") updatePosCards_PM10_();
}
function updateMapDotPm10_(pos){
  var point = null;
  for(var i=0;i<MAP_POINTS.length;i++){
    if(MAP_POINTS[i].pos === pos && MAP_POINTS[i].modes && MAP_POINTS[i].modes.includes("PM10")){
      point = MAP_POINTS[i];
      break;
    }
  }
  
  if(!point || !point.__el) return;
  
  var data = __PM10_LATEST__[pos];
  var nextCls = "stale";
  var nextPulse = false;
  
  if(data && !isPm10Stale_(data)){
    var sev = pm10Severity_(data.v);
    if(sev === "bad"){
      nextCls = "pm-bad";
      nextPulse = true;
    }else if(sev === "warn"){
      nextCls = "pm-warn";
      nextPulse = true;
    }else{
      nextCls = "pm-ok";
      nextPulse = true;
    }
  }

  var valStr = "-";
  if (data && data.v != null && !isPm10Stale_(data)) {
    valStr = Number(data.v).toFixed(0) + " µg"; 
  }

  var nextSig = nextCls + "|" + (nextPulse ? 1 : 0) + "|" + valStr;
  if(point.__pmStateSig === nextSig && __PAGE_MODE__ === "PM10") return;

  point.__pmStateSig = nextSig;
  if(__PAGE_MODE__ === "PM10"){
    applyMapDotState_(point.__el, "PM10", nextCls, nextPulse);
    point.__el.classList.add("pmFocus");
    point.__el.innerHTML = valStr; 
  }
}
function updateMapDots_PM10_(){
  buildMapDotsOnce_();
  for(var j=0;j<MAP_POINTS.length;j++){
    var p=MAP_POINTS[j];
    if(!p.__el) continue;
    updateMapDotPm10_(p.pos);
  }
}

function renderPm10Modal_(pos,res){
  var rows=(res&&res.rows)?res.rows:[];
  var tzNote=(res&&res.tz)?String(res.tz):"";
  function num_(x){ var n=Number(x); return isFinite(n)?n:null; }
  function sev_(v){
    if(v==null) return{txt:"-",cls:"sev0",color:"var(--muted)"};
    if(v>=151) return{txt:"อันตราย ⚠",cls:"sev4",color:"var(--open)"};
    if(v>=91)  return{txt:"ไม่ดีมาก",cls:"sev3",color:"#ff7a00"};
    if(v>=51)  return{txt:"เริ่มมีผล",cls:"sev2",color:"var(--stuck)"};
    if(v>=26)  return{txt:"ปานกลาง",cls:"sev1",color:"#a8d8a8"};
    return{txt:"ดี ✓",cls:"sev0",color:"var(--ok)"};
  }
  function fmt_(v){ if(v==null) return "-"; return(Math.round(v*10)/10).toString(); }

  var latest=null;
  for(var i=rows.length-1;i>=0;i--){
    var vv=num_(rows[i]&&rows[i].v);
    if(vv!=null){latest={time:String(rows[i].time||""),v:vv};break;}
  }
  var latestVal=latest?latest.v:null;
  var latestTime=latest?latest.time:(rows.length?String((rows[rows.length-1]||{}).time||""):"");
  var sev=sev_(latestVal);
  var vals=rows.map(function(r){return num_(r&&r.v);}).filter(function(v){return v!=null;});
  var minV=vals.length?Math.min.apply(null,vals):null;
  var maxV=vals.length?Math.max.apply(null,vals):null;
  var avgV=vals.length?(vals.reduce(function(a,b){return a+b;},0)/vals.length):null;
  var barPct=latestVal!=null?Math.min(100,(latestVal/200)*100):0;
  var barColor=latestVal==null?"var(--muted)":latestVal>=PM10_BAD?"var(--open)":latestVal>=PM10_WARN?"var(--stuck)":"var(--ok)";

  var html='<div style="display:flex;flex-direction:column;gap:10px;">';
  html+='<div class="rCard">';
  html+='<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">';
  html+='<div><div class="mono" style="font-size:26px;font-weight:800;color:'+sev.color+';">'+esc(fmt_(latestVal))+' <span style="font-size:13px;color:var(--muted);">µg/m³</span></div>';
  html+='<div class="mono" style="color:var(--muted);margin-top:3px;font-size:11px;">'+esc(latestTime||"-")+(tzNote?" • "+esc(tzNote):"")+'</div></div>';
  html+='<div class="'+esc(sev.cls)+'" style="font-size:14px;font-weight:900;white-space:nowrap;">'+esc(sev.txt)+'</div></div>';
  html+='<div class="pm10LevelBar"><div class="pm10LevelFill" style="width:'+barPct+'%;background:'+barColor+';"></div></div>';
  html+='<div class="pm10Legend">';
  html+='<div class="pm10LegItem"><div class="pm10LegDot" style="background:var(--ok)"></div><span>OK <50</span></div>';
  html+='<div class="pm10LegItem"><div class="pm10LegDot" style="background:var(--stuck)"></div><span>WARN 50-120</span></div>';
  html+='<div class="pm10LegItem"><div class="pm10LegDot" style="background:var(--open)"></div><span>BAD >120</span></div>';
  html+='</div>';
  html+='<div class="pm10Summary">';
  html+='<div class="pm10StatCard"><div class="pm10StatVal mono">'+esc(fmt_(minV))+'</div><div class="pm10StatLbl">MIN</div></div>';
  html+='<div class="pm10StatCard"><div class="pm10StatVal mono">'+esc(fmt_(avgV?Math.round(avgV*10)/10:null))+'</div><div class="pm10StatLbl">AVG</div></div>';
  html+='<div class="pm10StatCard"><div class="pm10StatVal mono">'+esc(fmt_(maxV))+'</div><div class="pm10StatLbl">MAX</div></div>';
  html+='</div>';
  html+='</div>';
  html+='<div class="rCard" style="padding:10px;">';
  html+='<div class="mono" style="color:var(--muted);margin-bottom:6px;font-size:11px;">PM10 trend — last '+rows.length+' readings</div>';
  html+='<div style="height:240px;width:100%;"><canvas id="pm10Chart"></canvas></div>';
  html+='</div>';

  html+='<div class="rCard" style="padding:10px;">';
  html+='<div style="overflow:auto;max-height:320px;">';
  html+='<table><thead><tr><th>Time</th><th style="text-align:right;">PM10 (µg/m³)</th><th>Status</th></tr></thead><tbody>';
  for(var r=rows.length-1;r>=0;r--){
    var row=rows[r]||{},tv=String(row.time||""),vv2=num_(row.v);
    var rs=sev_(vv2);
    html+='<tr><td class="mono">'+esc(tv)+'</td><td class="mono" style="text-align:right;font-weight:900;color:'+rs.color+';">'+esc(fmt_(vv2))+'</td><td class="'+esc(rs.cls)+'">'+esc(rs.txt)+'</td></tr>';
  }
  html+='</tbody></table></div></div>';
  html+='</div>';

  setText("modalTitle", "PM10 • " + (res.location || "POS " + pos));
  setHTML("modalBody",html);
  try{drawPm10Chart_(rows);}catch(e){console.log("chart err:",e);}
}

var __PM10_CHART__ = null;
function drawPm10Chart_(rows) {
  var cvs = document.getElementById("pm10Chart");
  if (!cvs) return;
  
  if (__PM10_CHART__ && __PM10_CHART__.canvas !== cvs) {
    __PM10_CHART__.destroy();
    __PM10_CHART__ = null;
  }

  var clean = (rows || []).filter(function(r) { 
    return r && r.v != null && isFinite(Number(r.v)); 
  }).map(function(r) { 
    return { time: String(r.time || ""), v: Number(r.v) }; 
  });
  
  if (clean.length > 50) clean = clean.slice(clean.length - 50);
  
  var labels = clean.map(function(r) {
    var t = r.time; 
    if (t.indexOf(" ") >= 0) t = t.split(" ").pop().slice(0, 5); 
    return t;
  });
  
  var data = clean.map(function(r) { return r.v; });
  var pointBg = data.map(function(v) { 
    return v >= PM10_BAD ? "#ff3b30" : v >= PM10_WARN ? "#ff9f0a" : "#1fd27a"; 
  });

  var isDark = (document.body.getAttribute("data-theme") || "night") !== "day";
  var gridColor = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)";
  var textColor = isDark ? "#9fb2c9" : "#4b5b70";
  var isMobile = window.innerWidth <= 768;

  if (__PM10_CHART__) {
    __PM10_CHART__.data.labels = labels;
    __PM10_CHART__.data.datasets[0].data = data;
    __PM10_CHART__.data.datasets[0].pointBackgroundColor = pointBg;
    __PM10_CHART__.data.datasets[0].pointBorderColor = pointBg;
    
    if (__PM10_CHART__.options.scales.x && __PM10_CHART__.options.scales.y) {
      __PM10_CHART__.options.scales.x.ticks.color = textColor;
      __PM10_CHART__.options.scales.x.grid.color = gridColor;
      __PM10_CHART__.options.scales.y.ticks.color = textColor;
      __PM10_CHART__.options.scales.y.grid.color = gridColor;
    }
    __PM10_CHART__.update('none'); 
    
  } else {
    __PM10_CHART__ = new Chart(cvs, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "PM10 (µg/m³)",
          data: data,
          tension: 0.3,
          pointRadius: isMobile ? 1.5 : 3,
          pointHoverRadius: isMobile ? 2 : 5,
          borderWidth: 2,
          pointBackgroundColor: pointBg,
          pointBorderColor: pointBg,
          segment: {
            borderColor: function(ctx) {
              var v = data[ctx.p1DataIndex];
              return v >= PM10_BAD ? "#ff3b30" : v >= PM10_WARN ? "#ff9f0a" : "#1fd27a";
            }
          },
          fill: true,
          backgroundColor: function(ctx) {
            var chart = ctx.chart, c = chart.ctx, area = chart.chartArea;
            if (!area) return "transparent";
            var grad = c.createLinearGradient(0, area.top, 0, area.bottom);
            grad.addColorStop(0, "rgba(255,59,48,.18)");
            grad.addColorStop(0.5, "rgba(255,159,10,.10)");
            grad.addColorStop(1, "rgba(31,210,122,.05)");
            return grad;
          }
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: isMobile ? false : { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              label: function(ctx) {
                var v = ctx.parsed.y;
                var s = v >= PM10_BAD ? "⚠ BAD" : v >= PM10_WARN ? "▲ WARN" : "✓ OK";
                return " " + v.toFixed(1) + " µg/m³ (" + s + ")";
              }
            }
          },
          zoom: {
            pan: { enabled: true, mode: 'x' },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
          }
        },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { 
            ticks: { maxRotation: 0, autoSkip: true, color: textColor, font: { size: 10 } }, 
            grid: { color: gridColor } 
          },
          y: {
            beginAtZero: true,
            ticks: { color: textColor, font: { size: 10 }, callback: function(v) { return v + " µg"; } },
            grid: { color: gridColor },
            afterDataLimits: function(axis) { axis.max = Math.max(axis.max || 0, 150); }
          }
        }
      },
      plugins: [{
        id: "thresholdLines",
        afterDraw: function(chart) {
          var ctx2 = chart.ctx, area = chart.chartArea, yScale = chart.scales.y;
          if (!area) return;
          function drawLine(val, color, label) {
            var y = yScale.getPixelForValue(val);
            if (y < area.top || y > area.bottom) return;
            ctx2.save();
            ctx2.strokeStyle = color; 
            ctx2.lineWidth = 1.5;
            ctx2.setLineDash([5, 4]);
            ctx2.globalAlpha = 0.65;
            ctx2.beginPath(); 
            ctx2.moveTo(area.left, y); 
            ctx2.lineTo(area.right, y); 
            ctx2.stroke();
            ctx2.setLineDash([]);
            ctx2.globalAlpha = 0.85;
            ctx2.fillStyle = color; 
            ctx2.font = "bold 10px ui-monospace,monospace";
            ctx2.fillText(label, area.left + 4, y - 3);
            ctx2.restore();
          }
          drawLine(PM10_WARN, "#ff9f0a", "WARN " + PM10_WARN);
          drawLine(PM10_BAD, "#ff3b30", "BAD " + PM10_BAD);
        }
      }]
    });
  }
}

// =========================================================
// 13. UI MODE / SWITCHING
// =========================================================
function worstLevel_(items){
  var best=0;
  for(var i=0;i<items.length;i++){
    var it=items[i]; if(!it) continue; if(it.currentStatus!=="ALERT") continue;
    var t=String(it.currentAlarmType||""); var lv=2;
    if(t==="OPEN") lv=4; else if(t==="STUCK") lv=3; else if(t==="OTHER") lv=2; else if(t==="STALE") lv=1;
    if(lv>best) best=lv;
  }
  return best;
}
function classFromLevel_(lv){if(lv===4) return"open";if(lv===3) return"stuck";if(lv===2) return"other";if(lv===1) return"stale";return"ok";}
function beltLevel_(it){
  if(!it) return 1;
  if(it.currentStatus==="NO_DATA") return 1; if(it.currentStatus!=="ALERT") return 0;
  if(it.isAcked&&it.currentAlarmType!=="STALE") return 0;
  if(it.currentAlarmType==="OPEN") return 4; if(it.currentAlarmType==="STUCK") return 3;
  if(it.currentAlarmType==="OTHER") return 2;
  if(it.currentAlarmType==="STALE") return 1; return 2;
}
function beltClsSmall_(it){
  var lv=beltLevel_(it);
  if(lv===4) return"pos-open";
  if(lv===3) return"pos-stuck"; if(lv===2) return"pos-other"; if(lv===1) return"pos-stale"; return"pos-ok";
}
function posSummaryText_(lv){if(lv===4) return"OPEN";if(lv===3) return"STUCK";if(lv===2) return"ALERT";if(lv===1) return"STALE";return"OK";}

function updatePosCards_(data){
  if(!data||!data.belts) return;
  var map={};
  for(var i=0;i<data.belts.length;i++){var it=data.belts[i]; if(it&&it.belt) map[String(it.belt)]=it;}
  for(var j=0;j<MAP_POINTS.length;j++){
    var p=MAP_POINTS[j];
    if(!p.__card || !p.modes.includes("BELT")) continue; 
    var worst=0,bodyHtml="";
    for(var k=0;k<p.belts.length;k++){
      var bname=p.belts[k],it2=map[bname]||null,lv=beltLevel_(it2);
      if(lv>worst) worst=lv;
      var runTxt="";
      if(it2&&it2.currentStatus==="ALERT"&&it2.currentAlarmType==="STALE") runTxt="";
      else if(it2&&it2.run!=null) runTxt=(Number(it2.run)===1)?"RUN":"STOP";
      var stTxt="OK";
      if(!it2) stTxt="STALE"; else if(it2.currentStatus==="NO_DATA") stTxt="STALE";
      else if(it2.currentStatus==="ALERT") stTxt=it2.isAcked?"ACK":String(it2.currentAlarmType||"ALERT");
      var lineCls=beltClsSmall_(it2);
      if(it2&&it2.currentStatus!=="ALERT"&&Number(it2.run)===0) lineCls="pos-stop";
      bodyHtml+='<div class="posLine '+esc(lineCls)+'"><div class="posLeft"><span class="posChip"></span><span>'+esc(bname)+'</span></div><div class="posRight mono"><span>'+esc(stTxt)+'</span>'+(runTxt?('<span>• '+esc(runTxt)+'</span>'):'')+' </div></div>';
    }
    var sumEl=$id("posSum_"+p.pos+"_BELT"); if(sumEl) sumEl.textContent=posSummaryText_(worst);
    var bodyEl=$id("posBody_"+p.pos+"_BELT"); if(bodyEl) bodyEl.innerHTML=bodyHtml;
  }
  setTimeout(adjustCardPositions_, 100);
}
function updatePosCards_PM10_(){
  for(var j=0;j<MAP_POINTS.length;j++){
    var p=MAP_POINTS[j];
    if(!p.__card || !p.modes.includes("PM10")) continue; 
    
    var sumEl=$id("posSum_"+p.pos+"_PM10"),bodyEl=$id("posBody_"+p.pos+"_PM10");
    if(!sumEl||!bodyEl) continue;
    
    var latest=__PM10_LATEST__[p.pos];
    var v=(latest&&latest.v!=null)?Number(latest.v):NaN;
    var ageMin=(!isNaN(v)&&latest)?pm10AgeMin_(latest):null;
    var ageTxt=ageMin!=null?(" "+ageMin+"m ago"):"";
    
    if(!isFinite(v)){
      sumEl.textContent="NO"; bodyEl.innerHTML='<div class="posLine pos-stale"><div class="posLeft"><span class="posChip"></span><span>PM10</span></div><div class="posRight mono"><span>- µg/m³</span></div></div>';
      continue;
    }
    
    var sev=pm10Severity_(v);
    var sevTxt=(sev==="bad")?"BAD":(sev==="warn"?"WARN":"OK");
    var lineCls=(sev==="bad")?"pos-open":(sev==="warn"?"pos-stuck":"pos-ok");
    sumEl.textContent=sevTxt;
    bodyEl.innerHTML='<div class="posLine '+lineCls+'"><div class="posLeft"><span class="posChip"></span><span>PM10</span></div><div class="posRight mono"><span>'+esc(v.toFixed(0))+' µg</span><span style="opacity:.6">'+esc(ageTxt)+'</span></div></div>';
  }
  setTimeout(adjustCardPositions_, 100);
}

function isAllStopNoAlarm_(arr){
  if(!arr||!arr.length) return false;
  for(var i=0;i<arr.length;i++){
    var it=arr[i]; if(!it) return false;
    if(it.currentStatus==="NO_DATA") return false;
    if(it.currentStatus==="ALERT") return false;
    if(Number(it.run)!==0) return false;
  }
  return true;
}

function updateMapDots_(data){
  buildMapDotsOnce_();
  if(!data || !data.belts) return;
  if(__PAGE_MODE__==="PM10" || __PAGE_MODE__==="VIB") return;

  var map={};
  for(var i=0;i<data.belts.length;i++){
    var b=data.belts[i];
    if(!b) continue;
    var key=String(b.belt||b.name||b.id||("B"+i));
    map[key]=b;
  }

  function beltLv_(it){
    if(!it) return 1;
    if(it.currentStatus==="NO_DATA") return 1;
    if(it.currentStatus!=="ALERT") return 0;
    if(it.isAcked && it.currentAlarmType!=="STALE") return 0;

    var t=String(it.currentAlarmType||"").toUpperCase();
    if(t==="OPEN")  return 4;
    if(t==="STUCK") return 3;
    if(t==="OTHER") return 2;
    if(t==="STALE") return 1;
    return 2;
  }

  function clsFromLv_(lv){
    if(lv===4) return "open";
    if(lv===3) return "stuck";
    if(lv===2) return "other";
    if(lv===1) return "stale";
    return "ok";
  }

  function isOfflineOnly_(it){
    if(!it) return true;
    if(it.currentStatus==="NO_DATA") return true;
    return String(it.currentAlarmType||"").toUpperCase()==="STALE";
  }

  for(var k=0;k<MAP_POINTS.length;k++){
    var p=MAP_POINTS[k];
    if(!p.__el) continue;

    var worstAlarm=0;
    var anyRun=false;
    var allOffline=true;
    var beltCount=(p.belts && p.belts.length)?p.belts.length:0;
    for(var j=0;j<beltCount;j++){
      var id=String(p.belts[j]);
      var it=map[id] || null;

      var lv=beltLv_(it);
      if(lv>=2 && lv>worstAlarm) worstAlarm=lv;

      if(!isOfflineOnly_(it)) allOffline=false;

      var rr=Number(it && it.run);
      if(isFinite(rr) && rr!==0) anyRun=true;
    }

    var nextCls="ok";
    if(worstAlarm>=2){
      nextCls=clsFromLv_(worstAlarm);
    }else if(allOffline && beltCount>0){
      nextCls="stale";
    }else{
      nextCls="ok";
    }

    var nextPulse=(nextCls!=="stale") && !!(anyRun || p.pulse);
    var nextSig=nextCls+"|"+(nextPulse?1:0);
    if(p.__beltStateSig===nextSig && __PAGE_MODE__==="BELT") continue;
    p.__beltStateSig=nextSig;

    if(__PAGE_MODE__==="BELT"){
      applyMapDotState_(p.__el, "BELT", nextCls, nextPulse);
      p.__el.classList.remove("pmFocus");
    }
  }
}

function render(data){
  window.__LAST_DATA__=data;
  setText("sheetLast",data.sheetLastUpdate||"-");
  setText("sleepLast",data.lastSleepTime||"-");
  renderAiAnalysis_(data);
  if (typeof updateGlobalLeftAlarms_ === "function") {
    updateGlobalLeftAlarms_();
  }
  if(__PAGE_MODE__==="BELT"){
    handleBeepFromData(data);
    setText("title",data.title||"Monitor");
    setText("subtitle",data.subtitle||"");
    updateMapDots_(data);
    updatePosCards_(data);
  }else if(__PAGE_MODE__==="PM10"){
    setText("title","Monitor");
    setText("subtitle","PM10 Monitor");
    updatePosCards_PM10_();
  }else if(__PAGE_MODE__==="VIB"){
    setText("title","Monitor");
    setText("subtitle","Vibration Gear-Motor");
    setText("mapHint","Click POS on map to view vibration graphs"); 
  }else{
    handleBeepFromData(data);
    setText("title","Monitor");
    setText("subtitle","AI Analysis Monitor");
  }
}

function setModeButtons_(){
  var b1=$id("modeBeltBtn"),b2=$id("modePm10Btn"),b3=$id("modeBeltBtn2"),b4=$id("modePm10Btn2"),b5=$id("modeAiBtn"),b6=$id("modeAiBtn2");
  var b7=$id("modeVibBtn"),b8=$id("modeVibBtn2"), b9=$id("modeVibDashBtn"), b10=$id("modeVibDashBtn2"); 

  if(b1) b1.classList.toggle("primary",__PAGE_MODE__==="BELT");
  if(b2) b2.classList.toggle("primary",__PAGE_MODE__==="PM10");
  if(b3) b3.classList.toggle("primary",__PAGE_MODE__==="BELT");
  if(b4) b4.classList.toggle("primary",__PAGE_MODE__==="PM10");
  if(b5) b5.classList.toggle("primary",__PAGE_MODE__==="AI");
  if(b6) b6.classList.toggle("primary",__PAGE_MODE__==="AI");
  if(b7) b7.classList.toggle("primary",__PAGE_MODE__==="VIB");
  if(b8) b8.classList.toggle("primary",__PAGE_MODE__==="VIB");
  
  if(b9) b9.classList.toggle("primary",__PAGE_MODE__==="VIB_DASH");
  if(b10) b10.classList.toggle("primary",__PAGE_MODE__==="VIB_DASH");
}
function setLegendForMode_(){
  if(__PAGE_MODE__==="PM10"){
    setHTML("legendPill",'<span class="lg pmok">PM OK</span> • <span class="lg pmwarn">PM WARN</span> • <span class="lg pmbad">PM BAD</span>');
    setText("mapTitle","Plant Map • PM10 (µg/m³)");
    setText("mapHint","Click dot/card to open PM10");
  }else if(__PAGE_MODE__==="AI"){
    setHTML("legendPill",'<span class="lg open">CRITICAL</span> • <span class="lg stuck">HIGH</span> • <span class="lg pmbad">ACTION</span>');
  }else if(__PAGE_MODE__==="VIB"){
    setHTML("legendPill",'<span class="lg pmok">NORMAL</span> • <span class="lg stuck">WARN</span> • <span class="lg open">DANGER</span>');
    setText("mapTitle","Plant Map • Vibration Gear-Motor");
    setText("mapHint","Click POS 7 to view vibration graphs");
  }else if(__PAGE_MODE__==="VIB_DASH"){
    setHTML("legendPill",'<span class="lg pmok">DASHBOARD</span>');
    setText("mapTitle","External Dashboard");
    setText("mapHint","Vibration Gear-Motor Live Data");
  }else{
    setHTML("legendPill",'<span class="lg open">OPEN</span> • <span class="lg stuck">STUCK</span> • <span class="lg stale">STALE</span>');
    setText("mapTitle","Plant Map • หัวสายพานชำรุด Check Points");
    setText("mapHint","Click dot/card to view details");
  }
}

function setPageMode(mode){
  var isCurrentMapVisible = (__PAGE_MODE__ !== "AI" && __PAGE_MODE__ !== "VIB_DASH");
  if (isCurrentMapVisible && typeof map !== 'undefined' && map) {
    map.__lastCenter = map.getCenter();
    map.__lastZoom = map.getZoom();
  }

  __PAGE_MODE__ = mode;
  document.body.setAttribute("data-mode", mode);
  localStorage.setItem("scada_page_mode", mode);

  setSectionVisibility_();
  setModeButtons_();
  setLegendForMode_();
  hideMapPopup_();

  clearMapDotStateCache_();

  if (typeof map !== 'undefined' && map) {
    setTimeout(function() {
      map.invalidateSize(true);
      var isNewMapVisible = (mode !== "AI" && mode !== "VIB_DASH");
      
      if (isNewMapVisible) {
        fitMapToActivePoints_();
      }
    }, 150);
  }

  for(var i=0; i<MAP_POINTS.length; i++){
    var p = MAP_POINTS[i];
    if(p && p.__marker){
      if (p.__el) {
         p.__el.className = "mapDot";
         p.__el.classList.remove("pmFocus");
         p.__el.innerHTML = String(p.pos);
      }

      if(p.modes && p.modes.includes(mode)) {
        p.__marker.addTo(map); 
        if (mode === "PM10") {
          if(p.__card) p.__card.style.display = "none";
        } else {
          if(p.__card) {
            if(window.innerWidth <= 768) {
              p.__card.style.display = "none";
            } else {
              p.__card.style.display = "block";
            }
          }
        }
        
        if(mode === "VIB") {
          applyMapDotState_(p.__el, "VIB", "stale", true);
          var sumEl = $id("posSum_" + p.pos + "_" + p.modes[0]); 
          if(sumEl) sumEl.textContent = "WAIT";
          var bodyEl = $id("posBody_" + p.pos + "_" + p.modes[0]);
          if(bodyEl) {
            var waitName = (p.pos == 2) ? "6532.18 / 6532.20" : 
                           (p.pos == 3) ? "542.22" : 
                           (p.pos == 4) ? "6413.03" : "6522.18 / 6522.20";
            bodyEl.innerHTML = '<div class="posLine pos-stale"><div class="posLeft"><span class="posChip"></span><span>' + waitName + '</span></div><div class="posRight mono"><span>Loading...</span></div></div>';
          }
        }
      } else {
        map.removeLayer(p.__marker);
        if(p.__card) p.__card.style.display = "none";
      }
    }
  }

  if(mode === "PM10"){
    setText("title", "Monitor");
    setText("subtitle", "PM10 Monitor");
    updateMapDots_PM10_();
    updatePosCards_PM10_();
    fetchPm10SnapshotAll_();
  } else if(mode === "AI"){
    setText("title", "Monitor");
    setText("subtitle", "AI Analysis Monitor");
    if(window.__LAST_DATA__) renderAiAnalysis_(window.__LAST_DATA__);
    refreshVibStatus_(); 
  } else if(mode === "VIB"){
    setText("title", "Monitor");
    setText("subtitle", "Vibration Gear-Motor");
    refreshVibStatus_();
  } else if(mode === "VIB_DASH"){
    setText("title", "Monitor");
    setText("subtitle", "Vibration Dashboard");
  } else {
    if(window.__LAST_DATA__){
      setText("title", window.__LAST_DATA__.title || "Monitor");
      setText("subtitle", window.__LAST_DATA__.subtitle || "");
      updateMapDots_(window.__LAST_DATA__);
      updatePosCards_(window.__LAST_DATA__);
    }
  }

  if(__AUTO_SWITCH_ENABLED__) startAutoSwitch_();
}

function isShown_(el){
  if(!el) return false;
  if(el.classList && el.classList.contains("open")) return true;
  var st=window.getComputedStyle?getComputedStyle(el):null;
  if(!st) return false;
  return st.display!=="none" && st.visibility!=="hidden" && st.opacity!=="0";
}
function shouldPauseAutoSwitch_(){
  return isShown_($id("overlay")) ||
         isShown_($id("reportOverlay")) ||
         isShown_($id("reportFormOverlay")) ||
         isShown_($id("mapPopup")) ||
         isShown_($id("qrOverlay"));
}
function setAutoSwitchButtons_(){
  var txt = __AUTO_SWITCH_ENABLED__ ? ("🔄 Auto: ON " + __AUTO_SWITCH_REMAINING__ + "s") : "⏸ Auto: OFF";
  var isWarning = (__AUTO_SWITCH_ENABLED__ && __AUTO_SWITCH_REMAINING__ <= 5 && __AUTO_SWITCH_REMAINING__ > 0);

  ["autoSwitchBtn","autoSwitchBtn2"].forEach(function(id){
    var b = document.getElementById(id);
    if(!b) return;
    b.innerHTML = txt;
    b.classList.toggle("btn-auto-active", __AUTO_SWITCH_ENABLED__);
    if (isWarning) b.classList.add("btn-timer-warn");
    else b.classList.remove("btn-timer-warn");
  });
}

function stopAutoSwitch_(){
  if(__AUTO_SWITCH_TIMER__){
    clearInterval(__AUTO_SWITCH_TIMER__);
    __AUTO_SWITCH_TIMER__=null;
  }
}

function autoSwitchTick_(){
  if(!__AUTO_SWITCH_ENABLED__ || document.hidden || shouldPauseAutoSwitch_()) return;
  
  __AUTO_SWITCH_REMAINING__--;
  setAutoSwitchButtons_(); 
  
  if(__AUTO_SWITCH_REMAINING__ <= 0){
    __AUTO_SWITCH_REMAINING__ = AUTO_SWITCH_SEC;
    var seq=["BELT","PM10","VIB","VIB_DASH","AI"];
    var idx=seq.indexOf(__PAGE_MODE__);
    if(idx<0) idx=0;
    setPageMode(seq[(idx+1)%seq.length]);
  }
}

function startAutoSwitch_(){
  stopAutoSwitch_();
  __AUTO_SWITCH_REMAINING__ = AUTO_SWITCH_SEC;
  setAutoSwitchButtons_();
  if(!__AUTO_SWITCH_ENABLED__) return;
  __AUTO_SWITCH_TIMER__ = setInterval(autoSwitchTick_, 1000);
}
function setAutoSwitchEnabled_(on){
  __AUTO_SWITCH_ENABLED__=!!on;
  try{ localStorage.setItem("scada_auto_switch", on ? "1" : "0"); }catch(e){}
  setAutoSwitchButtons_();
  if(__AUTO_SWITCH_ENABLED__) startAutoSwitch_();
  else stopAutoSwitch_();
}

(function(){
  ["modeBeltBtn","modeBeltBtn2"].forEach(function(id){var b=$id(id);if(b) b.addEventListener("click",function(){setPageMode("BELT");});});
  ["modePm10Btn","modePm10Btn2"].forEach(function(id){var b=$id(id);if(b) b.addEventListener("click",function(){setPageMode("PM10");});});
  ["modeVibBtn","modeVibBtn2"].forEach(function(id){var b=$id(id);if(b) b.addEventListener("click",function(){setPageMode("VIB");});});
  ["modeAiBtn","modeAiBtn2"].forEach(function(id){var b=$id(id);if(b) b.addEventListener("click",function(){setPageMode("AI");});});
  ["modeVibDashBtn","modeVibDashBtn2"].forEach(function(id){var b=$id(id);if(b) b.addEventListener("click",function(){setPageMode("VIB_DASH");});}); 
  ["autoSwitchBtn","autoSwitchBtn2"].forEach(function(id){var b=$id(id);if(b) b.addEventListener("click",function(){setAutoSwitchEnabled_(!__AUTO_SWITCH_ENABLED__);});}); 
})();

// =========================================================
// 14. ALARM LOG & EVENT LIST
// =========================================================
function renderSimpleTable_(title,rows){
  rows=rows||[];
  var html="";
  if(!rows.length){html='<div class="mono" style="color:var(--muted);font-weight:900;">No data</div>';}
  else{
    var keys=Object.keys(rows[0]||{}).filter(function(k){return k!=="ts";});
    html+='<table><thead><tr>';
    for(var k=0;k<keys.length;k++) html+='<th>'+esc(keys[k])+'</th>';
    html+='</tr></thead><tbody>';
    for(var i=0;i<rows.length;i++){
      html+='<tr>';
      for(var j=0;j<keys.length;j++){var v=rows[i][keys[j]];
      html+='<td>'+esc(v==null?"":String(v))+'</td>';}
      html+='</tr>';
    }
    html+='</tbody></table>';
  }
  setText("modalTitle",title); setHTML("modalBody",html);
}

(function bindLogButtons_(){
  function bind(id,fn){
    var el=document.getElementById(id); if(!el) return;
    el.onclick=null; el.addEventListener("click",function(ev){try{ev.preventDefault();ev.stopPropagation();}catch(_){} fn();});
  }
  function openBasicModal_(title){setText("modalTitle",title);setHTML("modalBody","<div class='skeleton' style='height:20px;margin-bottom:5px;'></div><div class='skeleton' style='height:20px;margin-bottom:5px;'></div><div class='skeleton' style='height:20px;'></div>");openModal();}
  function fetchAlarmLog24h_(){
    openBasicModal_("Alarm Log 24h");
    callGasAPI('getAlarmLog24h', {page: 'overview'})
      .then(res => {
        if(!res||res.ok===false){setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc((res&&res.error)?res.error:"unknown")+'</div>');return;}
        renderSimpleTable_("Alarm Log 24h",res.rows||[]);
      })
      .catch(err => {setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc(String(err))+'</div>');});
  }
  function fetchEventList24h_(){
    openBasicModal_("Event List 24h");
    callGasAPI('getEventList24h', {page: 'overview'})
      .then(res => {
        if(!res||res.ok===false){setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc((res&&res.error)?res.error:"unknown")+'</div>');return;}
        renderSimpleTable_("Event List 24h",res.rows||[]);
      })
      .catch(err => {setHTML("modalBody",'<div class="mono" style="color:var(--other);font-weight:900;">ERROR: '+esc(String(err))+'</div>');});
  }
  bind("alarmLogBtn",fetchAlarmLog24h_); bind("alarmLogBtn2",fetchAlarmLog24h_);
  bind("eventListBtn",fetchEventList24h_); bind("eventListBtn2",fetchEventList24h_);
})();

document.addEventListener("click", function(event) {
  if (event.target.closest('.dropbtn')) {
    var btn = event.target.closest('.dropbtn');
    var targetId = btn.getAttribute('data-target');
    var dropdown = document.getElementById(targetId);
    if (dropdown) {
      dropdown.classList.toggle("show");
    }
  } else {
    var openDropdowns = document.querySelectorAll(".dropdown-content.show");
    for (var i = 0; i < openDropdowns.length; i++) {
      openDropdowns[i].classList.remove('show');
    }
  }
});

var __resizeTimer = null;
window.addEventListener("resize", function() {
  if (typeof MAP_POINTS === "undefined" || !MAP_POINTS || !MAP_POINTS.length) return;
  for (var i = 0; i < MAP_POINTS.length; i++) {
    var p = MAP_POINTS[i];
    if (!p.__card) continue;
    if (window.innerWidth <= 768) {
      p.__card.style.display = "none";
    } else {
      if (p.modes && p.modes.includes(__PAGE_MODE__) && __PAGE_MODE__ !== "PM10") {
        p.__card.style.display = "block";
      } else {
        p.__card.style.display = "none";
      }
    }
  }
  
  if (typeof map !== 'undefined' && map) {
    if(__resizeTimer) clearTimeout(__resizeTimer);
    __resizeTimer = setTimeout(function() {
      map.invalidateSize(true);
      if (__PAGE_MODE__ !== "AI" && __PAGE_MODE__ !== "VIB_DASH") {
        fitMapToActivePoints_();
      }
    }, 250); 
  }
});

// =========================================================
// 15. INITIALIZATION
// =========================================================
refreshOperatorPill();
updateMuteBtn();
loadLogo(); 
buildMapDotsOnce_();

var savedMode=localStorage.getItem("scada_page_mode")||"PM10";
setPageMode(savedMode);
setAutoSwitchButtons_();
if(__AUTO_SWITCH_ENABLED__) startAutoSwitch_();

window.addEventListener("load",function(){
  setTimeout(function(){
    fetchStatus(); 
    refreshVibStatus_(); 
    startPolling();
    if(__AUTO_SWITCH_ENABLED__) startAutoSwitch_();
  },50);
});

// =========================================================
// 16. QR ZOOM
// =========================================================
(function(){
  var btn  = document.getElementById("qrBtn");
  var btn2 = document.getElementById("qrBtn2");
  var ov   = document.getElementById("qrOverlay");
  var box  = document.getElementById("qrZoomBox");
  var img  = document.getElementById("qrZoomImg");
  if(!ov || !box || !img) return;

  img.src = "https://lh3.googleusercontent.com/d/1exbJtHJeLCMXH-MAPoCkItOj0rCJXBRB";
  function openQR(){ ov.setAttribute("aria-hidden","false"); ov.classList.add("open"); }
  function closeQR(){ ov.classList.remove("open"); ov.setAttribute("aria-hidden","true"); }
  function stop_(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} }

  if(btn) btn.addEventListener("click", function(e){ stop_(e); openQR(); });
  if(btn2) btn2.addEventListener("click", function(e){ stop_(e); openQR(); });

  ov.addEventListener("pointerup", function(e){ stop_(e); closeQR(); }, {passive:false});
  box.addEventListener("pointerup", function(e){ stop_(e); closeQR(); }, {passive:false});
  document.addEventListener("keydown", function(e){ if(e.key==="Escape") closeQR(); });
})();

// =========================================================
// 17. REPORT LOGIC
// =========================================================
const DELETE_PASSWORD="1234";

function swalLoadingOpen(title,text){if(!window.Swal) return; Swal.fire({title:title||"Loading…",text:text||"Please wait",allowOutsideClick:false,allowEscapeKey:false,showConfirmButton:false,backdrop:true,didOpen:()=>Swal.showLoading()});}
function swalLoadingClose(){if(!window.Swal) return; if(Swal.isVisible()) Swal.close();}
function makeDelayedLoader(ms,title,text){
  var shown=false;
  var t=setTimeout(function(){shown=true;swalLoadingOpen(title,text);},ms||900);
  return{close:function(){clearTimeout(t);if(shown) swalLoadingClose();}};
}

function toDriveImgUrl_(u){
  u=String(u||"").trim(); if(!u) return "";
  if(u.indexOf("https://lh3.googleusercontent.com/d/")===0) return u;
  if(u.indexOf("drive.google.com/uc?export=view&id=")>=0){var m=u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/); if(m&&m[1]) return"https://lh3.googleusercontent.com/d/"+m[1];}
  var m1=u.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/); if(m1&&m1[1]) return"https://lh3.googleusercontent.com/d/"+m1[1];
  var m2=u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/); if(m2&&m2[1]) return"https://lh3.googleusercontent.com/d/"+m2[1];
  if(/^[a-zA-Z0-9_-]{10,}$/.test(u)) return"https://lh3.googleusercontent.com/d/"+u;
  return u;
}

function openReport(){var ov=$id("reportOverlay");if(ov) ov.style.display="flex";reportRefresh_();}
function closeReport(){var ov=$id("reportOverlay");if(ov) ov.style.display="none";reportCloseForm_();}
function reportOpenForm_(){var ov=$id("reportFormOverlay");if(ov) ov.style.display="flex";if(!__REPORT_EDIT_ID__) setDefaultCheckTimeNow_();}
function reportCloseForm_(){var ov=$id("reportFormOverlay");if(ov) ov.style.display="none";}

var __IMGV__ = { scale: 1, minScale: 1, maxScale: 4, x: 0, y: 0, raf: 0, drag: null, pinch: null, lastTapAt: 0 };
function imgViewerApply_(){
  var img = $id("imgViewerImg"); if(!img) return;
  if(__IMGV__.raf) cancelAnimationFrame(__IMGV__.raf);
  __IMGV__.raf = requestAnimationFrame(function(){
    img.style.transform = "translate3d(" + __IMGV__.x + "px," + __IMGV__.y + "px,0) scale(" + __IMGV__.scale + ")";
  });
}
function imgViewerClamp_(){
  var body = $id("imgViewerBody"), img  = $id("imgViewerImg"); if(!body || !img) return;
  var rect = body.getBoundingClientRect(), iw = img.naturalWidth  || img.width  || 1, ih = img.naturalHeight || img.height || 1;
  var fit = Math.min(rect.width / iw, rect.height / ih, 1), drawW = iw * fit * __IMGV__.scale, drawH = ih * fit * __IMGV__.scale;
  var maxX = Math.max(0, (drawW - rect.width) / 2), maxY = Math.max(0, (drawH - rect.height) / 2);
  if(__IMGV__.x >  maxX) __IMGV__.x =  maxX;
  if(__IMGV__.x < -maxX) __IMGV__.x = -maxX;
  if(__IMGV__.y >  maxY) __IMGV__.y =  maxY;
  if(__IMGV__.y < -maxY) __IMGV__.y = -maxY;
}
function imgViewerReset_(){
  __IMGV__.scale = 1; __IMGV__.x = 0; __IMGV__.y = 0; __IMGV__.drag = null; __IMGV__.pinch = null; imgViewerApply_();
}
function imgViewerZoomAt_(nextScale, cx, cy){
  var body = $id("imgViewerBody"); if(!body) return;
  var rect = body.getBoundingClientRect(), ox = cx - rect.left - rect.width / 2, oy = cy - rect.top  - rect.height / 2;
  var prev = __IMGV__.scale; nextScale = Math.max(__IMGV__.minScale, Math.min(__IMGV__.maxScale, nextScale));
  if(nextScale === prev) return;
  var ratio = nextScale / prev;
  __IMGV__.x = (__IMGV__.x - ox) * ratio + ox; __IMGV__.y = (__IMGV__.y - oy) * ratio + oy; __IMGV__.scale = nextScale;
  imgViewerClamp_(); imgViewerApply_();
}
function openImgViewer_(title,url){
  url = toDriveImgUrl_(url);
  var v = $id("imgViewer"), t = $id("imgViewerTitle"), i = $id("imgViewerImg"); if(!v || !i) return;
  if(t) t.textContent = title || "Image";
  i.onload = function(){ imgViewerReset_(); imgViewerClamp_(); imgViewerApply_(); };
  i.src = url || ""; v.style.display = "flex"; document.body.style.overflow = "hidden";
}
function closeImgViewer_(){
  var v = $id("imgViewer"), i = $id("imgViewerImg");
  if(i){ i.onload = null; i.src = ""; i.style.transform = "translate3d(0,0,0) scale(1)"; }
  if(v) v.style.display = "none"; document.body.style.overflow = ""; imgViewerReset_();
}
(function initImgViewerGesture_(){
  var body = $id("imgViewerBody"), stage = $id("imgViewerStage"), viewer = $id("imgViewer"); if(!body || !stage || !viewer) return;
  function dist_(a,b){ var dx = b.clientX - a.clientX, dy = b.clientY - a.clientY; return Math.sqrt(dx*dx + dy*dy); }
  function mid_(a,b){ return { x:(a.clientX+b.clientX)/2, y:(a.clientY+b.clientY)/2 }; }
  body.addEventListener("wheel", function(e){
    if(viewer.style.display !== "flex") return; e.preventDefault();
    var delta = e.deltaY < 0 ? 1.12 : 0.9; imgViewerZoomAt_(__IMGV__.scale * delta, e.clientX, e.clientY);
  }, { passive:false });
  body.addEventListener("touchstart", function(e){
    if(viewer.style.display !== "flex") return;
    if(e.touches.length === 1){
      var t = e.touches[0], now = Date.now();
      if(now - __IMGV__.lastTapAt < 260){
        e.preventDefault(); if(__IMGV__.scale > 1.01) imgViewerReset_(); else imgViewerZoomAt_(2, t.clientX, t.clientY);
        __IMGV__.lastTapAt = 0; return;
      }
      __IMGV__.lastTapAt = now; __IMGV__.drag = { sx: t.clientX, sy: t.clientY, ox: __IMGV__.x, oy: __IMGV__.y };
    } else if(e.touches.length === 2){
      e.preventDefault(); var a = e.touches[0], b = e.touches[1], m = mid_(a,b);
      __IMGV__.pinch = { dist: dist_(a,b), scale: __IMGV__.scale, mx: m.x, my: m.y }; __IMGV__.drag = null;
    }
  }, { passive:false });
  body.addEventListener("touchmove", function(e){
    if(viewer.style.display !== "flex") return;
    if(e.touches.length === 2 && __IMGV__.pinch){
      e.preventDefault(); var a = e.touches[0], b = e.touches[1], d = dist_(a,b), m = mid_(a,b);
      var ratio = d / Math.max(1, __IMGV__.pinch.dist);
      __IMGV__.scale = Math.max(__IMGV__.minScale, Math.min(__IMGV__.maxScale, __IMGV__.pinch.scale * ratio));
      __IMGV__.x += (m.x - __IMGV__.pinch.mx); __IMGV__.y += (m.y - __IMGV__.pinch.my);
      __IMGV__.pinch.mx = m.x; __IMGV__.pinch.my = m.y; imgViewerClamp_(); imgViewerApply_(); return;
    }
    if(e.touches.length === 1 && __IMGV__.drag){
      var t = e.touches[0]; if(__IMGV__.scale <= 1.01) return; e.preventDefault();
      __IMGV__.x = __IMGV__.drag.ox + (t.clientX - __IMGV__.drag.sx); __IMGV__.y = __IMGV__.drag.oy + (t.clientY - __IMGV__.drag.sy);
      imgViewerClamp_(); imgViewerApply_();
    }
  }, { passive:false });
  body.addEventListener("touchend", function(e){
    if(viewer.style.display !== "flex") return; __IMGV__.drag = null;
    if(!e.touches || e.touches.length < 2) __IMGV__.pinch = null;
    if(__IMGV__.scale < 1.02) imgViewerReset_();
  }, { passive:true });
  body.addEventListener("mousedown", function(e){
    if(viewer.style.display !== "flex") return; if(__IMGV__.scale <= 1.01) return; e.preventDefault();
    __IMGV__.drag = { sx: e.clientX, sy: e.clientY, ox: __IMGV__.x, oy: __IMGV__.y };
  });
  window.addEventListener("mousemove", function(e){
    if(!__IMGV__.drag || viewer.style.display !== "flex") return;
    __IMGV__.x = __IMGV__.drag.ox + (e.clientX - __IMGV__.drag.sx); __IMGV__.y = __IMGV__.drag.oy + (e.clientY - __IMGV__.drag.sy);
    imgViewerClamp_(); imgViewerApply_();
  });
  window.addEventListener("mouseup", function(){ __IMGV__.drag = null; });
  window.addEventListener("resize", function(){
    if(viewer.style.display !== "flex") return; imgViewerClamp_(); imgViewerApply_();
  });
})();

function fileToBase64_(file){
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onload=function(){
      try{var s=String(reader.result||""),comma=s.indexOf(","),b64=(comma>=0)?s.slice(comma+1):s;resolve({fileName:file.name||("img_"+Date.now()+".jpg"),mimeType:file.type||"image/jpeg",base64:b64});}catch(e){reject(e);}
    };
    reader.onerror=function(){reject(reader.error||new Error("read error"));};
    reader.readAsDataURL(file);
  });
}

function renderLocalThumbs_(files){
  var wrap=$id("r_imgThumbs"); if(!wrap) return; wrap.innerHTML="";
  if(!files||!files.length) return;
  for(let i=0;i<files.length;i++){
    const f=files[i]; const reader=new FileReader();
    reader.onload=function(){
      var url=String(reader.result||"");
      var box=document.createElement("div"); box.className="rThumb";
      box.innerHTML='<img referrerpolicy="no-referrer" src="'+esc(url)+'" alt="img"/>';
      box.addEventListener("click",function(){openImgViewer_("Local preview",url);}); wrap.appendChild(box);
    };
    reader.readAsDataURL(f);
  }
}

var __REPORT_EDIT_ID__="", __REPORT_EDIT_OLD__=null;
function setDefaultCheckTimeNow_(){
  var el=$id("r_checkTime"); if(!el) return; var d=new Date();
  function pad(n){return String(n).padStart(2,"0");}
  el.value=d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes());
}
function clearReportForm_(){
  __REPORT_EDIT_ID__=""; __REPORT_EDIT_OLD__=null;
  setText("r_editId",""); setText("formHeadTitle","FORM • กรอก/แก้ไข รายงาน");
  if($id("r_code")) $id("r_code").value="";
  if($id("r_detail")) $id("r_detail").value="";
  if($id("r_files")) $id("r_files").value="";
  setHTML("r_imgThumbs",""); setDefaultCheckTimeNow_();
  var del=$id("r_deleteBtn"); if(del) del.style.display="none";
  setUploadProgress_(0,false);
}

function setUploadProgress_(pct,show){
  var bar=$id("uploadBar"),fill=$id("uploadBarFill");
  if(bar) bar.style.display=show?"block":"none";
  if(fill) fill.style.width=(pct||0)+"%";
}

function showExistingImagesThumbs_(row){
  var wrap=$id("r_imgThumbs"); if(!wrap) return; wrap.innerHTML=""; if(!row) return;
  var arr=[];
  ["img1","img2","img3","img4"].forEach(function(k){var u=row[k];if(u) arr.push(toDriveImgUrl_(u));});
  if(!arr.length) return;
  for(let i=0;i<arr.length;i++){
    const u=arr[i];
    var box=document.createElement("div"); box.className="rThumb";
    box.innerHTML='<img referrerpolicy="no-referrer" src="'+esc(u)+'" alt="img"/>';
    box.addEventListener("click",function(){openImgViewer_("Saved image",u);}); wrap.appendChild(box);
  }
}

function setFormFromRow_(row){
  __REPORT_EDIT_ID__=row.id||""; __REPORT_EDIT_OLD__=row;
  setText("r_editId",__REPORT_EDIT_ID__?("EDIT: "+__REPORT_EDIT_ID__):"");
  setText("formHeadTitle","FORM • แก้ไข: "+esc(row.code||__REPORT_EDIT_ID__));
  if($id("r_code")) $id("r_code").value=row.code||"";
  if($id("r_detail")) $id("r_detail").value=row.detail||"";
  var el=$id("r_checkTime");
  if(el){var ms=Number(row.checkTimeMs||0);
  if(isFinite(ms)&&ms>0){var d=new Date(ms);function pad(n){return String(n).padStart(2,"0");}el.value=d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes());}}
  if($id("r_files")) $id("r_files").value="";
  showExistingImagesThumbs_(row);
  var del=$id("r_deleteBtn"); if(del) del.style.display=__REPORT_EDIT_ID__?"inline-flex":"none";
  reportOpenForm_();
}

async function reportSave_(){
  try{
    var op=(typeof getOperator==="function")?(getOperator()||{name:"",shift:""}):{name:"",shift:""};
    var checkStr=($id("r_checkTime")&&$id("r_checkTime").value)?$id("r_checkTime").value:"";
    var code=($id("r_code")&&$id("r_code").value)?$id("r_code").value.trim():"";
    var detail=($id("r_detail")&&$id("r_detail").value)?$id("r_detail").value.trim():"";
    if(!checkStr){showToast("Missing check time","warn");return;}
    if(!code){showToast("Missing code","warn","กรอก code ก่อน");return;}
    function parseDatetimeLocalToMs_(s){var m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);if(!m) return NaN;return new Date(+m[1],(+m[2])-1,+m[3],+m[4],+m[5],0,0).getTime();}
    var checkMs=parseDatetimeLocalToMs_(checkStr);
    if(!isFinite(checkMs)){showToast("Invalid time","err","เลือกเวลาใหม่");return;}
    var filesEl=$id("r_files");
    var fileArr=(filesEl&&filesEl.files&&filesEl.files.length)?Array.from(filesEl.files):[];
    if(fileArr.length>4){showToast("Too many images","warn","เลือกได้สูงสุด 4 รูป");return;}

    var imgUrls=null;
    if(fileArr.length){
      imgUrls={}; setUploadProgress_(0,true);
      for(let i=0;i<fileArr.length;i++){
        setUploadProgress_(Math.round(((i)/fileArr.length)*100),true);
        try{
          const meta=await fileToBase64_(fileArr[i]);
          const res = await callGasAPI('uploadReportImage', {}, 'POST', meta);
          if(!res||res.ok===false) throw new Error((res&&res.error)?res.error:"upload error");
          imgUrls["img"+(i+1)]=toDriveImgUrl_(res.viewUrl||res.fileId||"");
        }catch(e){
          setUploadProgress_(0,false);
          showToast("Upload failed","err","File "+(i+1)+": "+String(e));
          return;
        }
      }
      setUploadProgress_(100,true);
      setTimeout(function(){setUploadProgress_(0,false);},800);
    }

    var payload={id:__REPORT_EDIT_ID__||"",checkTimeMs:checkMs,code:code,detail:detail,images:imgUrls,operator:op.name||"",shift:op.shift||""};
    if(!__REPORT_EDIT_ID__){
      var saveLoader=makeDelayedLoader(350,"Saving…","Please wait");
      callGasAPI('reportCreate', {}, 'POST', payload)
        .then(res => {
          saveLoader.close();
          if(!res||res.ok===false){showToast("Create failed","err",(res&&res.error)?res.error:"unknown");return;}
          showToast("Saved","ok",res.id||"");clearReportForm_();reportCloseForm_();reportRefresh_();
        })
        .catch(err => { saveLoader.close();showToast("Create failed","err",String(err)); });
      return;
    }

    Swal.fire({
      title:"Confirm edit",text:"Enter password to save changes",input:"password",inputPlaceholder:"Password",
      inputAttributes:{autocapitalize:"off",autocorrect:"off"},showCancelButton:true,confirmButtonText:"Save",cancelButtonText:"Cancel",
      confirmButtonColor:"#3085d6",reverseButtons:true,
      preConfirm:(pw)=>{if((pw||"").trim()!==DELETE_PASSWORD){Swal.showValidationMessage("Wrong password");return false;}return true;}
    }).then((result)=>{
      if(!result.isConfirmed) return;
      var upLoader=makeDelayedLoader(350,"Updating…","Please wait");
      callGasAPI('reportUpdate', {}, 'POST', payload)
        .then(res => {
          upLoader.close();
          if(!res||res.ok===false){showToast("Update failed","err",(res&&res.error)?res.error:"unknown");return;}
          showToast("Updated","ok",__REPORT_EDIT_ID__);clearReportForm_();reportCloseForm_();reportRefresh_();
        })
        .catch(err => { upLoader.close();showToast("Update failed","err",String(err)); });
    });
  }catch(ex){showToast("Save crashed","err",String(ex));}
}

function reportDelete_(){
  if(!__REPORT_EDIT_ID__){showToast("No edit id","warn");return;}
  Swal.fire({
    title:"Confirm delete",text:"Enter password to delete",input:"password",inputPlaceholder:"Password",
    inputAttributes:{autocapitalize:"off",autocorrect:"off"},showCancelButton:true,confirmButtonText:"Delete",cancelButtonText:"Cancel",
    confirmButtonColor:"#ff3b30",reverseButtons:true,
    preConfirm:(pw)=>{if((pw||"").trim()!==DELETE_PASSWORD){Swal.showValidationMessage("Wrong password");return false;}return true;}
  }).then((result)=>{
    if(!result.isConfirmed) return;
    var id=__REPORT_EDIT_ID__,loader=makeDelayedLoader(200,"Deleting…",id);
    callGasAPI('reportDelete', {}, 'POST', {id: id})
      .then(res => {
        loader.close();
        if(!res||res.ok===false){showToast("Delete failed","err",(res&&res.error)?res.error:"unknown");return;}
        showToast("Deleted","ok",id);clearReportForm_();reportCloseForm_();reportRefresh_();
      })
      .catch(err => { loader.close();showToast("Delete failed","err",String(err)); });
  });
}

function miniImgsHtml_(row){
  var urls=[];
  ["img1","img2","img3","img4"].forEach(function(k){var u=row[k];if(u) urls.push(toDriveImgUrl_(u));});
  if(!urls.length) return '<span class="rMut">-</span>';
  var html='<div class="rMiniImgs">';
  for(var i=0;i<urls.length;i++) html+='<img referrerpolicy="no-referrer" src="'+esc(urls[i])+'" data-img="'+esc(urls[i])+'" data-title="'+esc((row.code||"")+" • image "+(i+1))+'" />';
  html+='</div>';
  return html;
}

function reportRender_(rows){
  rows=rows||[]; setText("r_count","rows: "+rows.length);
  var tb=$id("r_tbody"); if(!tb) return; tb.innerHTML="";
  if(!rows.length){tb.innerHTML='<tr><td colspan="6" class="rMut">No data</td></tr>';return;}
  for(let i=0;i<rows.length;i++){
    const r=rows[i]; const tr=document.createElement("tr");
    tr.innerHTML='<td class="rSmallMono">'+esc(r.checkTime||"-")+'</td><td class="rSmallMono"><b>'+esc(r.code||"-")+'</b></td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc((r.detail||"").slice(0,120))+(String(r.detail||"").length>120?"…":"")+'</td><td>'+miniImgsHtml_(r)+'</td><td class="rSmallMono">'+esc((r.operator||"-")+(r.shift?" / "+r.shift:""))+'</td><td class="rActCell"><div class="rActRow"><button class="rBtn rBtnMini" data-act="edit">Edit</button><button class="rBtn danger rBtnMini" data-act="del">Del</button></div></td>';
    
    var editBtn = tr.querySelector('[data-act="edit"]');
    if(editBtn) editBtn.addEventListener("click", function(){ setFormFromRow_(r); });

    var delBtn = tr.querySelector('[data-act="del"]');
    if(delBtn) delBtn.addEventListener("click", function(){ 
      __REPORT_EDIT_ID__ = r.id || ""; reportDelete_(); 
    });

    var imgs = tr.querySelectorAll('.rMiniImgs img');
    for (var j = 0; j < imgs.length; j++) {
      imgs[j].addEventListener("click", function(e) {
        openImgViewer_(e.target.getAttribute("data-title"), e.target.getAttribute("data-img"));
      });
    }
    tb.appendChild(tr);
  }
}

function reportRefresh_(){
  var loader = makeDelayedLoader(200, "Loading reports…", "Please wait");
  callGasAPI('reportList', {limit: 200})
    .then(res => {
      loader.close();
      if(!res || res.ok === false){ showToast("Fetch failed", "err", (res && res.error) ? res.error : ""); return; }
      reportRender_(res.rows || []);
    })
    .catch(err => { loader.close(); showToast("Fetch failed", "err", String(err)); });
}

(function bindReportButtons_(){
  var b1 = $id("reportBtn"); if(b1) b1.addEventListener("click", openReport);
  var b2 = $id("reportBtn2"); if(b2) b2.addEventListener("click", openReport);
  var bClose = $id("reportCloseBtn"); if(bClose) bClose.addEventListener("click", closeReport);
  var bNew = $id("reportOpenFormBtn"); if(bNew) bNew.addEventListener("click", function(){ clearReportForm_(); reportOpenForm_(); });
  var bRef = $id("reportRefreshBtn"); if(bRef) bRef.addEventListener("click", reportRefresh_);
  var bFClose = $id("reportFormCloseBtn"); if(bFClose) bFClose.addEventListener("click", reportCloseForm_);
  var bFCancel = $id("r_formCancelBtn"); if(bFCancel) bFCancel.addEventListener("click", reportCloseForm_);
  var bClear = $id("r_clearBtn"); if(bClear) bClear.addEventListener("click", clearReportForm_);
  var bSave = $id("r_saveBtn"); if(bSave) bSave.addEventListener("click", reportSave_);
  var bDel = $id("r_deleteBtn"); if(bDel) bDel.addEventListener("click", reportDelete_);

  var imgClose = $id("imgViewerClose"); if(imgClose) imgClose.addEventListener("click", closeImgViewer_);
  var imgViewerBg = $id("imgViewer");
  if(imgViewerBg) imgViewerBg.addEventListener("click", function(e) { if(e.target === imgViewerBg) closeImgViewer_(); });

  var fInp = $id("r_files");
  if(fInp) {
    fInp.addEventListener("change", function(){
      if(fInp.files && fInp.files.length) renderLocalThumbs_(fInp.files);
      else $id("r_imgThumbs").innerHTML = "";
    });
  }
})();

// =========================================================
// 18. LEFT ALARM PANEL
// =========================================================
function updateGlobalLeftAlarms_() {
  if (!window.__LAST_DATA__) return; 
  var rows = buildAiRows_(window.__LAST_DATA__);
  
  var panel = document.getElementById("leftAlarmPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "leftAlarmPanel";
    
    panel.innerHTML = `
      <div id="alarmPanelHeader" style="display:none;" onclick="toggleLeftAlarmPanel_()">
        <span id="alarmHeaderTitle">🚨 Alarms</span>
        <span id="alarmHeaderIcon">➖</span>
      </div>
      <div id="alarmPanelList"></div>
    `;
    document.body.appendChild(panel);

    window.toggleLeftAlarmPanel_ = function() {
      var p = document.getElementById("leftAlarmPanel");
      var icon = document.getElementById("alarmHeaderIcon");
      if(p.classList.contains("collapsed")) {
        p.classList.remove("collapsed"); icon.textContent = "➖"; 
        window.__ALARM_PANEL_COLLAPSED__ = false;
      } else {
        p.classList.add("collapsed"); icon.textContent = "➕"; 
        window.__ALARM_PANEL_COLLAPSED__ = true;
      }
      
      if (__PAGE_MODE__ !== "AI" && __PAGE_MODE__ !== "VIB_DASH") {
        setTimeout(fitMapToActivePoints_, 300);
      }
    };
  }

  var activeAlarms = rows.filter(function(r) {
    var isAlarm = r.level === "CRITICAL" || r.level === "HIGH" || r.level === "MEDIUM";
    var isAlert = r.status === "ALERT" || r.status === "WARN";
    return isAlarm && isAlert;
  });

  var header = document.getElementById("alarmPanelHeader");
  var list = document.getElementById("alarmPanelList");

  if (activeAlarms.length === 0) {
    header.style.display = "none";
    list.innerHTML = "";
    return;
  }

  header.style.display = "flex";
  document.getElementById("alarmHeaderTitle").innerHTML = "🚨 Alarms (" + activeAlarms.length + ")";

  if (window.__ALARM_PANEL_COLLAPSED__) {
    panel.classList.add("collapsed");
    document.getElementById("alarmHeaderIcon").textContent = "➕";
  }

  var html = "";
  for (var i = 0; i < activeAlarms.length; i++) {
    var r = activeAlarms[i];
    var borderColor = r.level === "CRITICAL" ? "#ff3b30" : (r.level === "HIGH" ? "#ff9f0a" : "#f1c40f");
    var bgColor = "rgba(15,20,30,0.85)";

    html += '<div style="background:'+bgColor+'; padding:6px 10px; border-radius:6px; box-shadow:0 2px 8px rgba(0,0,0,0.6); pointer-events:auto; animation:alarmSlideIn 0.2s ease-out; backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); border: 1px solid rgba(255,255,255,0.05); border-left:4px solid '+borderColor+';">';
    html += '<div style="font-size:12px; font-weight:bold; color:#fff; line-height:1.3; word-break:break-word;">' + esc(r.belt) + '</div>';
    
    var shortMsg = r.alarmMsg ? r.alarmMsg : r.alarmType;
    html += '<div style="font-size:10px; color:'+borderColor+'; margin-top:3px; font-weight:bold;">⚠️ ' + esc(shortMsg) + '</div>';
    html += '</div>';
  }

  if(list.innerHTML !== html) { list.innerHTML = html; }
}
