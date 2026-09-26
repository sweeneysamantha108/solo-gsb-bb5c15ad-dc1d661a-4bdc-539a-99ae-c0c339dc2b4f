'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planRoute,
  arcWidthDeg,
  isFullArc,
  degInArc,
  onAvailableDetent,
} = require('../src/routePlan');
const { computeSeamAvoidance } = require('../src/seamMath');
const { computeMultiSpec } = require('../src/multiSpec');

function approx(actual, expected, eps = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !≈ ${expected}`);
}

/* ---------------- 几何辅助 ---------------- */

test('arcWidthDeg / isFullArc / degInArc：跨零弧与整圈弧', () => {
  const wrap = { startDeg: 350, endDeg: 10, wraps: true, widthDeg: 20 };
  approx(arcWidthDeg(wrap), 20);
  assert.equal(isFullArc(wrap), false);
  assert.equal(degInArc(355, wrap), true);
  assert.equal(degInArc(5, wrap), true);
  assert.equal(degInArc(180, wrap), false);
  assert.equal(isFullArc({ startDeg: 0, endDeg: 0, widthDeg: 360 }), true);
  assert.equal(isFullArc({ full: true }), true);
});

test('onAvailableDetent：圆周距离容差，跨 0° 命中', () => {
  const available = [{ deg: 0 }, { deg: 90 }, { deg: 359.9 }];
  assert.equal(onAvailableDetent(available, 0), true);
  assert.equal(onAvailableDetent(available, 359.9999995), true); // ≈0 档
  assert.equal(onAvailableDetent(available, 359.9), true);
  assert.equal(onAvailableDetent(available, 45), false);
});

/* ---------------- 基本路径规划 ---------------- */

test('planRoute：同一弧内自动选择唯一可行方向', () => {
  const arcs = [{ startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 }];
  // 150 → 120：只能逆时针 30°（顺时针会越出弧界）
  const ccw = planRoute(arcs, 150, 120, null);
  assert.equal(ccw.reachable, true);
  assert.equal(ccw.direction, 'ccw');
  approx(ccw.angleDeg, 30);
  assert.equal(ccw.cw.feasible, false);
  assert.equal(ccw.ccw.feasible, true);
  // 120 → 150：只能顺时针 30°
  const cw = planRoute(arcs, 120, 150, null);
  assert.equal(cw.direction, 'cw');
  approx(cw.angleDeg, 30);
});

test('planRoute：可行方向不一定更短，按唯一安全方向走', () => {
  // 弧 [100,300]（宽 200）：280 → 120 顺时针需 200° 且越界，只能逆时针 160°
  const arcs = [{ startDeg: 100, endDeg: 300, wraps: false, widthDeg: 200 }];
  const r = planRoute(arcs, 280, 120, null);
  assert.equal(r.reachable, true);
  assert.equal(r.direction, 'ccw');
  approx(r.angleDeg, 160);
  assert.equal(r.cw.feasible, false);
});

test('planRoute：跨 0° 弧与跨 0° 输入归一', () => {
  const arcs = [{ startDeg: 350, endDeg: 10, wraps: true, widthDeg: 20 }];
  const cw = planRoute(arcs, 355, 5, null);
  assert.equal(cw.direction, 'cw');
  approx(cw.angleDeg, 10);
  const ccw = planRoute(arcs, 5, 355, null);
  assert.equal(ccw.direction, 'ccw');
  approx(ccw.angleDeg, 10);
  // 输入超出 [0,360) 自动按整圈归一：370°→10°（弧边界，安全），-20°→340°（不安全）
  const norm = planRoute(arcs, 370, -20, null);
  approx(norm.fromDeg, 10);
  approx(norm.toDeg, 340);
  assert.equal(norm.reachable, false);
  assert.equal(norm.status, 'toUnsafe');
});

test('planRoute：整圈可行时两方向均可行，取较短者，等长取顺时针', () => {
  const arcs = [{ startDeg: 0, endDeg: 0, wraps: false, widthDeg: 360, full: true }];
  // 10°→200°：顺时针 190°、逆时针 170°，取较短的逆时针
  const ccw = planRoute(arcs, 10, 200, null);
  assert.equal(ccw.direction, 'ccw');
  approx(ccw.angleDeg, 170);
  // 200°→10°：顺时针 170°、逆时针 190°，取较短的顺时针
  const cw = planRoute(arcs, 200, 10, null);
  assert.equal(cw.direction, 'cw');
  approx(cw.angleDeg, 170);
  // 恰好 180°：等长取顺时针
  const tie = planRoute(arcs, 0, 180, null);
  assert.equal(tie.direction, 'cw');
  approx(tie.angleDeg, 180);
  assert.equal(tie.cw.feasible, true);
  assert.equal(tie.ccw.feasible, true);
});

test('planRoute：起终点相同转角为 0，取顺时针', () => {
  const arcs = [{ startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 }];
  const r = planRoute(arcs, 150, 150, null);
  assert.equal(r.reachable, true);
  assert.equal(r.direction, 'cw');
  approx(r.angleDeg, 0);
  // 跨整圈等价：45 与 405 相同
  const r2 = planRoute(arcs, 150, 510, null);
  approx(r2.angleDeg, 0);
  assert.equal(r2.reachable, true);
});

test('planRoute：两端各自安全但被禁用段隔开 → 不可达', () => {
  const arcs = [
    { startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 },
    { startDeg: 250, endDeg: 350, wraps: false, widthDeg: 100 },
  ];
  const r = planRoute(arcs, 150, 300, null);
  assert.equal(r.reachable, false);
  assert.equal(r.status, 'unreachable');
  assert.equal(r.direction, null);
  assert.equal(r.angleDeg, null);
  assert.match(r.message, /被禁用段隔开/);
});

test('planRoute：端点不安全分别指出；无安全弧时起点不安全', () => {
  const arcs = [{ startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 }];
  const fromBad = planRoute(arcs, 50, 150, null);
  assert.equal(fromBad.status, 'fromUnsafe');
  assert.match(fromBad.message, /起点/);
  const toBad = planRoute(arcs, 150, 300, null);
  assert.equal(toBad.status, 'toUnsafe');
  assert.match(toBad.message, /目标/);
  // 无安全弧（无解）
  const none = planRoute([], 10, 20, null);
  assert.equal(none.status, 'fromUnsafe');
  assert.equal(none.reachable, false);
});

test('planRoute：启用档位时两端还须落在可用档位上', () => {
  const arcs = [{ startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 }];
  const detents = { enabled: true, available: [{ deg: 120 }, { deg: 180 }] };
  // 两端均为可用档位 → 可达
  const ok = planRoute(arcs, 120, 180, detents);
  assert.equal(ok.reachable, true);
  assert.equal(ok.direction, 'cw');
  approx(ok.angleDeg, 60);
  // 起点安全但不在档位
  const fromBad = planRoute(arcs, 150, 180, detents);
  assert.equal(fromBad.status, 'fromNotOnDetent');
  assert.match(fromBad.message, /起点.*可用档位/);
  // 目标安全但不在档位
  const toBad = planRoute(arcs, 120, 150, detents);
  assert.equal(toBad.status, 'toNotOnDetent');
  assert.match(toBad.message, /目标.*可用档位/);
  // 不安全优先于不在档位
  const unsafe = planRoute(arcs, 50, 180, detents);
  assert.equal(unsafe.status, 'fromUnsafe');
  // 无可用档位：两端均报不在档位
  const noAvail = planRoute(arcs, 120, 180, { enabled: true, available: [] });
  assert.equal(noAvail.status, 'fromNotOnDetent');
});

/* ---------------- 与单/多规格结果集成 ---------------- */

test('planRoute + computeSeamAvoidance：基于可行段规划', () => {
  // C=400 W=20 保护区 [60,120][200,260] → 禁用 36°–108°、162°–234°
  // 可行：[108,162] 与跨零 [234,36]（宽 162°）
  const r = computeSeamAvoidance(400, 20, [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ]);
  const ok = planRoute(r.feasible, 300, 30, null);
  assert.equal(ok.reachable, true);
  assert.equal(ok.direction, 'cw');
  approx(ok.angleDeg, 90);
  // 跨段不可达
  const blocked = planRoute(r.feasible, 150, 300, null);
  assert.equal(blocked.status, 'unreachable');
  // 无解（覆盖整圈）：起点不安全
  const noSol = computeSeamAvoidance(400, 50, [
    { start: 0, end: 180 },
    { start: 150, end: 400 },
  ]);
  assert.equal(noSol.noSolution, true);
  const unreachable = planRoute(noSol.feasible, 10, 20, null);
  assert.equal(unreachable.status, 'fromUnsafe');
});

test('planRoute + computeSeamAvoidance + 档位：两端须在可用档位上', () => {
  const r = computeSeamAvoidance(
    400,
    20,
    [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ],
    { enabled: true, steps: 12 }
  );
  // 300° 与 30° 均为可用档位，同处跨零可行段
  const ok = planRoute(r.feasible, 300, 30, r.detents);
  assert.equal(ok.reachable, true);
  assert.equal(ok.direction, 'cw');
  approx(ok.angleDeg, 90);
  // 20° 安全（跨零可行段 0°–36° 内）但不是 12 档之一
  const toBad = planRoute(r.feasible, 300, 20, r.detents);
  assert.equal(toBad.status, 'toNotOnDetent');
});

test('planRoute + computeMultiSpec：基于共用安全段规划', () => {
  // 公共段 216°→36°（宽 180，跨零）
  const r = computeMultiSpec([400, 200], 20, [{ start: 60, end: 120 }]);
  assert.equal(r.noSolution, false);
  const ok = planRoute(r.common, 300, 30, null);
  assert.equal(ok.reachable, true);
  assert.equal(ok.direction, 'cw');
  approx(ok.angleDeg, 90);
  // 逆时针跨零：10 → 350 为逆时针 20°
  const ccw = planRoute(r.common, 10, 350, null);
  assert.equal(ccw.direction, 'ccw');
  approx(ccw.angleDeg, 20);
  // 100° 不在公共段内
  const toBad = planRoute(r.common, 300, 100, null);
  assert.equal(toBad.status, 'toUnsafe');
  // 无共同解：common 为空，起点不安全
  const noSol = computeMultiSpec([360, 180], 0, [
    { start: 90, end: 180 },
    { start: 180, end: 360 },
  ]);
  assert.equal(noSol.noSolution, true);
  const blocked = planRoute(noSol.common, 10, 20, null);
  assert.equal(blocked.status, 'fromUnsafe');
});
