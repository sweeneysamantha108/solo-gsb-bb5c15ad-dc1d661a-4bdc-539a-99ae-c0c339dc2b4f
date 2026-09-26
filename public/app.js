'use strict';

/* 圆筒包装接缝避让前端：参数表单、结果列表、Canvas 预览与拖动吸附 */

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  mode: 'single',      // 'single' | 'multi'
  result: null,        // 单规格：服务端计算结果
  multiResult: null,   // 多规格：服务端计算结果
  lastInput: null,     // 最近一次成功计算的输入（供快照保存/载入）
  thetaMm: 0,          // 单规格：当前接缝位置 (mm, [0, C))
  thetaDeg: 0,         // 多规格：当前共用角度 (deg, [0, 360))
  dragging: false,
  rawMm: null,         // 拖动时未吸附的原始角度（单规格）
  rawDeg: null,        // 拖动时未吸附的原始角度（多规格）
  selected: [],        // 选中的快照 id（按选择顺序，最多 2 个）
  currentDiff: null,   // 当前展示的差异结果
};

const SPEC_COLORS = [
  '#2563eb', '#7c3aed', '#db2777', '#0891b2',
  '#65a30d', '#d97706', '#0d9488', '#e11d48',
];
const MAX_SPECS_UI = 8;

const TAU = Math.PI * 2;
const mod = (n, m) => ((n % m) + m) % m;
const fmtMm = (x) => String(Math.round(x * 100) / 100);
const fmtDeg = (x) => (Math.round(x * 10) / 10).toFixed(1);

/* ---------------- 输入表单 ---------------- */

function addZoneRow(start = '', end = '') {
  const row = document.createElement('div');
  row.className = 'zone-row';
  row.innerHTML = `
    <label>起点 (mm)<input type="number" step="any" class="z-start" value="${start}"></label>
    <label>终点 (mm)<input type="number" step="any" class="z-end" value="${end}"></label>
    <button type="button" class="remove" title="删除">✕</button>`;
  row.querySelector('.remove').addEventListener('click', () => {
    row.remove();
    scheduleCompute();
  });
  row.querySelectorAll('input').forEach((i) => i.addEventListener('input', scheduleCompute));
  $('zones').appendChild(row);
}

/* ---------------- 多规格周长表单 ---------------- */

function addSpecRow(value = '') {
  const n = $('specs').children.length + 1;
  const row = document.createElement('div');
  row.className = 'spec-row';
  row.innerHTML = `
    <span class="spec-swatch" style="background:${SPEC_COLORS[n - 1]}"></span>
    <label><span class="spec-label">规格 ${n} 周长 (mm)</span><input type="number" min="0.01" step="any" class="c-spec" value="${value}"></label>
    <button type="button" class="remove" title="删除">✕</button>`;
  row.querySelector('.remove').addEventListener('click', () => {
    if ($('specs').children.length <= 2) return;
    row.remove();
    refreshSpecRows();
    scheduleCompute();
  });
  row.querySelector('.c-spec').addEventListener('input', scheduleCompute);
  $('specs').appendChild(row);
}

function refreshSpecRows() {
  const rows = [...$('specs').children];
  rows.forEach((row, i) => {
    row.querySelector('.spec-swatch').style.background = SPEC_COLORS[i];
    row.querySelector('.spec-label').textContent = `规格 ${i + 1} 周长 (mm)`;
    row.querySelector('.remove').disabled = rows.length <= 2;
  });
  $('addSpec').disabled = rows.length >= MAX_SPECS_UI;
}

function readZones() {
  return [...document.querySelectorAll('.zone-row')].map((row) => ({
    start: parseFloat(row.querySelector('.z-start').value),
    end: parseFloat(row.querySelector('.z-end').value),
  }));
}

/** 读取设备档位约束（单/多规格共用；关闭时只回传 enabled:false，输入仍保留在表单）。 */
function readDetents() {
  if (!$('detentsEnabled').checked) return { enabled: false };
  const offsetRaw = $('detentOffset').value.trim();
  return {
    enabled: true,
    steps: parseInt($('detentSteps').value, 10),
    offsetDeg: offsetRaw === '' ? 0 : parseFloat($('detentOffset').value),
  };
}

/** 档位参数的前端校验，返回错误信息或 null。 */
function validateDetentsInput(d) {
  if (!d.enabled) return null;
  if (!Number.isInteger(d.steps) || d.steps < 2 || d.steps > 360) {
    return '每圈档位数必须为 2～360 的整数';
  }
  if (!Number.isFinite(d.offsetDeg)) {
    return '零位偏移必须为数值（角度）';
  }
  return null;
}

/** 将档位参数写回表单（载入快照时使用）。 */
function fillDetents(d) {
  const enabled = !!(d && d.enabled);
  $('detentsEnabled').checked = enabled;
  if (d && Number.isFinite(d.steps)) $('detentSteps').value = d.steps;
  if (d && Number.isFinite(d.offsetDeg)) $('detentOffset').value = d.offsetDeg;
  updateDetentsUI();
}

function updateDetentsUI() {
  const enabled = $('detentsEnabled').checked;
  $('detentsFields').hidden = !enabled;
}

function readInputs() {
  const circumference = parseFloat($('circumference').value);
  const seamWidth = parseFloat($('seamWidth').value);
  return { circumference, seamWidth, zones: readZones(), detents: readDetents() };
}

function readMultiInputs() {
  const circumferences = [...document.querySelectorAll('#specs .c-spec')].map((i) =>
    parseFloat(i.value)
  );
  const seamWidth = parseFloat($('seamWidth').value);
  return { circumferences, seamWidth, zones: readZones(), detents: readDetents() };
}

/* ---------------- 模式切换（两个表单都保留在 DOM，互不丢输入） ---------------- */

function setMode(mode) {
  if (mode !== 'single' && mode !== 'multi') return;
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('singleFields').hidden = mode !== 'single';
  $('multiFields').hidden = mode !== 'multi';
  $('singleResults').hidden = mode !== 'single';
  $('multiResults').hidden = mode !== 'multi';
  $('multiLegend').hidden = mode !== 'multi';
  updatePreviewHint();

  if (mode === 'multi' && $('specs').children.length === 0) {
    const c = parseFloat($('circumference').value);
    addSpecRow(Number.isFinite(c) ? c : 400);
    addSpecRow(Number.isFinite(c) ? Math.round(c * 1.25 * 100) / 100 : 500);
  }
  refreshSpecRows();
  updateSnapshotModeUI();
  scheduleCompute();
}

/* ---------------- 计算 ---------------- */

let computeTimer = null;

/** 拖动提示随模式与档位约束变化。 */
function updatePreviewHint() {
  const detentsOn = $('detentsEnabled').checked;
  $('previewHint').textContent = state.mode === 'multi'
    ? detentsOn
      ? '拖动圆盘旋转，仅吸附到所有规格均安全的可用档位'
      : '拖动圆盘旋转，自动吸附到所有规格均安全的最近角度'
    : detentsOn
      ? '拖动圆盘旋转，仅吸附到可行段内的可用档位'
      : '拖动圆盘旋转，自动吸附到最近可行位置';
}

function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(compute, 250);
}

