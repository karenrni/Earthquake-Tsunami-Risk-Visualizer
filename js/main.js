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
    highlight: '#fbbf24' // amber
};
const NAVY_BG = '#0a1128'; // canvas background behind ocean oval

// Zoom behaviour tuning
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
const CARIBBEAN_INIT = { 
  type: 'caribbean', 
  projection: d3.geoMercator().center([-75, 18]).scale(1500) 
};

// ---------- App state ----------
let currentBasemap = WORLD_INIT;
let quakes = [];
let filtered = [];
let timeBuckets = [];
let timeIndex = 0;
let playing = false;       // timeline play/pause
let windowMode = 'year';

let sizeScale_mag, sizeScale_cdi, sizeScale_mmi, sizeScale_sig;
const depthStroke = d3.scaleLinear().domain([0, 700]).range([0.6, 4]).clamp(true);

const svg = d3.select('#map');

// Layer order
const gRoot = svg.append('g').attr('class', 'root');
const gBackground = gRoot.append('g').attr('class', 'background'); // page canvas
const gOval = gRoot.append('g').attr('class', 'oval');             // ocean oval thing
const gLand = gRoot.append('g').attr('class', 'land');
const gPlates = gRoot.append('g').attr('class', 'plates');
const gQuake = gRoot.append('g').attr('class', 'quakes');
const gStory = gRoot.append('g').attr('class', 'story-overlay');   // overlays for story highlights

const tip = d3.select('#tooltip');

// ---------- DOM refs ----------
const controls = document.querySelector('aside#controls');
const btnWorld = document.getElementById('btnWorld');
const btnNA = document.getElementById('btnNA');
const btnIndonesia = document.getElementById('btnIndonesia');
const btnJapan = document.getElementById('btnJapan');
const btnAndes = document.getElementById('btnAndes');
const btnNZ = document.getElementById('btnNZ');
const btnCaribbean = document.getElementById('btnCaribbean');

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

const timeline = document.getElementById('timeline');
const timeSlider = document.getElementById('timeSlider');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnPlay = document.getElementById('btnPlay');   // timeline play
const btnShowAll = document.getElementById('btnShowAll');
const timeLabel = document.getElementById('timeLabel');

const sizeModeInputs = document.querySelectorAll('input[name="sizeMode"]');
const chkMag = document.getElementById('chk-mag');
const chkCDI = document.getElementById('chk-cdi');
const chkMMI = document.getElementById('chk-mmi');
const comboMetricsGroup = document.getElementById('comboMetricsGroup');

// Legend containers
const legendPanel = document.getElementById('legendPanel');
const colorLegendDiv = d3.select('#colorLegend');
const sizeLegendDiv = d3.select('#sizeLegend');
const gradientLegendDiv = d3.select('#sigGradientLegend'); // unused

// detail sidepanel
const quakeDetailPanel = document.getElementById('quakeDetailPanel');
const closePanelBtn = document.getElementById('closePanelBtn');
let selectedQuakeData = null;

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
    if (zoomInBtn) zoomInBtn.disabled = atMax;
    if (zoomOutBtn) zoomOutBtn.disabled = atMin;
    if (zoomStatus) zoomStatus.textContent = `${zoomK.toFixed(1)}×${atMax ? ' (max)' : atMin ? ' (min)' : ''}`;
}

function setZoomExtents() {
    const v = viewportSize();
    zoom.extent([[0, 0], [v.w, v.h]]);

    // Constrain pan to feature bounds + padding (+15% vertical) :P
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

// zoom listeners
if (zoomInBtn) zoomInBtn.addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 1.3));
if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 1/1.3));
if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => { loadBasemap(WORLD_INIT); resetZoom(250); drawAll(); });

// quake sidepanel listeners
if (closePanelBtn) {
  closePanelBtn.addEventListener('click', closeQuakePanel);
}

svg.on('click', function(event) {
  if (event.target === this || event.target.tagName === 'svg') {
      closeQuakePanel(); // Close when clicking map background
  }
});

//  Controls wiring
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

// Move the legend panel ABOVE Filters
(function moveLegendAboveFilters() {
    const filtersGroup = document.querySelector('#depthRangeSlider')?.closest('.group');
    if (filtersGroup && legendPanel && legendPanel !== filtersGroup.previousSibling) {
        controls.insertBefore(legendPanel, filtersGroup);
    }
})();

