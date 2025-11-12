/* global d3, topojson */

// file paths
const FILES = {
    world: 'data/world_lowres.json',
    na: 'data/NA_lowres.json',
    quakes: 'data/earthquake_data_tsunami.csv'
};

// sizes and colors
const SIZE = { minPx: 2.2, maxPx: 20 };
const COLORS = {
    mag: '#1b9e77',
    cdi: '#d95f02',
    mmi: '#7570b3',
    sig: '#e7298a'
};

// projections
const WORLD_INIT = { type: 'world', projection: d3.geoNaturalEarth1() };
const NA_INIT = { type: 'na', projection: d3.geoAlbers().parallels([29.5, 45.5]).rotate([98, 0]).center([0, 38]) };

// app state
let currentBasemap = WORLD_INIT;
let quakes = [];
let filtered = [];
let timeIndex = 0;
let timeBuckets = [];
let playing = false;
/* default = YEARLY */
let windowMode = 'year';

let sizeScale_mag, sizeScale_cdi, sizeScale_mmi, sizeScale_sig;
let depthShade;

const svg = d3.select('#map');

/* Draw order: plates (back), land, quakes (top) */
const gRoot   = svg.append('g').attr('class', 'root');
const gPlates = gRoot.append('g').attr('class', 'plates');
const gLand   = gRoot.append('g').attr('class', 'land');
const gQuake  = gRoot.append('g').attr('class', 'quakes');

const tip = d3.select('#tooltip');

// layout helpers
function viewportSize() {
    const panel = document.querySelector('aside#controls');
    const panelW = panel ? panel.getBoundingClientRect().width : 320;
    const w = Math.max(480, window.innerWidth - panelW - 16);
    const h = Math.max(420, window.innerHeight - 0);
    return { w: w, h: h };
}

function resize() {
    const v = viewportSize();
    svg.attr('width', v.w).attr('height', v.h);
    setZoomExtents();
}

window.addEventListener('resize', function () {
    resize();
    drawAll();
});

/* ---------- Zoom & Pan + Buttons + Status ---------- */
let zoomK = 1; // current zoom scale
const ZOOM_MIN = 1;
const ZOOM_MAX = 12;

const zoom = d3.zoom()
    .scaleExtent([ZOOM_MIN, ZOOM_MAX])
    .on('zoom', (event) => {
        zoomK = event.transform.k;
        gRoot.attr('transform', event.transform);
        adjustCircleSizes();
        updateZoomUI();
    });

function setZoomExtents() {
    const v = viewportSize();
    zoom.extent([[0, 0], [v.w, v.h]]);
    zoom.translateExtent([[-v.w, -v.h], [v.w * 2, v.h * 2]]);
}

function resetZoom(duration = 300) {
    svg.transition().duration(duration).call(zoom.transform, d3.zoomIdentity);
}

setZoomExtents();
svg.call(zoom);

// zoom buttons & status
const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomResetBtn = document.getElementById('zoomReset');
const zoomStatus = document.getElementById('zoomStatus');

zoomInBtn.addEventListener('click', () => {
    svg.transition().duration(200).call(zoom.scaleBy, 1.3);
});
zoomOutBtn.addEventListener('click', () => {
    svg.transition().duration(200).call(zoom.scaleBy, 1/1.3);
});
zoomResetBtn.addEventListener('click', () => {
    // Fit to world view
    loadBasemap(WORLD_INIT);
    resetZoom(250);
    drawAll();
});

function updateZoomUI() {
    const atMin = zoomK <= ZOOM_MIN + 1e-6;
    const atMax = zoomK >= ZOOM_MAX - 1e-6;
    zoomInBtn.disabled = atMax;
    zoomOutBtn.disabled = atMin;
    zoomStatus.textContent = `${zoomK.toFixed(1)}×${atMax ? ' (max)' : atMin ? ' (min)' : ''}`;
}

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
    comboMetricsGroup.style.display = (checked && checked.value === 'combo') ? 'block' : 'none';
}
for (let sm = 0; sm < sizeModeInputs.length; sm++) {
    sizeModeInputs[sm].addEventListener('change', function () {
        updateComboMetricsVisibility();
        applyFiltersAndRender();
    });
}
updateComboMetricsVisibility();

