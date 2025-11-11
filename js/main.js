/* global d3, topojson */

// file paths (don’t change)
const FILES = {
  world: 'data/world_lowres.json',
  na: 'data/NA_lowres.json',
  quakes: 'data/earthquake_data_tsunami.csv'
};

// sizes and colors (don’t change)
const SIZE = { minPx: 2.2, maxPx: 20 };
const COLORS = {
  mag: '#1b9e77',  // green
  cdi: '#d95f02',  // orange
  mmi: '#7570b3',  // purple
  sig: '#e7298a'   // magenta
};

// projections (objects themselves are mutable but the refs don’t change)
const WORLD_INIT = { type: 'world', projection: d3.geoNaturalEarth1() };
const NA_INIT = { type: 'na', projection: d3.geoAlbers().parallels([29.5, 45.5]).rotate([98, 0]).center([0, 38]) };

// app state (these change over time)
let currentBasemap = WORLD_INIT;
let quakes = [];
let filtered = [];
let timeIndex = 0;
let timeBuckets = [];
let playing = false;
let windowMode = 'month';

let sizeScale_mag, sizeScale_cdi, sizeScale_mmi, sizeScale_sig;
let depthShade;

const svg = d3.select('#map');
const gLand = svg.append('g').attr('class', 'land');
const gQuake = svg.append('g').attr('class', 'quakes');
const tip = d3.select('#tooltip');

// layout helpers
function viewportSize() {
  const panel = document.querySelector('aside#controls');
  const panelW = panel ? panel.getBoundingClientRect().width : 320;
  const w = Math.max(480, window.innerWidth - panelW - 16);
  const h = Math.max(360, window.innerHeight - 0);
  return { w: w, h: h };
}

function resize() {
  const v = viewportSize();
  svg.attr('width', v.w).attr('height', v.h);
}

window.addEventListener('resize', function () {
  resize();
  drawAll();
});

// ui refs
const depthMin = document.getElementById('depthMin');
const depthMax = document.getElementById('depthMax');
const depthMinVal = document.getElementById('depthMinVal');
const depthMaxVal = document.getElementById('depthMaxVal');
const depthRangeMinVal = document.getElementById('depthRangeMinVal');
const depthRangeMaxVal = document.getElementById('depthRangeMaxVal');
const magMin = document.getElementById('magMin');
const magMax = document.getElementById('magMax');
const magMinVal = document.getElementById('magMinVal');
const magMaxVal = document.getElementById('magMaxVal');

const onlyTsunami = document.getElementById('onlyTsunami');
const btnClearFilters = document.getElementById('btnClearFilters');

// slider values
let depthRangeMinValue = 0;
let depthRangeMaxValue = 700;
let depthRangeSlider;

const btnWorld = document.getElementById('btnWorld');
const btnNA = document.getElementById('btnNA');

const timeSlider = document.getElementById('timeSlider');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnPlay = document.getElementById('btnPlay');
const btnShowAll = document.getElementById('btnShowAll');
const timeLabel = document.getElementById('timeLabel');

const sizeModeInputs = document.querySelectorAll('input[name="sizeMode"]');
const chkMag = document.getElementById('chk-mag');
const chkCDI = document.getElementById('chk-cdi');
const chkMMI = document.getElementById('chk-mmi');

// window radios (month/year)
const windowRadios = document.querySelectorAll('input[name="window"]');
for (let wr = 0; wr < windowRadios.length; wr++) {
  windowRadios[wr].addEventListener('change', function (e) {
    windowMode = e.target.value;
    bucketByTime();
    setTimeSlider(0);
    applyFiltersAndRender();
  });
}

// size mode radio handlers
const comboMetricsGroup = document.getElementById('comboMetricsGroup');
function updateComboMetricsVisibility() {
  if (!comboMetricsGroup) return;
  const checked = document.querySelector('input[name="sizeMode"]:checked');
  if (checked && checked.value === 'combo') {
    comboMetricsGroup.style.display = 'block';
  } else {
    comboMetricsGroup.style.display = 'none';
  }
}

for (let sm = 0; sm < sizeModeInputs.length; sm++) {
  sizeModeInputs[sm].addEventListener('change', function () {
    updateComboMetricsVisibility();
    applyFiltersAndRender();
  });
}

// Set initial visibility
updateComboMetricsVisibility();