// Tsunami toggle is inside the Filters group
(function moveTsunamiToggleIntoFilters() {
    const toggleRow = document.querySelector('.toggle-row');
    const clearBtn = document.getElementById('btnClearFilters');
    const filtersGroup = clearBtn?.closest('.group');

    if (toggleRow && filtersGroup && clearBtn) {
        filtersGroup.insertBefore(toggleRow, clearBtn);
    }

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

// Timeline: put Play + "Display All" on the LEFT
(function reorderTimelineButtons() {
    if (!timeline) return;
    // Labels
    if (btnPlay) btnPlay.textContent = 'Play Timeline';
    if (btnShowAll) btnShowAll.textContent = 'Display All';

    // Enforce order (of): Play Timeline, Display All, Prev, Slider, Next
    const desired = [btnPlay, btnShowAll, btnPrev, timeSlider, btnNext].filter(Boolean);
    desired.forEach(el => timeline.appendChild(el)); // append reorders to end in given sequence
})();

// Window radios
document.querySelectorAll('input[name="window"]').forEach(r => {
    r.addEventListener('change', (e) => {
        windowMode = e.target.value;
        bucketByTime();
        setTimeSlider(0);
        applyFiltersAndRender();
    });
});

// Region zoom buttons
btnWorld.addEventListener('click', () => { loadBasemap(WORLD_INIT); resetZoom(); drawAll(); });
btnNA.addEventListener('click', () => { loadBasemap(NA_INIT); resetZoom(); drawAll(); });
if (btnIndonesia) btnIndonesia.addEventListener('click', () => { loadBasemap(INDONESIA_INIT); resetZoom(); drawAll(); });
if (btnJapan) btnJapan.addEventListener('click', () => { loadBasemap(JAPAN_INIT); resetZoom(); drawAll(); });
if (btnAndes) btnAndes.addEventListener('click', () => { loadBasemap(ANDES_INIT); resetZoom(); drawAll(); });
if (btnNZ) btnNZ.addEventListener('click', () => { loadBasemap(NZ_INIT); resetZoom(); drawAll(); });
if (btnCaribbean) btnCaribbean.addEventListener('click',  ()=> { loadBasemap(CARIBBEAN_INIT); resetZoom(); drawAll(); });


// Timeline controls
btnPrev.addEventListener('click', () => { if (timeIndex > 0) { setTimeSlider(timeIndex - 1); applyFiltersAndRender(); } });
btnNext.addEventListener('click', () => {
    if (timeIndex < timeBuckets.length - 1) { setTimeSlider(timeIndex + 1); }
    else { setTimeSlider(0); }
    applyFiltersAndRender();
});
btnPlay.addEventListener('click', () => togglePlay());
btnShowAll.addEventListener('click', () => { setTimeSlider(-1); applyFiltersAndRender(); });

// Data loading
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
    [INDONESIA_INIT, JAPAN_INIT, ANDES_INIT, NZ_INIT, CARIBBEAN_INIT].forEach(r => r.feature = WORLD_INIT.feature);

    if (plates && plates.features) {
        [WORLD_INIT, NA_INIT, INDONESIA_INIT, JAPAN_INIT, ANDES_INIT, NZ_INIT, CARIBBEAN_INIT].forEach(r => r.plates = plates);
    }

    loadBasemap(WORLD_INIT);
    bucketByTime();
    setTimeSlider(-1); // show ALL by default

    resize();
    drawAll();
    renderLegend();

    resetZoom(0);
    updateZoomUI();

    showIntroOverlay(); // title screen on top

    addPlayStoryButton();
}).catch((err) => {
    console.error('data load error:', err);
    const msg = document.createElement('div');
    Object.assign(msg.style, {
        position: 'absolute',
        left: '12px',
        top: '12px',
        padding: '10px 12px',
        background: '#3b1d1d',
        color: '#fff',
        border: '1px solid #7f1d1d',
        borderRadius: '8px'
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
                    .attr('stroke', 'none')
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
            .attr('fill', d => {
                // Get center point of a country
                const bounds = pathGen.bounds(d);
                const centerLat = (bounds[0][1] + bounds[1][1]) / 2;
                const centerLon = (bounds[0][0] + bounds[1][0]) / 2;
                
                // Project back to the coordinates
                const geoCenter = currentBasemap.projection.invert([centerLon, centerLat]);
                if (!geoCenter) return '#d0dbc7';
                
                const lat = geoCenter[1];
                //const lon = geoCenter[0];
                
                // Latitude zones
                if (lat < -60) {
                  return '#ffffff';
                }
                const absLat = Math.abs(lat);
                

                // Polar
                if (absLat > 60) {
                    const t = (absLat - 60) / 30; 
                    return d3.interpolateRgb('#d8e3d8', '#f0f2f0')(t);
                }
                
                // Desert belt
                if (absLat > 15 && absLat < 35) {
                    const t = Math.abs(absLat - 25) / 10; //peak heat
                    return d3.interpolateRgb('#faf0e6', '#c8d5c0')(t);
                }
                
                // Tropical
                if (absLat < 15) {
                    return '#c2d4bc';
                }

                // Temperate default
                return '#d0dbc7';

            })
            .attr('stroke', '#99a88a')
            .attr('stroke-width', 0.35)
            .attr('d', pathGen),
        update => update.attr('d', pathGen),
        exit => exit.remove()
    );
    // gLand.selectAll('path.country')
    //     .data(feats, d => d.id || d.properties?.adm0_a3 || d.properties?.name)
    //     .join(
    //         enter => enter.append('path')
    //             .attr('class', 'country')
    //             .attr('fill', d => {
    //               // Different colors for different regions
    //               const name = d.properties?.name || '';
    //               if (name.includes('Desert') || name.includes('Arabia')) return '#e8d5b7';
    //               if (name.includes('forest') || name.includes('Brazil')) return '#c8d4c0';
    //               return '#d4e0d4'; // default soft green-gray
    //           })
    //             .attr('stroke', '#1e2a4c')
    //             .attr('stroke-width', 0.5)
    //             .attr('d', pathGen),
    //         update => update.attr('d', pathGen),
    //         exit => exit.remove()
    //     );

    // setZoomExtents();
    // drawBackgrounds();
}

// Time bucketing 
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

    sizeScale_mag = d3.scalePow().exponent(3).domain([magLo, magHi]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
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

    // Join quake groups
    const rows = gQuake.selectAll('g.quake')
        .data(filtered, (d, i) => `${d.time ? d.time.getTime() : i}:${d.latitude},${d.longitude}`);

    // Remove old rows
    rows.exit()
        .select('g.rings')
        .transition().duration(300)
        .style('opacity', 0)
        .on('end', function() { d3.select(this.parentNode).remove(); });

    // Enter rows
    const rowsEnter = rows.enter()
        .append('g')
        .attr('class', 'quake')
        .attr('transform', d => {
            const pt = proj([d.longitude, d.latitude]);
            return `translate(${pt[0]},${pt[1]})`;
        });

    rowsEnter.append('g').attr('class', 'rings');

    // UPDATE + ENTER
    const rowsAll = rowsEnter.merge(rows);

    rowsAll.attr('transform', d => {
        const pt = proj([d.longitude, d.latitude]);
        return `translate(${pt[0]},${pt[1]})`;
    });

    // -------------------------------------------------------------
    // ringSpec generator — only one source of rings !!!!
    // -------------------------------------------------------------
    rowsAll.each(function(d) {
        const container = d3.select(this).select('g.rings');

        const DEPTH_OFFSET = 1.5;
        const TSU_OFFSET   = 3.5;
        const DEPTH_EXTRA  = 0.25;
        const TSU_EXTRA    = 0.25;
        const TSU_COLOR    = '#1e40af';

        function ringSpec(d, useOverall) {
            if (useOverall) {
                const rSig = sizeScale_sig(d.sig ?? 0);

                const specs = [
                    { key:'sig', r:rSig, fill:COLORS.sig, fo:0.75, stroke:'#000', so:0.35, sw:0 },
                    {
                        key:'depth',
                        r:rSig + DEPTH_OFFSET,
                        fill:'none',
                        fo:1,
                        stroke:COLORS.depthRing,
                        so:0.9,
                        sw:depthStroke(d.depth ?? 0) + DEPTH_EXTRA
                    }
                ];

                if (d.tsunami === 1) {
                    specs.push({
                        key:'tsunami',
                        r:rSig + TSU_OFFSET,
                        fill:'none',
                        fo:1,
                        stroke:TSU_COLOR,
                        so:0.9,
                        sw:1.5 + TSU_EXTRA
                    });
                }

                return specs;
            }

            //  Combo mode / seprated metrics
            const showMag = chkMag.checked;
            const showCDI = chkCDI.checked;
            const showMMI = chkMMI.checked;

            let rMag = showMag ? sizeScale_mag(d.mag ?? 0) : 0;
            let rCDI = showCDI ? sizeScale_cdi(d.cdi ?? 0) : 0;
            let rMMI = showMMI ? sizeScale_mmi(d.mmi ?? 0) : 0;

            if (!showMag && !showCDI && !showMMI) {
                rMag = sizeScale_mag(d.mag ?? 0);
            }

            const rBase = Math.max(rMag, rCDI, rMMI, sizeScale_mag(d.mag ?? 0));

            const specs = [];
            if (rMag) specs.push({ key:'mag', r:rMag, fill:COLORS.mag, fo:0.55, stroke:'#000', so:0.25, sw:0 });
            if (rCDI) specs.push({ key:'cdi', r:rCDI, fill:COLORS.cdi, fo:0.45, stroke:'#000', so:0.25, sw:0 });
            if (rMMI) specs.push({ key:'mmi', r:rMMI, fill:COLORS.mmi, fo:0.35, stroke:'#000', so:0.25, sw:0 });

            // depth ring
            specs.push({
                key:'depth',
                r:rBase + DEPTH_OFFSET,
                fill:'none',
                fo:1,
                stroke:COLORS.depthRing,
                so:0.9,
                sw:depthStroke(d.depth ?? 0) + DEPTH_EXTRA
            });

            // tsunami ring
            if (d.tsunami === 1) {
                specs.push({
                    key:'tsunami',
                    r:rBase + TSU_OFFSET,
                    fill:'none',
                    fo:1,
                    stroke:TSU_COLOR,
                    so:0.9,
                    sw:1.5 + TSU_EXTRA
                });
            }

            return specs;
        }

        // Get specs
        const specs = ringSpec(d, useOverall);

        // JOIN
        const rings = container.selectAll('circle.ring')
            .data(specs, s => s.key);

        // ENTER
        rings.enter()
            .append('circle')
            .attr('class', s => 'ring ' + s.key)
            .attr('data-r', s => s.r)
            .attr('r', 0)
            .attr('fill', s => s.fill)
            .attr('fill-opacity', s => s.fo)
            .attr('stroke', s => s.stroke)
            .attr('stroke-opacity', s => s.so)
            .attr('stroke-width', s => s.sw)
            .attr('vector-effect', s => s.sw > 0 ? 'non-scaling-stroke' : null)
            .transition().duration(350)
            .attr('r', s => s.r);

        // UPDATE
        rings.transition().duration(350)
            .attr('data-r', s => s.r)
            .attr('r', s => s.r)
            .attr('fill-opacity', s => s.fo)
            .attr('stroke', s => s.stroke)
            .attr('stroke-width', s => s.sw);

        // EXIT
        rings.exit()
            .transition().duration(250)
            .attr('r', 0)
            .style('opacity', 0)
            .remove();
    });

    // Hover + click HANDLER PER EACH QUAKE
    rowsAll
      .style('cursor', 'pointer')
      // Hover shows tooltip
      .on('mouseover', (event, d) => showTooltip(event, d))
      .on('mousemove', positionTooltip)
      .on('mouseout', hideTooltip)
      // Click opens detail panel
      .on('click', function(event, d) {
          event.stopPropagation();
          
          // Hide tooltip when clicking
          hideTooltip();
          
          if (selectedQuakeData === d) {
              // Clicking same quake - deselect
              closeQuakePanel();
          } else {
              // Select new quake
              showQuakePanel(d);
              gQuake.selectAll('g.quake')
                  .transition().duration(250)
                  .style('opacity', q => q === d ? 1 : 0.3);
          }
      });
    
    let selectedQuake = null;

    // rowsAll
    //     .style('cursor','pointer')
    //     .on('click', function(event, d) {
    //         if (selectedQuake === d) {
    //             // unselect
    //             selectedQuake = null;
    //             gQuake.selectAll('g.quake').transition().duration(250).style('opacity', 1);
    //             return;
    //         }

    //         selectedQuake = d;
    //         gQuake.selectAll('g.quake')
    //             .transition().duration(250)
    //             .style('opacity', q => q === d ? 1 : 0.2);
    //     });


    // Fade-in enter vis
    rowsEnter.select('g.rings')
        .attr('opacity', 0)
        .transition().duration(400)
        .attr('opacity', 1);

    adjustCircleSizes();
}

function adjustCircleSizes() {
    const factor = Math.pow(zoomK, RADIUS_ZOOM_EXP) / zoomK;
    d3.selectAll('circle.ring').each(function () {
        const base = +this.getAttribute('data-r') || 0;
        this.setAttribute('r', base * factor);
    });
}

// Tooltip section
function showTooltip(event, d) {
    const timeFmt = d3.timeFormat('%b %d, %Y %H:%M UTC'); //utc for now

    function badge(text, color, borderColor = '#000', textColor = '#111') {
        return `
      <div style="
        display:inline-block;
        padding:4px 7px;
        margin:3px 0;
        border-radius:6px;
        background:${color};
        border:1px solid ${borderColor};
        color:${textColor};
        font-size:12px;
      ">
        ${text}
      </div>
    `;
    }

    const lines = [];

    lines.push(`
      <div style="
        font-size:14px; 
        font-weight:600; 
        margin-bottom:6px; 
        border-bottom:1px solid #ddd; 
        padding-bottom:4px;
        cursor:pointer;
        color:#333;
      ">
        Click for more details
      </div>
    `);

    lines.push(`
    <div style="font-size:12px; color:#666; margin-bottom:4px;">
      ${d.time ? timeFmt(d.time) : ''}
    </div>
  `);

    if (d.sig != null) lines.push(badge(`Overall Significance: ${d.sig}`, COLORS.sig + '33', COLORS.sig));
    if (d.mag != null) lines.push(badge(`Magnitude: ${d.mag.toFixed(1)}`, COLORS.mag + '33', COLORS.mag));
    if (d.cdi != null) lines.push(badge(`CDI: ${d.cdi.toFixed(1)}`, COLORS.cdi + '33', COLORS.cdi));
    if (d.mmi != null) lines.push(badge(`MMI: ${d.mmi.toFixed(1)}`, COLORS.mmi + '33', COLORS.mmi));
    if (d.tsunami === 1) lines.push(badge('Tsunami', COLORS.tsunami + '33', COLORS.tsunami));
    if (d.depth != null) lines.push(badge(`Depth: ${d.depth.toFixed(0)} km`, '#e5e7eb', '#6b7280'));

    if (Number.isFinite(d.dmin) && d.dmin > 0 &&
        Number.isFinite(d.longitude) && Number.isFinite(d.latitude))  {

        const proj = currentBasemap && currentBasemap.projection;
        const kmPerDeg = 111.32;
        const dminDeg = d.dmin;
        const dminKm  = dminDeg * kmPerDeg;

        let pxPerDeg = 0;
        if (proj) {
            const lon = d.longitude;
            const lat = d.latitude;
            const delta = 0.03;
            const p0 = proj([lon, lat]);
            const p1 = proj([lon + delta, lat]);
            if (p0 && p1) {
                const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
                pxPerDeg = (dist / delta) * zoomK;
            }
        }
        if (!pxPerDeg || !Number.isFinite(pxPerDeg)) pxPerDeg = 5 * zoomK;

        let pxLenRaw = dminDeg * pxPerDeg;
        const shrink = 0.22;
        let pxLen = Math.max(0, Math.min(pxLenRaw * shrink, 180));
        const MIN_LEN = 3;
        const showTickOnly = (dminKm <= 0.5 || pxLen < MIN_LEN);

        let scaleSvg;
        if (showTickOnly) {
            scaleSvg = `
        <svg width="20" height="18" style="display:block; margin-top:4px;">
          <line x1="10" y1="5" x2="10" y2="15" stroke="#374151" stroke-width="2"/>
        </svg>
      `;
        } else {
            scaleSvg = `
        <svg width="${pxLen + 18}" height="18" style="display:block; margin-top:4px;">
          <line x1="4"  y1="10" x2="${pxLen + 12}" y2="10" stroke="#374151" stroke-width="2"/>
          <line x1="4" y1="5"  x2="4" y2="15" stroke="#374151" stroke-width="2"/>
          <line x1="${pxLen + 12}" y1="5" x2="${pxLen + 12}" y2="15" stroke="#374151" stroke-width="2"/>
        </svg>
      `;
        }

        lines.push(`
      <div style="margin:2px 0;">
        <div style="
          display:inline-block;
          padding:4px 7px 6px 7px;
          border-radius:6px;
          background:#f1f5f9;
          border:1px solid #94a3b8;
          color:#111827;
          font-size:12px;
        ">
          Nearest station: ${dminKm.toFixed(0)} km
          ${scaleSvg}
        </div>
      </div>
    `);
    }

    tip.classed('hidden', false).html(lines.join(''));
    positionTooltip(event);
}

function positionTooltip(event) {
    const xy = d3.pointer(event, svg.node());
    tip.style('left', (xy[0] + 12) + 'px').style('top',  (xy[1] - 40) + 'px');
}
function hideTooltip() { tip.classed('hidden', true); }

function fmtNA(v, p=1) { return (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(p); }

//  Legends
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

        let ticks;
        if (k === 'mag') {
            const [lo, hi] = scale.domain();
            // integers
            ticks = d3.ticks(Math.floor(lo), Math.ceil(hi), 4);
        } else {
            const [lo, hi] = scale.domain();
            // rounded  values
            ticks = d3.ticks(lo, hi, 4);
        }

        const rowLeft = 35;
        const spacingX = 53;
        const cy = 36;
        const valueY = 82;

        const svgL = block.append('svg')
            .attr('width', rowLeft + spacingX * (ticks.length - 1) + 80)
            .attr('height', 96);

        ticks.forEach((v, i) => {
            const r = scale(v) * factor;
            const cx = rowLeft + i * spacingX;

            svgL.append('circle')
                .attr('cx', cx)
                .attr('cy', cy)
                .attr('r', r)
                .attr('fill', meta.color)
                .attr('fill-opacity', k === 'mag' ? 0.55 :
                    k === 'cdi' ? 0.45 :
                        k === 'mmi' ? 0.35 : 0.75)
                .attr('stroke', '#000')
                .attr('stroke-opacity', 0.25);

            svgL.append('text')
                .attr('x', cx)
                .attr('y', valueY)
                .attr('text-anchor', 'middle')
                .attr('font-size', '11px')
                .attr('fill', '#9ca3af')
                .text(
                    k === 'mag'
                        ? d3.format('.0f')(v)
                        : (v >= 1000 ? d3.format('~s')(v) : d3.format('.0f')(v)) // 2.1k style when large
                );
        });
    });

    // Depth + tsunami legend
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

        const svgL = c.append('svg').attr('width', w).attr('height', h);
        depths.forEach((d, i) => {
            const cx = cx0 + i * spacing;
            svgL.append('circle')
                .attr('cx', cx).attr('cy', cyR).attr('r', rBase)
                .attr('fill', 'none').attr('stroke', COLORS.depthRing).attr('stroke-opacity', 0.9)
                .attr('stroke-width', depthStroke(d)).attr('vector-effect', 'non-scaling-stroke');
            svgL.append('text')
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
  
      const svgL = c.append('svg').attr('width', w).attr('height', h);
      svgL.append('circle')
          .attr('cx', cx)
          .attr('cy', cyR)
          .attr('r', r)
          .attr('fill', 'none')
          .attr('stroke', COLORS.tsunami)
          .attr('stroke-width', 1.5)
          .attr('vector-effect', 'non-scaling-stroke');
  })();
  
  // tectonic plate boundaries legend
  (function addPlateBoundariesRow() {
      const w = 220, h = 48, x1 = 20, x2 = 80, cy = 24;
  
      const c = sizeLegendDiv.append('div').style('margin', '8px 0 0 0');
      c.append('div')
          .style('margin-bottom', '6px')
          .style('color', '#6b7280')
          .style('font-size', '12px')
          .style('text-align', 'left')
          .text('Tectonic Plate Boundaries');
  
      const svgL = c.append('svg').attr('width', w).attr('height', h);
      svgL.append('line')
          .attr('x1', x1)
          .attr('y1', cy)
          .attr('x2', x2)
          .attr('y2', cy)
          .attr('stroke', '#6b7280')
          .attr('stroke-width', 1.5)
          .attr('stroke-opacity', 0.25)
          .attr('vector-effect', 'non-scaling-stroke');
  })();
    
}

