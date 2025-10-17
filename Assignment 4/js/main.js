/* global d3, topojson */

// ------------ File paths ------------
const FILES = {
    world: 'data/world_lowres.json',
    na: 'data/NA_lowres.json',
    quakes: 'data/earthquake_data_tsunami.csv',
};

// ------------ Sizes & Colors ------------
const SIZE = { minPx: 2.2, maxPx: 20 };
const COLORS = {
    mag: '#1b9e77', // green (CB-safe)
    cdi: '#d95f02', // orange
    mmi: '#7570b3', // purple
    sig: '#e7298a'  // magenta
};

// ------------ Projections ------------
const WORLD_INIT = { type: 'world', projection: d3.geoNaturalEarth1() };
const NA_INIT    = { type: 'na',    projection: d3.geoAlbers().parallels([29.5, 45.5]).rotate([98, 0]).center([0, 38]) };

// ------------ State ------------
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
const gLand  = svg.append('g').attr('class','land');
const gQuake = svg.append('g').attr('class','quakes');
const tip = d3.select('#tooltip');

// ------------ Layout helpers ------------
function viewportSize() {
    const panel = document.querySelector('aside#controls');
    const panelW = panel ? panel.getBoundingClientRect().width : 320;
    const w = Math.max(480, window.innerWidth - panelW - 16);
    const h = Math.max(360, window.innerHeight - 0);
    return { w, h };
}
function resize() {
    const { w, h } = viewportSize();
    svg.attr('width', w).attr('height', h);
}
window.addEventListener('resize', () => { resize(); drawAll(); });

// ------------ UI ------------
const depthMin = document.getElementById('depthMin');
const depthMax = document.getElementById('depthMax');
const depthMinVal = document.getElementById('depthMinVal');
const depthMaxVal = document.getElementById('depthMaxVal');

const magMin = document.getElementById('magMin');
const magMax = document.getElementById('magMax');
const magMinVal = document.getElementById('magMinVal');
const magMaxVal = document.getElementById('magMaxVal');

const onlyTsunami = document.getElementById('onlyTsunami');
const btnClearFilters = document.getElementById('btnClearFilters');

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

document.querySelectorAll('input[name="window"]').forEach(r => {
    r.addEventListener('change', () => {
        windowMode = r.value;
        bucketByTime();
        setTimeSlider(0);
        applyFiltersAndRender();
    });
});

sizeModeInputs.forEach(r => r.addEventListener('change', () => applyFiltersAndRender()));
[chkMag, chkCDI, chkMMI].forEach(chk => chk.addEventListener('change', () => applyFiltersAndRender()));

[depthMin, depthMax, magMin, magMax, onlyTsunami].forEach(el => {
    el.addEventListener('input', () => {
        depthMinVal.textContent = depthMin.value;
        depthMaxVal.textContent = depthMax.value;
        magMinVal.textContent = (+magMin.value).toFixed(1);
        magMaxVal.textContent = (+magMax.value).toFixed(1);
        applyFiltersAndRender();
    });
});

btnClearFilters.addEventListener('click', () => {
    depthMin.value = 0; depthMax.value = 700;
    magMin.value = 0; magMax.value = 10;
    onlyTsunami.checked = false;
    depthMinVal.textContent = '0'; depthMaxVal.textContent = '700';
    magMinVal.textContent = '0.0'; magMaxVal.textContent = '10.0';
    applyFiltersAndRender();
});

btnWorld.addEventListener('click', async () => { await loadBasemap(WORLD_INIT); drawAll(); });
btnNA.addEventListener('click', async () => { await loadBasemap(NA_INIT); drawAll(); });

btnPrev.addEventListener('click', () => { if (timeIndex > 0) { setTimeSlider(timeIndex - 1); applyFiltersAndRender(); } });
btnNext.addEventListener('click', () => { if (timeIndex < timeBuckets.length - 1) { setTimeSlider(timeIndex + 1); applyFiltersAndRender(); } });
btnPlay.addEventListener('click', () => togglePlay());
btnShowAll.addEventListener('click', () => { setTimeSlider(-1); applyFiltersAndRender(); });

