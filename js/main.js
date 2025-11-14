/* global d3, topojson */

// ---------- Config ----------
const FILES = {
  world: 'data/world_lowres.json',
  na: 'data/NA_lowres.json',
  quakes: 'data/earthquake_data_tsunami.csv',
};

const SIZE = { minPx: 4, maxPx: 20 };
const COLORS = {
  mag: '#1b9e77',
  cdi: '#d95f02',
  mmi: '#7570b3',
  sig: '#e7298a',
  tsunami: '#3b82f6',
  depthRing: '#374151',
};
const NAVY_BG = '#0a1128'; // canvas background behind ocean oval

// Zoom behaviour tuning
// We'll compensate for the parent's <g transform="scale(k)"> so circles don't balloon.
// This exponent is a *tiny* positive value to allow very gentle growth on zoom-in.
// Set to 0 for perfectly constant-size circles under zoom.
const RADIUS_ZOOM_EXP = 0.23;

// ---------- Projections ----------
const WORLD_INIT = { type: 'world', projection: d3.geoNaturalEarth1() };
const NA_INIT = {
  type: 'na',
  projection: d3.geoAlbers().parallels([29.5, 45.5]).rotate([98, 0]).center([0, 38]),
};
const INDONESIA_INIT = { type: 'indo', projection: d3.geoMercator().center([120, -3]).scale(1450) };
const JAPAN_INIT = { type: 'japan', projection: d3.geoMercator().center([138, 38]).scale(2000) };
const ANDES_INIT = { type: 'andes', projection: d3.geoMercator().center([-72, -23]).scale(1650) };
const NZ_INIT = { type: 'nz', projection: d3.geoMercator().center([172, -41]).scale(2700) };

// ---------- App state ----------
let currentBasemap = WORLD_INIT;
let quakes = [];
let filtered = [];
let timeBuckets = [];
let timeIndex = 0;
let playing = false;
let windowMode = 'year';

let sizeScale_mag, sizeScale_cdi, sizeScale_mmi, sizeScale_sig;
const depthStroke = d3.scaleLinear().domain([0, 700]).range([0.6, 4]).clamp(true);

const svg = d3.select('#map');

// Layer order
const gRoot = svg.append('g').attr('class', 'root');
const gBackground = gRoot.append('g').attr('class', 'background'); // page canvas
const gOval = gRoot.append('g').attr('class', 'oval');             // ocean "oval"
const gPlates = gRoot.append('g').attr('class', 'plates');
const gLand = gRoot.append('g').attr('class', 'land');
const gQuake = gRoot.append('g').attr('class', 'quakes');

const tip = d3.select('#tooltip');

// ---------- DOM refs ----------
const controls = document.querySelector('aside#controls');
const btnWorld = document.getElementById('btnWorld');
const btnNA = document.getElementById('btnNA');
const btnIndonesia = document.getElementById('btnIndonesia');
const btnJapan = document.getElementById('btnJapan');
const btnAndes = document.getElementById('btnAndes');
const btnNZ = document.getElementById('btnNZ');

const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomResetBtn = document.getElementById('zoomReset');
const zoomStatus = document.getElementById('zoomStatus');

const depthRangeMinVal = document.getElementById('depthRangeMinVal');
const depthRangeMaxVal = document.getElementById('depthRangeMaxVal');
const magRangeMinVal = document.getElementById('magRangeMinVal');
const magRangeMaxVal = document.getElementById('magRangeMaxVal');

const onlyTsunami = document.getElementById('onlyTsunami');
const btnClearFilters = document.getElementById('btnClearFilters');

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
const comboMetricsGroup = document.getElementById('comboMetricsGroup');

// Legend containers (keep original structure/IDs)
const legendPanel = document.getElementById('legendPanel');
const colorLegendDiv = d3.select('#colorLegend');
const sizeLegendDiv = d3.select('#sizeLegend');
const gradientLegendDiv = d3.select('#sigGradientLegend'); // unused

// ---------- Layout helpers ----------
let zoomK = 1;

function viewportSize() {
  const panel = controls;
  const panelW = panel ? panel.getBoundingClientRect().width : 320;
  const w = Math.max(480, window.innerWidth - panelW - 16);
  const h = Math.max(420, window.innerHeight - 0);
  return { w, h };
}

function resize() {
  const v = viewportSize();
  svg.attr('width', v.w).attr('height', v.h);
  setZoomExtents();
  drawBackgrounds();
}
window.addEventListener('resize', () => {
  resize();
  drawAll();
});

// ---------- Zoom & Pan ----------
const ZOOM_MIN = 1;
const ZOOM_MAX = 12;

const zoom = d3.zoom()
  .scaleExtent([ZOOM_MIN, ZOOM_MAX])
  .on('zoom', (event) => {
    zoomK = event.transform.k;
    gRoot.attr('transform', event.transform);
    adjustCircleSizes();   // compensate zoom
    renderLegend();        // resize legend circles to match zoom
    updateZoomUI();
  });