//  Play loop FOR timeline
function togglePlay() {
    playing = !playing;
    btnPlay.textContent = playing ? 'Pause Timeline' : 'Play Timeline';
    if (playing) stepPlay();
}
function stepPlay() {
    if (!playing) return;
    if (!timeBuckets.length) { playing = false; btnPlay.textContent = 'Play Timeline'; return; }
    let next = timeIndex + 1;
    if (next >= timeBuckets.length) next = 0;
    setTimeSlider(next);
    applyFiltersAndRender();
    setTimeout(stepPlay, 900);
}

// detailed quake sidepanel funcs

///////////
function showQuakePanel(d) {
  if (!quakeDetailPanel) return;
  
  selectedQuakeData = d;
  
  const content = d3.select('#panelContent');
  content.selectAll('*').remove();
  
  // Helper: earthquake classification
  function getEarthquakeClass(mag) {
    if (!mag) return null;
    if (mag >= 8.0) return { label: 'Great', color: '#dc2626', desc: 'Can cause serious damage in areas several hundred miles across' };
    if (mag >= 7.0) return { label: 'Major', color: '#ea580c', desc: 'May cause serious damage over larger areas' };
    if (mag >= 6.0) return { label: 'Strong', color: '#f59e0b', desc: 'Can cause damage in areas up to 100 miles across' };
    if (mag >= 5.0) return { label: 'Moderate', color: '#eab308', desc: 'Can cause damage to poorly constructed buildings' };
    return { label: 'Light to Minor', color: '#84cc16', desc: 'Little to no damage expected' };
  }
  
  const eqClass = getEarthquakeClass(d.mag);
  
  // Title section with classification
  const titleSec = content.append('div').attr('class', 'detail-section');
  titleSec.append('div').attr('class', 'detail-title').text(d.place || 'Earthquake Event');
  
  if (d.year && d.month) {
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    titleSec.append('div').attr('class', 'detail-meta')
      .text(`${monthNames[d.month - 1]} ${d.year}`);
  } else if (d.year) {
    titleSec.append('div').attr('class', 'detail-meta').text(`Year: ${d.year}`);
  } else {
    titleSec.append('div').attr('class', 'detail-meta').text('Date unknown');
  }
  
  // Earthquake classification badge
  if (eqClass) {
    const classBadge = titleSec.append('div')
      .style('margin-top', '8px')
      .style('padding', '8px 12px')
      .style('background', eqClass.color + '11')
      .style('border', `2px solid ${eqClass.color}`)
      .style('border-radius', '8px');
    
    classBadge.append('div')
      .style('font-weight', '700')
      .style('color', eqClass.color)
      .style('font-size', '14px')
      .text(`${eqClass.label} Earthquake`);
    
    classBadge.append('div')
      .style('font-size', '12px')
      .style('color', '#64748b')
      .style('margin-top', '2px')
      .text(eqClass.desc);
  }
  
  // Overall Significance section
  if (d.sig != null) {
    const sigSec = content.append('div').attr('class', 'detail-section');
    sigSec.append('h3')
      .style('font-size', '14px')
      .style('font-weight', '600')
      .style('margin-bottom', '8px')
      .style('color', '#475569')
      .text('Overall Significance');
    
    const sigBox = sigSec.append('div')
      .style('padding', '12px')
      .style('background', COLORS.sig + '11')
      .style('border', `2px solid ${COLORS.sig}`)
      .style('border-radius', '8px')
      .style('text-align', 'center');
    
    sigBox.append('div')
      .style('font-size', '32px')
      .style('font-weight', '700')
      .style('color', COLORS.sig)
      .text(d.sig);
    
    sigBox.append('div')
      .style('font-size', '12px')
      .style('color', '#64748b')
      .style('margin-top', '4px')
      .text('Composite score based on magnitude, location, and impact. Higher values indicate greater significance.');
  }
  
  // Intensity Measurements
  const intensitySec = content.append('div').attr('class', 'detail-section');
  intensitySec.append('h3')
    .style('font-size', '14px')
    .style('font-weight', '600')
    .style('margin-bottom', '12px')
    .style('color', '#475569')
    .text('Intensity Measurements');
  
  const grid = intensitySec.append('div').attr('class', 'detail-grid');
  
  // Magnitude
  const magItem = grid.append('div').attr('class', 'detail-item')
    .style('background', COLORS.mag + '11')
    .style('border-color', COLORS.mag + '33');
  magItem.append('div').attr('class', 'detail-item-label').text('Magnitude (Richter)');
  magItem.append('div').attr('class', 'detail-item-value')
    .style('color', COLORS.mag)
    .text(d.mag != null ? d.mag.toFixed(1) : 'N/A');
  magItem.append('div')
    .style('font-size', '10px')
    .style('color', '#64748b')
    .style('margin-top', '4px')
    .text('Energy released by the earthquake');
  
  // CDI
  const cdiItem = grid.append('div').attr('class', 'detail-item')
    .style('background', COLORS.cdi + '11')
    .style('border-color', COLORS.cdi + '33');
  cdiItem.append('div').attr('class', 'detail-item-label').text('CDI (Felt Intensity)');
  cdiItem.append('div').attr('class', 'detail-item-value')
    .style('color', COLORS.cdi)
    .text(d.cdi != null ? d.cdi.toFixed(1) : 'N/A');
  cdiItem.append('div')
    .style('font-size', '10px')
    .style('color', '#64748b')
    .style('margin-top', '4px')
    .text('How strongly people felt it (1-10 scale)');
  
  // MMI
  const mmiItem = grid.append('div').attr('class', 'detail-item')
    .style('background', COLORS.mmi + '11')
    .style('border-color', COLORS.mmi + '33');
  mmiItem.append('div').attr('class', 'detail-item-label').text('MMI (Damage Intensity)');
  mmiItem.append('div').attr('class', 'detail-item-value')
    .style('color', COLORS.mmi)
    .text(d.mmi != null ? d.mmi.toFixed(1) : 'N/A');
  mmiItem.append('div')
    .style('font-size', '10px')
    .style('color', '#64748b')
    .style('margin-top', '4px')
    .text('Structural damage observed (1-10 scale)');
  
  // Data Quality section
  if (d.nst != null || d.gap != null) {
    const qualitySec = content.append('div').attr('class', 'detail-section');
    qualitySec.append('h3')
      .style('font-size', '14px')
      .style('font-weight', '600')
      .style('margin-bottom', '12px')
      .style('color', '#475569')
      .text('Data Quality');
    
    const qualityGrid = qualitySec.append('div').attr('class', 'detail-grid');
    
    if (d.nst != null) {
      const nstItem = qualityGrid.append('div').attr('class', 'detail-item');
      nstItem.append('div').attr('class', 'detail-item-label').text('Seismic Stations');
      nstItem.append('div').attr('class', 'detail-item-value').text(d.nst);
      nstItem.append('div')
        .style('font-size', '10px')
        .style('color', '#64748b')
        .style('margin-top', '4px')
        .text('Number of stations that detected this event');
    }
    
    if (d.gap != null) {
      const gapItem = qualityGrid.append('div').attr('class', 'detail-item');
      gapItem.append('div').attr('class', 'detail-item-label').text('Azimuthal Gap');
      gapItem.append('div').attr('class', 'detail-item-value').text(d.gap + '°');
      gapItem.append('div')
        .style('font-size', '10px')
        .style('color', '#64748b')
        .style('margin-top', '4px')
        .text('Smaller gap = better location accuracy');
    }
  }
  
  // Location section
  const locSec = content.append('div').attr('class', 'detail-section');
  locSec.append('h3')
    .style('font-size', '14px')
    .style('font-weight', '600')
    .style('margin-bottom', '12px')
    .style('color', '#475569')
    .text('Location Details');
  
  const locGrid = locSec.append('div').attr('class', 'detail-grid');
  
  const depthItem = locGrid.append('div').attr('class', 'detail-item');
  depthItem.append('div').attr('class', 'detail-item-label').text('Depth');
  depthItem.append('div').attr('class', 'detail-item-value')
    .text(d.depth != null ? d.depth.toFixed(0) + ' km' : 'N/A');
  depthItem.append('div')
    .style('font-size', '10px')
    .style('color', '#64748b')
    .style('margin-top', '4px')
    .text(d.depth != null && d.depth < 70 ? 'Shallow earthquake' : 
          d.depth != null && d.depth < 300 ? 'Intermediate depth' : 
          d.depth != null ? 'Deep earthquake' : '');
  
  const coordItem = locGrid.append('div').attr('class', 'detail-item');
  coordItem.append('div').attr('class', 'detail-item-label').text('Coordinates');
  coordItem.append('div').attr('class', 'detail-item-value')
    .style('font-size', '13px')
    .text(`${d.latitude.toFixed(2)}°, ${d.longitude.toFixed(2)}°`);
  
  // Nearest station
  if (d.dmin != null) {
    const dminItem = locGrid.append('div').attr('class', 'detail-item');
    dminItem.append('div').attr('class', 'detail-item-label').text('Nearest Station');
    dminItem.append('div').attr('class', 'detail-item-value')
      .style('font-size', '15px')
      .text((d.dmin * 111.32).toFixed(0) + ' km');
    dminItem.append('div')
      .style('font-size', '10px')
      .style('color', '#64748b')
      .style('margin-top', '4px')
      .text('Distance to closest seismic monitoring station');
  }
  
  // Tsunami badge
  if (d.tsunami === 1) {
    const tsuSec = content.append('div').attr('class', 'detail-section');
    const badge = tsuSec.append('div')
      .style('padding', '12px')
      .style('background', COLORS.tsunami + '11')
      .style('border', `2px solid ${COLORS.tsunami}`)
      .style('border-radius', '8px')
      .style('text-align', 'center');
    badge.append('div')
      .style('font-size', '16px')
      .style('font-weight', '700')
      .style('color', COLORS.tsunami)
      .text('🌊 Tsunami Generated');
    badge.append('div')
      .style('font-size', '13px')
      .style('color', '#475569')
      .style('margin-top', '4px')
      .text('This earthquake triggered a tsunami wave');
  }
  
  quakeDetailPanel.classList.remove('hidden');
}

