// =========================================================
// 1. CONFIGURATION (ศูนย์รวมการตั้งค่า)
// =========================================================
const CONFIG = {
  // 🛑 ใส่ URL Web App ที่ Deploy ใหม่จาก Google Apps Script 🛑
  GAS_URL: "https://script.google.com/macros/s/AKfycbwvucmeMFhcN_6wIyOGg33kd6XKKe3K66T311r8nm7GtlA29-qmisdoo5a6Rm5q690V/exec", 
  
  // 🛑 ใส่ API KEY ให้ตรงกับที่ตั้งไว้ใน Code.gs 🛑
  API_KEY: "scada_secure_key_2026", 

  AUTO_SWITCH_SEC: 30,
  POLL_DESKTOP: 30,
  POLL_MOBILE: 45,
  THRESHOLDS: {
    PM10_WARN: 50,
    PM10_BAD: 120
  }
};

// =========================================================
// 2. STATE MANAGEMENT (จัดการหน้าเว็บด้วย Proxy)
// =========================================================
const AppState = new Proxy({
  mode: localStorage.getItem("scada_page_mode") || "PM10",
  autoSwitch: (localStorage.getItem("scada_auto_switch") !== "0"),
  remainingSec: CONFIG.AUTO_SWITCH_SEC
}, {
  set(target, key, value) {
    target[key] = value;
    if (key === 'mode') {
      applyPageModeChange(value);
    } else if (key === 'autoSwitch' || key === 'remainingSec') {
      updateAutoSwitchUI();
    }
    return true;
  }
});

// Global Variables
let MAP_POINTS = [];
let mapCoords = {};
let map;
let __PM_FETCH_LOCK__ = false;
let __PM10_LATEST__ = {}, __PM10_SERIES__ = {}, __PM10_SERIES_FETCHED_AT__ = {};
let __AI_ROWS__ = [];
let lastPm10FetchTime = 0;
let failStreak = 0, reloading = false, fetchInFlight = false, pollTimer = null;
let _vibPollCount = 0;

// =========================================================
// 3. API CALLER (SECURE FETCH)
// =========================================================
async function callGasAPI(action, params = {}, method = 'GET', bodyData = null) {
  try {
    let url = new URL(CONFIG.GAS_URL);
    url.searchParams.append('action', action);
    url.searchParams.append('apiKey', CONFIG.API_KEY);
    
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
      }
    }

    const options = { method: method };
    if (method === 'POST' && bodyData) {
      options.body = JSON.stringify(bodyData);
      options.headers = { "Content-Type": "text/plain;charset=utf-8" };
    }

    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data;
  } catch (error) {
    throw new Error(error.message || "Network Error");
  }
}