// checkbox handlers
const showChecks = [chkMag, chkCDI, chkMMI];
for (let sc = 0; sc < showChecks.length; sc++) {
    showChecks[sc].addEventListener('change', function () {
        applyFiltersAndRender();
    });
}

// optional depth range slider (no-op if not present)
function initDepthRangeSlider() {
    if (typeof d3.sliderBottom !== 'function') return;
    const container = d3.select('#depthRangeSlider');
    if (container.empty()) return;

    depthRangeSlider = d3.sliderBottom()
        .min(0).max(700).width(220).ticks(6)
        .default([depthRangeMinValue, depthRangeMaxValue])
        .fill("#1b9e77")
        .on("onchange", function(val) {
            depthRangeMinValue = Math.min(val[0], val[1]);
            depthRangeMaxValue = Math.max(val[0], val[1]);
            if (depthRangeMinVal) depthRangeMinVal.textContent = Math.round(depthRangeMinValue);
            if (depthRangeMaxVal) depthRangeMaxVal.textContent = Math.round(depthRangeMaxValue);
        });

    container.attr("width", 250).attr("height", 60)
        .append("g").attr("transform", "translate(15,15)")
        .call(depthRangeSlider);

    if (depthRangeMinVal) depthRangeMinVal.textContent = Math.round(depthRangeMinValue);
    if (depthRangeMaxVal) depthRangeMaxVal.textContent = Math.round(depthRangeMaxValue);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDepthRangeSlider); else initDepthRangeSlider();

// filter handlers
depthMin.addEventListener('input', function () { depthMinVal.textContent = depthMin.value; applyFiltersAndRender(); });
depthMax.addEventListener('input', function () { depthMaxVal.textContent = depthMax.value; applyFiltersAndRender(); });
magMin.addEventListener('input', function () { magMinVal.textContent = (+magMin.value).toFixed(1); applyFiltersAndRender(); });
magMax.addEventListener('input', function () { magMaxVal.textContent = (+magMax.value).toFixed(1); applyFiltersAndRender(); });
onlyTsunami.addEventListener('input', applyFiltersAndRender);

btnClearFilters.addEventListener('click', function () {
    depthMin.value = 0; depthMax.value = 700; depthMinVal.textContent = '0'; depthMaxVal.textContent = '700';
    depthRangeMinValue = 0; depthRangeMaxValue = 700;
    if (depthRangeSlider) depthRangeSlider.value([depthRangeMinValue, depthRangeMaxValue]);
    if (depthRangeMinVal) depthRangeMinVal.textContent = '0';
    if (depthRangeMaxVal) depthRangeMaxVal.textContent = '700';
    magMin.value = 0; magMax.value = 10; magMinVal.textContent = '0.0'; magMaxVal.textContent = '10.0';
    onlyTsunami.checked = false;
    applyFiltersAndRender();
});

// map view buttons
btnWorld.addEventListener('click', function () { loadBasemap(WORLD_INIT); resetZoom(); drawAll(); });
btnNA   .addEventListener('click', function () { loadBasemap(NA_INIT);    resetZoom(); drawAll(); });

// timeline controls (play loops to start when reaching end)
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
    } else {
        setTimeSlider(0); // jump to start if at end
        applyFiltersAndRender();
    }
});
btnPlay.addEventListener('click', function () { togglePlay(); });
btnShowAll.addEventListener('click', function () { setTimeSlider(-1); applyFiltersAndRender(); });