function closeQuakePanel() {
  if (quakeDetailPanel) {
      quakeDetailPanel.classList.add('hidden');
      selectedQuakeData = null;
      gQuake.selectAll('g.quake').transition().duration(250).style('opacity', 1);
  }
}

// Backgrounds 
function drawBackgrounds() {
    const v = viewportSize();

    // Deep navy canvas
    gBackground.selectAll('rect.bg').data([1])
        .join('rect')
        .attr('class','bg')
        .attr('x', -v.w).attr('y', -v.h)
        .attr('width', v.w*3).attr('height', v.h*3)
        .attr('fill', NAVY_BG);

    // Ocean oval ONLY for world view
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
        .attr('fill', '#93c5fd');
}

// Draw wrapper
function drawAll() { drawBackgrounds(); drawQuakes(); }

//  Intro overlay
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
          <radialGradient id="pulse" fx="50%">
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

        overlay.style.transition = 'opacity .35s ease';
        overlay.style.opacity = '0';

        const overallRadio = document.querySelector('input[value="overall"]');
        if (overallRadio) overallRadio.checked = true;

        setTimeSlider(-1);
        applyFiltersAndRender();
        renderLegend();

        setTimeout(() => overlay.remove(), 380);
    });
}

// Story section

// Global story state
let storyRunning = false;
let storyPaused = false;
let storyEndRequested = false;
let storyJumpRequested = false;
let storyStepIndex = 0;

