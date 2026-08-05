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
        var bounds = L.latLngBounds();
        var hasPoints = false;
        for (var i = 0; i < MAP_POINTS.length; i++) {
          if (MAP_POINTS[i].modes && MAP_POINTS[i].modes.includes(mode)) {
            bounds.extend([MAP_POINTS[i].lat, MAP_POINTS[i].lng]);
            hasPoints = true;
          }
        }
        
        if (hasPoints) {
          map.fitBounds(bounds, { padding: [60, 60], maxZoom: 18 });
        } else if (map.__factoryBounds) {
          // ถ้าโหมดใหม่ไม่มีข้อมูลจุดเลย ให้ซูมกลับไปที่ภาพรวมของโรงงาน
          map.fitBounds(map.__factoryBounds, { padding: [60, 60], maxZoom: 18 });
        }
        setTimeout(adjustCardPositions_, 300);
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