// checkbox handlers
const showChecks = [chkMag, chkCDI, chkMMI];
for (let sc = 0; sc < showChecks.length; sc++) {
  showChecks[sc].addEventListener('change', function () {
    applyFiltersAndRender();
  });
}

// initialize depth range slider
function initDepthRangeSlider() {
  // Depth range slider - range slider with two handles (min and max)
  depthRangeSlider = d3.sliderBottom()
    .min(0)
    .max(700)
    .width(220)
    .ticks(6)
    .default([depthRangeMinValue, depthRangeMaxValue])
    .fill("#1b9e77")
    .on("onchange", function(val) {
      // Ensure min <= max (handles can't swap)
      depthRangeMinValue = Math.min(val[0], val[1]);
      depthRangeMaxValue = Math.max(val[0], val[1]);
      // Update display
      depthRangeMinVal.textContent = Math.round(depthRangeMinValue);
      depthRangeMaxVal.textContent = Math.round(depthRangeMaxValue);
    });

  d3.select("#depthRangeSlider")
    .attr("width", 250)
    .attr("height", 60)
    .append("g")
    .attr("transform", "translate(15,15)")
    .call(depthRangeSlider);
  
  // Update initial display values
  depthRangeMinVal.textContent = Math.round(depthRangeMinValue);
  depthRangeMaxVal.textContent = Math.round(depthRangeMaxValue);
}

// Initialize depth range slider when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDepthRangeSlider);
} else {
  // DOM is already ready
  initDepthRangeSlider();
}

// depth input handlers (keep existing inputs)
depthMin.addEventListener('input', function () {
  depthMinVal.textContent = depthMin.value;
  applyFiltersAndRender();
});

depthMax.addEventListener('input', function () {
  depthMaxVal.textContent = depthMax.value;
  applyFiltersAndRender();
});

// magnitude input handlers (keep as separate inputs)
magMin.addEventListener('input', function () {
  magMinVal.textContent = (+magMin.value).toFixed(1);
  applyFiltersAndRender();
});

magMax.addEventListener('input', function () {
  magMaxVal.textContent = (+magMax.value).toFixed(1);
  applyFiltersAndRender();
});

// tsunami filter
onlyTsunami.addEventListener('input', applyFiltersAndRender);

btnClearFilters.addEventListener('click', function () {
  // Reset depth inputs
  depthMin.value = 0;
  depthMax.value = 700;
  depthMinVal.textContent = '0';
  depthMaxVal.textContent = '700';
  
  // Reset depth range slider
  depthRangeMinValue = 0;
  depthRangeMaxValue = 700;
  if (depthRangeSlider) {
    depthRangeSlider.value([depthRangeMinValue, depthRangeMaxValue]);
  }
  depthRangeMinVal.textContent = '0';
  depthRangeMaxVal.textContent = '700';
  
  // Reset magnitude inputs
  magMin.value = 0;
  magMax.value = 10;
  magMinVal.textContent = '0.0';
  magMaxVal.textContent = '10.0';
  
  onlyTsunami.checked = false;
  applyFiltersAndRender();
});

btnWorld.addEventListener('click', function () {
  loadBasemap(WORLD_INIT);
  drawAll();
});

btnNA.addEventListener('click', function () {
  loadBasemap(NA_INIT);
  drawAll();
});

btnPrev.addEventListener('click', function () {
  if (timeIndex > 0) {
    setTimeSlider(timeIndex - 1);
    applyFiltersAndRender();
  }
});

btnNext.addEventListener('click', function () {
  if (timeIndex < timeBuckets.length - 1) {
    setTimeSlider(timeIndex + 1);
    applyFiltersAndRender();
  }
});

btnPlay.addEventListener('click', function () { togglePlay(); });

btnShowAll.addEventListener('click', function () {
  setTimeSlider(-1);
  applyFiltersAndRender();
});