// Predefined major events
const STORY_STEPS = [
  {
    year: 2001,
    title: '2001 Gujarat, India (Mw 7.7)',
    lon: 70.326, lat: 23.388, k: 6.5,
    html: `<b>Gujarat (Bhuj)</b>: at least ~20,000 deaths; widespread collapse across Kutch and beyond. Source: U.S. Geological Survey (USGS).`,
  },
  {
    year: 2004,
    title: '2004 Sumatra–Andaman (Mw 9.1)',
    lon: 95.85, lat: 3.32, k: 5.8,
    html: `<b>Indian Ocean tsunami</b>: one of the deadliest disasters on record; waves &gt;30 m; ~230k fatalities. Source: USGS.`,
  },
  {
    year: 2008,
    title: '2008 Wenchuan (Sichuan), China (Mw 7.9)',
    lon: 103.4, lat: 31.0, k: 6.6,
    html: `<b>Wenchuan quake</b>: ~87,000 dead or missing; massive landslides and school collapses. Source: USGS.`,
  },
  {
    year: 2010,
    title: '2010 Haiti (Mw 7.0)',
    lon: -72.533, lat: 18.457, k: 7.2,
    html: `<b>Port-au-Prince area</b>: catastrophic damage; death toll in the hundreds of thousands. Source: USGS.`,
  },
  {
    year: 2011,
    title: '2011 Tōhoku, Japan (Mw 9.1)',
    lon: 142.372, lat: 38.297, k: 6.2,
    html: `<b>Great East Japan Earthquake & Tsunami</b>: ~20k dead/missing; Fukushima crisis. Source: USGS.`,
  },
  {
    year: 2015,
    title: '2015 Gorkha, Nepal (Mw 7.8)',
    lon: 84.73, lat: 28.23, k: 6.8,
    html: `<b>Kathmandu Valley</b>: widespread destruction; ~10k fatalities. Source: USGS.`,
  },
  {
    year: 2018,
    title: '2018 Sulawesi (Palu), Indonesia (Mw 7.5)',
    lon: 119.84, lat: -0.178, k: 7.0,
    html: `<b>Palu Bay</b>: destructive tsunami and extensive liquefaction; thousands killed. Source: NOAA/USGS.`,
  },
];