svg.call(zoom);

function updateZoomUI() {
  const atMin = zoomK <= ZOOM_MIN + 1e-6;
  const atMax = zoomK >= ZOOM_MAX - 1e-6;
  zoomInBtn.disabled = atMax;
  zoomOutBtn.disabled = atMin;
  zoomStatus.textContent = `${zoomK.toFixed(1)}×${atMax ? ' (max)' : atMin ? ' (min)' : ''}`;
}

function setZoomExtents() {
  const v = viewportSize();
  zoom.extent([[0, 0], [v.w, v.h]]);

  // Constrain pan to feature bounds + padding (+15% vertical)
  if (currentBasemap && currentBasemap.feature) {
    const pathGen = d3.geoPath(currentBasemap.projection);
    const b = pathGen.bounds(currentBasemap.feature);
    const minX = Math.min(b[0][0], b[1][0]);
    const maxX = Math.max(b[0][0], b[1][0]);
    const minY = Math.min(b[0][1], b[1][1]);
    const maxY = Math.max(b[0][1], b[1][1]);
    const w = maxX - minX;
    const h = maxY - minY;

    const padX = 120;
    const padY = 60 + h * 0.15; // +15% vertical span
    zoom.translateExtent([[minX - padX, minY - padY], [maxX + padX, maxY + padY]]);
  } else {
    const v2 = viewportSize();
    zoom.translateExtent([[-v2.w * 0.5, -v2.h * 0.2], [v2.w * 1.5, v2.h * 1.2]]);
  }
}
function resetZoom(duration = 300) {
  svg.transition().duration(duration).call(zoom.transform, d3.zoomIdentity);
}

zoomInBtn.addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 1.3));
zoomOutBtn.addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 1/1.3));
zoomResetBtn.addEventListener('click', () => { loadBasemap(WORLD_INIT); resetZoom(250); drawAll(); });

// ---------- Controls wiring ----------
function updateComboVisibility() {
  const checked = document.querySelector('input[name="sizeMode"]:checked');
  comboMetricsGroup.style.display = (checked && checked.value === 'combo') ? 'block' : 'none';
}
sizeModeInputs.forEach(r => r.addEventListener('change', () => { updateComboVisibility(); applyFiltersAndRender(); renderLegend(); }));
[chkMag, chkCDI, chkMMI].forEach(c => c.addEventListener('change', () => { applyFiltersAndRender(); renderLegend(); }));
updateComboVisibility();

// Depth slider
let depthRangeMinValue = 0;
let depthRangeMaxValue = 700;
const depthSlider = d3.sliderBottom()
  .min(0).max(700).width(240).tickFormat(d3.format('.0f')).ticks(5).default([0, 700])
  .fill(COLORS.mag)
  .on('onchange', val => {
    depthRangeMinValue = val[0];
    depthRangeMaxValue = val[1];
    depthRangeMinVal.textContent = Math.round(val[0]);
    depthRangeMaxVal.textContent = Math.round(val[1]);
    applyFiltersAndRender();
  });
d3.select('#depthRangeSlider').append('g').attr('transform', 'translate(20,10)').call(depthSlider);

// Magnitude slider
let magRangeMinValue = 0;
let magRangeMaxValue = 10;
const magRangeSlider = d3.sliderBottom()
  .min(0).max(10).width(240).tickFormat(d3.format('.1f')).ticks(5).default([0, 10])
  .fill(COLORS.cdi)
  .on('onchange', val => {
    magRangeMinValue = val[0];
    magRangeMaxValue = val[1];
    magRangeMinVal.textContent = val[0].toFixed(1);
    magRangeMaxVal.textContent = val[1].toFixed(1);
    applyFiltersAndRender();
  });
d3.select('#magRangeSlider').append('g').attr('transform', 'translate(20,10)').call(magRangeSlider);

// Move the legend panel ABOVE Filters (keep your original HTML nodes)
(function moveLegendAboveFilters() {
  const filtersGroup = document.querySelector('#depthRangeSlider')?.closest('.group');
  if (filtersGroup && legendPanel && legendPanel !== filtersGroup.previousSibling) {
    controls.insertBefore(legendPanel, filtersGroup);
  }
})();

// Ensure the tsunami toggle is inside the Filters group
(function moveTsunamiToggleIntoFilters() {
  const toggleRow = document.querySelector('.toggle-row');
  const clearBtn = document.getElementById('btnClearFilters');
  const filtersGroup = clearBtn?.closest('.group');

  // Move "Show Only Tsunami Events" ABOVE the Clear Filters button
  if (toggleRow && filtersGroup && clearBtn) {
    filtersGroup.insertBefore(toggleRow, clearBtn);
  }

  // Apply immediately when toggled
  if (onlyTsunami) {
    onlyTsunami.addEventListener('change', applyFiltersAndRender);
  }
})();