// load data
Promise.all([
  d3.json(FILES.world),
  d3.json(FILES.na),
  d3.csv(FILES.quakes, autoTypeQuake)
]).then(function (all) {
  const world = all[0];
  const na = all[1];
  const rows = all[2];

  // keep only rows with valid lat/lon
  quakes = rows.filter(function (d) {
    return Number.isFinite(d.latitude) && Number.isFinite(d.longitude);
  });

  initScales();

  WORLD_INIT.feature = toGeo(world);
  NA_INIT.feature = toGeo(na);

  loadBasemap(WORLD_INIT);

  bucketByTime();
  setTimeSlider(0);

  resize();
  applyFiltersAndRender();
  renderLegend();
}).catch(function (err) {
  console.error('data load error:', err);
  const msg = document.createElement('div');
  msg.style.position = 'absolute';
  msg.style.left = '12px';
  msg.style.top = '12px';
  msg.style.padding = '10px 12px';
  msg.style.background = '#3b1d1d';
  msg.style.color = '#fff';
  msg.style.border = '1px solid #7f1d1d';
  msg.style.borderRadius = '8px';
  msg.textContent = 'failed to load data (check server & file paths). see console.';
  document.body.appendChild(msg);
});

// parse one csv row 
function autoTypeQuake(d) {
  // year / month
  let yy = parseInt(d.Year, 10);
  let mm = parseInt(d.Month, 10);
  if (!isFinite(yy)) yy = null;
  if (!isFinite(mm)) mm = null;

  // magnitude column can be "magnitude" (dataset) or "mag" (older code)
  let magVal = null;
  if (isFinite(+d.magnitude)) magVal = +d.magnitude;
  else if (isFinite(+d.mag)) magVal = +d.mag;

  return {
    year: yy,
    month: mm,
    latitude: +d.latitude,
    longitude: +d.longitude,
    depth: isFinite(+d.depth) ? +d.depth : null,

    // keep it under the name "mag" so the rest of the code works
    mag: isFinite(magVal) ? magVal : null,

    cdi: isFinite(+d.cdi) ? +d.cdi : null,
    mmi: isFinite(+d.mmi) ? +d.mmi : null,
    sig: isFinite(+d.sig) ? +d.sig : null,
    tsunami: +d.tsunami === 1 ? 1 : 0,
    place: d.place || '',
    dmin: isFinite(+d.dmin) ? +d.dmin : null
  };
}

// convert topojson to geojson
function toGeo(obj) {
  if (obj.type === 'FeatureCollection') return obj;
  const k = Object.keys(obj.objects)[0];
  return topojson.feature(obj, obj.objects[k]);
}

// draw or update the basemap
function loadBasemap(target) {
  currentBasemap = target;

  const v = viewportSize();
  svg.attr('width', v.w).attr('height', v.h);

  if (currentBasemap && currentBasemap.feature) {
    currentBasemap.projection.fitSize([v.w, v.h], currentBasemap.feature);
  }

  const feats = (currentBasemap && currentBasemap.feature && currentBasemap.feature.features) ? currentBasemap.feature.features : [];
  const pathGen = d3.geoPath(currentBasemap.projection);

  gLand.selectAll('path.country')
    .data(feats, function (d) {
      return (d.id || (d.properties && (d.properties.adm0_a3 || d.properties.name)));
    })
    .join(
      function (enter) {
        return enter.append('path')
          .attr('class', 'country')
          .attr('fill', '#e5e7eb')
          .attr('stroke', '#1e2a4c')
          .attr('stroke-width', 0.5)
          .attr('d', pathGen);
      },
      function (update) {
        return update.attr('d', pathGen);
      },
      function (exit) { exit.remove(); }
    );
}