// UI STORY

function addPlayStoryButton() {
  const container = document.querySelector('main#viz');
  if (!container) return;

  // Play Story button
  const btn = document.createElement('button');
  btn.id = 'btnPlayStory';
  btn.textContent = '▶ Play Story - Major Earthquakes';
  Object.assign(btn.style, {
    position: 'absolute',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 12,
    padding: '14px 22px',
    borderRadius: '999px',
    border: '1px solid #c7d2fe',
    background: 'linear-gradient(90deg, #e0e7ff, #f5d0fe)',
    color: '#111827',
    fontWeight: 800,
    fontSize: '16px',
    letterSpacing: '.2px',
    cursor: 'pointer',
    boxShadow: '0 10px 24px rgba(59,130,246,0.18), inset 0 0 8px rgba(255,255,255,0.6)',
    textShadow: '0 1px 0 rgba(255,255,255,0.6)'
  });
  btn.addEventListener('mouseenter', () => {
    btn.style.boxShadow = '0 14px 30px rgba(59,130,246,0.25), inset 0 0 10px rgba(255,255,255,0.7)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.boxShadow = '0 10px 24px rgba(59,130,246,0.18), inset 0 0 8px rgba(255,255,255,0.6)';
  });
  btn.addEventListener('click', () => {
    if (!storyRunning) {
      playStory();
    } else {
      // toggle pause when already running
      storyPaused = !storyPaused;
      updateStoryButtons();
    }
  });
  container.appendChild(btn);

  // Story note container 
  // top, with Pause / Next / End / progress bar
  const note = document.createElement('div');
  note.id = 'storyNote';
  Object.assign(note.style, {
    position: 'absolute',
    left: '50%',
    top: '64px',
    transform: 'translateX(-50%)',
    maxWidth: '900px',
    padding: '16px 18px',
    borderRadius: '14px',
    border: '1px solid #cbd5e1',
    background: 'rgba(255,255,255,0.98)',
    color: '#0f172a',
    fontSize: '16px',
    lineHeight: 1.45,
    boxShadow: '0 12px 26px rgba(0,0,0,0.12)',
    zIndex: 11,
    display: 'none'
  });

  note.innerHTML = `
    <div id="storyTitle" style="font-weight:800; font-size:18px; margin-bottom:6px;"></div>
    <div id="storyText" style="margin-bottom:10px;"></div>
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
      <button id="storyPauseBtn" style="
        padding:6px 10px; border-radius:8px; border:1px solid #cbd5e1;
        background:#f8fafc; cursor:pointer; font-weight:700;
      ">Pause</button>
      <button id="storyNextBtn" style="
        padding:6px 10px; border-radius:8px; border:1px solid #cbd5e1;
        background:#eef2ff; cursor:pointer; font-weight:700;
      ">Next earthquake</button>
      <button id="storyEndBtn" style="
        padding:6px 10px; border-radius:8px; border:1px solid #fecaca;
        background:#fee2e2; cursor:pointer; font-weight:700; color:#991b1b;
      ">End story</button>
      <div style="flex:1; min-width:140px; height:10px; background:#e5e7eb; border-radius:999px; overflow:hidden; border:1px solid #cbd5e1;">
        <div id="storyProgress" style="height:100%; width:0%; background:linear-gradient(90deg,#3b82f6,#a855f7)"></div>
      </div>
    </div>
  `;
  container.appendChild(note);

  // Wire up the small buttons
  const pauseBtn = note.querySelector('#storyPauseBtn');
  const nextBtn  = note.querySelector('#storyNextBtn');
  const endBtn   = note.querySelector('#storyEndBtn');

  pauseBtn.addEventListener('click', () => {
    if (!storyRunning) return;
    storyPaused = !storyPaused;
    updateStoryButtons();
  });

  nextBtn.addEventListener('click', () => {
    if (!storyRunning) return;
    // current step to finish early, advance to next
    storyJumpRequested = true;
  });

  endBtn.addEventListener('click', () => {
    if (!storyRunning) return;
    // request a hard stop; playStory uses to fully exit
    storyEndRequested = true;
  });

  updateStoryButtons();
}