// load data
Promise.all([
    d3.json(FILES.world),
    d3.json(FILES.na),
    d3.csv(FILES.quakes, autoTypeQuake),
    d3.json('https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json').catch(function(err) {
        console.warn('Could not load tectonic plate data:', err);
        return null;
    })
]).then(function (all) {
    const world = all[0], na = all[1], rows = all[2], plates = all[3];

    quakes = rows.filter(d => Number.isFinite(d.latitude) && Number.isFinite(d.longitude));
    initScales();

    WORLD_INIT.feature = toGeo(world);
    NA_INIT.feature = toGeo(na);
    if (plates && plates.features) { WORLD_INIT.plates = plates; NA_INIT.plates = plates; }

    loadBasemap(WORLD_INIT);

    bucketByTime();
    /* CHANGE: start with ALL time periods visible */
    setTimeSlider(-1);

    resize();
    applyFiltersAndRender();
    renderLegend();

    resetZoom(0);
    updateZoomUI();
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

// parse csv row
function autoTypeQuake(d) {
    let yy = parseInt(d.Year, 10);
    let mm = parseInt(d.Month, 10);
    if (!isFinite(yy)) yy = null;
    if (!isFinite(mm)) mm = null;

    let magVal = null;
    if (isFinite(+d.magnitude)) magVal = +d.magnitude;
    else if (isFinite(+d.mag)) magVal = +d.mag;

    return {
        year: yy, month: mm,
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

// topojson → geojson
function toGeo(obj) {
    if (obj.type === 'FeatureCollection') return obj;
    const k = Object.keys(obj.objects)[0];
    return topojson.feature(obj, obj.objects[k]);
}

// basemap
function loadBasemap(target) {
    currentBasemap = target;

    const v = viewportSize();
    svg.attr('width', v.w).attr('height', v.h);

    if (currentBasemap && currentBasemap.feature) {
        currentBasemap.projection.fitSize([v.w, v.h], currentBasemap.feature);
    }

    const feats = (currentBasemap && currentBasemap.feature && currentBasemap.feature.features) ? currentBasemap.feature.features : [];
    const pathGen = d3.geoPath(currentBasemap.projection);

    // plates BEHIND land, subtle
    if (currentBasemap.plates && currentBasemap.plates.features) {
        const plateFeatures = currentBasemap.plates.features;
        gPlates.selectAll('path.plate-boundary')
            .data(plateFeatures, (d, i) => d.id || i)
            .join(
                enter => enter.append('path')
                    .attr('class', 'plate-boundary')
                    .attr('fill', 'none')
                    .attr('stroke', '#6b7280')        // gray-500
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

    // land
    gLand.selectAll('path.country')
        .data(feats, d => (d.id || (d.properties && (d.properties.adm0_a3 || d.properties.name))))
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
}

// time bucketting
function bucketByTime() {
    const usable = [];
    for (let i = 0; i < quakes.length; i++) {
        const q = quakes[i];
        if (windowMode === 'month') {
            if (q.year != null && q.month != null && q.month >= 1 && q.month <= 12) usable.push(q);
        } else {
            if (q.year != null) usable.push(q);
        }
    }

    const groups = {};
    let key;
    if (windowMode === 'month') {
        for (let j = 0; j < usable.length; j++) {
            const r = usable[j];
            const mm = (r.month < 10 ? '0' + r.month : '' + r.month);
            key = r.year + '-' + mm;
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        }
    } else {
        for (let k = 0; k < usable.length; k++) {
            const r2 = usable[k];
            key = '' + r2.year;
            if (!groups[key]) groups[key] = [];
            groups[key].push(r2);
        }
    }

    const keys = Object.keys(groups);
    keys.sort(function (a, b) {
        if (windowMode === 'month') {
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
            label = monthNames[m - 1] + ' ' + y;
        } else {
            label = kstr;
        }
        buckets.push({ key: kstr, label: label, values: groups[kstr] });
    }

    timeBuckets = buckets;

    const hasBuckets = timeBuckets.length > 1;
    timeSlider.disabled = !hasBuckets;
    btnPrev.disabled = !hasBuckets;
    btnNext.disabled = !hasBuckets;
    btnPlay.disabled = !hasBuckets;

    timeSlider.min = 0;
    timeSlider.max = Math.max(0, timeBuckets.length - 1);
    timeSlider.value = 0;

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

// scales
function initScales() {
    const magExtent = d3.extent(quakes, d => d.mag);
    const cdiExtent = d3.extent(quakes, d => d.cdi);
    const mmiExtent = d3.extent(quakes, d => d.mmi);
    const sigExtent = d3.extent(quakes, d => d.sig);

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

    const depths = quakes.map(d => d.depth || 0).sort(d3.ascending);
    const q98 = d3.quantile(depths, 0.98);
    const depthMaxGuess = Math.max(100, q98 || 700);

    depthShade = function (baseColor, depth) {
        const val = (depth != null) ? depth : 0;
        const t = Math.max(0, Math.min(1, val / depthMaxGuess));
        return d3.interpolateRgb(baseColor, '#000')(t);
    };
}

// filter + draw
function applyFiltersAndRender() {
    const depLo = +depthMin.value;
    const depHi = +depthMax.value;
    const magLo = +magMin.value;
    const magHi = +magMax.value;
    const tsunamiOnly = !!onlyTsunami.checked;

    let subset;
    if (timeIndex >= 0 && timeBuckets.length) subset = timeBuckets[timeIndex].values;
    else subset = quakes;

    filtered = subset.filter(function (d) {
        const okDepth = (d.depth == null) ? true : (d.depth >= depLo && d.depth <= depHi);
        const okMag   = (d.mag   == null) ? true : (d.mag   >= magLo && d.mag   <= magHi);
        const okTsu   = tsunamiOnly ? (d.tsunami === 1) : true;
        return okDepth && okMag && okTsu;
    });

    drawQuakes();
}

// draw quakes (with fade-in only)
function drawQuakes() {
    const proj = currentBasemap.projection;
    const checked = document.querySelector('input[name="sizeMode"]:checked');
    const useOverall = checked ? (checked.value === 'overall') : false;

    const rows = gQuake.selectAll('g.quake')
        .data(filtered, function (d, i) {
            const t = (d.time && d.time.getTime) ? d.time.getTime() : i;
            return t + ':' + d.latitude + ',' + d.longitude;
        });

    // EXIT
    rows.exit().remove();

    // ENTER
    const rowsEnter = rows.enter()
        .append('g')
        .attr('class', 'quake')
        .attr('transform', function (d) {
            const pt = proj([d.longitude, d.latitude]);
            return 'translate(' + pt[0] + ',' + pt[1] + ')';
        });

    rowsEnter.append('g').attr('class', 'rings');

    // UPDATE + ENTER MERGE
    const rowsAll = rowsEnter.merge(rows);

    // position update
    rowsAll.attr('transform', function (d) {
        const pt = proj([d.longitude, d.latitude]);
        return 'translate(' + pt[0] + ',' + pt[1] + ')';
    });

    // draw rings
    rowsAll.each(function (d) {
        const container = d3.select(this).select('g.rings');
        container.selectAll('circle.ring').remove();

        function addRing(cls, r, fill, fillOpacity, stroke, strokeOpacity) {
            container.append('circle').attr('class', 'ring ' + cls)
                .attr('data-r', r)
                .attr('r', r)
                .attr('fill', fill)
                .attr('fill-opacity', fillOpacity)
                .attr('stroke', stroke)
                .attr('stroke-opacity', strokeOpacity);
        }

        if (useOverall) {
            const rSig = sizeScale_sig(d.sig != null ? d.sig : 0);
            addRing('sig', rSig, depthShade(COLORS.sig, d.depth), 0.75, '#000', 0.35);

            if (d.tsunami === 1) {
                addRing('tsunami', rSig + 2, 'none', 1, '#3b82f6', 0.9);
                container.select('circle.tsunami').attr('fill', 'none').attr('stroke-width', 1.5);
            }
        } else {
            const showMag = chkMag.checked;
            const showCDI = chkCDI.checked;
            const showMMI = chkMMI.checked;

            let rMag = 0, rCDI = 0, rMMI = 0;

            if (showMag) {
                rMag = sizeScale_mag(d.mag != null ? d.mag : 0);
                addRing('mag', rMag, depthShade(COLORS.mag, d.depth), 0.55, '#000', 0.25);
            }
            if (showCDI) {
                rCDI = sizeScale_cdi(d.cdi != null ? d.cdi : 0);
                addRing('cdi', rCDI, depthShade(COLORS.cdi, d.depth), 0.45, '#000', 0.25);
            }
            if (showMMI) {
                rMMI = sizeScale_mmi(d.mmi != null ? d.mmi : 0);
                addRing('mmi', rMMI, depthShade(COLORS.mmi, d.depth), 0.35, '#000', 0.25);
            }
            if (!showMag && !showCDI && !showMMI) {
                rMag = sizeScale_mag(d.mag != null ? d.mag : 0);
                addRing('mag fallback', rMag, depthShade(COLORS.mag, d.depth), 0.55, '#000', 0.25);
            }

            if (d.tsunami === 1) {
                let rMax = Math.max(rMag || 0, rCDI || 0, rMMI || 0);
                if (rMax === 0) rMax = sizeScale_mag(d.mag != null ? d.mag : 0);
                addRing('tsunami', rMax + 2, 'none', 1, '#3b82f6', 0.9);
                container.select('circle.tsunami').attr('fill', 'none').attr('stroke-width', 1.5);
            }
        }
    });

    // ENTER FADE-IN ONLY
    rowsEnter.select('g.rings')
        .attr('opacity', 0)
        .transition()
        .duration(550)
        .attr('opacity', 1);

    // adapt radii to zoom
    adjustCircleSizes();
}

// resize circles according to zoom to reveal overlaps
function adjustCircleSizes() {
    const factor = Math.sqrt(zoomK);
    d3.selectAll('circle.ring').each(function () {
        const base = +this.getAttribute('data-r') || 0;
        this.setAttribute('r', base / factor);
    });
}

// tooltip
function showTooltip(event, d) {
    const timeFmt = d3.timeFormat('%b %d, %Y %H:%M UTC');

    const parts = [];
    if (d.mag != null) parts.push('<span class="badge">M ' + (+d.mag).toFixed(1) + '</span>');
    if (d.depth != null) parts.push('<span class="badge">' + (+d.depth).toFixed(0) + ' km</span>');
    if (d.tsunami === 1) parts.push('<span class="badge" style="border-color:#743; color:#fbbf24">Tsunami</span>');

    tip.classed('hidden', false).html(
        '<h3>' + (d.place || 'Earthquake') + '</h3>' +
        '<div class="meta">' + (d.time ? timeFmt(d.time) : '') + '</div>' +
        '<div>' + parts.join(' ') + '</div>' +
        '<div class="meta">CDI: ' + fmtNA(d.cdi) + ' | MMI: ' + fmtNA(d.mmi) + ' | Sig: ' + fmtNA(d.sig) + '</div>'
    );

    positionTooltip(event);
}
function hideTooltip() { tip.classed('hidden', true); }
function positionTooltip(event) {
    const xy = d3.pointer(event, svg.node());
    tip.style('left', xy[0] + 'px').style('top', xy[1] + 'px');
}
function fmtNA(v) { return (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(1); }

// color legend
function renderLegend() {
    const div = d3.select('main#viz').append('div').attr('class', 'legend color-legend');
    div.append('div').attr('class', 'row').html('<div class="swatch mag"></div> <span>Magnitude (Richter)</span>');
    div.append('div').attr('class', 'row').html('<div class="swatch cdi"></div> <span>CDI (felt)</span>');
    div.append('div').attr('class', 'row').html('<div class="swatch mmi"></div> <span>MMI (damage)</span>');
    div.append('div').attr('class', 'row').html('<div class="swatch sig"></div> <span>Significance (overall)</span>');
}

// play/pause (looping)
function togglePlay() {
    playing = !playing;
    btnPlay.textContent = playing ? 'Pause' : 'Play';
    if (playing) stepPlay();
}

function stepPlay() {
    if (!playing) return;
    if (timeBuckets.length === 0) { playing = false; btnPlay.textContent = 'Play'; return; }

    let next = timeIndex + 1;
    if (next >= timeBuckets.length) next = 0; // loop
    setTimeSlider(next);
    applyFiltersAndRender();
    setTimeout(stepPlay, 900);
}

// draw wrapper
function drawAll() { drawQuakes(); }
