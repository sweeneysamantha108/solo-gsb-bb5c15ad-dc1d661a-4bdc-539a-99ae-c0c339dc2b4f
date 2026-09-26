'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeZone,
  forbiddenPieces,
  mergeIntervals,
  computeGaps,
  computeSeamAvoidance,
} = require('../src/seamMath');

test('normalizeZone: 普通区间', () => {
  assert.deepEqual(normalizeZone(60, 120, 400), [[60, 120]]);
});

test('normalizeZone: 跨零点区间拆分', () => {
  assert.deepEqual(normalizeZone(350, 30, 400), [
    [350, 400],
    [0, 30],
  ]);
  // 终点恰好落在零点：不产生零长度片段
  assert.deepEqual(normalizeZone(150, 400, 400), [[150, 400]]);
});

test('normalizeZone: 超出周长的输入按周长归一化', () => {
  assert.deepEqual(normalizeZone(410, 450, 400), [[10, 50]]);
  assert.deepEqual(normalizeZone(-30, 10, 400), [
    [370, 400],
    [0, 10],
  ]);
});

test('normalizeZone: 零长度忽略，整圈保留', () => {
  assert.deepEqual(normalizeZone(100, 100, 400), []);
  assert.deepEqual(normalizeZone(0, 400, 400), [[0, 400]]);
});

test('forbiddenPieces: 向左扩展接缝宽度并跨零拆分', () => {
  assert.deepEqual(forbiddenPieces(60, 120, 20, 400), [[40, 120]]);
  assert.deepEqual(forbiddenPieces(10, 50, 20, 400), [
    [390, 400],
    [0, 50],
  ]);
  assert.deepEqual(forbiddenPieces(0, 390, 20, 400), [[0, 400]]);
});

test('mergeIntervals: 合并重叠与相邻区间', () => {
  assert.deepEqual(
    mergeIntervals([
      [10, 50],
      [40, 80],
      [90, 100],
      [100, 120],
    ]),
    [
      [10, 80],
      [90, 120],
    ]
  );
});

test('computeGaps: 环形空隙含跨零段', () => {
  const gaps = computeGaps(
    [
      [0, 30],
      [100, 200],
    ],
    400
  );
  assert.deepEqual(gaps, [
    [30, 100],
    [200, 400], // 跨零空隙线性化为 [200, 400+0]
  ]);
});

test('computeSeamAvoidance: 可行段与默认选择（最远边界、并列取最小角度）', () => {
  // C=400, W=20；保护区 [60,120] → 禁用 [40,120]；[200,260] → 禁用 [180,260]
  // 可行段：[120,180]（宽60）、[260,440]（跨零，宽180）→ 最优为最宽段中点 350
  const r = computeSeamAvoidance(400, 20, [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ]);
  assert.equal(r.noSolution, false);
  assert.equal(r.feasible.length, 2);
  assert.equal(r.best.mm, 350);
  assert.equal(r.best.deg, 315);
});

test('computeSeamAvoidance: 等宽可行段并列时取角度最小者', () => {
  // 禁用 [0,100] 与 [200,300] → 可行 [100,200]、[300,400]，等宽，取中点较小者 150
  const r = computeSeamAvoidance(400, 0, [
    { start: 0, end: 100 },
    { start: 200, end: 300 },
  ]);
  assert.equal(r.best.mm, 150);
});

test('computeSeamAvoidance: 跨零点保护区参与计算', () => {
  // 保护区 [350,30]（跨零），W=20 → 禁用片段 [330,400]、[0,30]
  const r = computeSeamAvoidance(400, 20, [{ start: 350, end: 30 }]);
  assert.equal(r.noSolution, false);
  assert.deepEqual(
    r.forbiddenMerged.map((s) => [s.startMm, s.endMm]),
    [
      [0, 30],
      [330, 400],
    ]
  );
  assert.equal(r.feasible.length, 1);
  assert.equal(r.feasible[0].startMm, 30);
  assert.equal(r.feasible[0].endMm, 330);
  assert.equal(r.best.mm, 180);
});

test('computeSeamAvoidance: 无解时给出覆盖整圈的禁用区间链', () => {
  // 两个保护区扩展后相接，覆盖整圈
  const r = computeSeamAvoidance(400, 50, [
    { start: 0, end: 180 },
    { start: 150, end: 400 },
  ]);
  assert.equal(r.noSolution, true);
  assert.equal(r.best, null);
  assert.equal(r.feasible.length, 0);
  assert.equal(r.coveragePct, 100);
  // 区间链：各保护区扩展后的片段依次搭接，覆盖整圈
  assert.deepEqual(
    r.forbiddenChain.map((s) => [s.startMm, s.endMm]),
    [
      [0, 180],
      [100, 400],
      [350, 400],
    ]
  );
  assert.deepEqual(
    r.forbiddenMerged.map((s) => [s.startMm, s.endMm]),
    [[0, 400]]
  );
});

test('computeSeamAvoidance: 无保护区时整圈可行，默认 0°', () => {
  const r = computeSeamAvoidance(400, 20, []);
  assert.equal(r.noSolution, false);
  assert.equal(r.feasible.length, 1);
  assert.equal(r.feasible[0].widthMm, 400);
  assert.equal(r.best.mm, 0);
});