function updateStoryButtons() {
  const bigBtn   = document.getElementById('btnPlayStory');
  const pauseBtn = document.getElementById('storyPauseBtn');
  const nextBtn  = document.getElementById('storyNextBtn');
  const endBtn   = document.getElementById('storyEndBtn');

  if (bigBtn) {
    if (!storyRunning) {
      bigBtn.textContent = '▶ Play Story - Major Earthquakes';
    } else if (storyPaused) {
      bigBtn.textContent = '⏸ Story Paused - Click to Resume';
    } else {
      bigBtn.textContent = '⏯ Story Playing - Click to Pause';
    }
  }

  if (pauseBtn) {
    pauseBtn.textContent = storyPaused ? 'Resume' : 'Pause';
    pauseBtn.disabled = !storyRunning;
  }
  if (nextBtn) {
    nextBtn.disabled = !storyRunning;
  }
  if (endBtn) {
    endBtn.disabled = !storyRunning;
  }
}

function showStoryNote(title, html) {
  const note = document.getElementById('storyNote');
  if (!note) return;
  const titleDiv = note.querySelector('#storyTitle');
  const textDiv  = note.querySelector('#storyText');
  if (titleDiv) titleDiv.textContent = title || '';
  if (textDiv)  textDiv.innerHTML = html || '';
  note.style.display = 'block';
  note.style.opacity = '0';
  note.style.transition = 'opacity .25s ease';
  requestAnimationFrame(() => { note.style.opacity = '1'; });
}
function hideStoryNote() {
  const note = document.getElementById('storyNote');
  if (!note) return;
  note.style.transition = 'opacity .25s ease';
  note.style.opacity = '0';
  setTimeout(() => { note.style.display = 'none'; }, 250);
}