// group quakes into monthly or yearly buckets
function bucketByTime() {
  // keep only rows that have a valid year (and month if needed)
  const usable = [];
  for (let i = 0; i < quakes.length; i++) {
    const q = quakes[i];
    if (windowMode === 'month') {
      if (q.year != null && q.month != null && q.month >= 1 && q.month <= 12) usable.push(q);
    } else {
      if (q.year != null) usable.push(q);
    }
  }

  // dictionary of key -> rows
  const groups = {};
  let key;
  if (windowMode === 'month') {
    // key like "2016-03"
    for (let j = 0; j < usable.length; j++) {
      const r = usable[j];
      const mm = (r.month < 10 ? '0' + r.month : '' + r.month);
      key = r.year + '-' + mm;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
  } else {
    // key like "2016"
    for (let k = 0; k < usable.length; k++) {
      const r2 = usable[k];
      key = '' + r2.year;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r2);
    }
  }

  // turn into sorted array with labels
  const keys = Object.keys(groups);
  // sort by time
  keys.sort(function (a, b) {
    if (windowMode === 'month') {
      // a = "YYYY-MM"
      const ay = parseInt(a.slice(0, 4), 10), am = parseInt(a.slice(5, 7), 10);
      const by = parseInt(b.slice(0, 4), 10), bm = parseInt(b.slice(5, 7), 10);
      if (ay !== by) return ay - by;
      return am - bm;
    } else {
      return parseInt(a, 10) - parseInt(b, 10);
    }
  });

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const buckets = [];
  for (let t = 0; t < keys.length; t++) {
    const kstr = keys[t];
    let label;
    if (windowMode === 'month') {
      const y = parseInt(kstr.slice(0, 4), 10);
      const m = parseInt(kstr.slice(5, 7), 10);
      label = monthNames[m - 1] + ' ' + y; // e.g., "March 2016"
    } else {
      label = kstr; // e.g., "2016"
    }
    buckets.push({ key: kstr, label: label, values: groups[kstr] });
  }

  timeBuckets = buckets;

  // set up slider state
  const hasBuckets = timeBuckets.length > 1;
  timeSlider.disabled = !hasBuckets;
  btnPrev.disabled = !hasBuckets;
  btnNext.disabled = !hasBuckets;
  btnPlay.disabled = !hasBuckets;

  timeSlider.min = 0;
  timeSlider.max = Math.max(0, timeBuckets.length - 1);
  timeSlider.value = 0;

  // make slider move the view
  timeSlider.oninput = function () {
    const v = +timeSlider.value;
    setTimeSlider(v);
    applyFiltersAndRender();
  };
  timeSlider.onchange = function () {
    const v = +timeSlider.value;
    setTimeSlider(v);
    applyFiltersAndRender();
  };
}

// set slider label and index
function setTimeSlider(idx) {
  // clamp to range or -1 for "all"
  if (idx >= 0) {
    idx = Math.min(Math.max(0, idx), Math.max(0, timeBuckets.length - 1));
  }
  timeIndex = idx;

  if (idx < 0 || !timeBuckets.length) {
    timeLabel.textContent = 'All times';
    if (!timeSlider.disabled) timeSlider.value = 0;
  } else {
    const bucket = timeBuckets[idx];
    timeLabel.textContent = bucket ? bucket.label : '';
    if (!timeSlider.disabled) timeSlider.value = idx;
  }
}