async function compute() {
  $('error').hidden = true;
  if (state.mode === 'multi') return computeMulti();

  const body = readInputs();

  if (!Number.isFinite(body.circumference) || body.circumference <= 0) {
    return showError('筒体周长必须为大于 0 的数值');
  }
  if (!Number.isFinite(body.seamWidth) || body.seamWidth < 0) {
    return showError('接缝安全宽度必须为不小于 0 的数值');
  }
  if (body.zones.some((z) => !Number.isFinite(z.start) || !Number.isFinite(z.end))) {
    return showError('保护区的起点与终点必须为数值 (mm)');
  }
  const detentsError = validateDetentsInput(body.detents);
  if (detentsError) return showError(detentsError);

  let result;
  try {
    const res = await fetch('/api/compute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    result = await res.json();
    if (!res.ok) return showError(result.error || '计算失败');
  } catch (e) {
    return showError('无法连接服务器：' + e.message);
  }

  state.result = result;
  state.lastInput = body;
  // 默认选择：距禁用边界最远、角度最小的旋转量；启用档位时为最优可用档位
  if (result.best) state.thetaMm = result.best.mm;
  exitDiffMode();
  renderResults();
  draw();
}

async function computeMulti() {
  const body = readMultiInputs();

  if (body.circumferences.length < 2 || body.circumferences.length > 8) {
    return showError('请输入 2～8 个筒体周长');
  }
  if (body.circumferences.some((C) => !Number.isFinite(C) || C <= 0)) {
    return showError('每个规格的筒体周长都必须为大于 0 的数值');
  }
  if (!Number.isFinite(body.seamWidth) || body.seamWidth < 0) {
    return showError('接缝安全宽度必须为不小于 0 的数值');
  }
  if (body.zones.some((z) => !Number.isFinite(z.start) || !Number.isFinite(z.end))) {
    return showError('保护区的起点与终点必须为数值 (mm)');
  }
  const detentsError = validateDetentsInput(body.detents);
  if (detentsError) return showError(detentsError);

  let result;
  try {
    const res = await fetch('/api/compute-multi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    result = await res.json();
    if (!res.ok) return showError(result.error || '计算失败');
  } catch (e) {
    return showError('无法连接服务器：' + e.message);
  }

  state.multiResult = result;
  state.lastInput = null; // 多规格结果不进入单规格快照
  if (result.best) {
    state.thetaDeg = result.best.deg;
  } else if (result.noSolution && result.fallback) {
    state.thetaDeg = result.fallback.deg; // 无共同解时定位到“最小违约备选”
  }
  exitDiffMode();
  renderMultiResults();
  draw();
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

/* ---------------- 档位结果辅助 ---------------- */

/** 角度 deg 是否落在弧 arc 内（含边界）。 */
function degInArc(deg, arc) {
  if (!arc || arc.full) return true;
  if (arc.wraps) return deg >= arc.startDeg - 1e-9 || deg <= arc.endDeg + 1e-9;
  return deg >= arc.startDeg - 1e-9 && deg <= arc.endDeg + 1e-9;
}

/** 弧内可用档位中按“瓶颈间隙最大、角度较小”选出的档位。 */
function bestDetentInArc(detents, arc) {
  if (!detents || !detents.available) return null;
  const list = detents.available.filter((d) => degInArc(d.deg, arc));
  if (list.length === 0) return null;
  list.sort((a, b) => {
    const ga = a.gapDeg !== undefined ? a.gapDeg : a.minGapDeg;
    const gb = b.gapDeg !== undefined ? b.gapDeg : b.minGapDeg;
    if (ga === null && gb === null) return a.deg - b.deg;
    if (ga === null) return -1;
    if (gb === null) return 1;
    if (Math.abs(ga - gb) > 1e-7) return gb - ga;
    return a.deg - b.deg;
  });
  return list[0];
}

/** “无可用档位”提示：列出每条可行/共用段前后最近的档位及角距离。 */
function renderNearestHtml(detents) {
  const parts = [
    `<strong>连续区间有解，但没有任何档位落在可行范围内。</strong>` +
      `（每圈 ${detents.steps} 档，间隔 ${fmtDeg(detents.stepDeg)}°）`,
  ];
  for (const n of detents.nearest || []) {
    const arcText = n.arc.full
      ? '0.0° → 360.0°'
      : `${fmtDeg(n.arc.startDeg)}° → ${fmtDeg(n.arc.endDeg)}°${n.arc.wraps ? '（跨零点）' : ''}`;
    const side = (label, x) =>
      x
        ? `${label}第 ${x.index + 1} 档 ${fmtDeg(x.deg)}°，角距离 ${fmtDeg(x.distanceDeg)}°`
        : `${label}无`;
    parts.push(
      `<div class="chain-item">可行段 ${arcText}：<br>` +
        `&nbsp;&nbsp;${side('逆时针最近（段前）：', n.before)}<br>` +
        `&nbsp;&nbsp;${side('顺时针最近（段后）：', n.after)}</div>`
    );
  }
  return parts.join('');
}

/* ---------------- 结果渲染 ---------------- */

function segText(s) {
  if (s.widthDeg !== undefined && s.widthDeg >= 360 - 1e-6) {
    return `0.0° → 360.0°（整圈）`;
  }
  const range = `${fmtDeg(s.startDeg)}° → ${fmtDeg(s.endDeg)}°`;
  const mm = `${fmtMm(s.startMm)} → ${fmtMm(s.endMm)} mm`;
  const wrap = s.wraps ? '（跨零点）' : '';
  return `${range} ｜ ${mm}${wrap}`;
}

function renderResults() {
  const r = state.result;
  const detentsOn = !!(r.detents && r.detents.enabled);

  const bestBox = $('bestBox');
  if (r.best) {
    bestBox.hidden = false;
    if (detentsOn) {
      const d = r.detents.best;
      const gapLine = d.gapDeg === null
        ? '无禁用区，瓶颈间隙无约束'
        : `瓶颈间隙 ${fmtDeg(d.gapDeg)}°`;
      bestBox.innerHTML =
        `默认档位（可用档位中瓶颈间隙最大、角度最小）：<br>` +
        `<span class="num">${fmtDeg(r.best.deg)}°</span> ＝ ${fmtMm(r.best.mm)} mm` +
        ` ｜ 第 ${d.index + 1}/${r.detents.steps} 档 ｜ ${gapLine}`;
    } else {
      bestBox.innerHTML =
        `默认旋转量（距禁用边界最远、角度最小）：<br>` +
        `<span class="num">${fmtDeg(r.best.deg)}°</span> ＝ ${fmtMm(r.best.mm)} mm`;
    }
  } else {
    bestBox.hidden = true;
  }

  // 连续有解但没有可用档位：区别于保护区覆盖整圈
  const warnBox = $('detentWarnBox');
  if (detentsOn && !r.noSolution && r.detents.noAvailable) {
    warnBox.hidden = false;
    warnBox.innerHTML = renderNearestHtml(r.detents);
  } else {
    warnBox.hidden = true;
    warnBox.innerHTML = '';
  }

  $('noSolutionBox').hidden = !r.noSolution;
  if (r.noSolution) {
    $('chainList').innerHTML = r.forbiddenChain
      .map(
        (c, i) =>
          `<div class="chain-item">链节 ${i + 1}：${fmtDeg(c.startDeg)}° → ${fmtDeg(c.endDeg)}°` +
          `（${fmtMm(c.startMm)} → ${fmtMm(c.endMm)} mm）</div>`
      )
      .join('');
  }

  renderSingleDetents();

  $('feasibleCount').textContent = r.noSolution ? '（无）' : `（共 ${r.feasible.length} 段）`;
  const fl = $('feasibleList');
  fl.innerHTML = '';
  r.feasible.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'feasible';
    li.innerHTML = `<span>段 ${i + 1}：${segText(s)}</span><span class="tag">宽 ${fmtDeg(s.widthDeg)}°</span>`;
    li.title = detentsOn ? '点击选择该段内的默认可用档位' : '点击将该段中点设为接缝位置';
    li.addEventListener('click', () => {
      const C = r.circumference;
      if (detentsOn) {
        const pick = bestDetentInArc(r.detents, s);
        if (!pick) return; // 该段无可用档位
        state.thetaMm = pick.mm;
      } else {
        const sMm = s.startMm;
        const eMm = s.wraps ? s.endMm + C : s.endMm;
        state.thetaMm = mod((sMm + eMm) / 2, C);
      }
      renderResults();
      draw();
    });
    fl.appendChild(li);
  });
  markActiveSegment();

  const dl = $('forbiddenList');
  dl.innerHTML = '';
  if (r.forbiddenMerged.length === 0) {
    dl.innerHTML = '<li class="forbidden">无禁用区间，整圈可行</li>';
  } else {
    r.forbiddenMerged.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'forbidden';
      li.innerHTML = `<span>禁用 ${i + 1}：${segText(s)}</span>`;
      dl.appendChild(li);
    });
  }
}

/** 单规格：渲染可用档位列表（含各档间隙）。 */
function renderSingleDetents() {
  const r = state.result;
  const panel = $('singleDetentsPanel');
  if (!r || !r.detents || !r.detents.enabled) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const d = r.detents;
  $('singleDetentCount').textContent = r.noSolution
    ? '（保护区覆盖整圈）'
    : d.noAvailable
      ? '（无可用档位）'
      : `（${d.available.length}/${d.steps} 档可用，间隔 ${fmtDeg(d.stepDeg)}°）`;

  const ul = $('singleDetentList');
  ul.innerHTML = '';
  if (r.noSolution) return;
  for (const item of d.available) {
    const li = document.createElement('li');
    li.className = 'detent-row';
    if (r.best && item.index === r.best.detentIndex) li.classList.add('active');
    const gap = item.gapDeg === null ? '无禁用区' : `间隙 ${fmtDeg(item.gapDeg)}°`;
    li.innerHTML =
      `<span class="d-name">第 ${item.index + 1} 档：${fmtDeg(item.deg)}°（${fmtMm(item.mm)} mm）</span>` +
      `<span class="tag">${gap}</span>`;
    li.title = '点击将接缝移到该档位';
    li.addEventListener('click', () => {
      state.thetaMm = item.mm;
      renderResults();
      draw();
    });
    ul.appendChild(li);
  }
}

function markActiveSegment() {
  const r = state.result;
  if (!r || r.noSolution) return;
  const C = r.circumference;
  [...$('feasibleList').children].forEach((li, i) => {
    const s = r.feasible[i];
    const eMm = s.wraps ? s.endMm + C : s.endMm;
    const t = state.thetaMm;
    li.classList.toggle('active', (t >= s.startMm && t <= eMm) || (t + C >= s.startMm && t + C <= eMm));
  });
}