// Clear filters
btnClearFilters.addEventListener('click', () => {
  depthRangeMinValue = 0; depthRangeMaxValue = 700;
  depthSlider.value([depthRangeMinValue, depthRangeMaxValue]);
  depthRangeMinVal.textContent = '0'; depthRangeMaxVal.textContent = '700';

  magRangeMinValue = 0; magRangeMaxValue = 10;
  magRangeSlider.value([magRangeMinValue, magRangeMaxValue]);
  magRangeMinVal.textContent = '0.0'; magRangeMaxVal.textContent = '10.0';

  if (onlyTsunami) onlyTsunami.checked = false;
  applyFiltersAndRender();
});

// Window radios
document.querySelectorAll('input[name="window"]').forEach(r => {
  r.addEventListener('change', (e) => {
    windowMode = e.target.value;
    bucketByTime();
    setTimeSlider(0);
    applyFiltersAndRender();
  });
});

// Region buttons
btnWorld.addEventListener('click', () => { loadBasemap(WORLD_INIT); resetZoom(); drawAll(); });
btnNA.addEventListener('click', () => { loadBasemap(NA_INIT); resetZoom(); drawAll(); });
btnIndonesia.addEventListener('click', () => { loadBasemap(INDONESIA_INIT); resetZoom(); drawAll(); });
btnJapan.addEventListener('click', () => { loadBasemap(JAPAN_INIT); resetZoom(); drawAll(); });
btnAndes.addEventListener('click', () => { loadBasemap(ANDES_INIT); resetZoom(); drawAll(); });
btnNZ.addEventListener('click', () => { loadBasemap(NZ_INIT); resetZoom(); drawAll(); });

// Timeline controls
btnPrev.addEventListener('click', () => { if (timeIndex > 0) { setTimeSlider(timeIndex - 1); applyFiltersAndRender(); } });
btnNext.addEventListener('click', () => {
  if (timeIndex < timeBuckets.length - 1) { setTimeSlider(timeIndex + 1); }
  else { setTimeSlider(0); }
  applyFiltersAndRender();
});
btnPlay.addEventListener('click', () => togglePlay());
btnShowAll.addEventListener('click', () => { setTimeSlider(-1); applyFiltersAndRender(); });

// ---------- Data load ----------
Promise.all([
  d3.json(FILES.world),
  d3.json(FILES.na),
  d3.csv(FILES.quakes, autoTypeQuake),
  d3.json('https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json')
    .catch(err => { console.warn('Could not load tectonic plate data:', err); return null; })
]).then((all) => {
  const [world, na, rows, plates] = all;

  quakes = rows.filter(d => Number.isFinite(d.latitude) && Number.isFinite(d.longitude));
  initScales();

  WORLD_INIT.feature = toGeo(world);
  NA_INIT.feature = toGeo(na);
  // custom regions reuse world features
  [INDONESIA_INIT, JAPAN_INIT, ANDES_INIT, NZ_INIT].forEach(r => r.feature = WORLD_INIT.feature);

  if (plates && plates.features) {
    [WORLD_INIT, NA_INIT, INDONESIA_INIT, JAPAN_INIT, ANDES_INIT, NZ_INIT].forEach(r => r.plates = plates);
  }

  loadBasemap(WORLD_INIT);
  bucketByTime();
  setTimeSlider(-1);

  resize();
  drawAll();
  renderLegend();

  resetZoom(0);
  updateZoomUI();

  showIntroOverlay(); // title screen on top
}).catch((err) => {
  console.error('data load error:', err);
  const msg = document.createElement('div');
  Object.assign(msg.style, {
    position: 'absolute', left: '12px', top: '12px',
    padding: '10px 12px', background: '#3b1d1d', color: '#fff',
    border: '1px solid #7f1d1d', borderRadius: '8px'
  });
  msg.textContent = 'failed to load data (check server & file paths). see console.';
  document.body.appendChild(msg);
});

// ---------- Helpers ----------
function autoTypeQuake(d) {
  const yy = +d.Year; const mm = +d.Month;
  let magVal = isFinite(+d.magnitude) ? +d.magnitude : (isFinite(+d.mag) ? +d.mag : null);
  return {
    year: isFinite(yy) ? yy : null,
    month: isFinite(mm) ? mm : null,
    latitude: +d.latitude, longitude: +d.longitude,
    depth: isFinite(+d.depth) ? +d.depth : null,
    mag: isFinite(magVal) ? magVal : null,
    cdi: isFinite(+d.cdi) ? +d.cdi : null,
    mmi: isFinite(+d.mmi) ? +d.mmi : null,
    sig: isFinite(+d.sig) ? +d.sig : null,
    tsunami: +d.tsunami === 1 ? 1 : 0,
    place: d.place || '',
    dmin: isFinite(+d.dmin) ? +d.dmin : null
  };
}
function toGeo(obj) {
  if (obj.type === 'FeatureCollection') return obj;
  const k = Object.keys(obj.objects)[0];
  return topojson.feature(obj, obj.objects[k]);
}