// =========================================================
// 4. UI & DOM HELPERS
// =========================================================
function $id(id){ return document.getElementById(id); }
function setText(id,val){ var el=$id(id); if(el) el.textContent=(val==null?"":val); }
function setHTML(id,html){ var el=$id(id); if(!el) return false; el.innerHTML=(html==null?"":html); return true; }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function showToast(msg, type = "ok", sub = "") {
  const wrap = $id("toastWrap");
  if(!wrap) return;
  while(wrap.children.length >= 3) wrap.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast " + (type === "err" ? "err" : type === "warn" ? "warn" : "");
  el.innerHTML = `<span class="toastDot"></span><div><div class="tMsg">${esc(msg)}</div>${sub?`<div class="tSub">${esc(sub)}</div>`:''}</div>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity="0"; el.style.transform="translateY(-4px)"; }, 2400);
  setTimeout(() => el.remove(), 2800);
}

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

function hardCrashScreen(title,msg,stack){
  stopPolling();
  document.body.innerHTML=`
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;padding:16px;">
      <h3 style="margin:0 0 10px 0;">${title}</h3>
      <div style="color:#ff9f0a;font-weight:900;">${String(msg||"")}</div>
      <pre style="white-space:pre-wrap;opacity:.85;margin-top:10px;">${stack||""}</pre>
      <button onclick="location.reload()" style="margin-top:12px;padding:10px 12px;">Reload</button>
    </div>`;
}
window.addEventListener("error", e => hardCrashScreen("SCADA UI crashed", (e&&e.message)||"Unknown", (e&&e.error&&e.error.stack)||""));
window.addEventListener("unhandledrejection", e => hardCrashScreen("SCADA Promise crashed", (e&&e.reason)||"Unknown", ""));

function loadLogo(){
  var img = $id("logoImg"); 
  if(!img) return;
  var cached = null;
  try { cached = localStorage.getItem("scada_logo"); } catch(e){}
  
  if(cached){
    img.src = cached; 
    img.style.display = "block";
    return;
  }
  
  callGasAPI('getLogoBase64')
    .then(res => {
      if(!res || res.ok === false) return;
      img.src = res.dataUrl; 
      img.style.display = "block";
      try { localStorage.setItem("scada_logo", res.dataUrl); } catch(e){}
    })
    .catch(err => console.error("Logo fetch error:", err));
}

// =========================================================
// 5. MOBILE MENU & THEME
// =========================================================
(function(){
  const btn = $id("hamburgerBtn");
  const menu = $id("mobileMenu");
  if(!btn || !menu) return;

  function closeMobileMenu(){ menu.classList.remove("open"); btn.textContent = "☰"; }
  function toggleMobileMenu(){ menu.classList.toggle("open"); btn.textContent = menu.classList.contains("open") ? "✕" : "☰"; }

  btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); toggleMobileMenu(); });
  menu.addEventListener("click", e => { if(e.target.closest("button")) setTimeout(closeMobileMenu, 120); });
  document.addEventListener("click", e => {
    if(!menu.classList.contains("open")) return;
    if(menu.contains(e.target) || btn.contains(e.target)) return;
    closeMobileMenu();
  });
  document.addEventListener("keydown", e => { if(e.key === "Escape") closeMobileMenu(); });
  window.addEventListener("resize", () => { if(window.innerWidth > 768) closeMobileMenu(); });
})();

function setTheme(theme){
  document.body.setAttribute("data-theme",theme);
  localStorage.setItem("belt_theme",theme);
  const txt = (theme==="day") ? "☀️ Theme: DAY" : "🌙 Theme: NIGHT";
  ["themeBtnToggle", "themeBtnToggle2"].forEach(id => { const e = $id(id); if(e) e.textContent = txt; });
}
setTheme(localStorage.getItem("belt_theme")||"night");

["themeBtnToggle", "themeBtnToggle2"].forEach(id => {
  $id(id)?.addEventListener("click", () => {
    const cur = document.body.getAttribute("data-theme")||"night"; 
    setTheme(cur==="day" ? "night" : "day"); 
  });
});

// =========================================================
// 6. OPERATOR & BEEP
// =========================================================
function getOperator(){ return {name:localStorage.getItem("op_name")||"", shift:localStorage.getItem("op_shift")||""}; }
function setOperator(name,shift){
  localStorage.setItem("op_name",(name||"").trim().slice(0,40));
  localStorage.setItem("op_shift",(shift||"").trim().slice(0,20));
  refreshOperatorPill();
}
function refreshOperatorPill(){
  const cur=getOperator(), pill=$id("opPill"); 
  if(pill) pill.textContent = cur.name ? `OP: ${cur.name}${cur.shift?` / ${cur.shift}`:""}` : "OP: -";
}
function doOpPrompt(){
  const cur=getOperator();
  Swal.fire({
    title: 'Operator Login',
    html: `
      <input id="swal-input1" class="swal2-input" placeholder="Name" value="${cur.name||""}">
      <select id="swal-input2" class="swal2-input">
        <option value="เช้า" ${cur.shift==="เช้า"?"selected":""}>กะเช้า (08:00 - 16:00)</option>
        <option value="บ่าย" ${cur.shift==="บ่าย"?"selected":""}>กะบ่าย (16:00 - 00:00)</option>
        <option value="ดึก" ${cur.shift==="ดึก"?"selected":""}>กะดึก (00:00 - 08:00)</option>
      </select>`,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: 'Save',
    preConfirm: () => [$id('swal-input1').value, $id('swal-input2').value]
  }).then((res) => {
    if (res.isConfirmed) {
      setOperator(res.value[0], res.value[1]);
      showToast("Saved operator", "ok", res.value[0] + " / " + res.value[1]);
    }
  });
}
["opBtn","opBtn2"].forEach(id => $id(id)?.addEventListener("click", doOpPrompt));

function setConnBadge(state,txt){
  const b=$id("connBadge"), t=$id("connTxt"); 
  if(b&&t) { b.className="connBadge "+state; t.textContent=txt; }
}

let BEEP_INTERVAL_MS=7000, BEEP_COOLDOWN_MS=1200;
let lastBeepAt=0, beepedOpenIds={}, audioCtx=null;

function getBeepEnabled(){ return localStorage.getItem("belt_beep")!=="0"; }
function setBeepEnabled(on){ localStorage.setItem("belt_beep",on?"1":"0"); updateMuteBtn(); }
function updateMuteBtn(){
  const lbl = "Beep: " + (getBeepEnabled() ? "ON" : "MUTE");
  ["muteBtn","muteBtn2"].forEach(id => { const b=$id(id); if(b) b.textContent=lbl; });
}
function ensureAudio(){ 
  if(audioCtx) return true; 
  try{ audioCtx = new(window.AudioContext||window.webkitAudioContext)(); }catch(e){ audioCtx=null; return false; } 
  return true; 
}
function beepOnce(){
  if(!getBeepEnabled() || !ensureAudio()) return;
  if(audioCtx.state==="suspended") audioCtx.resume().catch(()=>{});
  const now = Date.now();
  if(now - lastBeepAt < BEEP_COOLDOWN_MS) return;
  lastBeepAt = now;
  const t0 = audioCtx.currentTime;
  function tone(freq,start,dur,gainVal){
    const osc=audioCtx.createOscillator(), gain=audioCtx.createGain();
    osc.type="square"; osc.frequency.setValueAtTime(freq,start);
    gain.gain.setValueAtTime(0.0001,start); gain.gain.exponentialRampToValueAtTime(gainVal,start+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001,start+dur);
    osc.connect(gain).connect(audioCtx.destination); osc.start(start); osc.stop(start+dur+0.02);
  }
  tone(1100, t0+0.00, 0.10, 0.18); tone(900, t0+0.14, 0.12, 0.14);
}
function handleBeepFromData(data){
  if(document.hidden || (AppState.mode !== "BELT" && AppState.mode !== "AI")) return;  
  if(!data||!data.belts||!data.belts.length) return;
  let hasOpen=false, openNew=false;
  data.belts.forEach(it => {
    if(it && it.currentStatus==="ALERT" && it.currentAlarmType==="OPEN" && !it.isAcked){
      hasOpen = true;
      const id = String(it.alarmId||it.belt||"");
      if(id && !beepedOpenIds[id]){ beepedOpenIds[id]=1; openNew=true; }
    }
  });
  if(!hasOpen){ beepedOpenIds={}; return; }
  const now = Date.now();
  if(openNew){ beepOnce(); return; }
  if(now - lastBeepAt >= BEEP_INTERVAL_MS) beepOnce();
}

["muteBtn","muteBtn2"].forEach(id => {
  $id(id)?.addEventListener("click", () => {
    const on = !getBeepEnabled(); setBeepEnabled(on); ensureAudio();
    if(audioCtx && audioCtx.state==="suspended") audioCtx.resume().catch(()=>{});
    showToast(on?"Beep ON":"Beep MUTED", on?"warn":"ok");
  });
});
document.addEventListener("click", () => { ensureAudio(); if(audioCtx && audioCtx.state==="suspended") audioCtx.resume().catch(()=>{}); }, {once:true});

// =========================================================
// 7. STATE CONTROLLER (Proxy Logic)
// =========================================================
function setSectionVisibility_(){
  const mapSec=$id("mapSection"), aiSec=$id("aiSection"), dashSec=$id("vibDashboardSection");
  if(mapSec) mapSec.style.display = (AppState.mode==="AI" || AppState.mode==="VIB_DASH") ? "none" : "block";
  if(aiSec) aiSec.classList.toggle("open", AppState.mode==="AI");
  if(dashSec) dashSec.style.display = (AppState.mode==="VIB_DASH") ? "block" : "none";
}

function setModeButtons_(){
  ["modeBeltBtn", "modePm10Btn", "modeVibBtn", "modeVibDashBtn", "modeAiBtn"].forEach(id => {
    let btn = $id(id), btn2 = $id(id+"2");
    const isActive = id.toLowerCase().includes(AppState.mode.replace("_", "").toLowerCase());
    if(btn) btn.classList.toggle("primary", isActive);
    if(btn2) btn2.classList.toggle("primary", isActive);
  });
}

function setLegendForMode_(){
  if(AppState.mode==="PM10"){
    setHTML("legendPill",'<span class="lg pmok">PM OK</span> • <span class="lg pmwarn">PM WARN</span> • <span class="lg pmbad">PM BAD</span>');
    setText("mapTitle","Plant Map • PM10 (µg/m³)"); setText("mapHint","Click dot/card to open PM10");
  }else if(AppState.mode==="AI"){
    setHTML("legendPill",'<span class="lg open">CRITICAL</span> • <span class="lg stuck">HIGH</span> • <span class="lg pmbad">ACTION</span>');
  }else if(AppState.mode==="VIB"){
    setHTML("legendPill",'<span class="lg pmok">NORMAL</span> • <span class="lg stuck">WARN</span> • <span class="lg open">DANGER</span>');
    setText("mapTitle","Plant Map • Vibration Gear-Motor"); setText("mapHint","Click POS to view graphs");
  }else if(AppState.mode==="VIB_DASH"){
    setHTML("legendPill",'<span class="lg pmok">DASHBOARD</span>');
    setText("mapTitle","External Dashboard"); setText("mapHint","Vibration Live Data");
  }else{
    setHTML("legendPill",'<span class="lg open">OPEN</span> • <span class="lg stuck">STUCK</span> • <span class="lg stale">STALE</span>');
    setText("mapTitle","Plant Map • หัวสายพานชำรุด"); setText("mapHint","Click dot/card to view details");
  }
}

function applyPageModeChange(mode) {
  document.body.setAttribute("data-mode", mode);
  localStorage.setItem("scada_page_mode", mode);

  setSectionVisibility_();
  setModeButtons_();
  setLegendForMode_();
  hideMapPopup_();
  clearMapDotStateCache_();

  if (typeof map !== 'undefined' && map && mode !== "AI" && mode !== "VIB_DASH") {
    setTimeout(() => {
      map.invalidateSize(true);
      var bounds = L.latLngBounds();
      var hasPoints = false;
      MAP_POINTS.forEach(p => {
        if (p.modes && p.modes.includes(mode)) {
          bounds.extend([p.lat, p.lng]);
          hasPoints = true;
        }
      });
      if (hasPoints) map.fitBounds(bounds, { padding: [80, 80], animate: true });
    }, 150);
  }

  MAP_POINTS.forEach(p => {
    if(p && p.__marker){
      if (p.__el) {
         p.__el.className = "mapDot"; p.__el.classList.remove("pmFocus"); p.__el.innerHTML = String(p.pos);
      }
      if(p.modes && p.modes.includes(mode)) {
        p.__marker.addTo(map); 
        if (mode === "PM10") {
          if(p.__card) p.__card.style.display = "none";
        } else {
          if(p.__card) p.__card.style.display = (window.innerWidth <= 768) ? "none" : "block";
        }
        
        if(mode === "VIB") {
          applyMapDotState_(p.__el, "VIB", "stale", true);
          if($id("posSum_" + p.pos + "_" + p.modes[0])) $id("posSum_" + p.pos + "_" + p.modes[0]).textContent = "WAIT";
          var bodyEl = $id("posBody_" + p.pos + "_" + p.modes[0]);
          if(bodyEl) {
            var waitName = (p.pos == 2) ? "6532.18 / 6532.20" : (p.pos == 3) ? "542.22" : (p.pos == 4) ? "6413.03" : "6522.18 / 6522.20";
            bodyEl.innerHTML = `<div class="posLine pos-stale"><div class="posLeft"><span class="posChip"></span><span>${waitName}</span></div><div class="posRight mono"><span>Loading...</span></div></div>`;
          }
        }
      } else {
        map.removeLayer(p.__marker);
        if(p.__card) p.__card.style.display = "none";
      }
    }
  });

  if(mode === "PM10"){
    setText("title", "Monitor"); setText("subtitle", "PM10 Monitor");
    updateMapDots_PM10_(); updatePosCards_PM10_(); fetchPm10SnapshotAll_();
  } else if(mode === "AI"){
    setText("title", "Monitor"); setText("subtitle", "AI Analysis Monitor");
    if(window.__LAST_DATA__) renderAiAnalysis_(window.__LAST_DATA__);
    refreshVibStatus_(); 
  } else if(mode === "VIB"){
    setText("title", "Monitor"); setText("subtitle", "Vibration Gear-Motor");
    refreshVibStatus_();
  } else if(mode === "VIB_DASH"){
    setText("title", "Monitor"); setText("subtitle", "Vibration Dashboard");
  } else {
    if(window.__LAST_DATA__){
      setText("title", window.__LAST_DATA__.title || "Monitor"); setText("subtitle", window.__LAST_DATA__.subtitle || "");
      updateMapDots_(window.__LAST_DATA__); updatePosCards_(window.__LAST_DATA__);
    }
  }
}

function updateAutoSwitchUI() {
  const txt = AppState.autoSwitch ? `🔄 Auto: ON ${AppState.remainingSec}s` : "⏸ Auto: OFF";
  const isWarn = (AppState.autoSwitch && AppState.remainingSec <= 5 && AppState.remainingSec > 0);
  
  ["autoSwitchBtn","autoSwitchBtn2"].forEach(id => {
    const b = $id(id);
    if(b) {
      b.textContent = txt;
      b.classList.toggle("btn-auto-active", AppState.autoSwitch);
      b.classList.toggle("btn-timer-warn", isWarn);
    }
  });
}

function isShown_(el){
  if(!el) return false;
  if(el.classList && el.classList.contains("open")) return true;
  var st=window.getComputedStyle?getComputedStyle(el):null;
  return st && st.display!=="none" && st.visibility!=="hidden" && st.opacity!=="0";
}

function shouldPauseAutoSwitch_(){
  return isShown_($id("overlay")) || isShown_($id("reportOverlay")) || isShown_($id("reportFormOverlay")) || isShown_($id("mapPopup")) || isShown_($id("qrOverlay"));
}

setInterval(() => {
  if(!AppState.autoSwitch || document.hidden || shouldPauseAutoSwitch_()) return;
  AppState.remainingSec--;
  updateAutoSwitchUI();
  
  if(AppState.remainingSec <= 0) {
    const seq = ["BELT", "PM10", "VIB", "VIB_DASH", "AI"];
    const nextIdx = (seq.indexOf(AppState.mode) + 1) % seq.length;
    AppState.mode = seq[nextIdx]; 
    AppState.remainingSec = CONFIG.AUTO_SWITCH_SEC;
  }
}, 1000);

// =========================================================
// 8. DATA FETCHING (REST API via fetch)
// =========================================================
function fetchStatus(){
  if(reloading||fetchInFlight) return;
  fetchInFlight=true; setConnBadge("warn","...");
  let done=false;
  const tmr = setTimeout(()=>{ if(done) return; done=true; fetchInFlight=false; recordFetchFail("timeout"); }, 20000);
  
  const now = Date.now();
  if(!__PM_FETCH_LOCK__ && (now - lastPm10FetchTime > 60000)) { 
     lastPm10FetchTime = now; fetchPm10SnapshotAll_();
  }

  if(AppState.mode==="VIB" || AppState.mode==="AI") refreshVibStatus_();

  callGasAPI('getStatusAll')
    .then(data => {
      if(reloading||done) return; done=true; clearTimeout(tmr); fetchInFlight=false;
      setText("lastFetch",new Date().toLocaleString("th-TH"));
      if(!data || data.ok===false){
        if (data && data.error === "SYSTEM_WARMING_UP") {
           showToast("Warming Up", "warn", data.message); setConnBadge("warn", "WAIT");
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

function recordFetchOK(){
  if(failStreak>=2) showToast("Connection recovered","ok","fetch ok");
  failStreak=0; setConnBadge("ok","LIVE");
}
function recordFetchFail(reason){
  failStreak++;
  setConnBadge(failStreak>=3?"err":"warn","FAIL "+failStreak);
  showToast("Fetch failed","warn",(reason||"unknown")+" • streak "+failStreak+"/3");
}
function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
function startPolling(){ stopPolling(); pollTimer = setInterval(fetchStatus, (window.innerWidth<=768 ? CONFIG.POLL_MOBILE : CONFIG.POLL_DESKTOP) * 1000); }

document.addEventListener("visibilitychange", () => {
  if(document.hidden){ stopPolling(); }
  else{
    if(reloading) return;
    failStreak=0; fetchInFlight=false; fetchStatus(); startPolling();
    if(AppState.mode==="PM10") fetchPm10SnapshotAll_();
  }
});

// =========================================================
// 9. AI ENGINE & TEMPLATE RENDERING
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
  var status=String(it.currentStatus||""), type=String(it.currentAlarmType||"").toUpperCase(), run=Number(it.run||0);
  var swayCount=Number(it.swayCount||0); if(!isFinite(swayCount)) swayCount=0;
  var swayStreak=aiToNum_(it.swayStreakHours), acked=!!it.isAcked;

  if(status==="ALERT"){
    if(type==="OPEN"){ score+=75; reasons.push("หัวเปิด"); }
    else if(type==="STUCK"){ score+=60; reasons.push("ติดค้าง"); }
    else if(type==="OTHER"){ score+=45; reasons.push("alarm อื่น"); }
    else if(type==="STALE"){ score+=20; reasons.push("สัญญาณหาย"); }
    else { score+=35; reasons.push("alarm ไม่ระบุชนิด"); }
  } else if(status==="NO_DATA"){ score+=15; reasons.push("ไม่มีข้อมูล"); }

  if(run===1){ 
    if(status==="ALERT"){
      score+=30; reasons.push("อันตราย: เครื่อง RUN ขณะมี Alarm");
      if(type==="STUCK") { score+=20; reasons.push("🔥 เสี่ยงสายพานไหม้/ขาด (มอเตอร์หมุนแต่สายพานหยุด)"); }
    } else { score+=10; reasons.push("เครื่องยัง RUN"); }
  }

  if(swayCount>=1){ score+=5; reasons.push("มี sway"); }
  if(swayCount>=3){ score+=8; reasons.push("sway หลายครั้ง"); }
  if(swayCount>=5){ score+=10; reasons.push("sway หนัก"); }
  if(swayStreak!=null && swayStreak>=1){ score+=10; reasons.push("sway ต่อเนื่อง"); }
  if(swayStreak!=null && swayStreak>=3){ score+=15; reasons.push("วิกฤต: sway ต่อเนื่องหลายชั่วโมง"); }
  if(status!=="ALERT" && swayCount>0){ score+=15; reasons.push("เริ่มมีแนวโน้มผิดปกติ (Pre-Alarm)"); }
  if(type==="STALE" && run===1){ score+=25; reasons.push("ความเสี่ยงสูง: RUN แต่ข้อมูลหาย"); }
  if(acked && type!=="STALE"){ score-=30; reasons.push("มีการ ACK แล้ว"); }

  score=Math.max(0,Math.min(100,Math.round(score)));
  var level="NORMAL";
  if(score>=90) level="CRITICAL"; else if(score>=70) level="HIGH"; else if(score>=40) level="MEDIUM"; else if(score>0) level="LOW";

  var ca=aiReasonCause_(type);
  if(status==="ALERT" && run===1 && type==="STUCK"){ ca.cause = "🔥 มอเตอร์หมุนแต่สายพานติดขัด (Fire Hazard)"; ca.action = "🛑 สั่งหยุดเครื่องทันที! ตรวจสอบเศษวัสดุค้างหรือลูกกลิ้งล็อค"; }
  else if(status==="ALERT" && run===1 && type==="OPEN"){ ca.cause = "⚠️ เครื่องเดินแต่หัวเปิด (Spill Hazard)"; ca.action = "🛑 สั่งหยุดเครื่อง! ระวังวัสดุล้นร่วง ตรวจสอบ Limit Switch"; }
  else if(status!=="ALERT" && swayCount>=3){ ca.cause="แนวโน้มส่ายต่อเนื่องหรือเริ่มมีความผิดปกติ"; ca.action="ตรวจ alignment, bearing, roller และติดตามซ้ำอย่างใกล้ชิด"; }
  else if(status==="NO_DATA"){ ca.cause="ไม่มีข้อมูลล่าสุดจากแหล่งต้นทาง"; ca.action="ตรวจ source sheet, gateway และการเชื่อมต่อ"; }

  return {
    belt:String(it.belt||"-"), group:String(it.group||""), status:status, alarmType:type||"-", run:run===1?1:0, score:score, level:level, isAcked:acked,
    swayCount:swayCount, swayStreakHours:swayStreak, cause:ca.cause, action:ca.action, reasonText:reasons.join(", "), alarmMsg:String(it.currentAlarmMsg||""),
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
          belt: name, group: "Vibration Gear", status: "ALERT", alarmType: "VIB_" + level, run: 1, score: baseScore, level: level, isAcked: false, cause: latest.reason, action: latest.advice, 
          reasonText: `เกินเกณฑ์ที่ตั้งไว้ (>${limitWarn} mm/s)`, alarmMsg: "Peak: " + (latest.acc||0).toFixed(2) + " mm/s", sortKey: (level==="CRITICAL"?500:level==="HIGH"?400:level==="MEDIUM"?300:level==="LOW"?200:100) + baseScore
       });
     }
     function getLimits(posNum) {
        var p = MAP_POINTS.find(m => m.pos === posNum && m.modes && m.modes.includes("VIB"));
        return { w: p ? (p.vibWarn || 30) : 30, d: p ? (p.vibDanger || 60) : 60 };
     }
     if(window.__LAST_VIB_DATA__[1]) { var lim = getLimits(1); addVibAi(window.__LAST_VIB_DATA__[1].data18, "6522.18", lim.w, lim.d); addVibAi(window.__LAST_VIB_DATA__[1].data20, "6522.20", lim.w, lim.d); }
     if(window.__LAST_VIB_DATA__[2]) { var lim = getLimits(2); addVibAi(window.__LAST_VIB_DATA__[2].data18, "6532.18", lim.w, lim.d); addVibAi(window.__LAST_VIB_DATA__[2].data20, "6532.20", lim.w, lim.d); }
     if(window.__LAST_VIB_DATA__[3]) { var lim = getLimits(3); addVibAi(window.__LAST_VIB_DATA__[3].data18, "542.22", lim.w, lim.d); }
     if(window.__LAST_VIB_DATA__[4]) { var lim = getLimits(4); addVibAi(window.__LAST_VIB_DATA__[4].data18, "6413.03", lim.w, lim.d); }
  }

  if(window.__TREND_VIB_DATA__) {
     var t18 = window.__TREND_VIB_DATA__.data18 || [];
     var t20 = window.__TREND_VIB_DATA__.data20 || [];
     function addVibAiTrend(vibData, name) {
        if(!vibData || vibData.length < 2000) return;
        var chunk = Math.floor(vibData.length / 5); 
        var oldData = vibData.slice(0, chunk), newData = vibData.slice(vibData.length - chunk);
        var oldAvg = oldData.reduce((acc, val) => acc + (val.baseAcc||0), 0) / chunk;
        var newAvg = newData.reduce((acc, val) => acc + (val.baseAcc||0), 0) / chunk;
        if(oldAvg > 0.03) { 
            var increasePct = ((newAvg - oldAvg) / oldAvg) * 100;
            if(increasePct >= 25 && newAvg >= 20) {
                var isCrit = increasePct >= 50 && newAvg >= 30;
                rows.push({
                   belt: name, group: "Predictive Maint.", status: "WARN", alarmType: "TREND_UP", run: 1, score: isCrit ? 85 : 65, level: isCrit ? "CRITICAL" : "HIGH", isAcked: false,
                   cause: `📈 ระดับพลังงานการสั่นสะเทือน (RMS) ไต่ระดับเพิ่มขึ้น ${increasePct.toFixed(1)}%`, action: "ตรวจสอบตลับลูกปืน, การหล่อลื่น (จาระบี) และ Alignment เพื่อป้องกัน Break down",
                   reasonText: `AI วิเคราะห์แนวโน้มจาก ${vibData.length} ข้อมูลย้อนหลัง (5 วัน)`, alarmMsg: `RMS เดิม: ${oldAvg.toFixed(3)}G ➔ ปัจจุบัน: ${newAvg.toFixed(3)}G`, sortKey: isCrit ? 485 : 385
                });
            }
        }
     }
     addVibAiTrend(t18, "6522.18"); addVibAiTrend(t20, "6522.20");
  }

  if (window.__PM10_LATEST__) {
    for (var pos in window.__PM10_LATEST__) {
      var pm = window.__PM10_LATEST__[pos];
      if (pm && pm.v != null && !isPm10Stale_(pm)) {
        var v = Number(pm.v);
        var displayName = pm.loc ? pm.loc : pos;
        if (v >= CONFIG.THRESHOLDS.PM10_BAD) {
          rows.push({ belt: "PM10 " + displayName, group: "Environment", status: "ALERT", alarmType: "DUST_BAD", run: 0, score: 85, level: "HIGH", isAcked: false, cause: "⚠️ ฝุ่นสะสมหนาแน่นเกินมาตรฐานอันตราย", action: "ตรวจสอบ Bag Filter และระบบพรมน้ำด่วน", reasonText: `เกิน ${CONFIG.THRESHOLDS.PM10_BAD} µg/m³`, alarmMsg: v.toFixed(0) + " µg/m³", sortKey: 485 });
        } else if (v >= CONFIG.THRESHOLDS.PM10_WARN) {
          rows.push({ belt: "PM10 " + displayName, group: "Environment", status: "WARN", alarmType: "DUST_WARN", run: 0, score: 45, level: "MEDIUM", isAcked: false, cause: "ฝุ่นเริ่มฟุ้งกระจายในพื้นที่", action: "ตรวจสอบจุดรั่วไหลของฝุ่น", reasonText: `เกิน ${CONFIG.THRESHOLDS.PM10_WARN} µg/m³`, alarmMsg: v.toFixed(0) + " µg/m³", sortKey: 345 });
        }
      }
    }
  }

  rows.sort((a,b) => (b.sortKey||0)-(a.sortKey||0) || String(a.belt).localeCompare(String(b.belt)));
  window.__AI_ROWS__=rows;
  return rows;
}

function renderAiAnalysis_(data){
  var rows = buildAiRows_(data);
  var c = {CRITICAL:0, HIGH:0, MEDIUM:0, LOW:0, NORMAL:0};
  rows.forEach(r => c[r.level||"NORMAL"] = (c[r.level||"NORMAL"]||0)+1);
  
  setText("aiKpiCritical", c.CRITICAL||0);
  setText("aiKpiHigh", c.HIGH||0);
  setText("aiKpiMedium", c.MEDIUM||0);
  setText("aiKpiWatch", c.LOW||0);
  setText("aiGeneratedAt", "Generated: " + new Date().toLocaleString("th-TH"));

  const tbody = $id("aiTbody");
  if(tbody) {
    tbody.innerHTML = ""; 
    if(rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="rMut empty-row">No AI findings</td></tr>';
    } else {
      const topRows = rows.slice(0, 15);
      const template = $id("tpl-ai-row"); 
      
      topRows.forEach(r => {
        const clone = template.content.cloneNode(true);
        const tr = clone.querySelector('tr');
        
        if (r.level === "CRITICAL") tr.style.background = "rgba(255,59,48,0.15)";
        else if (r.level === "HIGH") tr.style.background = "rgba(255,159,10,0.10)";

        clone.querySelector('.t-score').textContent = r.score;
        clone.querySelector('.t-level').textContent = r.level;
        clone.querySelector('.t-level').className = `aiLevel ${r.level}`;
        
        clone.querySelector('.t-belt').textContent = r.belt;
        clone.querySelector('.t-group').textContent = r.group || "-";
        
        clone.querySelector('.t-run').textContent = (r.group==="Environment") ? "-" : (r.run===1?'RUN':'STOP');
        if(r.isAcked) clone.querySelector('.t-ack').textContent = "ACK";
        
        clone.querySelector('.t-alarm').textContent = r.alarmType || "-";
        if(r.alarmMsg) clone.querySelector('.t-msg').textContent = r.alarmMsg;
        
        clone.querySelector('.t-cause').textContent = r.cause;
        clone.querySelector('.t-action').textContent = r.action;

        tbody.appendChild(clone);
      });
    }
  }

  const list = $id("aiReasonList");
  if(list){
    if(!rows.length){
      list.innerHTML='<div class="aiEmpty">No AI findings</div>';
    }else{
      var out="";
      var top=rows.slice(0,5);
      top.forEach(rr => {
        var borderGlow = rr.level === "CRITICAL" ? "border-color: #ff3b30; box-shadow: 0 0 10px rgba(255,59,48,0.2);" : "";
        out+=`<div class="aiReasonItem" style="${borderGlow}">
          <div class="aiReasonTop">
            <div class="aiReasonBelt mono">${esc(rr.belt)} <span class="aiTiny">${esc(rr.group||"")}</span></div>
            <span class="aiLevel ${esc(rr.level)}">${esc(rr.level)} • ${esc(String(rr.score))}</span>
          </div>
          <div class="aiReasonMsg"><b>Alarm:</b> ${esc(rr.alarmType||"-")}${rr.alarmMsg?(` • ${esc(rr.alarmMsg)}`):''}</div>
          <div class="aiReasonMsg"><b>Why:</b> ${esc(rr.reasonText||rr.cause)}</div>
          <div class="aiReasonMsg" style="color:var(--scada-cyan);"><b>Action:</b> ${esc(rr.action)}</div>
        </div>`;
      });
      list.innerHTML=out;
    }
  }
}

// =========================================================
// 10. MAP, POS CARDS & POPUPS
// =========================================================
function buildMapDotsOnce_() {
  var canvas = $id("mapCanvas"); 
  if(!canvas || canvas.__dotsBuilt) return;
  canvas.__dotsBuilt = true;
  ensureMapPopup_();

  callGasAPI('getMapPointsData')
    .then(points => {
      MAP_POINTS = points;
      mapCoords = {};
      points.forEach(p => { mapCoords[p.pos] = { lat: p.lat, lng: p.lng }; });
      initLeafletMap_();
      fetchPm10SnapshotAll_(); 
    })
    .catch(err => console.error("Map points fetch error:", err));
}

function initLeafletMap_() {
  var bounds = L.latLngBounds();
  var hasPoints = false;
  MAP_POINTS.forEach(p => {
    if (p.modes && p.modes.includes(AppState.mode)) { bounds.extend([p.lat, p.lng]); hasPoints = true; }
  });

  var BASE_ZOOM = 17.5; 
  map = L.map('mapCanvas', { zoomControl: false, attributionControl: false, zoomSnap: 0.5, wheelPxPerZoomLevel: 120 });
  if (hasPoints) { map.fitBounds(bounds, { padding: [80, 80] }); BASE_ZOOM = map.getZoom(); } 
  else { map.setView([14.5, 100.5], BASE_ZOOM); }
  
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 22, maxNativeZoom: 17
  }).addTo(map);

  var markerWrappers = [];
  MAP_POINTS.forEach(p => {
    var wrapper = document.createElement('div');
    wrapper.style.position = 'relative'; wrapper.style.transformOrigin = "0 0";

    var d = document.createElement("div");
    d.className = "mapDot ok"; d.textContent = String(p.pos); p.__el = d;

    var card = document.createElement("div");
    card.className = "posCard"; card.style.transform = `translate(${p.labelDx}px,${p.labelDy}px)`;
    card.innerHTML = `<div class="posCardTitle"><div class="t">POS ${p.pos}</div><div class="sum mono" id="posSum_${p.pos}_${p.modes[0]}">-</div></div><div class="posCardBody" id="posBody_${p.pos}_${p.modes[0]}"></div>`;
    p.__card = card;

    d.addEventListener("click", ev => {
      if(ev.stopPropagation) ev.stopPropagation();
      if (window.innerWidth <= 768) {
        var isHidden = (card.style.display === "none" || !card.style.display);
        MAP_POINTS.forEach(m => { if(m.__card) m.__card.style.display = "none"; });
        card.style.display = isHidden ? "block" : "none";
      } else { showPosCards_(p.pos, wrapper); }
    });

    card.addEventListener("click", ev => {
      if(ev.stopPropagation) ev.stopPropagation(); showPosCards_(p.pos, wrapper);
    });

    wrapper.appendChild(d); wrapper.appendChild(card);
    p.__marker = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'scada-leaflet-marker', html: wrapper, iconSize: [0, 0] }) });

    if (p.modes && p.modes.includes(AppState.mode)) {
      p.__marker.addTo(map);
      if (AppState.mode === "PM10") { p.__card.style.display = "none"; } 
      else { p.__card.style.display = (window.innerWidth <= 768) ? "none" : "block"; }
    } else {
      p.__card.style.display = "none";
    }
    markerWrappers.push(wrapper);
  });

  map.on('zoom', () => {
    var currentZoom = map.getZoom();
    var scaleFactor = Math.pow(2, currentZoom - BASE_ZOOM);
    markerWrappers.forEach(w => w.style.transform = `scale(${scaleFactor})`);
  });
  map.fire('zoom');

  map.on('click', () => {
    if(window.innerWidth <= 768) MAP_POINTS.forEach(m => { if(m.__card) m.__card.style.display = "none"; });
  });

  if (AppState.mode === "PM10") { updateMapDots_PM10_(); updatePosCards_PM10_(); } 
  else if (AppState.mode === "BELT" && window.__LAST_DATA__) { updateMapDots_(window.__LAST_DATA__); updatePosCards_(window.__LAST_DATA__); }
}

function showPosCards_(pos, anchorEl) {
  if (AppState.mode === "PM10") { hideMapPopup_(); fetchPm10ForPos_(pos); return; }
  if (AppState.mode === "VIB") { hideMapPopup_(); fetchVibData("6h", pos); return; }

  var pop = ensureMapPopup_(); if (!pop) return;
  var data = window.__LAST_DATA__, belts = (data && data.belts) ? data.belts : [], mapObj = {};
  belts.forEach(b => { if(b && b.belt) mapObj[String(b.belt)] = b; });
  
  var point = MAP_POINTS.find(m => m.pos === pos); if (!point) return;
  var list = [];
  point.belts.forEach(name => { if(mapObj[name]) list.push(mapObj[name]); });
  
  setText("mapPopupTitle", `POS ${pos} • ${point.belts.join(", ")}`);
  var body = $id("mapPopupBody"); if (!body) return; body.innerHTML = "";
  
  if (!list.length) {
    body.innerHTML = '<div class="mono" style="color:var(--muted);font-weight:900;">No belt data for this POS</div>';
  } else {
    list.forEach(item => {
      var div = document.createElement("div"); div.className = "miniCard"; div.innerHTML = buildMiniCardHtml_(item);
      div.addEventListener("click", ev => { if (ev.stopPropagation) ev.stopPropagation(); hideMapPopup_(); fetchHistory(item.belt); });
      body.appendChild(div);
    });
  }
  
  var canvas = $id("mapCanvas"); if (!canvas) return;
  var cr = canvas.getBoundingClientRect(), ar = anchorEl ? anchorEl.getBoundingClientRect() : cr;
  pop.style.display = "block";
  var pw = pop.offsetWidth || 280, ph = pop.offsetHeight || 200;
  var dotLeft = ar.left - cr.left, dotTop = ar.top - cr.top;
  var left = dotLeft + 16, top = dotTop + 16;
  if (left + pw > cr.width - 8) left = Math.max(8, dotLeft - pw - 8);
  if (top + ph > cr.height - 8) top = Math.max(8, dotTop - ph - 8);
  if (left < 8) left = 8; if (top < 8) top = 8;
  pop.style.left = left + "px"; pop.style.top = top + "px";
}

function ensureMapPopup_(){
  var canvas=$id("mapCanvas"); if(!canvas) return null;
  var ex=$id("mapPopup"); if(ex) return ex;
  var pop=document.createElement("div"); pop.id="mapPopup"; pop.className="mapPopup";
  pop.innerHTML='<div class="mapPopupHead"><div class="mapPopupTitle" id="mapPopupTitle">POS</div><button class="mapPopupClose" id="mapPopupClose">✕</button></div><div class="mapPopupBody" id="mapPopupBody"></div>';
  canvas.appendChild(pop); pop.addEventListener("click", ev => { if(ev.stopPropagation) ev.stopPropagation(); });
  var closeBtn=$id("mapPopupClose"); if(closeBtn) closeBtn.addEventListener("click", ev => { if(ev.stopPropagation) ev.stopPropagation(); hideMapPopup_(); });
  canvas.addEventListener("click", () => hideMapPopup_()); return pop;
}
function hideMapPopup_(){ var pop=$id("mapPopup"); if(pop) pop.style.display="none"; }

function buildMiniCardHtml_(item){
  var c=clsFor(item), isStale=(item.currentStatus==="ALERT"&&item.currentAlarmType==="STALE");
  var runHtml=(isStale||item.hideRunTag)?"":runTag(item.run||0);
  var showAlarm=(item.currentStatus==="ALERT"&&item.currentAlarmMsg), lineLabel=(item.currentStatus==="ALERT")?"Alarm time":"Sleep time";
  var lineTime=item.currentTime||"-", swayHtml=buildSwayHtml(item), offlineBadge=isStale?'<span class="badge-offline">OFFLINE</span>':'';
  return `
    <div class="miniTitleRow"><div class="miniTitle">${esc(item.belt)} ${offlineBadge} ${runHtml}</div><div class="badge ${esc(c.badge)}">${esc(c.text)}</div></div>
    <div class="miniSmall">${esc(lineLabel)}: <span class="mono">${esc(lineTime)}</span></div>
    ${showAlarm ? `<div class="miniAlarm mono">${esc(item.currentAlarmMsg)}</div>` : ''}
    ${swayHtml || ''}
  `;
}

function updateMapDots_(data){
  buildMapDotsOnce_();
  if(!data || !data.belts) return;
  if(AppState.mode==="PM10" || AppState.mode==="VIB") return;
  var mapObj={}; data.belts.forEach(b => { if(b) mapObj[String(b.belt||b.name||b.id)] = b; });
  
  MAP_POINTS.forEach(p => {
    if(!p.__el) return;
    var worstAlarm=0, anyRun=false, allOffline=true, beltCount=(p.belts && p.belts.length)?p.belts.length:0;
    for(var j=0; j<beltCount; j++){
      var id=String(p.belts[j]), it=mapObj[id] || null;
      var lv = beltLevel_(it); if(lv>=2 && lv>worstAlarm) worstAlarm=lv;
      if(!(it && (it.currentStatus==="NO_DATA" || String(it.currentAlarmType||"").toUpperCase()==="STALE"))) allOffline=false;
      var rr=Number(it && it.run); if(isFinite(rr) && rr!==0) anyRun=true;
    }
    var nextCls="ok";
    if(worstAlarm>=2) nextCls = (worstAlarm===4)?"open":(worstAlarm===3?"stuck":"other");
    else if(allOffline && beltCount>0) nextCls="stale";
    var nextPulse=(nextCls!=="stale") && !!(anyRun || p.pulse);
    var nextSig=nextCls+"|"+(nextPulse?1:0);
    if(p.__beltStateSig===nextSig && AppState.mode==="BELT") return;
    p.__beltStateSig=nextSig;
    if(AppState.mode==="BELT"){ applyMapDotState_(p.__el, "BELT", nextCls, nextPulse); p.__el.classList.remove("pmFocus"); }
  });
}

function updatePosCards_(data){
  if(!data||!data.belts) return;
  var mapObj={}; data.belts.forEach(it => { if(it&&it.belt) mapObj[String(it.belt)]=it; });
  MAP_POINTS.forEach(p => {
    if(!p.__card || !p.modes.includes("BELT")) return; 
    var worst=0, bodyHtml="";
    p.belts.forEach(bname => {
      var it2=mapObj[bname]||null, lv=beltLevel_(it2); if(lv>worst) worst=lv;
      var runTxt=""; if(it2&&it2.currentStatus==="ALERT"&&it2.currentAlarmType==="STALE") runTxt=""; else if(it2&&it2.run!=null) runTxt=(Number(it2.run)===1)?"RUN":"STOP";
      var stTxt="OK"; if(!it2 || it2.currentStatus==="NO_DATA") stTxt="STALE"; else if(it2.currentStatus==="ALERT") stTxt=it2.isAcked?"ACK":String(it2.currentAlarmType||"ALERT");
      var lineCls = (lv===4)?"pos-open":(lv===3?"pos-stuck":(lv===2?"pos-other":(lv===1?"pos-stale":"pos-ok")));
      if(it2&&it2.currentStatus!=="ALERT"&&Number(it2.run)===0) lineCls="pos-stop";
      bodyHtml+=`<div class="posLine ${esc(lineCls)}"><div class="posLeft"><span class="posChip"></span><span>${esc(bname)}</span></div><div class="posRight mono"><span>${esc(stTxt)}</span>${runTxt?`<span>• ${esc(runTxt)}</span>`:''} </div></div>`;
    });
    var sumEl=$id("posSum_"+p.pos+"_BELT"); if(sumEl) sumEl.textContent = (worst===4)?"OPEN":(worst===3?"STUCK":(worst===2?"ALERT":(worst===1?"STALE":"OK")));
    var bodyEl=$id("posBody_"+p.pos+"_BELT"); if(bodyEl) bodyEl.innerHTML=bodyHtml;
  });
}

// =========================================================
// 11. PM10 LOGIC & CHARTS
// =========================================================
function fetchPm10SnapshotAll_() {
  var pmPoints = MAP_POINTS.filter(m => m.modes && m.modes.includes("PM10"));
  if(pmPoints.length === 0) { lastPm10FetchTime = 0; return; }
  
  pmPoints.forEach(p => {
    var pos = p.pos;
    if (!__PM10_LATEST__[pos]) {
       if($id(`posSum_${pos}_PM10`)) $id(`posSum_${pos}_PM10`).textContent = "...";
       if($id(`posBody_${pos}_PM10`)) $id(`posBody_${pos}_PM10`).innerHTML = '<div class="posLine pos-stale"><div class="posLeft"><span class="posChip"></span><span>PM10</span></div><div class="posRight mono"><span>Loading...</span></div></div>';
    }
  });

  callGasAPI('getPm10SnapshotAll')
    .then(res => {
       if(res && res.ok && res.data) {
         for (var posKey in res.data) {
           var posNum = Number(posKey); setPm10Latest_(posNum, res.data[posKey]); updateMapDotPm10_(posNum);
         }
         if(AppState.mode === "PM10") updatePosCards_PM10_();
       }
    }).catch(err => console.error("PM10 Batch Fetch error: ", err));
}

function fetchPm10ForPos_(pos,forceRefresh){
  var hasCache = Array.isArray(__PM10_SERIES__[pos]) && __PM10_SERIES__[pos].length>0;
  var canUseCache = hasCache && !forceRefresh && (Number(__PM10_SERIES_FETCHED_AT__[pos]||0)>0 && (Date.now()-__PM10_SERIES_FETCHED_AT__[pos])<=120000);

  setText("modalTitle", `PM10 • POS ${pos}`);
  if(canUseCache || (__PM_FETCH_LOCK__ && hasCache)){ renderPm10Modal_(pos,{ok:true,rows:__PM10_SERIES__[pos]||[]}); openModal(); return; }
  if(__PM_FETCH_LOCK__){ showToast("PM10 busy","warn","please wait…"); return; }

  __PM_FETCH_LOCK__=true; destroyAllModalCharts_();
  setHTML("modalBody","<div class='skeleton' style='height:80px;margin-bottom:8px;'></div><div class='skeleton' style='height:240px;'></div>");
  openModal();

  callGasAPI('getPm10Latest100', {pos: pos})
    .then(res => {
      __PM_FETCH_LOCK__=false;
      if(!res||res.ok===false){
        if(hasCache){ renderPm10Modal_(pos,{ok:true,rows:__PM10_SERIES__[pos]}); showToast("PM10 cached","warn","showing cached data"); return; }
        setHTML("modalBody",`<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc((res&&res.error)?res.error:"unknown")}</div>`); return;
      }
      __PM10_SERIES__[pos]=res.rows||[]; __PM10_SERIES_FETCHED_AT__[pos]=Date.now();
      let latest=null; for(let i=res.rows.length-1;i>=0;i--){ if(res.rows[i] && res.rows[i].v!=null){ latest=res.rows[i]; break; } }
      setPm10Latest_(pos, latest); updateMapDotPm10_(pos);
      if(AppState.mode==="PM10") updatePosCards_PM10_();
      renderPm10Modal_(pos,res);
    }).catch(err => {
      __PM_FETCH_LOCK__=false;
      if(hasCache){ renderPm10Modal_(pos,{ok:true,rows:__PM10_SERIES__[pos]}); showToast("PM10 cached","warn","showing cached data"); return; }
      setHTML("modalBody",`<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc(String(err))}</div>`);
    });
}

function updateMapDotPm10_(pos){
  var point = MAP_POINTS.find(m => m.pos === pos && m.modes && m.modes.includes("PM10"));
  if(!point || !point.__el) return;
  var data = __PM10_LATEST__[pos];
  var nextCls = "stale", nextPulse = false;
  
  if(data && !isPm10Stale_(data)){
    var sev = pm10Severity_(data.v);
    if(sev === "bad"){ nextCls = "pm-bad"; nextPulse = true; }
    else if(sev === "warn"){ nextCls = "pm-warn"; nextPulse = true; }
    else{ nextCls = "pm-ok"; nextPulse = true; }
  }

  var valStr = (data && data.v != null && !isPm10Stale_(data)) ? Number(data.v).toFixed(0) + " µg" : "-";
  var nextSig = nextCls + "|" + (nextPulse ? 1 : 0) + "|" + valStr;
  if(point.__pmStateSig === nextSig && AppState.mode === "PM10") return;

  point.__pmStateSig = nextSig;
  if(AppState.mode === "PM10"){
    applyMapDotState_(point.__el, "PM10", nextCls, nextPulse);
    point.__el.classList.add("pmFocus"); point.__el.innerHTML = valStr; 
  }
}

function updateMapDots_PM10_(){
  buildMapDotsOnce_(); MAP_POINTS.forEach(p => { if(p.__el) updateMapDotPm10_(p.pos); });
}

function updatePosCards_PM10_(){
  MAP_POINTS.forEach(p => {
    if(!p.__card || !p.modes.includes("PM10")) return; 
    var sumEl=$id(`posSum_${p.pos}_PM10`), bodyEl=$id(`posBody_${p.pos}_PM10`); if(!sumEl||!bodyEl) return;
    var latest=__PM10_LATEST__[p.pos], v=(latest&&latest.v!=null)?Number(latest.v):NaN;
    var ageMin=(!isNaN(v)&&latest)?pm10AgeMin_(latest):null, ageTxt=ageMin!=null?` ${ageMin}m ago`:"";
    
    if(!isFinite(v)){
      sumEl.textContent="NO"; bodyEl.innerHTML='<div class="posLine pos-stale"><div class="posLeft"><span class="posChip"></span><span>PM10</span></div><div class="posRight mono"><span>- µg/m³</span></div></div>';
      return;
    }
    var sev=pm10Severity_(v), sevTxt=(sev==="bad")?"BAD":(sev==="warn"?"WARN":"OK"), lineCls=(sev==="bad")?"pos-open":(sev==="warn"?"pos-stuck":"pos-ok");
    sumEl.textContent=sevTxt;
    bodyEl.innerHTML=`<div class="posLine ${lineCls}"><div class="posLeft"><span class="posChip"></span><span>PM10</span></div><div class="posRight mono"><span>${esc(v.toFixed(0))} µg</span><span style="opacity:.6">${esc(ageTxt)}</span></div></div>`;
  });
}

function renderPm10Modal_(pos,res){
  var rows=(res&&res.rows)?res.rows:[];
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

  var latest=null; for(let i=rows.length-1;i>=0;i--){ var vv=num_(rows[i]&&rows[i].v); if(vv!=null){latest={time:String(rows[i].time||""),v:vv};break;} }
  var latestVal=latest?latest.v:null, latestTime=latest?latest.time:(rows.length?String((rows[rows.length-1]||{}).time||""):"");
  var sev=sev_(latestVal), vals=rows.map(r=>num_(r&&r.v)).filter(v=>v!=null);
  var minV=vals.length?Math.min.apply(null,vals):null, maxV=vals.length?Math.max.apply(null,vals):null;
  var avgV=vals.length?(vals.reduce((a,b)=>a+b,0)/vals.length):null;
  var barPct=latestVal!=null?Math.min(100,(latestVal/200)*100):0, barColor=latestVal==null?"var(--muted)":latestVal>=CONFIG.THRESHOLDS.PM10_BAD?"var(--open)":latestVal>=CONFIG.THRESHOLDS.PM10_WARN?"var(--stuck)":"var(--ok)";

  var html=`<div style="display:flex;flex-direction:column;gap:10px;">
    <div class="rCard">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div><div class="mono" style="font-size:26px;font-weight:800;color:${sev.color};">${esc(fmt_(latestVal))} <span style="font-size:13px;color:var(--muted);">µg/m³</span></div>
        <div class="mono" style="color:var(--muted);margin-top:3px;font-size:11px;">${esc(latestTime||"-")} ${res.tz?`• ${esc(res.tz)}`:""}</div></div>
        <div class="${esc(sev.cls)}" style="font-size:14px;font-weight:900;white-space:nowrap;">${esc(sev.txt)}</div>
      </div>
      <div class="pm10LevelBar"><div class="pm10LevelFill" style="width:${barPct}%;background:${barColor};"></div></div>
      <div class="pm10Legend">
        <div class="pm10LegItem"><div class="pm10LegDot" style="background:var(--ok)"></div><span>OK <50</span></div>
        <div class="pm10LegItem"><div class="pm10LegDot" style="background:var(--stuck)"></div><span>WARN 50-120</span></div>
        <div class="pm10LegItem"><div class="pm10LegDot" style="background:var(--open)"></div><span>BAD >120</span></div>
      </div>
      <div class="pm10Summary">
        <div class="pm10StatCard"><div class="pm10StatVal mono">${esc(fmt_(minV))}</div><div class="pm10StatLbl">MIN</div></div>
        <div class="pm10StatCard"><div class="pm10StatVal mono">${esc(fmt_(avgV?Math.round(avgV*10)/10:null))}</div><div class="pm10StatLbl">AVG</div></div>
        <div class="pm10StatCard"><div class="pm10StatVal mono">${esc(fmt_(maxV))}</div><div class="pm10StatLbl">MAX</div></div>
      </div>
    </div>
    <div class="rCard" style="padding:10px;">
      <div class="mono" style="color:var(--muted);margin-bottom:6px;font-size:11px;">PM10 trend — last ${rows.length} readings</div>
      <div style="height:240px;width:100%;"><canvas id="pm10Chart"></canvas></div>
    </div>
    <div class="rCard" style="padding:10px;"><div style="overflow:auto;max-height:320px;">
      <table><thead><tr><th>Time</th><th style="text-align:right;">PM10 (µg/m³)</th><th>Status</th></tr></thead><tbody>`;
  
  for(let r=rows.length-1;r>=0;r--){
    var row=rows[r]||{}, tv=String(row.time||""), vv2=num_(row.v), rs=sev_(vv2);
    html+=`<tr><td class="mono">${esc(tv)}</td><td class="mono" style="text-align:right;font-weight:900;color:${rs.color};">${esc(fmt_(vv2))}</td><td class="${esc(rs.cls)}">${esc(rs.txt)}</td></tr>`;
  }
  html+=`</tbody></table></div></div></div>`;

  setText("modalTitle", `PM10 • ${res.location || "POS " + pos}`);
  setHTML("modalBody",html);
  setTimeout(()=>drawPm10Chart_(rows), 50);
}

var __PM10_CHART__ = null;
function drawPm10Chart_(rows) {
  var cvs = $id("pm10Chart"); if (!cvs) return;
  if (__PM10_CHART__ && __PM10_CHART__.canvas !== cvs) { __PM10_CHART__.destroy(); __PM10_CHART__ = null; }

  var clean = (rows || []).filter(r => r && r.v != null && isFinite(Number(r.v))).map(r => ({ time: String(r.time || ""), v: Number(r.v) }));
  if (clean.length > 50) clean = clean.slice(clean.length - 50);
  
  var labels = clean.map(r => { var t = r.time; if(t.indexOf(" ")>=0) t = t.split(" ").pop().slice(0, 5); return t; });
  var data = clean.map(r => r.v);
  var pointBg = data.map(v => v >= CONFIG.THRESHOLDS.PM10_BAD ? "#ff3b30" : v >= CONFIG.THRESHOLDS.PM10_WARN ? "#ff9f0a" : "#1fd27a");

  var isDark = (document.body.getAttribute("data-theme") || "night") !== "day";
  var gridColor = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)", textColor = isDark ? "#9fb2c9" : "#4b5b70", isMobile = window.innerWidth <= 768;

  if (__PM10_CHART__) {
    __PM10_CHART__.data.labels = labels; __PM10_CHART__.data.datasets[0].data = data;
    __PM10_CHART__.data.datasets[0].pointBackgroundColor = pointBg; __PM10_CHART__.data.datasets[0].pointBorderColor = pointBg;
    if (__PM10_CHART__.options.scales.x && __PM10_CHART__.options.scales.y) {
      __PM10_CHART__.options.scales.x.ticks.color = textColor; __PM10_CHART__.options.scales.x.grid.color = gridColor;
      __PM10_CHART__.options.scales.y.ticks.color = textColor; __PM10_CHART__.options.scales.y.grid.color = gridColor;
    }
    __PM10_CHART__.update('none'); 
  } else {
    __PM10_CHART__ = new Chart(cvs, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "PM10 (µg/m³)", data: data, tension: 0.3, borderWidth: 2,
          pointRadius: isMobile ? 1.5 : 3, pointHoverRadius: isMobile ? 2 : 5, pointBackgroundColor: pointBg, pointBorderColor: pointBg,
          segment: { borderColor: ctx => { var v=data[ctx.p1DataIndex]; return v>=CONFIG.THRESHOLDS.PM10_BAD?"#ff3b30":(v>=CONFIG.THRESHOLDS.PM10_WARN?"#ff9f0a":"#1fd27a"); } },
          fill: true,
          backgroundColor: ctx => {
            var area = ctx.chart.chartArea; if (!area) return "transparent";
            var grad = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            grad.addColorStop(0, "rgba(255,59,48,.18)"); grad.addColorStop(0.5, "rgba(255,159,10,.10)"); grad.addColorStop(1, "rgba(31,210,122,.05)");
            return grad;
          }
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: isMobile ? false : { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: { mode: "index", intersect: false, callbacks: { label: ctx => { var v=ctx.parsed.y, s=v>=CONFIG.THRESHOLDS.PM10_BAD?"⚠ BAD":(v>=CONFIG.THRESHOLDS.PM10_WARN?"▲ WARN":"✓ OK"); return ` ${v.toFixed(1)} µg/m³ (${s})`; } } },
          zoom: { pan: { enabled: true, mode: 'x' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } }
        },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true, color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
          y: { beginAtZero: true, ticks: { color: textColor, font: { size: 10 }, callback: v => v+" µg" }, grid: { color: gridColor }, afterDataLimits: a => { a.max = Math.max(a.max || 0, 150); } }
        }
      },
      plugins: [{
        id: "thresholdLines",
        afterDraw: chart => {
          var ctx2 = chart.ctx, area = chart.chartArea, yScale = chart.scales.y; if (!area) return;
          function drawLine(val, color, label) {
            var y = yScale.getPixelForValue(val); if (y < area.top || y > area.bottom) return;
            ctx2.save(); ctx2.strokeStyle = color; ctx2.lineWidth = 1.5; ctx2.setLineDash([5, 4]); ctx2.globalAlpha = 0.65;
            ctx2.beginPath(); ctx2.moveTo(area.left, y); ctx2.lineTo(area.right, y); ctx2.stroke();
            ctx2.setLineDash([]); ctx2.globalAlpha = 0.85; ctx2.fillStyle = color; ctx2.font = "bold 10px ui-monospace,monospace";
            ctx2.fillText(label, area.left + 4, y - 3); ctx2.restore();
          }
          drawLine(CONFIG.THRESHOLDS.PM10_WARN, "#ff9f0a", "WARN " + CONFIG.THRESHOLDS.PM10_WARN);
          drawLine(CONFIG.THRESHOLDS.PM10_BAD, "#ff3b30", "BAD " + CONFIG.THRESHOLDS.PM10_BAD);
        }
      }]
    });
  }
}

// =========================================================
// 12. VIBRATION LOGIC & CHARTS
// =========================================================
function refreshVibStatus_(){
  var timeRange = (_vibPollCount % 30 === 0) ? "5d" : "4h"; _vibPollCount++;
  callGasAPI('getVibData', {rangeKey: timeRange})
    .then(res => {
      if(!res || res.ok === false) return;
      if(timeRange === "5d") window.__TREND_VIB_DATA__ = res;
      window.__LAST_VIB_DATA__ = res; 

      MAP_POINTS.forEach(p => {
        if(p.modes && p.modes.includes("VIB") && p.__el && AppState.mode === "VIB") {
          var posData = res[p.pos]; if(!posData) return; 

          var d18 = posData.data18 || [], d20 = posData.data20 || [], name18 = posData.name18, name20 = posData.name20;
          var latest18 = d18.length > 0 ? d18[d18.length-1] : null, latest20 = d20.length > 0 ? d20[d20.length-1] : null;
          var v18 = latest18 ? (Number(latest18.acc) || 0) : 0, v20 = latest20 ? (Number(latest20.acc) || 0) : 0;
          var warnLimit = p.vibWarn || 30, dangerLimit = p.vibDanger || 60;

          var lv18 = "NORMAL"; if (v18 > dangerLimit) lv18 = "DANGER"; else if (v18 > warnLimit) lv18 = "WARN";
          var lv20 = "NORMAL"; if (v20 > dangerLimit) lv20 = "DANGER"; else if (v20 > warnLimit) lv20 = "WARN";

          var now = Date.now();
          if(latest18 && (now - latest18.ts > 1200000)) lv18 = "OFFLINE";
          if(latest20 && (now - latest20.ts > 1200000)) lv20 = "OFFLINE";

          var worst = "NORMAL";
          if(lv18 === "DANGER" || lv20 === "DANGER") worst = "DANGER"; else if(lv18 === "WARN" || lv20 === "WARN") worst = "WARN";
          if(name20) { if(lv18 === "OFFLINE" && lv20 === "OFFLINE") worst = "OFFLINE"; } else { if(lv18 === "OFFLINE") worst = "OFFLINE"; }

          var acc18Str = latest18 ? Number(latest18.acc || 0).toFixed(2) + " mm/s" : "-", acc20Str = latest20 ? Number(latest20.acc || 0).toFixed(2) + " mm/s" : "-";
          var cls = (worst === "DANGER") ? "open" : (worst === "WARN" ? "stuck" : (worst === "OFFLINE" ? "stale" : "ok"));
          
          applyMapDotState_(p.__el, "VIB", cls, true);
          if($id(`posSum_${p.pos}_VIB`)) $id(`posSum_${p.pos}_VIB`).textContent = worst;

          var bodyEl = $id(`posBody_${p.pos}_VIB`);
          if(bodyEl) {
            var lineCls18 = (lv18 === "DANGER") ? "pos-open" : (lv18 === "WARN" ? "pos-stuck" : (lv18 === "OFFLINE" ? "pos-stale" : "pos-ok"));
            var lineCls20 = (lv20 === "DANGER") ? "pos-open" : (lv20 === "WARN" ? "pos-stuck" : (lv20 === "OFFLINE" ? "pos-stale" : "pos-ok"));
            var cardHtml = `<div class="posLine ${lineCls18}"><div class="posLeft"><span class="posChip"></span><span>${name18}</span></div><div class="posRight mono"><span>${acc18Str}</span></div></div>`;
            if(name20) cardHtml += `<div class="posLine ${lineCls20}" style="border-top:1px solid rgba(255,255,255,0.07); padding-top:3px; margin-top:3px;"><div class="posLeft"><span class="posChip"></span><span>${name20}</span></div><div class="posRight mono"><span>${acc20Str}</span></div></div>`;
            bodyEl.innerHTML = cardHtml;
          }
        }
      });
      if(AppState.mode === "AI" && window.__LAST_DATA__) renderAiAnalysis_(window.__LAST_DATA__);
    }).catch(err => console.error("Vib Fetch Error:", err));
}

function fetchVibData(rangeKey, pos) {
  rangeKey = rangeKey || "4h"; pos = pos || window.__CURRENT_VIB_POS__ || 1; window.__CURRENT_VIB_POS__ = pos;
  var titleText = (pos == 2) ? "Vibration ก้นกะพ้อ CM11_6532" : (pos == 3) ? "Vibration CM9_542.22" : (pos == 4) ? "Vibration Gyp_6413.03" : "Vibration ก้นกะพ้อ CM10_6522";
                  
  setText("modalTitle", titleText); destroyAllModalCharts_();
  setHTML("modalBody","<div class='skeleton' style='height:40px;margin-bottom:8px;'></div><div class='skeleton' style='height:240px;margin-bottom:8px;'></div><div class='skeleton' style='height:240px;'></div>"); openModal();

  callGasAPI('getVibData', {rangeKey: rangeKey})
    .then(res => {
      if(!res||res.ok===false){ setHTML("modalBody",`<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc((res&&res.error)?res.error:"unknown")}</div>`); return; }
      renderVibModal_(res, rangeKey, pos);
    }).catch(err => { setHTML("modalBody",`<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc(String(err))}</div>`); });
}

function renderVibModal_(res, currentRange, isGroup2) {
  var pos = parseInt(isGroup2 === true ? 2 : (isGroup2 === false || !isGroup2 ? 1 : isGroup2));
  var rawD18 = [], rawD20 = [], name18 = "", name20 = "", posArg = pos; 

  if (pos === 2) { rawD18 = res.data32_18 || (res[2] ? res[2].data18 : []); rawD20 = res.data32_20 || (res[2] ? res[2].data20 : []); name18 = "CM11_6532.18"; name20 = "CM11_6532.20"; } 
  else if (pos === 3) { rawD18 = res.data3_18 || (res[3] ? res[3].data18 : []); rawD20 = []; name18 = "CM9_542.22"; name20 = ""; } 
  else if (pos === 4) { rawD18 = res.data4_18 || (res[4] ? res[4].data18 : []); rawD20 = []; name18 = "Gyp_6413.03"; name20 = ""; } 
  else { rawD18 = res.data18 || (res[1] ? res[1].data18 : []); rawD20 = res.data20 || (res[1] ? res[1].data20 : []); name18 = "CM10_6522.18"; name20 = "CM10_6522.20"; posArg = 1; }

  currentRange = currentRange || "4h";
  var d18 = downsampleVibData_(rawD18, currentRange), d20 = downsampleVibData_(rawD20, currentRange);

  var html = `<div style="display:flex;flex-direction:column;gap:10px;">
    <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); padding:10px 12px; border-radius:10px; border:1px solid var(--border);">
    <div style="font-weight:900; font-size:13px;">📈 เลือกช่วงเวลาดูแนวโน้ม</div>
    <select style="background:var(--panel); color:var(--text); border:1px solid var(--border); padding:6px 12px; border-radius:8px; font-weight:bold; cursor:pointer; outline:none;" onchange="fetchVibData(this.value, ${posArg})">
      <option value="4h" ${currentRange==="4h"?"selected":""}>4 ชั่วโมงล่าสุด</option>
      <option value="8h" ${currentRange==="8h"?"selected":""}>8 ชั่วโมงย้อนหลัง</option>
      <option value="12h" ${currentRange==="12h"?"selected":""}>12 ชั่วโมงย้อนหลัง</option>
      <option value="24h" ${currentRange==="24h"?"selected":""}>1 วันล่าสุด</option>
      <option value="2d" ${currentRange==="2d"?"selected":""}>2 วันย้อนหลัง</option>
      <option value="3d" ${currentRange==="3d"?"selected":""}>3 วันย้อนหลัง</option>
    </select></div>`;

  var pConfig = MAP_POINTS.find(mp => mp.pos === posArg && mp.modes.includes("VIB"));
  var warnLimit = pConfig ? (pConfig.vibWarn || 30) : 30, dangerLimit = pConfig ? (pConfig.vibDanger || 60) : 60;

  function makeVibCard_(title, data, canvasId) {
    var latest = data.length ? data[data.length-1] : null;
    var now = Date.now(), isOffline = latest ? (now - latest.ts > 1200000) : true, vVibNum = latest ? (Number(latest.acc) || 0) : 0;
    var statusText = isOffline ? "OFFLINE" : (vVibNum > dangerLimit ? "DANGER" : (vVibNum > warnLimit ? "WARN" : (latest && latest.level.includes("IDLE") ? "IDLE" : "NORMAL")));
    var color = isOffline ? "var(--stale)" : (statusText === "DANGER" ? "var(--open)" : (statusText === "WARN" ? "var(--stuck)" : "var(--ok)"));

    return `<div class="rCard" style="padding:10px; margin-bottom:10px; position:relative; z-index:1;">
      <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
        <div class="mono" style="color:var(--text);font-weight:bold;font-size:14px;">${title}</div>
        <div class="mono" style="color:${color};font-weight:bold;">${statusText}</div>
      </div>
      <div style="height:240px;width:100%;"><canvas id="${canvasId}"></canvas></div>
    </div>`;
  }

  html += makeVibCard_(name18, d18, "vibChart18");
  if (name20) html += makeVibCard_(name20, d20, "vibChart20");
  html += '</div>'; setHTML("modalBody", html);

  setTimeout(() => {
    drawVibDualChart_("vibChart18", d18, d18, d20);
    if (name20) drawVibDualChart_("vibChart20", d20, d18, d20);
  }, 50);
}

function downsampleVibData_(data, rangeKey) {
  if (!data || data.length === 0) return [];
  const MAX_POINTS_ON_CHART = 300; let step = Math.ceil(data.length / MAX_POINTS_ON_CHART);
  if (step <= 1) return data;
  const result = [];
  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step); let maxObj = chunk[0], maxAcc = -999, maxSound = -999;
    for (let j = 0; j < chunk.length; j++) {
      const r = chunk[j], acc = Number(r.acc) || 0, sound = Number(r.sound) || 0;
      if (acc > maxAcc) { maxAcc = acc; maxObj = Object.assign({}, r); }
      if (sound > maxSound) maxSound = sound;
      if (r.level.includes("DANGER")) maxObj.level = r.level;
      else if ((r.level.includes("WARN") || r.level.includes("CHECK")) && !maxObj.level.includes("DANGER")) maxObj.level = r.level;
    }
    result.push({ time: maxObj.time, ts: maxObj.ts, level: maxObj.level, score: maxObj.score, reason: maxObj.reason, advice: maxObj.advice, acc: maxAcc, sound: maxSound, temp: maxObj.temp });
  }
  return result;
}

var __VIB_CHARTS__ = {};
function drawVibDualChart_(canvasId, data, allD18, allD20) {
  var cvs = $id(canvasId); if(!cvs) return;
  if(__VIB_CHARTS__[canvasId]) __VIB_CHARTS__[canvasId].destroy();

  let globalMaxVib = 0, globalMaxSound = 0, globalMinVib = Infinity, globalMinSound = Infinity;
  [allD18, allD20].forEach(d => {
    if(d && d.length > 0) {
      let maxV = Math.max(...d.map(r=>r.acc||0)), maxS = Math.max(...d.map(r=>r.sound||0));
      if (maxV > globalMaxVib) globalMaxVib = maxV; if (maxS > globalMaxSound) globalMaxSound = maxS;
      let minV = Math.min(...d.map(r=>r.acc||0)), minS = Math.min(...d.map(r=>r.sound||0));
      if (minV < globalMinVib) globalMinVib = minV; if (minS < globalMinSound) globalMinSound = minS;
    }
  });

  if (globalMinVib === Infinity) globalMinVib = 0; if (globalMinSound === Infinity) globalMinSound = 40;
  let targetMaxVib = Math.max(3, globalMaxVib * 1.1), targetMaxSound = Math.max(90, globalMaxSound + 5);   
  let targetMinVib = Math.max(0, globalMinVib - 0.5), targetMinSound = Math.max(0, globalMinSound - 5);

  var labels = data.map(r => r.time), acc = data.map(r => r.acc), sound = data.map(r => r.sound);
  var isDark = (document.body.getAttribute("data-theme") || "night") !== "day", gridColor = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)", textColor = isDark ? "#9fb2c9" : "#4b5b70";

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
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, zoom: { pan: { enabled: true, mode: 'x' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } } },
      scales: {
        x: { ticks: { color: textColor, maxTicksLimit: 10 }, grid: { color: gridColor } },
        y: { type: 'linear', position: 'left', ticks: { color: '#e74c3c' }, grid: { color: gridColor }, suggestedMin: targetMinVib, suggestedMax: targetMaxVib },
        y1: { type: 'linear', position: 'right', ticks: { color: '#3498db' }, grid: { drawOnChartArea: false }, suggestedMin: targetMinSound, suggestedMax: targetMaxSound }
      }
    }
  });
}

// =========================================================
// 13. HISTORY LOGIC
// =========================================================
function fetchHistory(beltName){
  setText("modalTitle", "History 24h — " + beltName);
  setHTML("modalBody", "<div class='skeleton' style='height:30px;margin-bottom:6px;'></div><div class='skeleton' style='height:20px;margin-bottom:4px;'></div><div class='skeleton' style='height:20px;'></div>"); openModal();
  
  callGasAPI('getHistory24h', {beltName: beltName})
    .then(data => {
      if(!data||data.ok===false){setHTML("modalBody", `<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc((data&&data.error)?data.error:"unknown")}</div>`); return;}
      renderHistory(data);
    })
    .catch(err => setHTML("modalBody", `<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc(String(err))}</div>`));
}

function renderHistory(history){
  var belt=history.belt, group=history.group||"", rows=history.rows||[];
  var html=`<div class="mono" style="color:var(--muted);margin-bottom:9px;">CM: <b>${esc(group)}</b></div>`;
  if(!rows.length){ html+='<div class="mono" style="color:var(--muted);">No data</div>'; }
  else {
    html+=`<table><thead><tr><th style="width:195px;">Time</th><th style="width:100px;">Type</th><th>Msg</th><th style="width:100px;">SWAY</th><th style="width:80px;">DIR</th><th style="width:150px;">RPM</th></tr></thead><tbody>`;
    rows.forEach(r => {
      var raw=(r&&r.rpm!=null)?r.rpm:"", s=(raw===""||raw==null)?"":String(raw).trim(), n=(s==="")?null:Number(s), isNum=(n!=null&&isFinite(n)), isZero=false, isRun=false;
      if(isNum){ if(n<=0) isZero=true; else isRun=true; }
      var cls = "rpmCell " + ((s==="")?"rpmDash":(isRun?"rpmRun":(isZero?"rpmZero":"rpmDash")));
      var isStop = false; if(r.type==="SLEEP"){ if(s==="") isStop=true; else if(!isRun) isStop=true; }
      
      var dirMini = r.dir ? `  DIR:${esc(r.dir)}` : ""; var msgText = r.msg ? `${esc(r.msg)}${dirMini}` : dirMini;
      var sc = (r&&r.swayCountHour!=null)?Number(r.swayCountHour):0; if(!isFinite(sc)) sc=0;
      var sd = (r&&r.swayDirHour!=null)?String(r.swayDirHour).trim().toUpperCase():"";
      function fullDirName(d){ if(d==="N") return "NORTH"; if(d==="S") return "SOUTH"; if(d==="E") return "EAST"; if(d==="W") return "WEST"; return ""; }
      var scText = (sc>0) ? (history.belt||"") : "-"; var sdText = (sc>0&&sd) ? fullDirName(sd) : "-";

      html+=`<tr><td>${esc(r.time)}</td><td>${tagHtml(r.type,isStop)}</td><td>${msgText}</td><td class="mono" style="text-align:center;font-weight:900;">${esc(scText)}</td><td class="mono" style="text-align:center;font-weight:900;">${esc(sdText)}</td><td class="${esc(cls)}">${esc(s===""?"-":s)}</td></tr>`;
    });
    html+=`</tbody></table>`;
  }
  setText("modalTitle", `History 24h — ${belt} (${group})`); setHTML("modalBody", html);
}

function tagHtml(type,isStop){
  if(type==="OPEN") return '<span class="tagOpen">OPEN</span>';
  if(type==="STUCK") return '<span class="tagStuck">STUCK</span>';
  if(type==="SWAY") return '<span class="tagStuck">SWAY</span>';
  if(type==="SLEEP") return isStop?'<span class="tagOther">STOP</span>':'<span class="tagOk">NORMAL</span>';
  if(type==="STALE") return '<span class="tagOther">STALE</span>';
  if(type==="OTHER") return '<span class="tagOther">OTHER</span>';
  return `<span class="tagOther">${esc(type||"")}</span>`;
}

// =========================================================
// 14. ALARM LOG & EVENT LIST
// =========================================================
function renderSimpleTable_(title,rows){
  rows=rows||[]; var html="";
  if(!rows.length){html='<div class="mono" style="color:var(--muted);font-weight:900;">No data</div>';}
  else{
    var keys=Object.keys(rows[0]||{}).filter(k=>k!=="ts");
    html+='<table><thead><tr>';
    keys.forEach(k => html+=`<th>${esc(k)}</th>`);
    html+='</tr></thead><tbody>';
    rows.forEach(row => {
      html+='<tr>'; keys.forEach(k => html+=`<td>${esc(row[k]==null?"":String(row[k]))}</td>`); html+='</tr>';
    });
    html+='</tbody></table>';
  }
  setText("modalTitle",title); setHTML("modalBody",html);
}

function openBasicModal_(title){ setText("modalTitle",title); setHTML("modalBody","<div class='skeleton' style='height:20px;margin-bottom:5px;'></div><div class='skeleton' style='height:20px;margin-bottom:5px;'></div><div class='skeleton' style='height:20px;'></div>"); openModal(); }

function fetchAlarmLog24h_(){
  openBasicModal_("Alarm Log 24h");
  callGasAPI('getAlarmLog24h', {page: 'overview'})
    .then(res => {
      if(!res||res.ok===false){ setHTML("modalBody", `<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc((res&&res.error)?res.error:"unknown")}</div>`); return; }
      renderSimpleTable_("Alarm Log 24h", res.rows||[]);
    }).catch(err => setHTML("modalBody", `<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc(String(err))}</div>`));
}

function fetchEventList24h_(){
  openBasicModal_("Event List 24h");
  callGasAPI('getEventList24h', {page: 'overview'})
    .then(res => {
      if(!res||res.ok===false){ setHTML("modalBody", `<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc((res&&res.error)?res.error:"unknown")}</div>`); return; }
      renderSimpleTable_("Event List 24h", res.rows||[]);
    }).catch(err => setHTML("modalBody", `<div class="mono" style="color:var(--other);font-weight:900;">ERROR: ${esc(String(err))}</div>`));
}

["alarmLogBtn", "alarmLogBtn2"].forEach(id => $id(id)?.addEventListener("click", () => fetchAlarmLog24h_()));
["eventListBtn", "eventListBtn2"].forEach(id => $id(id)?.addEventListener("click", () => fetchEventList24h_()));

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

window.addEventListener("resize", function() {
  if (typeof MAP_POINTS === "undefined" || !MAP_POINTS || !MAP_POINTS.length) return;
  for (var i = 0; i < MAP_POINTS.length; i++) {
    var p = MAP_POINTS[i];
    if (!p.__card) continue;
    if (window.innerWidth <= 768) {
      p.__card.style.display = "none";
    } else {
      if (p.modes && p.modes.includes(AppState.mode) && AppState.mode !== "PM10") {
        p.__card.style.display = "block";
      } else {
        p.__card.style.display = "none";
      }
    }
  }
  if (typeof map !== 'undefined' && map) {
    map.invalidateSize();
  }
});

// =========================================================
// 15. REPORT CRUD & IMAGE UPLOAD
// =========================================================
const DELETE_PASSWORD="1234";

function swalLoadingOpen(title,text){ if(window.Swal) Swal.fire({title:title||"Loading…", text:text||"Please wait", allowOutsideClick:false, allowEscapeKey:false, showConfirmButton:false, backdrop:true, didOpen:()=>Swal.showLoading()}); }
function swalLoadingClose(){ if(window.Swal && Swal.isVisible()) Swal.close(); }
function makeDelayedLoader(ms,title,text){
  let shown=false; const t=setTimeout(()=>{ shown=true; swalLoadingOpen(title,text); }, ms||900);
  return { close: () => { clearTimeout(t); if(shown) swalLoadingClose(); } };
}

function toDriveImgUrl_(u){
  u=String(u||"").trim(); if(!u) return "";
  if(u.startsWith("https://lh3.googleusercontent.com/d/")) return u;
  if(u.includes("drive.google.com/uc?export=view&id=")){ const m=u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/); if(m&&m[1]) return `https://lh3.googleusercontent.com/d/${m[1]}`; }
  const m1=u.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/); if(m1&&m1[1]) return `https://lh3.googleusercontent.com/d/${m1[1]}`;
  const m2=u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/); if(m2&&m2[1]) return `https://lh3.googleusercontent.com/d/${m2[1]}`;
  if(/^[a-zA-Z0-9_-]{10,}$/.test(u)) return `https://lh3.googleusercontent.com/d/${u}`;
  return u;
}