/* ---------------- 多规格结果渲染 ---------------- */

function arcText(a) {
  if (a.full) return '0.0° → 360.0°（整圈）';
  const wrap = a.wraps ? '（跨零点）' : '';
  return `${fmtDeg(a.startDeg)}° → ${fmtDeg(a.endDeg)}°${wrap}`;
}

/**
 * “最小违约备选”结果块：公共可行段为空时展示备选角度、最大/总侵入深度
 * 及各规格侵入深度（启用档位时标注档位序号）。
 */
function renderFallbackHtml(r) {
  const f = r.fallback;
  if (!f) return '';
  const detentsOn = !!(r.detents && r.detents.enabled);
  const detentTag =
    detentsOn && f.detentIndex !== null && f.detentIndex !== undefined
      ? ` ｜ 第 ${f.detentIndex + 1}/${r.detents.steps} 档`
      : '';
  const per = f.intrusions
    .map((x) => {
      const zero = x.intrusionDeg <= 1e-9;
      return (
        `<div class="fb-item${zero ? ' ok' : ''}">规格 ${x.index + 1}（${fmtMm(x.circumference)} mm）：` +
        (zero
          ? '<span class="fb-zero">未侵入禁用区</span>'
          : `侵入深度 <strong>${fmtDeg(x.intrusionDeg)}°</strong>`) +
        `（接缝落在 ${fmtMm(x.mm)} mm）</div>`
      );
    })
    .join('');
  return (
    `<div class="fallback-box">` +
    `<div class="fb-title">最小违约备选${detentsOn ? '（仅在档位角度中求解）' : ''}</div>` +
    `<div class="fb-reason">${f.reason}</div>` +
    `<div class="fb-angle">备选角度：<span class="num">${fmtDeg(f.deg)}°</span>${detentTag}` +
    ` ｜ 最大侵入深度 <strong>${fmtDeg(f.maxIntrusionDeg)}°</strong>` +
    ` ｜ 总侵入深度 ${fmtDeg(f.totalIntrusionDeg)}°</div>` +
    `<div class="fb-per">${per}</div>` +
    `</div>`
  );
}

function renderMultiResults() {
  const r = state.multiResult;
  if (!r) return;

  const bestBox = $('multiBestBox');
  const noBox = $('multiNoSolutionBox');
  bestBox.hidden = !!r.noSolution;
  noBox.hidden = !r.noSolution;

  if (!r.noSolution && r.best) {
    let line = '';
    const detentsOn = !!(r.detents && r.detents.enabled);
    const detentTag = detentsOn ? ` ｜ 第 ${r.best.detentIndex + 1}/${r.detents.steps} 档` : '';
    if (r.best.minGapDeg === null) {
      line =
        `${detentsOn ? '默认档位' : '默认共用角度'}（所有规格均无禁用区，取最小角度）：<br>` +
        `<span class="num">${fmtDeg(r.best.deg)}°</span>${detentTag}`;
    } else {
      const tight = r.specs[r.best.minGapSpecIndex];
      line =
        `${detentsOn ? '默认档位' : '默认共用角度'}（各规格下距禁用边界的最小间隙最大）：<br>` +
        `<span class="num">${fmtDeg(r.best.deg)}°</span>${detentTag}` +
        ` ｜ 最小间隙 ${fmtDeg(r.best.minGapDeg)}°（规格 ${r.best.minGapSpecIndex + 1}：${
          tight ? fmtMm(tight.circumference) : ''
        } mm）`;
      const per = r.best.gaps
        .map(
          (g) =>
            `规格 ${g.index + 1}：${g.gapDeg === null ? '无禁用区' : fmtDeg(g.gapDeg) + '°'}` +
            `（接缝落在 ${fmtMm(g.mm)} mm）`
        )
        .join('<br>');
      line += `<div class="gap-detail">${per}</div>`;
    }
    bestBox.innerHTML = line;
  }

  // 连续公共段有解但没有可用档位
  const warnBox = $('multiDetentWarnBox');
  if (!r.noSolution && r.detents && r.detents.enabled && r.detents.noAvailable) {
    warnBox.hidden = false;
    warnBox.innerHTML = renderNearestHtml(r.detents);
  } else {
    warnBox.hidden = true;
    warnBox.innerHTML = '';
  }

  if (r.noSolution && r.blocker) {
    const b = r.blocker;
    const conflicts = b.conflictSegments.length
      ? b.conflictSegments.map((a) => `<div class="chain-item">冲突区间：${arcText(a)}</div>`).join('')
      : '<div class="chain-item">仅余零宽接触点（角度边界相接），无可行公共段。</div>';
    const blocking = b.blockingForbidden
      .map((f) => `${fmtDeg(f.startDeg)}° → ${fmtDeg(f.endDeg)}°`)
      .join('、');
    noBox.innerHTML =
      `<strong>无共同解：</strong>规格 ${b.index + 1}（周长 ${fmtMm(b.circumference)} mm）` +
      `使公共可行角度首次归零。<div class="chain-item">该规格禁用区间：${blocking || '整圈禁用'}</div>` +
      conflicts +
      renderFallbackHtml(r);
  }

  $('commonCount').textContent = r.noSolution
    ? '（无）'
    : r.fullCircle
      ? '（整圈）'
      : `（共 ${r.common.length} 段）`;
  const cl = $('commonList');
  cl.innerHTML = '';
  if (!r.noSolution) {
    for (const a of r.common) {
      const li = document.createElement('li');
      li.className = 'feasible common-item';
      li.innerHTML = a.full
        ? `<span>整圈：0.0° → 360.0°</span><span class="tag">宽 360.0°</span>`
        : `<span>共用段：${arcText(a)}</span><span class="tag">宽 ${fmtDeg(a.widthDeg)}°</span>`;
      li.title = r.detents && r.detents.enabled ? '点击选择该段内的默认可用档位' : '点击将该段中点设为共用角度';
      li.addEventListener('click', () => {
        if (r.detents && r.detents.enabled) {
          const pick = bestDetentInArc(r.detents, a);
          if (!pick) return;
          state.thetaDeg = pick.deg;
        } else {
          state.thetaDeg = a.full ? 0 : mod((a.startDeg + (a.wraps ? a.endDeg + 360 : a.endDeg)) / 2, 360);
        }
        renderMultiResults();
        draw();
      });
      cl.appendChild(li);
    }
  }
  markActiveCommon();
  renderMultiDetents();

  const sl = $('multiSpecList');
  sl.innerHTML = '';
  r.specs.forEach((s) => {
    const color = SPEC_COLORS[s.index % SPEC_COLORS.length];
    const res = s.result;
    const li = document.createElement('li');
    li.className = 'multi-spec-row';
    const status = res.noSolution
      ? '<span class="ms-nosol">该规格自身无解（禁用覆盖整圈）</span>'
      : res.forbiddenMerged.length === 0
        ? '<span class="ms-ok">无禁用区间</span>'
        : `<span class="ms-forb">${res.forbiddenMerged.length} 段禁用</span>` +
          `<span class="ms-feas">可行 ${res.feasible.length} 段</span>`;
    li.innerHTML =
      `<span class="spec-swatch" style="background:${color}"></span>` +
      `<div class="ms-info"><div class="ms-name">规格 ${s.index + 1}：${fmtMm(s.circumference)} mm` +
      `（接缝宽 ${fmtDeg(res.seamWidthDeg)}°）</div>` +
      `<div class="ms-status">${status}</div></div>`;
    sl.appendChild(li);
  });

  renderMultiLegend();
}

function markActiveCommon() {
  const r = state.multiResult;
  if (!r || r.noSolution) return;
  const t = state.thetaDeg;
  [...$('commonList').children].forEach((li, i) => {
    const a = r.common[i];
    let active = false;
    if (a.full) active = true;
    else if (a.wraps) active = t >= a.startDeg - 1e-9 || t <= a.endDeg + 1e-9;
    else active = t >= a.startDeg - 1e-9 && t <= a.endDeg + 1e-9;
    li.classList.toggle('active', active);
  });
}