// ------------ Data load ------------
Promise.all([
    d3.json(FILES.world),
    d3.json(FILES.na),
    d3.csv(FILES.quakes, autoTypeQuake)
]).then(async ([world, na, rows]) => {
    quakes = rows.filter(d => Number.isFinite(d.latitude) && Number.isFinite(d.longitude));

    initScales();

    WORLD_INIT.feature = toGeo(world);
    NA_INIT.feature = toGeo(na);

    await loadBasemap(WORLD_INIT);

    bucketByTime();
    setTimeSlider(0);

    resize();
    applyFiltersAndRender(); // ensures filtered set and first draw

    renderLegend();
}).catch(err => {
    console.error('Data load error:', err);
    const msg = document.createElement('div');
    msg.style.position = 'absolute';
    msg.style.left = '12px';
    msg.style.top = '12px';
    msg.style.padding = '10px 12px';
    msg.style.background = '#3b1d1d';
    msg.style.color = '#fff';
    msg.style.border = '1px solid #7f1d1d';
    msg.style.borderRadius = '8px';
    msg.textContent = 'Failed to load data (check server & file paths). See console.';
    document.body.appendChild(msg);
});

// ------------ Row parsing (robust time) ------------
function autoTypeQuake(d){
    // time can be ISO string, milliseconds, or seconds
    let t = d.time;
    let dt = null;
    if (t !== undefined && t !== null && t !== '') {
        if (/^\d+$/.test(t)) {
            const n = +t;
            dt = new Date(n < 1e12 ? n * 1000 : n); // seconds -> ms
        } else {
            dt = new Date(t);
        }
    }
    return {
        time: dt,
        latitude: +d.latitude,
        longitude: +d.longitude,
        depth: isFinite(+d.depth) ? +d.depth : null,
        mag: isFinite(+d.mag) ? +d.mag : null,
        cdi: isFinite(+d.cdi) ? +d.cdi : null,
        mmi: isFinite(+d.mmi) ? +d.mmi : null,
        sig: isFinite(+d.sig) ? +d.sig : null,
        tsunami: +d.tsunami === 1 ? 1 : 0,
        place: d.place || '',
        dmin: isFinite(+d.dmin) ? +d.dmin : null
    };
}

// ------------ Geo helpers ------------
function toGeo(obj){
    if (obj.type === 'FeatureCollection') return obj;
    const k = Object.keys(obj.objects)[0];
    return topojson.feature(obj, obj.objects[k]);
}

// ------------ Basemap ------------
async function loadBasemap(target){
    currentBasemap = target;

    const { w, h } = viewportSize();
    svg.attr('width', w).attr('height', h);

    currentBasemap.projection.fitSize([w, h], currentBasemap.feature);

    const countries = gLand.selectAll('path.country')
        .data(currentBasemap.feature?.features ?? [], d => d.id || d.properties?.adm0_a3 || d.properties?.name);

    countries.join(
        enter => enter.append('path').attr('class','country')
            .attr('fill','#0a142e')
            .attr('stroke','#1e2a4c')
            .attr('stroke-width',0.5)
            .attr('d', d3.geoPath(currentBasemap.projection)),
        update => update.attr('d', d3.geoPath(currentBasemap.projection)),
        exit => exit.remove()
    );
}

// ------------ Time bucketing ------------
function bucketByTime(){
    const fmtMonthKey = d3.timeFormat('%Y-%m');
    const fmtYearKey  = d3.timeFormat('%Y');
    const keyFn = windowMode === 'month' ? fmtMonthKey : fmtYearKey;

    const q = quakes.filter(d => d.time instanceof Date && !Number.isNaN(+d.time));
    const groups = d3.group(q, d => keyFn(d.time));

    timeBuckets = Array.from(groups, ([key, values]) => {
        let start, end;
        if (windowMode === 'month'){
            const [y,m] = key.split('-').map(Number);
            start = new Date(y, m-1, 1);
            end = d3.timeMonth.offset(start, 1);
        } else {
            const y = +key;
            start = new Date(y, 0, 1);
            end = new Date(y+1, 0, 1);
        }
        return { key, start, end, values: values.sort((a,b)=>a.time-b.time) };
    }).sort((a,b)=>a.start - b.start);

    // Slider enable/disable + bounds
    const hasBuckets = timeBuckets.length > 1;
    timeSlider.disabled = !hasBuckets;
    btnPrev.disabled = !hasBuckets;
    btnNext.disabled = !hasBuckets;
    btnPlay.disabled = !hasBuckets;

    timeSlider.min = 0;
    timeSlider.max = Math.max(0, timeBuckets.length - 1);
    timeSlider.value = 0;

    timeSlider.oninput = () => {
        const v = +timeSlider.value;
        setTimeSlider(v);
        applyFiltersAndRender();
    };
}