function loadBasemap(target) {
  currentBasemap = target;

  const v = viewportSize();
  svg.attr('width', v.w).attr('height', v.h);

  if (currentBasemap && currentBasemap.feature) {
    if (currentBasemap.type === 'world' || currentBasemap.type === 'na') {
      currentBasemap.projection.fitSize([v.w, v.h], currentBasemap.feature);
      // shrink base scale ~15% so 1x view breathes
      currentBasemap.projection.scale(currentBasemap.projection.scale() * 0.85);
    }
  }

  const feats = currentBasemap.feature?.features ?? [];
  const pathGen = d3.geoPath(currentBasemap.projection);

  // Plates
  if (currentBasemap.plates?.features) {
    gPlates.selectAll('path.plate-boundary')
      .data(currentBasemap.plates.features, (d, i) => d.id || i)
      .join(
        enter => enter.append('path')
          .attr('class', 'plate-boundary')
          .attr('fill', 'none')
          .attr('stroke', '#6b7280')
          .attr('stroke-width', 0.6)
          .attr('stroke-opacity', 0.25)
          .attr('d', pathGen)
          .attr('pointer-events', 'none'),
        update => update.attr('d', pathGen),
        exit => exit.remove()
      );
  } else {
    gPlates.selectAll('path.plate-boundary').remove();
  }

  // Land
  gLand.selectAll('path.country')
    .data(feats, d => d.id || d.properties?.adm0_a3 || d.properties?.name)
    .join(
      enter => enter.append('path')
        .attr('class', 'country')
        .attr('fill', '#e5e7eb')
        .attr('stroke', '#1e2a4c')
        .attr('stroke-width', 0.5)
        .attr('d', pathGen),
      update => update.attr('d', pathGen),
      exit => exit.remove()
    );

  setZoomExtents();
  drawBackgrounds();
}

