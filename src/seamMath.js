'use strict';

/**
 * 圆筒包装接缝避让核心算法。
 *
 * 模型：筒体周长 C (mm) 对应 360°。接缝（含安全余量）占宽度 W (mm)。
 * 印刷保护区以 [start, end] (mm) 给出，沿周向正向延伸，允许跨零点。
 * 旋转量为 θ (mm, 0 <= θ < C)，表示接缝起点落在周向 θ 处，
 * 接缝占据 [θ, θ+W] (mod C)。接缝与任一保护区相交的 θ 即禁用。
 * 因此对保护区段 [a, b]，禁用区间为 [a-W, b] (mod C)。
 */

const EPS = 1e-9;

const { parseDetents, buildSingleDetents, circDistDeg, FULL: DEG_FULL } = require('./detents');

function mod(n, m) {
  return ((n % m) + m) % m;
}

function mmToDeg(mm, C) {
  return (mm / C) * 360;
}

/**
 * 将保护区 [startMm, endMm] 归一化到 [0, C] 上的若干不跨零区间。
 * 语义：从 start 沿正向走到 end（模 C）。start === end 视为零长度（忽略）；
 * 正向长度恰好为 C 的整数倍且端点不同视为整圈。
 * @returns {Array<[number, number]>} 满足 0 <= a <= b <= C 的区间列表
 */
function normalizeZone(startMm, endMm, C) {
  const len = mod(endMm - startMm, C);
  if (len === 0) {
    // 端点不同但正向距离为整圈 → 覆盖整圈；否则零长度，忽略
    return endMm !== startMm ? [[0, C]] : [];
  }
  const a = mod(startMm, C);
  const b = mod(endMm, C);
  if (a <= b) return [[a, b]];
  const pieces = [];
  if (C - a > EPS) pieces.push([a, C]);
  if (b > EPS) pieces.push([0, b]);
  return pieces;
}

/**
 * 由保护区段 [a, b]（已归一化到 [0, C]）生成接缝起点的禁用区间，
 * 即 [a-W, b] (mod C)，结果拆分为 [0, C] 内的不跨零片段。
 */
function forbiddenPieces(a, b, W, C) {
  const s = a - W;
  const e = b;
  if (e - s >= C - EPS) return [[0, C]];
  if (s < 0) {
    const pieces = [[s + C, C]];
    if (e > EPS) pieces.push([0, e]);
    return pieces;
  }
  return [[s, e]];
}

/** 合并 [0, C] 内的线性区间（不跨零合并，跨零由环形空隙处理）。 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b - a > EPS)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + EPS) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

/**
 * 求合并后禁用区间在圆周上的空隙，即可行段。
 * 返回线性化区间，跨零空隙的 end 可能大于 C（如 [370, 410) 表示 370..C 与 0..10）。
 */
function computeGaps(merged, C) {
  if (merged.length === 0) return [[0, C]];
  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const s = merged[i][1];
    const e = merged[i + 1][0];
    if (e - s > EPS) gaps.push([s, e]);
  }
  const s = merged[merged.length - 1][1];
  const e = merged[0][0] + C;
  if (e - s > EPS) gaps.push([s, e]);
  return gaps;
}

/**
 * 主入口。
 * @param {number} C 周长 (mm)，> 0
 * @param {number} W 接缝安全宽度 (mm)，>= 0
 * @param {Array<{start: number, end: number}>} zones 印刷保护区 (mm)
 * @param {object} [detentsOpt] 设备档位约束
 *        {enabled:boolean, steps?:2～360 整数, offsetDeg?:number}
 */
function computeSeamAvoidance(C, W, zones, detentsOpt) {
  const zonePieces = [];
  const rawForbidden = [];
  for (const z of zones) {
    const pieces = normalizeZone(z.start, z.end, C);
    zonePieces.push(pieces);
    for (const [a, b] of pieces) {
      for (const p of forbiddenPieces(a, b, W, C)) rawForbidden.push(p);
    }
  }

  const merged = mergeIntervals(rawForbidden);
  const gaps = computeGaps(merged, C);
  const noSolution = gaps.length === 0;

  const feasible = gaps.map(([s, e]) => {
    const startMm = mod(s, C);
    const endMm = mod(e, C);
    return {
      startMm,
      endMm,
      startDeg: mmToDeg(startMm, C),
      endDeg: mmToDeg(endMm, C),
      widthMm: e - s,
      widthDeg: mmToDeg(e - s, C),
      wraps: e > C + EPS,
    };
  });

  // 默认选择：段宽最大者的中点；并列取模 C 后角度最小者
  let best = null;
  if (!noSolution) {
    if (merged.length === 0) {
      // 无禁用区间：整圈等距，按“角度最小”取 0
      best = { mm: 0, deg: 0 };
    } else {
      let bestGap = null;
      for (const [s, e] of gaps) {
        const width = e - s;
        const mid = mod((s + e) / 2, C);
        if (
          !bestGap ||
          width > bestGap.width + EPS ||
          (Math.abs(width - bestGap.width) <= EPS && mid < bestGap.mid - EPS)
        ) {
          bestGap = { width, mid };
        }
      }
      best = { mm: bestGap.mid, deg: mmToDeg(bestGap.mid, C) };
    }
  }

  const coveredMm = merged.reduce((acc, [a, b]) => acc + (b - a), 0);

  const toView = ([a, b]) => ({
    startMm: a,
    endMm: b,
    startDeg: mmToDeg(a, C),
    endDeg: mmToDeg(b, C),
  });

  // 设备档位约束（可启用）：档位与可行段相交，默认档位取“瓶颈间隙最大、角度较小”
  const detentCfg = parseDetents(detentsOpt);
  let detents = { enabled: false };
  if (detentCfg.enabled) {
    const boundaryDeg = [];
    for (const [a, b] of merged) {
      for (const p of [mmToDeg(a, C), mmToDeg(b, C)]) {
        const q = mod(p, DEG_FULL);
        if (!boundaryDeg.some((x) => Math.abs(x - q) <= 1e-7 || Math.abs(x - q) >= DEG_FULL - 1e-7)) {
          boundaryDeg.push(q);
        }
      }
    }
    const noForbidden = boundaryDeg.length === 0;
    const gapDegAt = (deg) =>
      boundaryDeg.reduce((m, p) => Math.min(m, circDistDeg(deg, p)), Infinity);
    detents = buildSingleDetents(detentCfg, feasible, C, gapDegAt, noForbidden);
    if (noSolution) {
      // 保护区覆盖整圈：与“连续有解但无可用档位”区分
      detents.best = null;
      detents.noAvailable = false;
    } else {
      best = detents.best
        ? {
            mm: detents.best.mm,
            deg: detents.best.deg,
            detentIndex: detents.best.index,
          }
        : null; // 连续有解但没有任何可用档位
    }
  }

  return {
    circumference: C,
    seamWidth: W,
    seamWidthDeg: mmToDeg(W, C),
    zonePieces: zonePieces.map((pieces) => pieces.map(toView)),
    // 每个保护区扩展后的禁用片段（按起点排序、未合并），无解时用于展示覆盖整圈的区间链
    forbiddenChain: rawForbidden
      .slice()
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
      .map(toView),
    forbiddenMerged: merged.map(toView),
    feasible,
    best,
    noSolution,
    detents,
    coveragePct: Math.min(100, (coveredMm / C) * 100),
  };
}

module.exports = {
  EPS,
  mod,
  mmToDeg,
  normalizeZone,
  forbiddenPieces,
  mergeIntervals,
  computeGaps,
  computeSeamAvoidance,
};