// setup scales (sizes + depth shading)
function initScales() {
  const magExtent = d3.extent(quakes, function (d) { return d.mag; });
  const cdiExtent = d3.extent(quakes, function (d) { return d.cdi; });
  const mmiExtent = d3.extent(quakes, function (d) { return d.mmi; });
  const sigExtent = d3.extent(quakes, function (d) { return d.sig; });

  const magLo = Math.max(0, (magExtent && magExtent[0] != null) ? magExtent[0] : 0);
  const magHi = Math.max(1, (magExtent && magExtent[1] != null) ? magExtent[1] : 1);

  const cdiLo = Math.max(0, (cdiExtent && cdiExtent[0] != null) ? cdiExtent[0] : 0);
  const cdiHi = Math.max(1, (cdiExtent && cdiExtent[1] != null) ? cdiExtent[1] : 1);

  const mmiLo = Math.max(0, (mmiExtent && mmiExtent[0] != null) ? mmiExtent[0] : 0);
  const mmiHi = Math.max(1, (mmiExtent && mmiExtent[1] != null) ? mmiExtent[1] : 1);

  const sigLo = Math.max(0, (sigExtent && sigExtent[0] != null) ? sigExtent[0] : 0);
  const sigHi = Math.max(1, (sigExtent && sigExtent[1] != null) ? sigExtent[1] : 1);

  sizeScale_mag = d3.scaleSqrt().domain([magLo, magHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
  sizeScale_cdi = d3.scaleSqrt().domain([cdiLo, cdiHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
  sizeScale_mmi = d3.scaleSqrt().domain([mmiLo, mmiHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
  sizeScale_sig = d3.scaleSqrt().domain([sigLo, sigHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);

  // compute a high-ish depth for dark end of gradient (98th percentile)
  const depths = [];
  for (let i = 0; i < quakes.length; i++) depths.push(quakes[i].depth || 0);
  depths.sort(d3.ascending);
  const q98 = d3.quantile(depths, 0.98);
  const depthMaxGuess = Math.max(100, q98 || 700);

  // color gradient: base color -> black as depth increases
  depthShade = function (baseColor, depth) {
    const val = (depth != null) ? depth : 0;
    const t = Math.max(0, Math.min(1, val / depthMaxGuess));
    return d3.interpolateRgb(baseColor, '#000')(t);
  };
}

// apply filters and draw
function applyFiltersAndRender() {
  const depLo = +depthMin.value;
  const depHi = +depthMax.value;
  const magLo = +magMin.value;
  const magHi = +magMax.value;
  const tsunamiOnly = !!onlyTsunami.checked;

  // pick the slice: bucket when slider is active, else all
  let subset;
  if (timeIndex >= 0 && timeBuckets.length) {
    subset = timeBuckets[timeIndex].values;
  } else {
    subset = quakes; // all times
  }

  // now apply the other filters (same as before)
  filtered = subset.filter(function (d) {
    const okDepth = (d.depth == null) ? true : (d.depth >= depLo && d.depth <= depHi);
    const okMag   = (d.mag   == null) ? true : (d.mag   >= magLo && d.mag   <= magHi);
    const okTsu   = tsunamiOnly ? (d.tsunami === 1) : true;
    return okDepth && okMag && okTsu;
  });

  drawQuakes();
}

// draw the quake circles (with optional tsunami ring)
function drawQuakes() {
  const proj = currentBasemap.projection;
  const checked = document.querySelector('input[name="sizeMode"]:checked');
  const useOverall = checked ? (checked.value === 'overall') : false;

  gQuake.selectAll('g.quake')
    .data(filtered, function (d, i) {
      const t = (d.time && d.time.getTime) ? d.time.getTime() : i;
      return t + ':' + d.latitude + ',' + d.longitude;
    })
    .join(
      function (enter) {
        return enter.append('g')
          .attr('class', 'quake')
          .attr('transform', function (d) {
            const pt = proj([d.longitude, d.latitude]);
            return 'translate(' + pt[0] + ',' + pt[1] + ')';
          })
          .on('mouseenter', function (event, d) { showTooltip(event, d); })
          .on('mouseleave', function () { hideTooltip(); })
          .on('mousemove', function (event) { positionTooltip(event); });
      },
      function (update) {
        update.attr('transform', function (d) {
          const pt = proj([d.longitude, d.latitude]);
          return 'translate(' + pt[0] + ',' + pt[1] + ')';
        });
        return update;
      },
      function (exit) { exit.remove(); }
    )
    .each(function (d) {
      const g = d3.select(this);
      g.selectAll('circle.ring').remove();

      if (useOverall) {
        // one circle using overall "sig"
        const rSig = sizeScale_sig(d.sig != null ? d.sig : 0);
        g.append('circle').attr('class', 'ring sig')
          .attr('r', rSig)
          .attr('fill', depthShade(COLORS.sig, d.depth))
          .attr('fill-opacity', 0.75)
          .attr('stroke', '#000')
          .attr('stroke-opacity', 0.35);

        // add blue tsunami ring if flagged
        if (d.tsunami === 1) {
          g.append('circle').attr('class', 'ring tsunami')
            .attr('r', rSig + 2)              // a tad larger so it shows outside
            .attr('fill', 'none')
            .attr('stroke', '#3b82f6')        // blue
            .attr('stroke-width', 1.5)
            .attr('stroke-opacity', 0.9);
        }
      } else {
        const showMag = chkMag.checked;
        const showCDI = chkCDI.checked;
        const showMMI = chkMMI.checked;

        let rMag = 0, rCDI = 0, rMMI = 0;

        if (showMag) {
          rMag = sizeScale_mag(d.mag != null ? d.mag : 0);
          g.append('circle').attr('class', 'ring mag')
            .attr('r', rMag)
            .attr('fill', depthShade(COLORS.mag, d.depth))
            .attr('fill-opacity', 0.55)
            .attr('stroke', '#000')
            .attr('stroke-opacity', 0.25);
        }
        if (showCDI) {
          rCDI = sizeScale_cdi(d.cdi != null ? d.cdi : 0);
          g.append('circle').attr('class', 'ring cdi')
            .attr('r', rCDI)
            .attr('fill', depthShade(COLORS.cdi, d.depth))
            .attr('fill-opacity', 0.45)
            .attr('stroke', '#000')
            .attr('stroke-opacity', 0.25);
        }
        if (showMMI) {
          rMMI = sizeScale_mmi(d.mmi != null ? d.mmi : 0);
          g.append('circle').attr('class', 'ring mmi')
            .attr('r', rMMI)
            .attr('fill', depthShade(COLORS.mmi, d.depth))
            .attr('fill-opacity', 0.35)
            .attr('stroke', '#000')
            .attr('stroke-opacity', 0.25);
        }

        // if none checked, fall back to magnitude
        if (!showMag && !showCDI && !showMMI) {
          rMag = sizeScale_mag(d.mag != null ? d.mag : 0);
          g.append('circle').attr('class', 'ring mag fallback')
            .attr('r', rMag)
            .attr('fill', depthShade(COLORS.mag, d.depth))
            .attr('fill-opacity', 0.55)
            .attr('stroke', '#000')
            .attr('stroke-opacity', 0.25);
        }

        // blue tsunami ring sized to the largest visible ring
        if (d.tsunami === 1) {
          let rMax = Math.max(rMag || 0, rCDI || 0, rMMI || 0);
          if (rMax === 0) {
            // if we fell back to mag, use that
            rMax = sizeScale_mag(d.mag != null ? d.mag : 0);
          }
          g.append('circle').attr('class', 'ring tsunami')
            .attr('r', rMax + 2)
            .attr('fill', 'none')
            .attr('stroke', '#3b82f6')
            .attr('stroke-width', 1.5)
            .attr('stroke-opacity', 0.9);
        }
      }
    });
}

// tooltip stuff
function showTooltip(event, d) {
  const timeFmt = d3.timeFormat('%b %d, %Y %H:%M UTC');

  const parts = [];
  if (d.mag != null) parts.push('<span class="badge">M ' + (+d.mag).toFixed(1) + '</span>');
  if (d.depth != null) parts.push('<span class="badge">' + (+d.depth).toFixed(0) + ' km</span>');
  if (d.tsunami === 1) parts.push('<span class="badge" style="border-color:#743; color:#fbbf24">Tsunami</span>');

  let barHtml = '';
  if (d.dmin != null) {
    const dminPct = Math.max(0, Math.min(1, d.dmin / 5));
    barHtml =
      '<div class="bar-wrap">' +
      '<div class="meta">Nearest station distance: ' + d.dmin.toFixed(2) + ' (scaled)</div>' +
      '<div class="bar-bg"><div class="bar" style="width:' + (dminPct * 100).toFixed(0) + '%"></div></div>' +
      '</div>';
  }

  tip.classed('hidden', false).html(
    '<h3>' + (d.place || 'Earthquake') + '</h3>' +
    '<div class="meta">' + (d.time ? timeFmt(d.time) : '') + '</div>' +
    '<div>' + parts.join(' ') + '</div>' +
    '<div class="meta">CDI: ' + fmtNA(d.cdi) + ' | MMI: ' + fmtNA(d.mmi) + ' | Sig: ' + fmtNA(d.sig) + '</div>' +
    barHtml
  );

  positionTooltip(event);
}

function hideTooltip() { tip.classed('hidden', true); }

function positionTooltip(event) {
  const xy = d3.pointer(event, svg.node());
  tip.style('left', xy[0] + 'px').style('top', xy[1] + 'px');
}

function fmtNA(v) {
  return (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(1);
}

// legend
function renderLegend() {
  const div = d3.select('main#viz').append('div').attr('class', 'legend');

  div.append('div').attr('class', 'row')
    .html('<div class="swatch mag"></div> <span>Magnitude (Richter)</span>');

  div.append('div').attr('class', 'row')
    .html('<div class="swatch cdi"></div> <span>CDI (felt)</span>');

  div.append('div').attr('class', 'row')
    .html('<div class="swatch mmi"></div> <span>MMI (damage)</span>');

  div.append('div').attr('class', 'row')
    .html('<div class="swatch sig"></div> <span>Significance (overall)</span>');
}

// play/pause animation
function togglePlay() {
  playing = !playing;
  btnPlay.textContent = playing ? 'Pause' : 'Play';
  if (playing) stepPlay();
}

function stepPlay() {
  if (!playing) return;
  if (timeBuckets.length === 0) {
    playing = false;
    btnPlay.textContent = 'Play';
    return;
  }
  const next = timeIndex + 1;
  if (next < timeBuckets.length) {
    setTimeSlider(next);
    applyFiltersAndRender();
    setTimeout(stepPlay, 900);
  } else {
    playing = false;
    btnPlay.textContent = 'Play';
  }
}

// simple wrapper so i can call one thing on resize
function drawAll() {
  drawQuakes();
}