// ---------- Time bucketing ----------
function bucketByTime() {
  const usable = quakes.filter(q => (windowMode === 'month')
    ? (q.year != null && q.month != null && q.month >= 1 && q.month <= 12)
    : (q.year != null));

  const groups = {};
  if (windowMode === 'month') {
    usable.forEach(r => {
      const mm = (r.month < 10 ? '0' + r.month : '' + r.month);
      const key = `${r.year}-${mm}`;
      (groups[key] ||= []).push(r);
    });
  } else {
    usable.forEach(r => { (groups['' + r.year] ||= []).push(r); });
  }

  const keys = Object.keys(groups).sort((a, b) => {
    if (windowMode === 'month') {
      const ay = +a.slice(0, 4), am = +a.slice(5, 7);
      const by = +b.slice(0, 4), bm = +b.slice(5, 7);
      return ay !== by ? ay - by : am - bm;
    }
    return (+a) - (+b);
  });

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  timeBuckets = keys.map(k => {
    let label = k;
    if (windowMode === 'month') {
      const y = +k.slice(0, 4), m = +k.slice(5, 7);
      label = `${monthNames[m - 1]} ${y}`;
    }
    return { key: k, label, values: groups[k] };
  });

  const hasBuckets = timeBuckets.length > 1;
  timeSlider.disabled = !hasBuckets;
  btnPrev.disabled = !hasBuckets;
  btnNext.disabled = !hasBuckets;
  btnPlay.disabled = !hasBuckets;

  timeSlider.min = 0;
  timeSlider.max = Math.max(0, timeBuckets.length - 1);
  timeSlider.value = 0;
  timeSlider.oninput = () => { setTimeSlider(+timeSlider.value); applyFiltersAndRender(); };
  timeSlider.onchange = () => { setTimeSlider(+timeSlider.value); applyFiltersAndRender(); };
}
function setTimeSlider(idx) {
  if (idx >= 0) idx = Math.min(Math.max(0, idx), Math.max(0, timeBuckets.length - 1));
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

// ---------- Scales ----------
function initScales() {
  const magExtent = d3.extent(quakes, d => d.mag);
  const cdiExtent = d3.extent(quakes, d => d.cdi);
  const mmiExtent = d3.extent(quakes, d => d.mmi);
  const sigExtent = d3.extent(quakes, d => d.sig);

  const magLo = Math.max(0, magExtent?.[0] ?? 0);
  const magHi = Math.max(1, magExtent?.[1] ?? 1);
  const cdiLo = Math.max(0, cdiExtent?.[0] ?? 0);
  const cdiHi = Math.max(1, cdiExtent?.[1] ?? 1);
  const mmiLo = Math.max(0, mmiExtent?.[0] ?? 0);
  const mmiHi = Math.max(1, mmiExtent?.[1] ?? 1);
  const sigLo = Math.max(0, sigExtent?.[0] ?? 0);
  const sigHi = Math.max(1, sigExtent?.[1] ?? 1);

  // Revert to original: sqrt for all measures
  sizeScale_mag = d3.scalePow().exponent(3)
  .domain([magLo, magHi])
  .range([SIZE.minPx, SIZE.maxPx])
  .clamp(true);

  sizeScale_cdi = d3.scaleSqrt().domain([cdiLo, cdiHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
  sizeScale_mmi = d3.scaleSqrt().domain([mmiLo, mmiHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
  sizeScale_sig = d3.scaleSqrt().domain([sigLo, sigHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
}

// ---------- Filter & draw ----------
function applyFiltersAndRender() {
  const depLo = depthRangeMinValue;
  const depHi = depthRangeMaxValue;
  const magLo = magRangeMinValue;
  const magHi = magRangeMaxValue;
  const tsunamiOnly = !!(onlyTsunami && onlyTsunami.checked);

  const subset = (timeIndex >= 0 && timeBuckets.length) ? timeBuckets[timeIndex].values : quakes;

  filtered = subset.filter(d => {
    const okDepth = (d.depth == null) ? true : (d.depth >= depLo && d.depth <= depHi);
    const okMag = (d.mag == null) ? true : (d.mag >= magLo && d.mag <= magHi);
    const okTsu = tsunamiOnly ? (d.tsunami === 1) : true;
    return okDepth && okMag && okTsu;
  });

  drawQuakes();
  renderLegend();
}

function drawQuakes() {
  const proj = currentBasemap.projection;
  const useOverall = (document.querySelector('input[name="sizeMode"]:checked')?.value === 'overall');

  const rows = gQuake.selectAll('g.quake')
    .data(filtered, (d, i) => `${(d.time && d.time.getTime) ? d.time.getTime() : i}:${d.latitude},${d.longitude}`);

  rows.exit().remove();

  const rowsEnter = rows.enter().append('g')
    .attr('class', 'quake')
    .attr('transform', d => `translate(${proj([d.longitude, d.latitude])[0]},${proj([d.longitude, d.latitude])[1]})`);
  rowsEnter.append('g').attr('class', 'rings');

  const rowsAll = rowsEnter.merge(rows);
  rowsAll.attr('transform', d => {
    const pt = proj([d.longitude, d.latitude]);
    return `translate(${pt[0]},${pt[1]})`;
  });

  rowsAll.each(function(d) {
    const container = d3.select(this).select('g.rings');
    container.selectAll('circle.ring').remove();

    function addRing(cls, r, fill, fillOpacity, stroke, strokeOpacity, strokeWidth = 0) {
      const c = container.append('circle').attr('class', 'ring ' + cls)
        .attr('data-r', r)
        .attr('r', r)
        .attr('fill', fill)
        .attr('fill-opacity', fillOpacity)
        .attr('stroke', stroke)
        .attr('stroke-opacity', strokeOpacity);
      if (strokeWidth > 0) {
        c.attr('stroke-width', strokeWidth).attr('vector-effect', 'non-scaling-stroke');
      }
      return c;
    }

    if (useOverall) {
      const rSig = sizeScale_sig(d.sig ?? 0);
      addRing('sig', rSig, COLORS.sig, 0.75, '#000', 0.35);

      // Depth ring
      const depthW = depthStroke(d.depth ?? 0);
      addRing('depth', rSig + 1.5, 'none', 1, COLORS.depthRing, 0.9, depthW);

      // Tsunami ring
      if (d.tsunami === 1)
        addRing('tsunami', rSig + 3, 'none', 1, COLORS.tsunami, 0.9, 1.5);

    } else {
      const showMag = chkMag.checked, showCDI = chkCDI.checked, showMMI = chkMMI.checked;
      let rMag = 0, rCDI = 0, rMMI = 0;

      if (showMag) { rMag = sizeScale_mag(d.mag ?? 0); addRing('mag', rMag, COLORS.mag, 0.55, '#000', 0.25); }
      if (showCDI) { rCDI = sizeScale_cdi(d.cdi ?? 0); addRing('cdi', rCDI, COLORS.cdi, 0.45, '#000', 0.25); }
      if (showMMI) { rMMI = sizeScale_mmi(d.mmi ?? 0); addRing('mmi', rMMI, COLORS.mmi, 0.35, '#000', 0.25); }

      if (!showMag && !showCDI && !showMMI) {
        rMag = sizeScale_mag(d.mag ?? 0);
        addRing('mag fallback', rMag, COLORS.mag, 0.55, '#000', 0.25);
      }

      let rBase = Math.max(rMag || 0, rCDI || 0, rMMI || 0);
      if (rBase === 0) rBase = sizeScale_mag(d.mag ?? 0);

      const depthW = depthStroke(d.depth ?? 0);
      addRing('depth', rBase + 1.5, 'none', 1, COLORS.depthRing, 0.9, depthW);

      if (d.tsunami === 1)
        addRing('tsunami', rBase + 3, 'none', 1, COLORS.tsunami, 0.9, 1.5);
    }
  });

  // Tooltips
  rowsAll
    .on('mouseover', (event, d) => showTooltip(event, d))
    .on('mousemove', (event) => positionTooltip(event))
    .on('mouseout', hideTooltip);

  rowsEnter.select('g.rings').attr('opacity', 0).transition().duration(550).attr('opacity', 1);

  adjustCircleSizes();
}


function adjustCircleSizes() {
  // Compensate for parent group scaling so circles don’t balloon.
  // factor = gentle_growth / zoomK
  const factor = Math.pow(zoomK, RADIUS_ZOOM_EXP) / zoomK;

  d3.selectAll('circle.ring').each(function () {
    const base = +this.getAttribute('data-r') || 0;
    this.setAttribute('r', base * factor);
  });
}

// ---------- Tooltip ----------
function showTooltip(event, d) {
  const timeFmt = d3.timeFormat('%b %d, %Y %H:%M UTC');

  const badges = [];
  if (d.mag != null) badges.push(`<span class="badge">M ${(+d.mag).toFixed(1)}</span>`);
  if (d.depth != null) badges.push(`<span class="badge">${(+d.depth).toFixed(0)} km</span>`);
  if (d.tsunami === 1) badges.push('<span class="badge" style="border-color:#743; color:#fbbf24">Tsunami</span>');

  const sigRow = `<div><span class="badge" style="background:${COLORS.sig};border-color:#000;color:#fff">Overall Significance: ${d.sig==null?'—':(+d.sig).toFixed(0)}</span></div>`;

  // Nearest station mini scale: grows with zoom (so it lengthens as you zoom in)
  const kmPerDeg = 111.32;
  const dminKm = (d.dmin != null) ? (d.dmin * kmPerDeg) : null;
  const pxBase = dminKm == null ? 0 : (dminKm / 1000) * 60; // base mapping
  const pxLen = dminKm == null ? 0 : Math.max(24, Math.min(180, pxBase * Math.pow(zoomK, 0.45))); // grow with zoom
  const scaleBar = (dminKm == null) ? '' : `
    <div style="margin-top:6px;">
      <div style="font-size:11px;color:var(--muted, #6b7280)">Nearest station: ${dminKm.toFixed(0)} km</div>
      <svg width="${pxLen+16}" height="18" style="overflow:visible">
        <line x1="4" y1="10" x2="${pxLen+12}" y2="10" stroke="#374151" stroke-width="2"/>
        <line x1="4" y1="5" x2="4" y2="15" stroke="#374151" stroke-width="2"/>
        <line x1="${pxLen+12}" y1="5" x2="${pxLen+12}" y2="15" stroke="#374151" stroke-width="2"/>
      </svg>
    </div>`;

  const bottom = `<div class="meta">Magnitude (Richter Scale): ${fmtNA(d.mag,1)} | CDI (Felt Intensity): ${fmtNA(d.cdi,1)} | MMI (Structural Intensity): ${fmtNA(d.mmi,1)}</div>`;

  tip.classed('hidden', false).html(
    `<h3>${d.place || 'Earthquake'}</h3>` +
    `<div class="meta">${d.time ? timeFmt(d.time) : ''}</div>` +
    sigRow +
    `<div style="margin-top:4px;">${badges.join(' ')}</div>` +
    scaleBar +
    bottom
  );

  positionTooltip(event);
}
function hideTooltip() { tip.classed('hidden', true); }
function positionTooltip(event) {
  const xy = d3.pointer(event, svg.node());
  tip.style('left', xy[0] + 'px').style('top', xy[1] + 'px');
}
function fmtNA(v, p=1) { return (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(p); }

// ---------- Legend (inside sidebar, above Filters) ----------
function renderLegend() {
  colorLegendDiv.html('');
  sizeLegendDiv.html('');
  gradientLegendDiv.html('');

  const labels = [
    { key: 'mag', text: 'Magnitude (Richter Scale)', color: COLORS.mag },
    { key: 'cdi', text: 'CDI (Felt Intensity)', color: COLORS.cdi },
    { key: 'mmi', text: 'MMI (Structural Intensity)', color: COLORS.mmi },
    { key: 'sig', text: 'Overall Significance', color: COLORS.sig }
  ];

  const useOverall = (document.querySelector('input[name="sizeMode"]:checked')?.value === 'overall');
  const rows = [];

  if (useOverall) rows.push('sig');
  else {
    if (chkMag.checked) rows.push('mag');
    if (chkCDI.checked) rows.push('cdi');
    if (chkMMI.checked) rows.push('mmi');
    if (!rows.length) rows.push('mag');
  }

  const factor = Math.pow(zoomK, RADIUS_ZOOM_EXP);

  rows.forEach(k => {
    const meta = labels.find(x => x.key === k);
    const scale = (k === 'mag') ? sizeScale_mag :
                  (k === 'cdi') ? sizeScale_cdi :
                  (k === 'mmi') ? sizeScale_mmi :
                  sizeScale_sig;

    const block = colorLegendDiv.append('div')
      .style('display', 'flex')
      .style('flex-direction', 'column')
      .style('gap', '6px')
      .style('margin', '8px 0 12px 0');

    block.append('div')
      .style('display', 'flex')
      .style('align-items', 'center')
      .style('gap', '10px')
      .html(`
        <div style="width:12px;height:12px;border-radius:3px;background:${meta.color}"></div>
        <div style="font-weight:600;">${meta.text}</div>
      `);

    // ✔ Only change: properly fix magnitude ticks (6,7,8,9)
    let ticks;
    if (k === 'mag') {
      const base = Math.floor(scale.domain()[0]);
      ticks = [base, base + 1, base + 2, base + 3];
    } else {
      const [lo, hi] = scale.domain();
      const step = (hi - lo) / 3;
      ticks = [lo, lo + step, lo + step * 2, hi];
    }

    const rowLeft = 35;
    const spacingX = 68;
    const cy = 36;
    const valueY = 82;

    const svg = block.append('svg')
      .attr('width', rowLeft + spacingX * (ticks.length - 1) + 80)
      .attr('height', 96);

    ticks.forEach((v, i) => {
      const r = scale(v) * factor;
      const cx = rowLeft + i * spacingX;

      svg.append('circle')
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', r)
        .attr('fill', meta.color)
        .attr('fill-opacity', k === 'mag' ? 0.55 :
                            k === 'cdi' ? 0.45 :
                            k === 'mmi' ? 0.35 : 0.75)
        .attr('stroke', '#000')
        .attr('stroke-opacity', 0.25);

      svg.append('text')
        .attr('x', cx)
        .attr('y', valueY)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .attr('fill', '#9ca3af')
        .text(v.toFixed(0));
    });
  });

  // Depth legend + tsunami legend untouched (your original code)
  (function addDepthRow() {
    const depths = [100, 300, 600];
    const w = 230, h = 75, cx0 = 42, spacing = 70, cyR = 28;
    const rBase = 15;

    const c = sizeLegendDiv.append('div').style('margin', '10px 0 0 0');
    c.append('div')
      .style('margin-bottom', '6px')
      .style('color', '#6b7280')
      .style('font-size', '12px')
      .style('text-align', 'left')
      .text('Depth (km)');

    const svg = c.append('svg').attr('width', w).attr('height', h);
    depths.forEach((d, i) => {
      const cx = cx0 + i * spacing;
      svg.append('circle')
        .attr('cx', cx).attr('cy', cyR).attr('r', rBase)
        .attr('fill', 'none').attr('stroke', COLORS.depthRing).attr('stroke-opacity', 0.9)
        .attr('stroke-width', depthStroke(d)).attr('vector-effect', 'non-scaling-stroke');
      svg.append('text')
        .attr('x', cx)
        .attr('y', cyR + 32)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .attr('fill', '#9ca3af')
        .text(d);
    });
  })();

  (function addTsunamiRow() {
    const w = 220, h = 58, cx = 42, cyR = 26, r = 15;

    const c = sizeLegendDiv.append('div').style('margin', '8px 0 0 0');
    c.append('div')
      .style('margin-bottom', '6px')
      .style('color', '#6b7280')
      .style('font-size', '12px')
      .style('text-align', 'left')
      .text('Tsunami Occurred');

    const svg = c.append('svg').attr('width', w).attr('height', h);
    svg.append('circle')
      .attr('cx', cx)
      .attr('cy', cyR)
      .attr('r', r)
      .attr('fill', 'none')
      .attr('stroke', COLORS.tsunami)
      .attr('stroke-width', 1.5)
      .attr('vector-effect', 'non-scaling-stroke');
  })();
}






// ---------- Play loop ----------
function togglePlay() {
  playing = !playing;
  btnPlay.textContent = playing ? 'Pause' : 'Play';
  if (playing) stepPlay();
}
function stepPlay() {
  if (!playing) return;
  if (!timeBuckets.length) { playing = false; btnPlay.textContent = 'Play'; return; }
  let next = timeIndex + 1;
  if (next >= timeBuckets.length) next = 0;
  setTimeSlider(next);
  applyFiltersAndRender();
  setTimeout(stepPlay, 900);
}

// ---------- Backgrounds ----------
function drawBackgrounds() {
  const v = viewportSize();

  // Deep navy canvas (behind ocean oval)
  gBackground.selectAll('rect.bg').data([1])
    .join('rect')
    .attr('class','bg')
    .attr('x', -v.w).attr('y', -v.h)
    .attr('width', v.w*3).attr('height', v.h*3)
    .attr('fill', NAVY_BG);

  // Ocean oval only for world view
  if (currentBasemap.type !== 'world') {
    gOval.selectAll('path.ocean-shape').remove();
    return;
  }

  const projection = currentBasemap.projection;
  const pathGen = d3.geoPath(projection);

  const bounds = currentBasemap.feature ? pathGen.bounds(currentBasemap.feature)
                                        : [[v.w*0.1, v.h*0.1],[v.w*0.9, v.h*0.9]];

  const minX = bounds[0][0], minY = bounds[0][1], maxX = bounds[1][0], maxY = bounds[1][1];
  const paddingX = 25, paddingY = 4;
  const width = (maxX - minX) + (paddingX * 2);
  const height = (maxY - minY) + (paddingY * 2);
  const x = minX - paddingX;
  const y = minY - paddingY - 3;
  const radius = height / 2;

  const path = `
    M ${x + radius},${y}
    L ${x + width - radius},${y}
    A ${radius},${radius} 0 0 1 ${x + width - radius},${y + height}
    L ${x + radius},${y + height}
    A ${radius},${radius} 0 0 1 ${x + radius},${y}
    Z
  `;

  gOval.selectAll('path.ocean-shape')
    .data([1])
    .join('path')
    .attr('class','ocean-shape')
    .attr('d', path)
    .attr('fill', '#93c5fd'); // keep ocean color
}

// ---------- Draw wrapper ----------
function drawAll() { drawBackgrounds(); drawQuakes(); }

// ---------- Intro overlay ----------
function showIntroOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'introOverlay';
  Object.assign(overlay.style, {
    position:'fixed', inset:'0', background: NAVY_BG, display:'flex',
    alignItems:'center', justifyContent:'center', flexDirection:'column',
    zIndex: 9999, color:'#f3f4f6', textAlign:'center'
  });

  overlay.innerHTML = `
    <div style="position:absolute; inset:0; overflow:hidden;">
      <svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice" style="pointer-events:none">
        <defs>
          <radialGradient id="pulse" fx="50%" fy="50%">
            <stop offset="0%" stop-color="#ff4d4d" stop-opacity="0.55"></stop>
            <stop offset="60%" stop-color="#ff4d4d" stop-opacity="0.12"></stop>
            <stop offset="100%" stop-color="#ff4d4d" stop-opacity="0"></stop>
          </radialGradient>
        </defs>
        <g id="rings"></g>
      </svg>
    </div>
    <h1 style="font-weight:700; letter-spacing:.3px; margin:0 16px 14px; font-size:28px; position:relative; z-index:2;">
      Global Earthquake & Tsunami Visualization
    </h1>
    <p style="max-width:720px; margin:0 16px 22px; color:#cbd5e1; position:relative; z-index:2;">
      Explore historical earthquakes by magnitude, felt and structural intensity, significance, depth, and tsunamis.
    </p>
    <button id="startVizBtn" style="
      padding:10px 16px; border-radius:10px; border:1px solid #1f2937;
      background:#111827; color:#e5e7eb; cursor:pointer; position:relative; z-index:2;
    ">Start Visualization</button>
  `;
  document.body.appendChild(overlay);

  // animated radiating circles
  const svgSel = d3.select(overlay).select('svg');
  const ringsG = svgSel.select('#rings');
  const W = window.innerWidth, H = window.innerHeight, cx = W/2, cy = H/2;
  function spawnRing() {
    const r = ringsG.append('circle')
      .attr('cx', cx).attr('cy', cy).attr('r', 0)
      .attr('fill', 'url(#pulse)');
    r.transition().duration(2400).ease(d3.easeCubicOut)
      .attr('r', Math.max(W,H) * 0.6).style('opacity', 0)
      .on('end', () => r.remove());
  }
  spawnRing();
  const ringTimer = setInterval(spawnRing, 700);

  document.getElementById('startVizBtn').addEventListener('click', () => {
    clearInterval(ringTimer);

    // Fade out overlay
    overlay.style.transition = 'opacity .35s ease';
    overlay.style.opacity = '0';

    // ✔ Default mode: Overall Impact
    const overallRadio = document.querySelector('input[value="overall"]');
    if (overallRadio) overallRadio.checked = true;

    // ✔ Show ALL time buckets immediately
    setTimeSlider(-1);

    // ✔ Draw immediately (no blank map)
    applyFiltersAndRender();
    renderLegend();

    // Remove overlay after fade
    setTimeout(() => overlay.remove(), 380);
  });

}