/** 多规格：渲染可用档位列表（逐档列出各规格间隙）。 */
function renderMultiDetents() {
  const r = state.multiResult;
  const panel = $('multiDetentsPanel');
  if (!r || !r.detents || !r.detents.enabled) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const d = r.detents;
  $('multiDetentCount').textContent = r.noSolution
    ? r.fallback && Number.isInteger(r.fallback.detentIndex)
      ? `（公共交集归零；备选第 ${r.fallback.detentIndex + 1} 档）`
      : '（公共交集归零）'
    : d.noAvailable
      ? '（无可用档位）'
      : `（${d.available.length}/${d.steps} 档可用，间隔 ${fmtDeg(d.stepDeg)}°）`;

  const ul = $('multiDetentList');
  ul.innerHTML = '';
  if (r.noSolution) return;
  for (const item of d.available) {
    const li = document.createElement('li');
    li.className = 'detent-row';
    if (r.best && item.index === r.best.detentIndex) li.classList.add('active');
    const per = item.gaps
      .map(
        (g) =>
          `规格${g.index + 1}：${g.gapDeg === null ? '无禁用区' : fmtDeg(g.gapDeg) + '°'}`
      )
      .join(' ｜ ');
    const bottleneck =
      item.minGapDeg === null ? '无禁用区' : `瓶颈 ${fmtDeg(item.minGapDeg)}°`;
    li.innerHTML =
      `<div class="md-head"><span class="d-name">第 ${item.index + 1} 档：${fmtDeg(item.deg)}°</span>` +
      `<span class="tag">${bottleneck}</span></div>` +
      `<div class="md-gaps">${per}</div>`;
    li.title = '点击将共用角度移到该档位';
    li.addEventListener('click', () => {
      state.thetaDeg = item.deg;
      renderMultiResults();
      draw();
    });
    ul.appendChild(li);
  }
}

function renderMultiLegend() {
  const r = state.multiResult;
  const el = $('multiLegend');
  if (!r || state.mode !== 'multi') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const items = r.specs
    .map(
      (s) =>
        `<span class="lg-item"><span class="lg-swatch" style="background:${
          SPEC_COLORS[s.index % SPEC_COLORS.length]
        }"></span>规格 ${s.index + 1}（${fmtMm(s.circumference)} mm）禁用</span>`
    )
    .join('');
  el.innerHTML =
    `<div class="lg-row">${items}</div>` +
    `<div class="lg-row"><span class="lg-item"><span class="lg-swatch common"></span>所有规格共用安全段</span>` +
    (r.noSolution
      ? `<span class="lg-item"><span class="lg-swatch conflict"></span>冲突区间（首次归零）</span>` +
        (r.fallback ? `<span class="lg-item"><span class="lg-swatch fallback"></span>最小违约备选角度</span>` : '')
      : '') +
    `</div>`;
}

/* ---------------- 吸附 ---------------- */

/** 将角度 m (mm) 吸附到最近可行位置；无解时返回 null。启用档位时仅吸附到可用档位。 */
function snapToFeasible(m) {
  const r = state.result;
  if (!r || r.noSolution) return null;
  const C = r.circumference;
  if (r.feasible.length === 0) return null;

  const inGap = (x) =>
    r.feasible.some((s) => {
      const e = s.wraps ? s.endMm + C : s.endMm;
      return (x >= s.startMm && x <= e) || (x + C >= s.startMm && x + C <= e);
    });

  // 设备档位约束：只能落在可用档位上，取圆周距离最近（并列取较小角度）
  if (r.detents && r.detents.enabled) {
    if (r.detents.noAvailable || r.detents.available.length === 0) return null;
    let best = null;
    for (const d of r.detents.available) {
      const cand = d.mm;
      const diff = Math.abs(cand - m);
      const dist = Math.min(diff, C - diff);
      if (
        !best ||
        dist < best.dist - 1e-9 ||
        (Math.abs(dist - best.dist) <= 1e-9 && cand < best.v)
      ) {
        best = { dist, v: cand };
      }
    }
    return best ? best.v : null;
  }

  if (inGap(m)) return m;

  let best = null;
  for (const s of r.feasible) {
    const e = s.wraps ? s.endMm + C : s.endMm;
    for (const cand of [mod(s.startMm, C), mod(e, C)]) {
      const d = Math.min(Math.abs(cand - m), C - Math.abs(cand - m));
      if (!best || d < best.d) best = { d, v: cand };
    }
  }
  return best ? best.v : null;
}

/** 多规格：将角度吸附到最近的共用安全段；无共同解返回 null。启用档位时仅吸附可用档位。 */
function snapToCommon(m) {
  const r = state.multiResult;
  if (!r || r.noSolution) return null;

  // 设备档位约束
  if (r.detents && r.detents.enabled) {
    if (r.detents.noAvailable || r.detents.available.length === 0) return null;
    let best = null;
    for (const d of r.detents.available) {
      const cand = d.deg;
      const diff = Math.abs(cand - m);
      const dist = Math.min(diff, 360 - diff);
      if (
        !best ||
        dist < best.dist - 1e-9 ||
        (Math.abs(dist - best.dist) <= 1e-9 && cand < best.v)
      ) {
        best = { dist, v: cand };
      }
    }
    return best ? best.v : null;
  }

  if (r.fullCircle) return m;

  const inArc = (x, a) =>
    a.wraps ? x >= a.startDeg - 1e-9 || x <= a.endDeg + 1e-9
            : x >= a.startDeg - 1e-9 && x <= a.endDeg + 1e-9;
  if (r.common.some((a) => inArc(m, a))) return m;

  let best = null;
  for (const a of r.common) {
    for (const cand of [a.startDeg, a.endDeg]) {
      const d = Math.min(Math.abs(cand - m), 360 - Math.abs(cand - m));
      if (!best || d < best.d) best = { d, v: cand };
    }
  }
  return best ? best.v : null;
}

/* ---------------- Canvas ---------------- */

function geom() {
  const dpr = window.devicePixelRatio || 1;
  const size = 520;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cx: size / 2, cy: size / 2, R: 170, size };
}

/**
 * 绘制设备档位刻度（角度域，单/多规格共用）。
 * 可用档位绿色长刻度；无可用档位时，最近档位琥珀色，其余灰色短刻度。
 * @param {object} det 结果中的 detents 对象
 * @param {number} ringR 最外侧环半径（刻度画在其外）
 */
function drawDetentTicks(c, cx, cy, det, ringR, fallbackIndex = null) {
  if (!det || !det.enabled) return;
  const availSet = new Set((det.available || []).map((d) => d.index));
  const nearSet = new Set();
  (det.nearest || []).forEach((n) => {
    if (n.before) nearSet.add(n.before.index);
    if (n.after) nearSet.add(n.after.index);
  });
  const radDeg = (deg) => (deg / 360) * TAU - Math.PI / 2;
  det.positions.forEach((deg, index) => {
    const a = radDeg(deg);
    const available = availSet.has(index);
    const near = nearSet.has(index) || index === fallbackIndex;
    const r0 = ringR + 24;
    const r1 = available ? ringR + 32 : ringR + 29;
    c.beginPath();
    c.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
    c.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
    c.strokeStyle = available
      ? '#0f7a3d'
      : near
        ? '#d97706'
        : '#c4c9d2';
    c.lineWidth = available ? 2.2 : 1.2;
    c.stroke();
  });
}

/** 无可用档位时，在距可行段最近的前后档位画琥珀色菱形标记。 */
function drawNearestDetentMarkers(c, cx, cy, det, rMark) {
  if (!det || !det.enabled || !det.noAvailable) return;
  const radDeg = (deg) => (deg / 360) * TAU - Math.PI / 2;
  const drawMark = (deg) => {
    const a = radDeg(deg);
    const x = cx + rMark * Math.cos(a);
    const y = cy + rMark * Math.sin(a);
    c.save();
    c.translate(x, y);
    c.rotate(a + Math.PI / 2);
    c.fillStyle = '#d97706';
    c.beginPath();
    c.moveTo(0, -5);
    c.lineTo(4, 0);
    c.lineTo(0, 5);
    c.lineTo(-4, 0);
    c.closePath();
    c.fill();
    c.restore();
  };
  for (const n of det.nearest || []) {
    if (n.before) drawMark(n.before.deg);
    if (n.after) drawMark(n.after.deg);
  }
}

/** 我们的角度约定：0° 在正上方，顺时针为正；转为 canvas 弧度 */
function rad(mmAngle, C) {
  return (mmAngle / C) * TAU - Math.PI / 2;
}

function arc(cx, cy, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1, false);
  ctx.stroke();
}

function drawRingSegments(cx, cy, r, segments, C, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for (const s of segments) {
    const span =
      s.widthMm !== undefined ? s.widthMm : (s.wraps ? s.endMm + C : s.endMm) - s.startMm;
    if (span >= C - 1e-9) {
      arc(cx, cy, r, 0, TAU); // 整圈
      continue;
    }
    const a0 = rad(s.startMm, C);
    const a1 = s.wraps ? rad(s.endMm + C, C) : rad(s.endMm, C);
    arc(cx, cy, r, a0, a1);
  }
}

