'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postJson(p, body) {
  const res = await fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

const baseSingle = { circumference: 400, seamWidth: 20, zones: [{ start: 60, end: 120 }] };
const baseMulti = {
  circumferences: [400, 200],
  seamWidth: 20,
  zones: [{ start: 60, end: 120 }],
};

test('GET /api/health 正常', async () => {
  const res = await fetch(baseUrl + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('单规格：缺省/禁用档位返回禁用结构且结果不变', async () => {
  const a = await postJson('/api/compute', baseSingle);
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.detents, { enabled: false });

  const b = await postJson('/api/compute', { ...baseSingle, detents: { enabled: false, steps: 3 } });
  assert.equal(b.status, 200);
  assert.equal(b.json.detents.enabled, false);
  assert.equal(b.json.best.mm, a.json.best.mm);
});

test('单规格：合法档位参数返回档位结果', async () => {
  const r = await postJson('/api/compute', {
    ...baseSingle,
    detents: { enabled: true, steps: 12, offsetDeg: 0 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.detents.enabled, true);
  assert.equal(r.json.detents.steps, 12);
  assert.ok(Array.isArray(r.json.detents.available));
  assert.ok(typeof r.json.best.detentIndex === 'number');
});

test('单规格：steps 越界/非整数/非数字 → 400', async () => {
  for (const steps of [1, 361, 12.5, '12', NaN]) {
    const r = await postJson('/api/compute', {
      ...baseSingle,
      detents: { enabled: true, steps },
    });
    assert.equal(r.status, 400, `steps=${steps} 应 400`);
    assert.match(r.json.error, /steps/);
  }
});

test('单规格：offsetDeg 非数值 → 400；detents 非对象 → 400', async () => {
  const r1 = await postJson('/api/compute', {
    ...baseSingle,
    detents: { enabled: true, steps: 12, offsetDeg: 'x' },
  });
  assert.equal(r1.status, 400);
  assert.match(r1.json.error, /offsetDeg/);

  for (const bad of [null, [], 'on', 42]) {
    const r = await postJson('/api/compute', { ...baseSingle, detents: bad });
    assert.equal(r.status, 400, `detents=${JSON.stringify(bad)} 应 400`);
  }
});

test('单规格：偏移超出 ±360° 自动按整圈归一，不报错', async () => {
  const r = await postJson('/api/compute', {
    ...baseSingle,
    detents: { enabled: true, steps: 12, offsetDeg: 375 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.detents.offsetDeg, 15);
});

test('多规格：合法档位返回逐规格间隙；非法参数 → 400', async () => {
  const ok = await postJson('/api/compute-multi', {
    ...baseMulti,
    detents: { enabled: true, steps: 8 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.detents.enabled, true);
  for (const d of ok.json.detents.available) {
    assert.equal(d.gaps.length, 2);
  }

  const bad = await postJson('/api/compute-multi', {
    ...baseMulti,
    detents: { enabled: true, steps: 0 },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /steps/);

  const badType = await postJson('/api/compute-multi', {
    ...baseMulti,
    detents: 'yes',
  });
  assert.equal(badType.status, 400);
});

test('多规格：连续公共段有解但无可用档位时 noAvailable=true 且 best=null', async () => {
  const r = await postJson('/api/compute-multi', {
    circumferences: [360, 360],
    seamWidth: 0,
    zones: [
      { start: 0, end: 30 },
      { start: 40, end: 360 },
    ],
    detents: { enabled: true, steps: 12, offsetDeg: 15 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.noSolution, false);
  assert.equal(r.json.best, null);
  assert.equal(r.json.detents.noAvailable, true);
  assert.equal(r.json.detents.nearest.length, 1);
});

test('多规格：无共同解时返回最小违约备选 fallback（关闭/启用档位）', async () => {
  const body = {
    circumferences: [360, 180],
    seamWidth: 0,
    zones: [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ],
  };
  const r = await postJson('/api/compute-multi', body);
  assert.equal(r.status, 200);
  assert.equal(r.json.noSolution, true);
  assert.equal(r.json.best, null);
  assert.ok(r.json.fallback);
  assert.equal(typeof r.json.fallback.deg, 'number');
  assert.equal(typeof r.json.fallback.maxIntrusionDeg, 'number');
  assert.equal(typeof r.json.fallback.totalIntrusionDeg, 'number');
  assert.equal(r.json.fallback.intrusions.length, 2);
  assert.equal(typeof r.json.fallback.reason, 'string');
  assert.equal(r.json.fallback.detentIndex, null);
  assert.equal(r.json.fallback.positions, null);
  // 有共同解时不返回 fallback
  const ok = await postJson('/api/compute-multi', baseMulti);
  assert.equal(ok.json.fallback, null);

  const rd = await postJson('/api/compute-multi', {
    ...body,
    detents: { enabled: true, steps: 8, offsetDeg: 0 },
  });
  assert.equal(rd.status, 200);
  assert.equal(rd.json.noSolution, true);
  assert.ok(Number.isInteger(rd.json.fallback.detentIndex));
  // 备选角度必须在档位集合中
  assert.ok(
    rd.json.detents.positions.some((d) => Math.abs(d - rd.json.fallback.deg) < 1e-9)
  );
  assert.match(rd.json.fallback.reason, /档位/);
});

/* ---------------- 调机旋转路径 route ---------------- */

test('route 参数校验：非对象/缺角度/非数值 → 400', async () => {
  for (const bad of [42, 'x', [], {}, { fromDeg: 10 }, { fromDeg: 'a', toDeg: 10 }]) {
    const r = await postJson('/api/compute', { ...baseSingle, route: bad });
    assert.equal(r.status, 400, `route=${JSON.stringify(bad)} 应 400`);
    assert.match(r.json.error, /route/);
  }
  const badMulti = await postJson('/api/compute-multi', { ...baseMulti, route: { fromDeg: 0 } });
  assert.equal(badMulti.status, 400);
});

test('单规格：未传 route 时 route=null；传入后返回路径结果', async () => {
  const noRoute = await postJson('/api/compute', baseSingle);
  assert.equal(noRoute.status, 200);
  assert.equal(noRoute.json.route, null);

  // 可行段 [108,162] 与跨零 [234,36]：300°→30° 顺时针 90°
  const r = await postJson('/api/compute', {
    ...baseSingle,
    zones: [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ],
    route: { fromDeg: 300, toDeg: 30 },
  });
  assert.equal(r.status, 200);
  const route = r.json.route;
  assert.equal(route.reachable, true);
  assert.equal(route.status, 'ok');
  assert.equal(route.direction, 'cw');
  assert.ok(Math.abs(route.angleDeg - 90) < 1e-7);
  assert.equal(route.cw.feasible, true);
  assert.equal(route.ccw.feasible, false);
});

test('单规格：route 不可达/端点不安全/不在档位分别报告', async () => {
  const zones = [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ];
  // 两端各自安全但被禁用段隔开
  const sep = await postJson('/api/compute', {
    ...baseSingle,
    zones,
    route: { fromDeg: 150, toDeg: 300 },
  });
  assert.equal(sep.json.route.reachable, false);
  assert.equal(sep.json.route.status, 'unreachable');

  // 起点不安全（50° 在禁用 36°–108° 内）
  const fromBad = await postJson('/api/compute', {
    ...baseSingle,
    zones,
    route: { fromDeg: 50, toDeg: 300 },
  });
  assert.equal(fromBad.json.route.status, 'fromUnsafe');

  // 目标不安全（200° 在禁用 162°–234° 内）
  const toBad = await postJson('/api/compute', {
    ...baseSingle,
    zones,
    route: { fromDeg: 300, toDeg: 200 },
  });
  assert.equal(toBad.json.route.status, 'toUnsafe');

  // 启用档位：20° 安全但不是 12 档之一
  const det = await postJson('/api/compute', {
    ...baseSingle,
    zones,
    detents: { enabled: true, steps: 12 },
    route: { fromDeg: 300, toDeg: 20 },
  });
  assert.equal(det.json.route.status, 'toNotOnDetent');
  const detOk = await postJson('/api/compute', {
    ...baseSingle,
    zones,
    detents: { enabled: true, steps: 12 },
    route: { fromDeg: 300, toDeg: 30 },
  });
  assert.equal(detOk.json.route.reachable, true);
  assert.equal(detOk.json.route.direction, 'cw');
});

test('多规格：route 基于共用安全段，与单规格结构一致', async () => {
  // 公共段 216°→36°（跨零，宽 180°）
  const r = await postJson('/api/compute-multi', {
    ...baseMulti,
    route: { fromDeg: 300, toDeg: 30 },
  });
  assert.equal(r.status, 200);
  const route = r.json.route;
  assert.equal(route.reachable, true);
  assert.equal(route.direction, 'cw');
  assert.ok(Math.abs(route.angleDeg - 90) < 1e-7);

  // 100° 不在公共段内
  const toBad = await postJson('/api/compute-multi', {
    ...baseMulti,
    route: { fromDeg: 300, toDeg: 100 },
  });
  assert.equal(toBad.json.route.status, 'toUnsafe');

  // 无共同解：共用段为空，起点不安全
  const noSol = await postJson('/api/compute-multi', {
    circumferences: [360, 180],
    seamWidth: 0,
    zones: [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ],
    route: { fromDeg: 10, toDeg: 20 },
  });
  assert.equal(noSol.json.noSolution, true);
  assert.equal(noSol.json.route.status, 'fromUnsafe');

  // 未传 route 时 route=null
  const noRoute = await postJson('/api/compute-multi', baseMulti);
  assert.equal(noRoute.json.route, null);
});