let __REPORT_EDIT_ID__="", __REPORT_EDIT_OLD__=null;
function clearReportForm_(){
  __REPORT_EDIT_ID__=""; __REPORT_EDIT_OLD__=null;
  setText("r_editId",""); setText("formHeadTitle","FORM • กรอก/แก้ไข รายงาน");
  if($id("r_code")) $id("r_code").value="";
  if($id("r_detail")) $id("r_detail").value="";
  if($id("r_files")) $id("r_files").value="";
  setHTML("r_imgThumbs",""); 
  var el=$id("r_checkTime"); if(el){ var d=new Date(); el.value=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")+"T"+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); }
  if($id("r_deleteBtn")) $id("r_deleteBtn").style.display="none";
  if($id("uploadBar")) $id("uploadBar").style.display="none";
}

function setFormFromRow_(row){
  __REPORT_EDIT_ID__=row.id||""; __REPORT_EDIT_OLD__=row;
  setText("r_editId", __REPORT_EDIT_ID__ ? `EDIT: ${__REPORT_EDIT_ID__}` : "");
  setText("formHeadTitle", `FORM • แก้ไข: ${esc(row.code||__REPORT_EDIT_ID__)}`);
  if($id("r_code")) $id("r_code").value=row.code||""; if($id("r_detail")) $id("r_detail").value=row.detail||"";
  var el=$id("r_checkTime"), ms=Number(row.checkTimeMs||0);
  if(el && isFinite(ms) && ms>0){ var d=new Date(ms); el.value=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")+"T"+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); }
  if($id("r_files")) $id("r_files").value="";
  var wrap=$id("r_imgThumbs"); if(wrap) { wrap.innerHTML=""; ["img1","img2","img3","img4"].forEach(k => { if(row[k]) { const u=toDriveImgUrl_(row[k]); const box=document.createElement("div"); box.className="rThumb"; box.innerHTML=`<img referrerpolicy="no-referrer" src="${esc(u)}" />`; box.addEventListener("click", () => openImgViewer_("Saved image", u)); wrap.appendChild(box); } }); }
  if($id("r_deleteBtn")) $id("r_deleteBtn").style.display = __REPORT_EDIT_ID__ ? "inline-flex" : "none";
  if($id("reportFormOverlay")) $id("reportFormOverlay").style.display="flex";
}

function reportRefresh_(){
  var loader = makeDelayedLoader(200, "Loading reports…", "Please wait");
  callGasAPI('reportList', {limit: 200})
    .then(res => {
      loader.close();
      if(!res || res.ok === false){ showToast("Fetch failed", "err", (res && res.error) ? res.error : ""); return; }
      
      var rows = res.rows || [], tb = $id("r_tbody"); setText("r_count", `rows: ${rows.length}`);
      if(!tb) return; tb.innerHTML = "";
      if(!rows.length){ tb.innerHTML='<tr><td colspan="6" class="rMut">No data</td></tr>'; return; }
      
      rows.forEach(r => {
        var tr = document.createElement("tr");
        var imgsHtml = ""; var urls = ["img1","img2","img3","img4"].map(k=>r[k]).filter(u=>u).map(toDriveImgUrl_);
        if(!urls.length) imgsHtml = '<span class="rMut">-</span>'; else { imgsHtml = '<div class="rMiniImgs">'; urls.forEach((u, i) => imgsHtml+=`<img referrerpolicy="no-referrer" src="${esc(u)}" data-img="${esc(u)}" data-title="${esc((r.code||"")+" • image "+(i+1))}" />`); imgsHtml+='</div>'; }
        
        tr.innerHTML=`<td class="rSmallMono">${esc(r.checkTime||"-")}</td><td class="rSmallMono"><b>${esc(r.code||"-")}</b></td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((r.detail||"").slice(0,120))}${String(r.detail||"").length>120?"…":""}</td><td>${imgsHtml}</td><td class="rSmallMono">${esc((r.operator||"-")+(r.shift?" / "+r.shift:""))}</td><td class="rActCell"><div class="rActRow"><button class="rBtn rBtnMini" data-act="edit">Edit</button><button class="rBtn danger rBtnMini" data-act="del">Del</button></div></td>`;
        
        tr.querySelector('[data-act="edit"]')?.addEventListener("click", () => setFormFromRow_(r));
        tr.querySelector('[data-act="del"]')?.addEventListener("click", () => { __REPORT_EDIT_ID__ = r.id || ""; reportDelete_(); });
        tr.querySelectorAll('.rMiniImgs img').forEach(img => img.addEventListener("click", e => openImgViewer_(e.target.getAttribute("data-title"), e.target.getAttribute("data-img"))));
        tb.appendChild(tr);
      });
    }).catch(err => { loader.close(); showToast("Fetch failed", "err", String(err)); });
}

async function reportSave_(){
  try{
    const op = getOperator(), checkStr = $id("r_checkTime")?.value, code = $id("r_code")?.value.trim(), detail = $id("r_detail")?.value.trim();
    if(!checkStr){ showToast("Missing check time","warn"); return; }
    if(!code){ showToast("Missing code","warn","กรอก code ก่อน"); return; }
    const m = String(checkStr).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if(!m){ showToast("Invalid time","err"); return; }
    const checkMs = new Date(+m[1], (+m[2])-1, +m[3], +m[4], +m[5], 0, 0).getTime();
    
    const filesEl = $id("r_files"), fileArr = (filesEl && filesEl.files) ? Array.from(filesEl.files) : [];
    if(fileArr.length > 4){ showToast("Too many images","warn","เลือกได้สูงสุด 4 รูป"); return; }

    let imgUrls = null;
    if(fileArr.length){
      imgUrls = {}; $id("uploadBar").style.display="block"; $id("uploadBarFill").style.width="0%";
      for(let i=0; i<fileArr.length; i++){
        $id("uploadBarFill").style.width = Math.round((i/fileArr.length)*100) + "%";
        try{
          const meta = await new Promise((resolve,reject) => { const reader=new FileReader(); reader.onload=()=>resolve({fileName:fileArr[i].name||"img.jpg",mimeType:fileArr[i].type||"image/jpeg",base64:(reader.result.split(',')[1]||reader.result)}); reader.onerror=reject; reader.readAsDataURL(fileArr[i]); });
          const res = await callGasAPI('uploadReportImage', {}, 'POST', meta);
          if(!res || res.ok===false) throw new Error(res?.error || "upload error");
          imgUrls["img"+(i+1)] = toDriveImgUrl_(res.viewUrl || res.fileId);
        }catch(e){
          $id("uploadBar").style.display="none"; showToast("Upload failed","err",`File ${i+1}: ${String(e)}`); return;
        }
      }
      $id("uploadBarFill").style.width="100%"; setTimeout(()=>$id("uploadBar").style.display="none", 800);
    }

    const payload = {id: __REPORT_EDIT_ID__, checkTimeMs: checkMs, code: code, detail: detail, images: imgUrls, operator: op.name, shift: op.shift};
    
    if(!__REPORT_EDIT_ID__){
      const loader = makeDelayedLoader(350, "Saving…");
      callGasAPI('reportCreate', {}, 'POST', payload).then(res => {
        loader.close(); if(!res||res.ok===false){ showToast("Create failed","err",res?.error); return; }
        showToast("Saved","ok"); clearReportForm_(); if($id("reportFormOverlay")) $id("reportFormOverlay").style.display="none"; reportRefresh_();
      }).catch(err => { loader.close(); showToast("Create failed","err",String(err)); });
    } else {
      Swal.fire({ title:"Confirm edit", text:"Enter password", input:"password", showCancelButton:true, confirmButtonColor:"#3085d6", preConfirm: pw => { if((pw||"").trim()!==DELETE_PASSWORD){ Swal.showValidationMessage("Wrong password"); return false; } return true; } })
      .then(res => {
        if(!res.isConfirmed) return;
        const loader = makeDelayedLoader(350, "Updating…");
        callGasAPI('reportUpdate', {}, 'POST', payload).then(r => {
          loader.close(); if(!r||r.ok===false){ showToast("Update failed","err",r?.error); return; }
          showToast("Updated","ok"); clearReportForm_(); if($id("reportFormOverlay")) $id("reportFormOverlay").style.display="none"; reportRefresh_();
        }).catch(err => { loader.close(); showToast("Update failed","err",String(err)); });
      });
    }
  }catch(e){ showToast("Save crashed","err",String(e)); }
}

function reportDelete_(){
  if(!__REPORT_EDIT_ID__) return;
  Swal.fire({ title:"Confirm delete", input:"password", showCancelButton:true, confirmButtonColor:"#ff3b30", confirmButtonText:"Delete", preConfirm: pw => { if((pw||"").trim()!==DELETE_PASSWORD){ Swal.showValidationMessage("Wrong password"); return false; } return true; } })
  .then(res => {
    if(!res.isConfirmed) return;
    const loader = makeDelayedLoader(200, "Deleting…");
    callGasAPI('reportDelete', {}, 'POST', {id: __REPORT_EDIT_ID__}).then(r => {
      loader.close(); if(!r||r.ok===false){ showToast("Delete failed","err",r?.error); return; }
      showToast("Deleted","ok"); clearReportForm_(); if($id("reportFormOverlay")) $id("reportFormOverlay").style.display="none"; reportRefresh_();
    }).catch(err => { loader.close(); showToast("Delete failed","err",String(err)); });
  });
}

$id("reportBtn")?.addEventListener("click", () => { if($id("reportOverlay")) $id("reportOverlay").style.display="flex"; reportRefresh_(); });
$id("reportBtn2")?.addEventListener("click", () => { if($id("reportOverlay")) $id("reportOverlay").style.display="flex"; reportRefresh_(); });
$id("reportCloseBtn")?.addEventListener("click", () => { if($id("reportOverlay")) $id("reportOverlay").style.display="none"; });
$id("reportOpenFormBtn")?.addEventListener("click", () => { clearReportForm_(); if($id("reportFormOverlay")) $id("reportFormOverlay").style.display="flex"; });
$id("reportRefreshBtn")?.addEventListener("click", reportRefresh_);
$id("reportFormCloseBtn")?.addEventListener("click", () => { if($id("reportFormOverlay")) $id("reportFormOverlay").style.display="none"; });
$id("r_formCancelBtn")?.addEventListener("click", () => { if($id("reportFormOverlay")) $id("reportFormOverlay").style.display="none"; });
$id("r_clearBtn")?.addEventListener("click", clearReportForm_);
$id("r_saveBtn")?.addEventListener("click", reportSave_);
$id("r_deleteBtn")?.addEventListener("click", reportDelete_);

$id("r_files")?.addEventListener("change", e => {
  const files = e.target.files, wrap = $id("r_imgThumbs"); if(!wrap) return; wrap.innerHTML = "";
  if(files && files.length) {
    Array.from(files).forEach(f => {
      const reader = new FileReader(); reader.onload = () => {
        const url = String(reader.result), box = document.createElement("div"); box.className="rThumb"; box.innerHTML=`<img src="${esc(url)}"/>`;
        box.addEventListener("click", () => openImgViewer_("Local preview", url)); wrap.appendChild(box);
      }; reader.readAsDataURL(f);
    });
  }
});

// =========================================================
// 16. IMAGE VIEWER (FULLSCREEN)
// =========================================================
var __IMGV__ = { scale: 1, minScale: 1, maxScale: 4, x: 0, y: 0, raf: 0, drag: null, pinch: null, lastTapAt: 0 };
function imgViewerApply_(){
  const img = $id("imgViewerImg"); if(!img) return;
  if(__IMGV__.raf) cancelAnimationFrame(__IMGV__.raf);
  __IMGV__.raf = requestAnimationFrame(() => img.style.transform = `translate3d(${__IMGV__.x}px,${__IMGV__.y}px,0) scale(${__IMGV__.scale})`);
}
function imgViewerClamp_(){
  const body = $id("imgViewerBody"), img = $id("imgViewerImg"); if(!body || !img) return;
  const rect = body.getBoundingClientRect(), iw = img.naturalWidth||1, ih = img.naturalHeight||1;
  const fit = Math.min(rect.width/iw, rect.height/ih, 1), drawW = iw*fit*__IMGV__.scale, drawH = ih*fit*__IMGV__.scale;
  const maxX = Math.max(0, (drawW-rect.width)/2), maxY = Math.max(0, (drawH-rect.height)/2);
  if(__IMGV__.x > maxX) __IMGV__.x = maxX; if(__IMGV__.x < -maxX) __IMGV__.x = -maxX;
  if(__IMGV__.y > maxY) __IMGV__.y = maxY; if(__IMGV__.y < -maxY) __IMGV__.y = -maxY;
}
function imgViewerReset_(){ __IMGV__.scale = 1; __IMGV__.x = 0; __IMGV__.y = 0; __IMGV__.drag = null; __IMGV__.pinch = null; imgViewerApply_(); }
function imgViewerZoomAt_(nextScale, cx, cy){
  const body = $id("imgViewerBody"); if(!body) return;
  const rect = body.getBoundingClientRect(), ox = cx - rect.left - rect.width/2, oy = cy - rect.top - rect.height/2;
  const prev = __IMGV__.scale; nextScale = Math.max(__IMGV__.minScale, Math.min(__IMGV__.maxScale, nextScale)); if(nextScale===prev) return;
  const ratio = nextScale / prev; __IMGV__.x = (__IMGV__.x-ox)*ratio + ox; __IMGV__.y = (__IMGV__.y-oy)*ratio + oy; __IMGV__.scale = nextScale;
  imgViewerClamp_(); imgViewerApply_();
}
function openImgViewer_(title, url){
  const v = $id("imgViewer"), t = $id("imgViewerTitle"), i = $id("imgViewerImg"); if(!v||!i) return;
  if(t) t.textContent = title || "Image";
  i.onload = () => { imgViewerReset_(); imgViewerClamp_(); imgViewerApply_(); };
  i.src = toDriveImgUrl_(url) || ""; v.style.display = "flex"; document.body.style.overflow = "hidden";
}
function closeImgViewer_(){
  const v = $id("imgViewer"), i = $id("imgViewerImg");
  if(i){ i.onload=null; i.src=""; i.style.transform="translate3d(0,0,0) scale(1)"; }
  if(v) v.style.display = "none"; document.body.style.overflow = ""; imgViewerReset_();
}

$id("imgViewerClose")?.addEventListener("click", closeImgViewer_);
$id("imgViewer")?.addEventListener("click", e => { if(e.target.id==="imgViewer" || e.target.id==="imgViewerStage") closeImgViewer_(); });

(function initImgViewerGesture_(){
  const body = $id("imgViewerBody"); if(!body) return;
  const dist = (a,b) => Math.sqrt(Math.pow(b.clientX-a.clientX,2) + Math.pow(b.clientY-a.clientY,2));
  const mid = (a,b) => ({ x:(a.clientX+b.clientX)/2, y:(a.clientY+b.clientY)/2 });

  body.addEventListener("wheel", e => { e.preventDefault(); imgViewerZoomAt_(__IMGV__.scale * (e.deltaY<0?1.12:0.9), e.clientX, e.clientY); }, {passive:false});
  body.addEventListener("touchstart", e => {
    if(e.touches.length === 1){
      const t=e.touches[0], now=Date.now();
      if(now - __IMGV__.lastTapAt < 260){ e.preventDefault(); if(__IMGV__.scale>1.01) imgViewerReset_(); else imgViewerZoomAt_(2, t.clientX, t.clientY); __IMGV__.lastTapAt=0; return; }
      __IMGV__.lastTapAt = now; __IMGV__.drag = { sx:t.clientX, sy:t.clientY, ox:__IMGV__.x, oy:__IMGV__.y };
    } else if(e.touches.length === 2){
      e.preventDefault(); const a=e.touches[0], b=e.touches[1], m=mid(a,b);
      __IMGV__.pinch = { dist: dist(a,b), scale: __IMGV__.scale, mx: m.x, my: m.y }; __IMGV__.drag = null;
    }
  }, {passive:false});
  body.addEventListener("touchmove", e => {
    if(e.touches.length === 2 && __IMGV__.pinch){
      e.preventDefault(); const a=e.touches[0], b=e.touches[1], m=mid(a,b), ratio = dist(a,b)/Math.max(1,__IMGV__.pinch.dist);
      __IMGV__.scale = Math.max(__IMGV__.minScale, Math.min(__IMGV__.maxScale, __IMGV__.pinch.scale*ratio));
      __IMGV__.x += (m.x-__IMGV__.pinch.mx); __IMGV__.y += (m.y-__IMGV__.pinch.my);
      __IMGV__.pinch.mx = m.x; __IMGV__.pinch.my = m.y; imgViewerClamp_(); imgViewerApply_();
    } else if(e.touches.length === 1 && __IMGV__.drag && __IMGV__.scale>1.01){
      e.preventDefault(); __IMGV__.x = __IMGV__.drag.ox + (e.touches[0].clientX-__IMGV__.drag.sx); __IMGV__.y = __IMGV__.drag.oy + (e.touches[0].clientY-__IMGV__.drag.sy);
      imgViewerClamp_(); imgViewerApply_();
    }
  }, {passive:false});
  body.addEventListener("touchend", e => { __IMGV__.drag = null; if(!e.touches || e.touches.length<2) __IMGV__.pinch = null; if(__IMGV__.scale<1.02) imgViewerReset_(); }, {passive:true});
  body.addEventListener("mousedown", e => { if(__IMGV__.scale<=1.01) return; e.preventDefault(); __IMGV__.drag = {sx:e.clientX, sy:e.clientY, ox:__IMGV__.x, oy:__IMGV__.y}; });
  window.addEventListener("mousemove", e => { if(__IMGV__.drag){ __IMGV__.x = __IMGV__.drag.ox+(e.clientX-__IMGV__.drag.sx); __IMGV__.y = __IMGV__.drag.oy+(e.clientY-__IMGV__.drag.sy); imgViewerClamp_(); imgViewerApply_(); } });
  window.addEventListener("mouseup", () => __IMGV__.drag = null);
})();

// =========================================================
// 17. LEFT ALARM PANEL
// =========================================================
function updateGlobalLeftAlarms_() {
  if (!window.__LAST_DATA__) return; 
  var rows = buildAiRows_(window.__LAST_DATA__);
  
  var panel = document.getElementById("leftAlarmPanel");
  if (!panel) {
    panel = document.createElement("div"); panel.id = "leftAlarmPanel";
    panel.innerHTML = `
      <div id="alarmPanelHeader" style="display:none;" onclick="toggleLeftAlarmPanel_()">
        <span id="alarmHeaderTitle">🚨 Alarms</span><span id="alarmHeaderIcon">➖</span>
      </div><div id="alarmPanelList"></div>`;
    document.body.appendChild(panel);

    window.toggleLeftAlarmPanel_ = function() {
      var p = document.getElementById("leftAlarmPanel"), icon = document.getElementById("alarmHeaderIcon");
      if(p.classList.contains("collapsed")) { p.classList.remove("collapsed"); icon.textContent = "➖"; window.__ALARM_PANEL_COLLAPSED__ = false; } 
      else { p.classList.add("collapsed"); icon.textContent = "➕"; window.__ALARM_PANEL_COLLAPSED__ = true; }
    };
  }

  var activeAlarms = rows.filter(r => (r.level === "CRITICAL" || r.level === "HIGH" || r.level === "MEDIUM") && (r.status === "ALERT" || r.status === "WARN"));
  var header = document.getElementById("alarmPanelHeader"), list = document.getElementById("alarmPanelList");

  if (activeAlarms.length === 0) { header.style.display = "none"; list.innerHTML = ""; return; }
  header.style.display = "flex"; document.getElementById("alarmHeaderTitle").innerHTML = `🚨 Alarms (${activeAlarms.length})`;
  if (window.__ALARM_PANEL_COLLAPSED__) { panel.classList.add("collapsed"); document.getElementById("alarmHeaderIcon").textContent = "➕"; }

  var html = "";
  activeAlarms.forEach(r => {
    var borderColor = r.level === "CRITICAL" ? "#ff3b30" : (r.level === "HIGH" ? "#ff9f0a" : "#f1c40f"), bgColor = "rgba(15,20,30,0.85)";
    html += `<div style="background:${bgColor}; padding:6px 10px; border-radius:6px; box-shadow:0 2px 8px rgba(0,0,0,0.6); pointer-events:auto; animation:alarmSlideIn 0.2s ease-out; backdrop-filter:blur(8px); border: 1px solid rgba(255,255,255,0.05); border-left:4px solid ${borderColor};">
      <div style="font-size:12px; font-weight:bold; color:#fff; line-height:1.3; word-break:break-word;">${esc(r.belt)}</div>
      <div style="font-size:10px; color:${borderColor}; margin-top:3px; font-weight:bold;">⚠️ ${esc(r.alarmMsg || r.alarmType)}</div>
    </div>`;
  });
  if(list.innerHTML !== html) list.innerHTML = html;
}

// =========================================================
// 18. QR ZOOM
// =========================================================
(function(){
  var btn=$id("qrBtn"), btn2=$id("qrBtn2"), ov=$id("qrOverlay"), box=$id("qrZoomBox"), img=$id("qrZoomImg");
  if(!ov || !box || !img) return;
  img.src = "https://lh3.googleusercontent.com/d/1exbJtHJeLCMXH-MAPoCkItOj0rCJXBRB";
  function openQR(){ ov.setAttribute("aria-hidden","false"); ov.classList.add("open"); }
  function closeQR(){ ov.classList.remove("open"); ov.setAttribute("aria-hidden","true"); }
  
  [btn, btn2].forEach(b => b?.addEventListener("click", e => { e.preventDefault(); openQR(); }));
  ov.addEventListener("pointerup", closeQR); box.addEventListener("pointerup", closeQR);
  document.addEventListener("keydown", e => { if(e.key==="Escape") closeQR(); });
})();

// =========================================================
// 19. INITIALIZATION
// =========================================================
window.addEventListener("load", function(){
  refreshOperatorPill();
  updateMuteBtn();
  loadLogo(); 
  buildMapDotsOnce_();
  updateAutoSwitchUI();

  setTimeout(function(){
    fetchStatus(); 
    refreshVibStatus_(); 
    startPolling();
  }, 50);
});