function drawSingle() {
  const r = state.result;
  const { cx, cy, R, size } = geom();
  ctx.clearRect(0, 0, size, size);
  if (!r) return;
  const C = r.circumference;

  // 刻度（每 30°）
  ctx.strokeStyle = '#d1d5db';
  ctx.fillStyle = '#9ca3af';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 30) {
    const a = rad((d / 360) * C, C);
    const x1 = cx + (R + 14) * Math.cos(a);
    const y1 = cy + (R + 14) * Math.sin(a);
    const x2 = cx + (R + 22) * Math.cos(a);
    const y2 = cy + (R + 22) * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.fillText(`${d}°`, cx + (R + 36) * Math.cos(a), cy + (R + 36) * Math.sin(a));
  }

  // 外环底色
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 20;
  arc(cx, cy, R, 0, TAU);

  if (r.noSolution) {
    // 无解：整圈禁用区间链
    drawRingSegments(cx, cy, R, r.forbiddenChain, C, '#d43a3a', 20);
  } else {
    drawRingSegments(cx, cy, R, r.feasible, C, '#1e9e50', 20);
    drawRingSegments(cx, cy, R, r.forbiddenMerged, C, '#d43a3a', 20);
  }

  // 设备档位刻度（环外）与“无可用档位”时的最近档位标记
  drawDetentTicks(ctx, cx, cy, r.detents, R);
  if (r.detents && r.detents.enabled && !r.noSolution && r.detents.noAvailable) {
    drawNearestDetentMarkers(ctx, cx, cy, r.detents, R + 12);
  }

  // 印刷保护区（内环）
  const zoneSegs = [];
  for (const pieces of r.zonePieces) {
    for (const p of pieces) zoneSegs.push({ startMm: p.startMm, endMm: p.endMm, wraps: false });
  }
  ctx.globalAlpha = 0.9;
  drawRingSegments(cx, cy, R - 34, zoneSegs, C, '#e8912d', 12);
  ctx.globalAlpha = 1;

  // 接缝扇形（宽度 = 接缝安全宽度）
  const theta = state.thetaMm;
  const a0 = rad(theta, C);
  const a1 = rad(theta + r.seamWidth, C);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R - 46, a0, a1, false);
  ctx.closePath();
  // 接缝位置线（先计算是否为可用档位，供扇形与位置线着色）
  const thetaOnAvailable =
    !r.detents || !r.detents.enabled ||
    r.detents.available.some((d) => Math.abs(d.mm - theta) <= C * 1e-7);
  ctx.fillStyle = r.noSolution
    ? 'rgba(212,58,58,0.18)'
    : thetaOnAvailable
      ? 'rgba(37,99,235,0.18)'
      : 'rgba(217,119,6,0.18)';
  ctx.fill();

  ctx.strokeStyle = r.noSolution ? '#d43a3a' : thetaOnAvailable ? '#2563eb' : '#d97706';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx + (R - 46) * Math.cos(a0), cy + (R - 46) * Math.sin(a0));
  ctx.lineTo(cx + (R + 26) * Math.cos(a0), cy + (R + 26) * Math.sin(a0));
  ctx.stroke();

  // 拖动时未吸附的原始位置（虚线）
  if (state.dragging && state.rawMm !== null && Math.abs(mod(state.rawMm - theta + C / 2, C) - C / 2) > C / 720) {
    const ar = rad(state.rawMm, C);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + (R - 46) * Math.cos(ar), cy + (R - 46) * Math.sin(ar));
    ctx.lineTo(cx + (R + 26) * Math.cos(ar), cy + (R + 26) * Math.sin(ar));
    ctx.stroke();
    ctx.restore();
  }

  // 最优位置标记（启用档位但无可用档位时不显示连续最优点）
  if (r.best && !(r.detents && r.detents.enabled && r.detents.noAvailable)) {
    const ab = rad(r.best.mm, C);
    const bx = cx + (R + 10) * Math.cos(ab);
    const by = cy + (R + 10) * Math.sin(ab);
    ctx.fillStyle = '#065f46';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 6 * Math.cos(ab - 0.35), by - 6 * Math.sin(ab - 0.35));
    ctx.lineTo(bx - 6 * Math.cos(ab + 0.35), by - 6 * Math.sin(ab + 0.35));
    ctx.closePath();
    ctx.fill();
  }

  // 中心文字
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (r.noSolution) {
    ctx.fillStyle = '#d43a3a';
    ctx.fillText('无解', cx, cy - 12);
    ctx.font = '13px sans-serif';
    ctx.fillText('禁用区间覆盖整圈', cx, cy + 14);
  } else {
    ctx.fillText(`${fmtDeg((theta / C) * 360)}°`, cx, cy - 10);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`${fmtMm(theta)} mm`, cx, cy + 14);
  }

  // 图例
  const detentsOn = !!(r.detents && r.detents.enabled);
  let legend = r.noSolution
    ? [['#d43a3a', '禁用（覆盖整圈）'], ['#e8912d', '印刷保护区']]
    : [['#1e9e50', '可行'], ['#d43a3a', '禁用'], ['#e8912d', '印刷保护区'], ['#2563eb', '接缝']];
  if (detentsOn && !r.noSolution) {
    legend.push(['#0f7a3d', '可用档位']);
    if (r.detents.noAvailable) legend.push(['#d97706', '最近档位']);
  }
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  let lx = 16;
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, size - 22, 12, 12);
    ctx.fillStyle = '#374151';
    ctx.fillText(label, lx + 16, size - 15);
    lx += 16 + ctx.measureText(label).width + 18;
  }

  // 当前位置文字
  const deg = fmtDeg((theta / C) * 360);
  $('currentPos').textContent = r.noSolution
    ? '当前无可行位置：请缩小接缝宽度或调整保护区'
    : detentsOn && r.detents.noAvailable
      ? '连续区间有解，但无可用档位：灰色为全部档位，琥珀色为距可行段最近的档位'
      : detentsOn
        ? `当前接缝位置（第 ${currentSingleDetentLabel(r)} 档）：${deg}°（${fmtMm(theta)} mm）`
        : `当前接缝位置：${deg}°（${fmtMm(theta)} mm）`;
  markActiveSegment();
}

/** 当前接缝位置对应的档位序号文本（若非可用档位返回 “—”）。 */
function currentSingleDetentLabel(r) {
  const deg = (state.thetaMm / r.circumference) * 360;
  const hit = (r.detents.available || []).find((d) => Math.abs(d.deg - deg) <= 1e-7);
  return hit ? `${hit.index + 1}/${r.detents.steps}` : '—';
}

/* ---------------- 多规格 Canvas ---------------- */

function multiRadDeg(deg) {
  return (deg / 360) * TAU - Math.PI / 2;
}

function multiDegArc(c, cy2, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(c, cy2, r, multiRadDeg(a0), multiRadDeg(a1), false);
  ctx.stroke();
}

function drawDegreeRing(cx, cy, r, arcs, color, width, opts = {}) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  if (opts.dash) ctx.setLineDash(opts.dash);
  for (const a of arcs) {
    if (a.full || a.widthDeg >= 360 - 1e-6) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
      continue;
    }
    if (a.wraps) {
      multiDegArc(cx, cy, r, a.startDeg, 360);
      if (a.endDeg > 1e-9) multiDegArc(cx, cy, r, 0, a.endDeg);
    } else if (a.endDeg - a.startDeg > 1e-9) {
      multiDegArc(cx, cy, r, a.startDeg, a.endDeg);
    }
  }
  if (opts.dash) ctx.setLineDash([]);
}