function setTimeSlider(idx){
    timeIndex = idx;
    if (idx < 0){
        timeLabel.textContent = 'All times';
        if (!timeSlider.disabled) timeSlider.value = 0;
    } else {
        const bucket = timeBuckets[idx];
        const fmt = windowMode === 'month' ? d3.timeFormat('%B %Y') : d3.timeFormat('%Y');
        timeLabel.textContent = bucket ? fmt(bucket.start) : '—';
        if (!timeSlider.disabled) timeSlider.value = Math.max(0, idx);
    }
}

// ------------ Scales ------------
function initScales(){
    const magExtent = d3.extent(quakes, d => d.mag).map(v => v ?? 0);
    const cdiExtent = d3.extent(quakes, d => d.cdi).map(v => v ?? 0);
    const mmiExtent = d3.extent(quakes, d => d.mmi).map(v => v ?? 0);
    const sigExtent = d3.extent(quakes, d => d.sig).map(v => v ?? 0);

    sizeScale_mag = d3.scaleSqrt().domain([Math.max(0, magExtent[0]||0), Math.max(1, magExtent[1]||1)]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
    sizeScale_cdi = d3.scaleSqrt().domain([Math.max(0, cdiExtent[0]||0), Math.max(1, cdiExtent[1]||1)]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
    sizeScale_mmi = d3.scaleSqrt().domain([Math.max(0, mmiExtent[0]||0), Math.max(1, mmiExtent[1]||1)]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);
    sizeScale_sig = d3.scaleSqrt().domain([Math.max(0, sigExtent[0]||0), Math.max(1, sigExtent[1]||1)]).range([SIZE.minPx, SIZE.maxPx]).clamp(true);

    const depthMax = Math.max(100, d3.quantile(quakes.map(d=>d.depth||0).sort(d3.ascending), 0.98) || 700);
    depthShade = (baseColor, depth) => {
        const t = Math.max(0, Math.min(1, (depth ?? 0)/depthMax));
        return d3.interpolateRgb(baseColor, '#000')(t);
    };
}

// ------------ Filtering & drawing ------------
function applyFiltersAndRender(){
    const depLo = +depthMin.value, depHi = +depthMax.value;
    const magLo = +magMin.value, magHi = +magMax.value;
    const tsunamiOnly = !!onlyTsunami.checked;

    let subset = quakes;
    if (timeIndex >= 0 && timeBuckets.length){
        const b = timeBuckets[timeIndex];
        subset = quakes.filter(d => d.time && d.time >= b.start && d.time < b.end);
    }
    filtered = subset.filter(d => {
        const OKdepth = d.depth == null ? true : (d.depth >= depLo && d.depth <= depHi);
        const OKmag   = d.mag == null   ? true : (d.mag >= magLo && d.mag <= magHi);
        const OKtsu   = tsunamiOnly ? d.tsunami === 1 : true;
        return OKdepth && OKmag && OKtsu;
    });

    drawQuakes();
}

function drawQuakes(){
    const proj = currentBasemap.projection;
    const useOverall = document.querySelector('input[name="sizeMode"]:checked').value === 'overall';

    // JOIN
    const nodes = gQuake.selectAll('g.quake')
        .data(filtered, (d,i) => (d.time?.getTime() ?? i) + ':' + d.latitude + ',' + d.longitude);

    // EXIT
    nodes.exit().remove();

    // ENTER
    const enter = nodes.enter().append('g')
        .attr('class','quake')
        .attr('transform', d => `translate(${proj([d.longitude, d.latitude])})`)
        .on('mouseenter', (event, d) => showTooltip(event, d))
        .on('mouseleave', hideTooltip)
        .on('mousemove', positionTooltip);

    // UPDATE + ENTER → rebuild rings for each node (so mode switches take effect)
    const all = enter.merge(nodes);
    all.attr('transform', d => `translate(${proj([d.longitude, d.latitude])})`);
    all.each(function(d){
        const g = d3.select(this);
        g.selectAll('circle.ring').remove(); // clear previous rings

        if (useOverall){
            g.append('circle').attr('class','ring sig')
                .attr('r', sizeScale_sig(d.sig ?? 0))
                .attr('fill', depthShade(COLORS.sig, d.depth))
                .attr('fill-opacity', 0.75)
                .attr('stroke', '#000').attr('stroke-opacity', 0.35);
        } else {
            const showMag = chkMag.checked;
            const showCDI = chkCDI.checked;
            const showMMI = chkMMI.checked;

            if (showMag){
                g.append('circle').attr('class','ring mag')
                    .attr('r', sizeScale_mag(d.mag ?? 0))
                    .attr('fill', depthShade(COLORS.mag, d.depth))
                    .attr('fill-opacity', 0.55)
                    .attr('stroke', '#000').attr('stroke-opacity', 0.25);
            }
            if (showCDI){
                g.append('circle').attr('class','ring cdi')
                    .attr('r', sizeScale_cdi(d.cdi ?? 0))
                    .attr('fill', depthShade(COLORS.cdi, d.depth))
                    .attr('fill-opacity', 0.45)
                    .attr('stroke', '#000').attr('stroke-opacity', 0.25);
            }
            if (showMMI){
                g.append('circle').attr('class','ring mmi')
                    .attr('r', sizeScale_mmi(d.mmi ?? 0))
                    .attr('fill', depthShade(COLORS.mmi, d.depth))
                    .attr('fill-opacity', 0.35)
                    .attr('stroke', '#000').attr('stroke-opacity', 0.25);
            }

            if (!showMag && !showCDI && !showMMI){
                g.append('circle').attr('class','ring mag fallback')
                    .attr('r', sizeScale_mag(d.mag ?? 0))
                    .attr('fill', depthShade(COLORS.mag, d.depth))
                    .attr('fill-opacity', 0.55)
                    .attr('stroke', '#000').attr('stroke-opacity', 0.25);
            }
        }
    });
}

// ------------ Tooltip ------------
function showTooltip(event, d){
    const timeFmt = d3.timeFormat('%b %d, %Y %H:%M UTC');
    const parts = [];
    if (d.mag != null) parts.push(`<span class="badge">M ${(+d.mag).toFixed(1)}</span>`);
    if (d.depth != null) parts.push(`<span class="badge">${(+d.depth).toFixed(0)} km</span>`);
    if (d.tsunami === 1) parts.push(`<span class="badge" style="border-color:#743; color:#fbbf24">Tsunami</span>`);

    const dmin = d.dmin;
    const dminPct = dmin != null ? Math.max(0, Math.min(1, dmin / 5)) : null;
    const bar = dminPct != null ? `
    <div class="bar-wrap">
      <div class="meta">Nearest station distance: ${dmin.toFixed(2)} (scaled)</div>
      <div class="bar-bg"><div class="bar" style="width:${(dminPct*100).toFixed(0)}%"></div></div>
    </div>` : '';

    tip.classed('hidden', false).html(`
    <h3>${d.place || 'Earthquake'}</h3>
    <div class="meta">${d.time ? timeFmt(d.time) : ''}</div>
    <div>${parts.join(' ')}</div>
    <div class="meta">CDI: ${fmtNA(d.cdi)} | MMI: ${fmtNA(d.mmi)} | Sig: ${fmtNA(d.sig)}</div>
    ${bar}
  `);

    positionTooltip(event);
}
function hideTooltip(){ tip.classed('hidden', true); }
function positionTooltip(event){
    const [x, y] = d3.pointer(event, svg.node());
    tip.style('left', `${x}px`).style('top', `${y}px`);
}
function fmtNA(v){ return (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(1); }

// ------------ Legend ------------
function renderLegend(){
    const div = d3.select('main#viz').append('div').attr('class','legend');
    div.append('div').attr('class','row').html(`<div class="swatch mag"></div> <span>Magnitude (Richter)</span>`);
    div.append('div').attr('class','row').html(`<div class="swatch cdi"></div> <span>CDI (felt)</span>`);
    div.append('div').attr('class','row').html(`<div class="swatch mmi"></div> <span>MMI (damage)</span>`);
    div.append('div').attr('class','row').html(`<div class="swatch sig"></div> <span>Significance (overall)</span>`);
}

// ------------ Animation ------------
function togglePlay(){
    playing = !playing;
    btnPlay.textContent = playing ? 'Pause' : 'Play';
    if (playing) stepPlay();
}
function stepPlay(){
    if (!playing) return;
    if (timeBuckets.length === 0){ playing = false; btnPlay.textContent = 'Play'; return; }

    const next = timeIndex + 1;
    if (next < timeBuckets.length){
        setTimeSlider(next);
        applyFiltersAndRender();
        setTimeout(stepPlay, 900);
    } else {
        playing = false;
        btnPlay.textContent = 'Play';
    }
}

// ------------ Draw all ------------
function drawAll(){ drawQuakes(); }