function setProgress(pct) {
  const bar = document.getElementById('storyProgress');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// Story helper funcs

function clearStoryHighlight() {
  gStory.selectAll('*').interrupt().remove();
}

// Find the nearest recorded quake to a lon/lat
// prefernecing same year if avail
function findNearestQuake(lon, lat, year) {
  const dist2 = (aLon, aLat, bLon, bLat) => {
    const dx = (aLon - bLon);
    const dy = (aLat - bLat);
    return dx*dx + dy*dy;
  };
  let pool = quakes;
  if (year != null) {
    const byYear = quakes.filter(q => q.year === year);
    if (byYear.length) pool = byYear;
  }
  let best = null, bestD = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const q = pool[i];
    const d = dist2(lon, lat, q.longitude, q.latitude);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

// Compute base radius
function baseRadiusForQuake(d) {
  const useOverall = (document.querySelector('input[name="sizeMode"]:checked')?.value === 'overall');
  if (useOverall) {
    return sizeScale_sig(d.sig ?? 0);
  }
  let rMag = chkMag.checked ? sizeScale_mag(d.mag ?? 0) : 0;
  let rCDI = chkCDI.checked ? sizeScale_cdi(d.cdi ?? 0) : 0;
  let rMMI = chkMMI.checked ? sizeScale_mmi(d.mmi ?? 0) : 0;
  if (!chkMag.checked && !chkCDI.checked && !chkMMI.checked) {
    rMag = sizeScale_mag(d.mag ?? 0);
  }
  return Math.max(rMag || 0, rCDI || 0, rMMI || 0) || sizeScale_mag(d.mag ?? 0);
}

// Draws a pulsing highlight at a given quake with overlay, scales with zoom. 
// Returns a cleanup.
function drawHighlightForQuake(q) {
  clearStoryHighlight();

  const proj = currentBasemap.projection;
  const pt = proj([q.longitude, q.latitude]);
  if (!pt) return () => {};

  const factor = Math.pow(zoomK, RADIUS_ZOOM_EXP) / zoomK;
  const rBase = baseRadiusForQuake(q);
  const r = Math.max(6, rBase * factor * 1.6);

  const halo = gStory.append('circle')
    .attr('class', 'ring story-halo')
    .attr('data-r', rBase * 1.6)
    .attr('cx', pt[0]).attr('cy', pt[1])
    .attr('r', r)
    .attr('fill', COLORS.highlight + '22')
    .attr('stroke', COLORS.highlight)
    .attr('stroke-width', 4)
    .attr('stroke-opacity', 0.7);

  const pulse = gStory.append('circle')
    .attr('class', 'ring story-highlight')
    .attr('data-r', rBase * 1.9)
    .attr('cx', pt[0]).attr('cy', pt[1])
    .attr('r', Math.max(8, r * 1.1))
    .attr('fill', 'none')
    .attr('stroke', COLORS.highlight)
    .attr('stroke-width', 2.5)
    .attr('stroke-opacity', 0.95);

  function loop() {
    pulse
      .attr('stroke-opacity', 0.95)
      .attr('r', Math.max(10, r * 1.1))
      .transition().duration(900).ease(d3.easeCubicOut)
      .attr('r', Math.max(16, r * 1.8))
      .attr('stroke-opacity', 0.05)
      .on('end', () => {
        if (!storyRunning || storyEndRequested) return;
        loop();
      });
  }
  loop();

  adjustCircleSizes();
  return () => clearStoryHighlight();
}

// Smooth zoom to lon/lat with given scale
function flyTo(lon, lat, k = 6, duration = 1600) {
  const v = viewportSize();
  const pt = currentBasemap.projection([lon, lat]);
  const t = d3.zoomIdentity
    .translate(v.w / 2, v.h / 2)
    .scale(k)
    .translate(-pt[0], -pt[1]);
  return new Promise(resolve => {
    svg.transition().duration(duration).ease(d3.easeCubicInOut)
      .call(zoom.transform, t)
      .on('end', () => resolve());
  });
}

// Wait with progress bar, respecting pause, end, and next-step jump
function waitWithProgress(totalMs) {
  return new Promise(resolve => {
    const start = performance.now();
    let last = start;
    let pausedOffset = 0;

    function tick(now) {
      if (storyEndRequested || storyJumpRequested) {
        setProgress(100);
        return resolve();
      }
      if (!storyRunning) {
        // story was externally ended
        setProgress(0);
        return resolve();
      }

      const dt = now - last;
      last = now;

      if (storyPaused) {
        pausedOffset += dt;
        requestAnimationFrame(tick);
        return;
      }

      const elapsed = now - start - pausedOffset;
      const pct = Math.min(1, elapsed / totalMs);
      setProgress(pct * 100);

      if (pct >= 1) {
        return resolve();
      }
      requestAnimationFrame(tick);
    }
    setProgress(0);
    requestAnimationFrame(tick);
  });
}

// Cleanly end story and reset state so it can be replayed
function endStory(resetView = true) {
  clearStoryHighlight();
  hideStoryNote();
  setProgress(0);

  storyRunning = false;
  storyPaused = false;
  storyEndRequested = false;
  storyJumpRequested = false;
  storyStepIndex = 0;

  updateStoryButtons();

  if (resetView) {
    // simple reset back to world view
    resetZoom(400);
    updateZoomUI();
  }
}

// ---------- Main story coroutine ----------

async function playStory() {
  if (storyRunning) return;

  storyRunning = true;
  storyPaused = false;
  storyEndRequested = false;
  storyJumpRequested = false;
  storyStepIndex = 0;
  updateStoryButtons();

  // Use overall mode & full time range for consistency
  setTimeSlider(-1);
  const overallRadio = document.querySelector('input[value="overall"]');
  if (overallRadio) overallRadio.checked = true;
  applyFiltersAndRender();
  renderLegend();

  const FLY_MS   = 1000;
  const DWELL_MS = 7000;

  try {
    // Gentle world reset first
    await flyTo(0, 20, 1.2, 900);
    if (storyEndRequested) return endStory(true);
    await waitWithProgress(800);
    if (storyEndRequested) return endStory(true);

    for (storyStepIndex = 0; storyStepIndex < STORY_STEPS.length; storyStepIndex++) {
      const s = STORY_STEPS[storyStepIndex];
      storyJumpRequested = false; // clear jump flag at start of each step

      if (storyEndRequested) break;

      await flyTo(s.lon, s.lat, s.k, FLY_MS);
      if (storyEndRequested) break;

      const q = findNearestQuake(s.lon, s.lat, s.year) || {
        longitude: s.lon, latitude: s.lat, mag: null, sig: null
      };

      drawHighlightForQuake(q);
      showStoryNote(s.title, s.html);

      await waitWithProgress(DWELL_MS);
      clearStoryHighlight();

      if (storyEndRequested) break;
      // if storyJumpRequested was set, move to next iteration
    }

    // Finish: fall through to endStory
    endStory(true);
  } catch (e) {
    // In case of any unexpected error, ensure we reset state
    console.error('Story mode error:', e);
    endStory(true);
  }
}