function drawMulti() {
  const r = state.multiResult;
  const { cx, cy, R, size } = geom();
  ctx.clearRect(0, 0, size, size);
  if (!r) return;

  // 刻度（每 30°）
  ctx.strokeStyle = '#d1d5db';
  ctx.fillStyle = '#9ca3af';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 30) {
    const a = multiRadDeg(d);
    const x1 = cx + (R + 14) * Math.cos(a);
    const y1 = cy + (R + 14) * Math.sin(a);
    const x2 = cx + (R + 22) * Math.cos(a);
    const y2 = cy + (R + 22) * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.fillText(`${d}°`, cx + (R + 36) * Math.cos(a), cy + (R + 36) * Math.sin(a));
  }

  // 各规格禁用环（颜色区分、半透明叠加），由外向内排列
  const n = r.specs.length;
  const ringW = 7;
  const ringGap = 3;
  const outR = R + 6;
  r.specs.forEach((s) => {
    const ringR = outR - s.index * (ringW + ringGap);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = ringW;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, TAU);
    ctx.stroke();

    const color = SPEC_COLORS[s.index % SPEC_COLORS.length];
    const arcs = s.result.noSolution
      ? [{ startDeg: 0, endDeg: 360, widthDeg: 360, full: true }]
      : s.result.forbiddenMerged.map((f) => ({
          startDeg: f.startDeg,
          endDeg: f.endDeg,
          widthDeg: f.endDeg - f.startDeg,
        }));
    ctx.globalAlpha = 0.75;
    drawDegreeRing(cx, cy, ringR, arcs, color, ringW);
    ctx.globalAlpha = 1;
  });

  // 共用安全段环（绿色）置于禁用环内侧
  const commonR = outR - n * (ringW + ringGap) - 8;
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(cx, cy, commonR, 0, TAU);
  ctx.stroke();
  if (!r.noSolution) {
    drawDegreeRing(cx, cy, commonR, r.common, '#1e9e50', 14);
  }

  // 冲突区间（首次归零）：红虚线叠在共用环上
  if (r.noSolution && r.blocker) {
    drawDegreeRing(cx, cy, commonR, r.blocker.conflictSegments, '#d43a3a', 14, {
      dash: [5, 4],
    });
  }

  // 设备档位刻度（最外侧禁用环之外）与“无可用档位”最近标记
  const fbDetentIndex =
    r.noSolution && r.fallback && r.detents && r.detents.enabled
      ? r.fallback.detentIndex
      : null;
  drawDetentTicks(ctx, cx, cy, r.detents, outR, fbDetentIndex);
  if (!r.noSolution && r.detents && r.detents.enabled && r.detents.noAvailable) {
    drawNearestDetentMarkers(ctx, cx, cy, r.detents, outR + 12);
  }

  // 当前共用角度位置线
  if (!r.noSolution) {
    const theta = state.thetaDeg;
    const onAvailable =
      !r.detents || !r.detents.enabled ||
      r.detents.available.some((d) => Math.abs(d.deg - theta) <= 1e-7);
    const a = multiRadDeg(theta);
    ctx.strokeStyle = onAvailable ? '#2563eb' : '#d97706';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + (commonR - 10) * Math.cos(a), cy + (commonR - 10) * Math.sin(a));
    ctx.lineTo(cx + (R + 26) * Math.cos(a), cy + (R + 26) * Math.sin(a));
    ctx.stroke();

    // 拖动时未吸附的原始位置（虚线）
    if (
      state.dragging &&
      state.rawDeg !== null &&
      Math.abs(mod(state.rawDeg - theta + 180, 360) - 180) > 0.5
    ) {
      const ar = multiRadDeg(state.rawDeg);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + (commonR - 10) * Math.cos(ar), cy + (commonR - 10) * Math.sin(ar));
      ctx.lineTo(cx + (R + 26) * Math.cos(ar), cy + (R + 26) * Math.sin(ar));
      ctx.stroke();
      ctx.restore();
    }

    // 默认角度标记
    if (r.best) {
      const ab = multiRadDeg(r.best.deg);
      const bx = cx + (commonR + 12) * Math.cos(ab);
      const by = cy + (commonR + 12) * Math.sin(ab);
      ctx.fillStyle = '#065f46';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - 6 * Math.cos(ab - 0.35), by - 6 * Math.sin(ab - 0.35));
      ctx.lineTo(bx - 6 * Math.cos(ab + 0.35), by - 6 * Math.sin(ab + 0.35));
      ctx.closePath();
      ctx.fill();
    }
  } else if (r.fallback) {
    // 无共同解：琥珀色位置线 + 菱形标记“最小违约备选”角度
    const a = multiRadDeg(r.fallback.deg);
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + (commonR - 10) * Math.cos(a), cy + (commonR - 10) * Math.sin(a));
    ctx.lineTo(cx + (R + 26) * Math.cos(a), cy + (R + 26) * Math.sin(a));
    ctx.stroke();
    const mx = cx + (commonR + 14) * Math.cos(a);
    const my = cy + (commonR + 14) * Math.sin(a);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillStyle = '#d97706';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(5, 0);
    ctx.lineTo(0, 6);
    ctx.lineTo(-5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 中心文字
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (r.noSolution) {
    ctx.fillStyle = '#d43a3a';
    ctx.fillText('无共同解', cx, cy - 12);
    ctx.font = '13px sans-serif';
    ctx.fillText(`规格 ${r.blocker ? r.blocker.index + 1 : ''} 使交集归零`, cx, cy + 8);
    if (r.fallback) {
      ctx.fillStyle = '#d97706';
      ctx.fillText(`备选 ${fmtDeg(r.fallback.deg)}°`, cx, cy + 26);
    }
  } else {
    ctx.fillText(`${fmtDeg(state.thetaDeg)}°`, cx, cy - 10);
    ctx.font = n > 4 ? '11px sans-serif' : '13px sans-serif';
    ctx.fillStyle = '#6b7280';
    if (n <= 4) {
      const mmText = r.specs
        .map((s) => `规格${s.index + 1} ${fmtMm((state.thetaDeg / 360) * s.circumference)}mm`)
        .join(' ｜ ');
      ctx.fillText(mmText, cx, cy + 16);
    } else {
      // 规格较多时分两行展示，避免溢出圆盘
      const half = Math.ceil(n / 2);
      const lineOf = (list) =>
        list
          .map((s) => `${s.index + 1}:${fmtMm((state.thetaDeg / 360) * s.circumference)}mm`)
          .join(' ｜ ');
      ctx.fillText(lineOf(r.specs.slice(0, half)), cx, cy + 12);
      ctx.fillText(lineOf(r.specs.slice(half)), cx, cy + 28);
    }
  }

  const detentsOn = !!(r.detents && r.detents.enabled);
  $('currentPos').textContent = r.noSolution
    ? r.fallback
      ? (detentsOn
          ? `无所有规格均安全的共用角度；琥珀色为最小违约备选档位：${fmtDeg(r.fallback.deg)}°` +
            `（第 ${r.fallback.detentIndex + 1}/${r.detents.steps} 档），最大侵入 ${fmtDeg(r.fallback.maxIntrusionDeg)}°`
          : `无所有规格均安全的共用角度；琥珀色为最小违约备选角度：${fmtDeg(r.fallback.deg)}°` +
            `（最大侵入 ${fmtDeg(r.fallback.maxIntrusionDeg)}°，总侵入 ${fmtDeg(r.fallback.totalIntrusionDeg)}°）`)
      : '当前无所有规格均安全的共用角度'
    : detentsOn && r.detents.noAvailable
      ? '共用段连续有解，但无可用档位：灰色为全部档位，琥珀色为距共用段最近的档位'
      : detentsOn
        ? `当前共用角度（第 ${currentMultiDetentLabel(r)} 档）：${fmtDeg(state.thetaDeg)}°`
        : `当前共用角度：${fmtDeg(state.thetaDeg)}°`;
  markActiveCommon();
}

/** 当前共用角度对应的档位序号文本（若非可用档位返回 “—”）。 */
function currentMultiDetentLabel(r) {
  const hit = (r.detents.available || []).find((d) => Math.abs(d.deg - state.thetaDeg) <= 1e-7);
  return hit ? `${hit.index + 1}/${r.detents.steps}` : '—';
}

/** 统一绘制入口：按当前模式分发。 */
function draw() {
  if (state.mode === 'multi') drawMulti();
  else drawSingle();
}

/* ---------------- 拖动 ---------------- */

function pointerMm(ev) {
  const rect = canvas.getBoundingClientRect();
  const { cx, cy, size } = geom();
  const scale = size / rect.width;
  const x = (ev.clientX - rect.left) * scale - cx;
  const y = (ev.clientY - rect.top) * scale - cy;
  const C = state.result.circumference;
  return mod((Math.atan2(x, -y) / TAU) * C, C);
}

function pointerDeg(ev) {
  const rect = canvas.getBoundingClientRect();
  const { cx, cy } = geom();
  const scale = 520 / rect.width;
  const x = (ev.clientX - rect.left) * scale - cx;
  const y = (ev.clientY - rect.top) * scale - cy;
  return mod((Math.atan2(x, -y) / TAU) * 360, 360);
}

canvas.addEventListener('pointerdown', (ev) => {
  if (state.mode === 'multi') {
    if (!state.multiResult) return;
    state.dragging = true;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(ev.pointerId);
    state.rawDeg = pointerDeg(ev);
    const snapped = snapToCommon(state.rawDeg);
    if (snapped !== null) state.thetaDeg = snapped;
    draw();
    return;
  }
  if (!state.result) return;
  state.dragging = true;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(ev.pointerId);
  state.rawMm = pointerMm(ev);
  const snapped = snapToFeasible(state.rawMm);
  if (snapped !== null) state.thetaMm = snapped;
  draw();
});
canvas.addEventListener('pointermove', (ev) => {
  if (!state.dragging) return;
  if (state.mode === 'multi') {
    state.rawDeg = pointerDeg(ev);
    const snapped = snapToCommon(state.rawDeg);
    if (snapped !== null) state.thetaDeg = snapped;
    draw();
    return;
  }
  state.rawMm = pointerMm(ev);
  const snapped = snapToFeasible(state.rawMm);
  if (snapped !== null) state.thetaMm = snapped;
  draw();
});
function endDrag() {
  state.dragging = false;
  state.rawMm = null;
  state.rawDeg = null;
  canvas.classList.remove('dragging');
  draw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

/* ---------------- 方案快照 ---------------- */

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );
}

function snapshotMsg(text, type) {
  const el = $('snapshotMsg');
  el.textContent = text;
  el.className = 'snapshot-msg ' + (type || 'err');
  el.hidden = !text;
  if (text && type === 'ok') {
    clearTimeout(snapshotMsg._t);
    snapshotMsg._t = setTimeout(() => {
      el.hidden = true;
    }, 2500);
  }
}

function snapshotMetaText(s) {
  const i = s.input;
  const zones = `${i.zones.length} 个保护区`;
  const noSol = s.result && s.result.noSolution ? ' · 无解' : '';
  const det =
    i.detents && i.detents.enabled ? ` · ${i.detents.steps} 档/偏移 ${fmtDeg(i.detents.offsetDeg)}°` : '';
  return `${fmtTime(s.createdAt)} ｜ C=${fmtMm(i.circumference)} W=${fmtMm(i.seamWidth)} mm ｜ ${zones}${det}${noSol}`;
}

function renderSnapshotList() {
  const ul = $('snapshotList');
  const list = SnapshotStore.loadAll().sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
  ul.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '尚无快照：计算后输入名称并保存';
    ul.appendChild(li);
    updateCompareBtn();
    return;
  }

  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'snapshot-item';
    const idx = state.selected.indexOf(s.id);
    if (idx === 0) li.classList.add('selected', 'sel-a');
    if (idx === 1) li.classList.add('selected', 'sel-b');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = idx >= 0;
    cb.title = '选中用于比较（最多两个）';
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!state.selected.includes(s.id)) {
          if (state.selected.length >= 2) state.selected.shift();
          state.selected.push(s.id);
        }
      } else {
        state.selected = state.selected.filter((x) => x !== s.id);
      }
      renderSnapshotList();
    });

    const badge = document.createElement('span');
    badge.className = 'badge' + (idx === 1 ? ' b' : '');
    badge.textContent = idx === 1 ? 'B' : 'A';

    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="name">${escapeHtml(s.name)}</div><div class="meta">${escapeHtml(snapshotMetaText(s))}</div>`;

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'icon-btn';
    loadBtn.title = '载入该快照参数到表单';
    loadBtn.textContent = '载入';
    loadBtn.addEventListener('click', () => loadSnapshot(s.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn del';
    delBtn.title = '删除快照';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => deleteSnapshot(s.id));

    li.append(cb, badge, info, loadBtn, delBtn);
    ul.appendChild(li);
  }
  updateCompareBtn();
}

function updateCompareBtn() {
  $('compareSnapshots').disabled = state.selected.length !== 2;
}

function saveSnapshot() {
  if (state.mode === 'multi') {
    return snapshotMsg('快照仅保存单规格结果；请切回单规格模式');
  }
  if (!state.result || !state.lastInput) {
    return snapshotMsg('请先完成一次计算再保存');
  }
  const { ok, error } = SnapshotStore.createSnapshot(
    $('snapshotName').value,
    state.lastInput,
    state.result
  );
  if (!ok) return snapshotMsg(error);
  $('snapshotName').value = '';
  snapshotMsg('快照已保存到本地', 'ok');
  renderSnapshotList();
}

/** 多规格模式下禁用快照保存输入，并给出提示。 */
function updateSnapshotModeUI() {
  const multi = state.mode === 'multi';
  $('snapshotName').disabled = multi;
  $('saveSnapshot').disabled = multi;
  $('snapshotName').placeholder = multi
    ? '多规格模式不支持快照（仅单规格结果可保存）'
    : '快照名称，如：400mm 初始方案';
}

function loadSnapshot(id) {
  const s = SnapshotStore.getById(id);
  if (!s) return;
  setMode('single');
  $('circumference').value = s.input.circumference;
  $('seamWidth').value = s.input.seamWidth;
  fillDetents(s.input.detents);
  $('zones').innerHTML = '';
  for (const z of s.input.zones) addZoneRow(z.start, z.end);
  compute();
}

function deleteSnapshot(id) {
  const s = SnapshotStore.getById(id);
  if (!s) return;
  if (!window.confirm(`确定删除快照「${s.name}」？`)) return;
  SnapshotStore.remove(id);
  state.selected = state.selected.filter((x) => x !== id);
  if (
    state.currentDiff &&
    (state.currentDiff.a.id === id || state.currentDiff.b.id === id)
  ) {
    exitDiffMode();
  }
  renderSnapshotList();
}

/* ---------------- 快照差异 ---------------- */

function compareSelected() {
  if (state.selected.length !== 2) return;
  const a = SnapshotStore.getById(state.selected[0]);
  const b = SnapshotStore.getById(state.selected[1]);
  if (!a || !b) return snapshotMsg('快照不存在，可能已被删除');
  state.currentDiff = SnapshotDiff.diffSnapshots(a, b);
  $('livePreviewWrap').hidden = true;
  $('diffView').hidden = false;
  $('diffListPanel').hidden = false;
  renderDiffMeta();
  drawDiff();
  renderDiffSummary();
  renderDiffLists();
}

function exitDiffMode() {
  state.currentDiff = null;
  const dv = $('diffView');
  if (dv) dv.hidden = true;
  const lp = $('diffListPanel');
  if (lp) lp.hidden = true;
  const live = $('livePreviewWrap');
  if (live) live.hidden = false;
}

function renderDiffMeta() {
  const d = state.currentDiff;
  const line = (m, cls) =>
    `<span class="${cls}">${m.tag}</span> ${escapeHtml(m.name)}` +
    ` ｜ ${fmtTime(m.createdAt)} ｜ C=${fmtMm(m.circumference)} W=${fmtMm(m.seamWidth)} mm` +
    ` ｜ ${m.zoneCount} 个保护区${m.noSolution ? ' ｜ 无解' : ''}`;
  $('diffMeta').innerHTML = `${line(d.a, 'tag-a')}<br>${line(d.b, 'tag-b')}`;
}

function countDiff(set) {
  return { added: set.added.length, removed: set.removed.length, moves: set.moves.length };
}

function renderDiffSummary() {
  const keys = ['zones', 'forbidden', 'feasible'];
  const totals = { added: 0, removed: 0, moves: 0 };
  for (const k of keys) {
    const cnt = countDiff(state.currentDiff[k]);
    totals.added += cnt.added;
    totals.removed += cnt.removed;
    totals.moves += cnt.moves;
  }
  $('diffSummary').innerHTML =
    `<span class="pill add">新增 ${totals.added}</span>` +
    `<span class="pill remove">移除 ${totals.removed}</span>` +
    `<span class="pill move">边界移动 ${totals.moves}</span>`;
}

function fullCircle([a, b]) {
  return a <= 1e-6 && b >= 360 - 1e-6;
}
function intervalText(seg) {
  if (fullCircle(seg)) return '0.0° → 360.0°（整圈）';
  return `${fmtDeg(seg[0])}° → ${fmtDeg(seg[1])}°（宽 ${fmtDeg(seg[1] - seg[0])}°）`;
}
function mmText(seg, meta) {
  const a = (seg[0] / 360) * meta.circumference;
  const b = (seg[1] / 360) * meta.circumference;
  return `≈ ${fmtMm(a)} → ${fmtMm(b)} mm（${meta.tag}：C=${fmtMm(meta.circumference)}）`;
}
function signedText(delta) {
  if (delta === null) return '不变';
  const dir = delta > 0 ? '顺时针' : '逆时针';
  return `${delta > 0 ? '+' : ''}${fmtDeg(delta)}°（${dir}）`;
}

function renderDiffLists() {
  const d = state.currentDiff;
  const layers = [
    { key: 'zones', title: '保护区' },
    { key: 'forbidden', title: '合并禁用段' },
    { key: 'feasible', title: '可行段' },
  ];
  const host = $('diffLists');
  host.innerHTML = '';

  let anyDiff = false;
  for (const layer of layers) {
    const set = d[layer.key];
    const block = document.createElement('div');
    block.className = 'diff-block';
    let html = `<h3>${layer.title}</h3><ul>`;
    if (set.added.length === 0 && set.removed.length === 0 && set.moves.length === 0) {
      html += '</ul><div class="none">无差异</div>';
    } else {
      anyDiff = true;
      for (const seg of set.added) {
        html += `<li class="add">新增：${intervalText(seg)}<div class="sub">${mmText(seg, d.b)}</div></li>`;
      }
      for (const seg of set.removed) {
        html += `<li class="remove">移除：${intervalText(seg)}<div class="sub">${mmText(seg, d.a)}</div></li>`;
      }
      for (const m of set.moves) {
        html +=
          `<li class="move">边界移动：${fmtDeg(m.aSeg[0])}°→${fmtDeg(m.aSeg[1])}°` +
          ` 变为 ${fmtDeg(m.bSeg[0])}°→${fmtDeg(m.bSeg[1])}°` +
          `<div class="sub">起点 ${signedText(m.startDelta)} ｜ 终点 ${signedText(m.endDelta)}</div></li>`;
      }
      html += '</ul>';
    }
    block.innerHTML = html;
    host.appendChild(block);
  }
  if (!anyDiff) {
    const note = document.createElement('p');
    note.className = 'none';
    note.textContent = '两个快照的保护区、禁用段与可行段完全一致。';
    host.prepend(note);
  }
}

/* ---------------- 差异 Canvas ---------------- */

const diffCanvas = $('diffCanvas');
const diffCtx = diffCanvas.getContext('2d');

function diffGeom() {
  const dpr = window.devicePixelRatio || 1;
  const size = 520;
  if (diffCanvas.width !== size * dpr) {
    diffCanvas.width = size * dpr;
    diffCanvas.height = size * dpr;
  }
  diffCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cx: size / 2, cy: size / 2, size };
}
function radDeg(deg) {
  return (deg / 360) * TAU - Math.PI / 2;
}
function drawDegArc(c, cy2, r, a0, a1) {
  diffCtx.beginPath();
  diffCtx.arc(c, cy2, r, radDeg(a0), radDeg(a1), false);
  diffCtx.stroke();
}
function drawDegRing(cx, cy, r, segs, color, width) {
  diffCtx.strokeStyle = color;
  diffCtx.lineWidth = width;
  diffCtx.lineCap = 'butt';
  for (const [a, b] of segs) {
    if (fullCircle([a, b])) {
      diffCtx.beginPath();
      diffCtx.arc(cx, cy, r, 0, TAU);
      diffCtx.stroke();
    } else if (b - a > 1e-6) {
      drawDegArc(cx, cy, r, a, b);
    }
  }
}

/** 在环上绘制边界移动弧线与箭头：fromDeg → toDeg（带符号最短圆弧）。 */
function drawMoveArc(cx, cy, r, fromDeg, toDeg, width) {
  let delta = ((toDeg - fromDeg) % 360 + 360) % 360;
  if (delta > 180) delta -= 360;
  if (Math.abs(delta) < 1e-6) return;
  const ccw = delta < 0;
  diffCtx.save();
  diffCtx.globalAlpha = 0.9;
  diffCtx.strokeStyle = '#7c3aed';
  diffCtx.lineWidth = width;
  diffCtx.lineCap = 'round';
  diffCtx.beginPath();
  diffCtx.arc(cx, cy, r, radDeg(fromDeg), radDeg(toDeg), ccw);
  diffCtx.stroke();
  diffCtx.restore();

  // A 端空心点
  const ar = r + width / 2 + 9;
  const aa = radDeg(fromDeg);
  diffCtx.beginPath();
  diffCtx.arc(cx + ar * Math.cos(aa), cy + ar * Math.sin(aa), 3, 0, TAU);
  diffCtx.fillStyle = '#fff';
  diffCtx.fill();
  diffCtx.strokeStyle = '#7c3aed';
  diffCtx.lineWidth = 1.5;
  diffCtx.stroke();

  // B 端箭头（沿圆周切向）
  const ab = radDeg(toDeg);
  const sign = delta > 0 ? 1 : -1;
  const ux = Math.cos(ab);
  const uy = Math.sin(ab);
  const tx = -Math.sin(ab) * sign;
  const ty = Math.cos(ab) * sign;
  const bx = cx + ar * ux;
  const by = cy + ar * uy;
  diffCtx.beginPath();
  diffCtx.moveTo(bx + tx * 7, by + ty * 7);
  diffCtx.lineTo(bx - tx * 5 + ux * 4.5, by - ty * 5 + uy * 4.5);
  diffCtx.lineTo(bx - tx * 5 - ux * 4.5, by - ty * 5 - uy * 4.5);
  diffCtx.closePath();
  diffCtx.fillStyle = '#7c3aed';
  diffCtx.fill();
}

function drawDiffMoves(cx, cy, r, moves, width) {
  for (const m of moves) {
    if (m.startDelta !== null) drawMoveArc(cx, cy, r, m.aSeg[0], m.bSeg[0], width);
    if (m.endDelta !== null) drawMoveArc(cx, cy, r, m.aSeg[1], m.bSeg[1], width);
  }
}

function drawDiff() {
  const d = state.currentDiff;
  if (!d) return;
  const { cx, cy, size } = diffGeom();
  const c = diffCtx;
  c.clearRect(0, 0, size, size);

  // 刻度（每 30°）
  c.strokeStyle = '#d1d5db';
  c.fillStyle = '#9ca3af';
  c.lineWidth = 1;
  c.font = '11px sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let deg = 0; deg < 360; deg += 30) {
    const a = radDeg(deg);
    c.beginPath();
    c.moveTo(cx + 184 * Math.cos(a), cy + 184 * Math.sin(a));
    c.lineTo(cx + 192 * Math.cos(a), cy + 192 * Math.sin(a));
    c.stroke();
    c.fillText(`${deg}°`, cx + 206 * Math.cos(a), cy + 206 * Math.sin(a));
  }

  const rings = [
    { key: 'feasible', r: 170, w: 16 },
    { key: 'forbidden', r: 140, w: 12 },
    { key: 'zones', r: 110, w: 12 },
  ];
  for (const ring of rings) {
    const set = d[ring.key];
    drawDegRing(cx, cy, ring.r, [[0, 360]], '#e5e7eb', ring.w);
    drawDegRing(cx, cy, ring.r, set.common, '#9ca3af', ring.w);
    drawDegRing(cx, cy, ring.r, set.removed, '#dc2626', ring.w);
    drawDegRing(cx, cy, ring.r, set.added, '#16a34a', ring.w);
    drawDiffMoves(cx, cy, ring.r, set.moves, ring.w);
  }

  // 环位说明（左上）
  c.font = '12px sans-serif';
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  const layerLabels = [
    ['#6b7280', '外圈：可行段'],
    ['#6b7280', '中圈：合并禁用段'],
    ['#6b7280', '内圈：保护区'],
  ];
  layerLabels.forEach(([color, label], i) => {
    const y = 18 + i * 18;
    c.fillStyle = color;
    c.fillRect(16, y - 6, 10, 10);
    c.fillStyle = '#374151';
    c.fillText(label, 32, y);
  });

  // 中心文字
  c.fillStyle = '#1f2937';
  c.font = 'bold 18px sans-serif';
  c.textAlign = 'center';
  c.fillText('快照差异', cx, cy - 22);
  c.font = '12px sans-serif';
  c.fillStyle = '#2563eb';
  c.fillText(`A：${truncate(d.a.name, 14)}`, cx, cy);
  c.fillStyle = '#7c3aed';
  c.fillText(`B：${truncate(d.b.name, 14)}`, cx, cy + 18);
  c.fillStyle = '#6b7280';
  c.fillText('按圆周角度比较', cx, cy + 38);

  // 图例（底部）
  const legend = [
    ['#16a34a', '新增（B 有 A 无）'],
    ['#dc2626', '移除（A 有 B 无）'],
    ['#7c3aed', '边界移动'],
    ['#9ca3af', '共有'],
  ];
  c.font = '11px sans-serif';
  c.textAlign = 'left';
  let lx = 12;
  const ly = size - 14;
  for (const [color, label] of legend) {
    c.fillStyle = color;
    c.fillRect(lx, ly - 6, 10, 10);
    c.fillStyle = '#374151';
    c.fillText(label, lx + 14, ly);
    lx += 14 + c.measureText(label).width + 12;
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ---------------- 初始化 ---------------- */

$('addZone').addEventListener('click', () => {
  addZoneRow();
  scheduleCompute();
});
$('addSpec').addEventListener('click', () => {
  if ($('specs').children.length < MAX_SPECS_UI) {
    addSpecRow('');
    refreshSpecRows();
    scheduleCompute();
  }
});
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});
$('compute').addEventListener('click', compute);
$('circumference').addEventListener('input', scheduleCompute);
$('seamWidth').addEventListener('input', scheduleCompute);
$('detentsEnabled').addEventListener('change', () => {
  updateDetentsUI();
  updatePreviewHint();
  scheduleCompute();
});
$('detentSteps').addEventListener('input', scheduleCompute);
$('detentOffset').addEventListener('input', scheduleCompute);
$('loadExample').addEventListener('click', () => {
  $('seamWidth').value = 20;
  $('zones').innerHTML = '';
  addZoneRow(60, 120);
  addZoneRow(200, 260);
  if (state.mode === 'multi') {
    // 多规格示例：同一组保护区在 3 个周长下映射到不同角度，公共段跨零点
    $('specs').innerHTML = '';
    addSpecRow(320);
    addSpecRow(400);
    addSpecRow(500);
    refreshSpecRows();
  } else {
    $('circumference').value = 400;
    addZoneRow(350, 30); // 跨零点保护区
  }
  compute();
});
window.addEventListener('resize', () => {
  draw();
  drawDiff();
});

// 快照相关
$('saveSnapshot').addEventListener('click', saveSnapshot);
$('snapshotName').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') saveSnapshot();
});
$('compareSnapshots').addEventListener('click', compareSelected);
$('exitDiff').addEventListener('click', () => {
  exitDiffMode();
  draw();
});
renderSnapshotList();
refreshSpecRows();
updateSnapshotModeUI();
updateDetentsUI();
updatePreviewHint();

// 默认载入示例并计算
$('loadExample').click();
