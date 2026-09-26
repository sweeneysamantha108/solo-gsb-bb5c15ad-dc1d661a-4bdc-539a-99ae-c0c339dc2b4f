'use strict';

/**
 * 调机旋转路径规划（UMD：Node 服务端与浏览器前端共用）。
 *
 * 在已有可行段（单规格）或共用安全段（多规格）上，判断能否从当前角度
 * 沿圆周连续旋转到目标角度，且全过程处于安全角度：
 *  - 两端必须各自落在安全（可行/共用）角度段内；
 *  - 启用设备档位约束时，两端还须落在可用档位上；
 *  - 只允许沿圆周单向连续旋转。分别评估顺时针（cw，角度增大）与
 *    逆时针（ccw，角度减小）两条路径，在可行路径中取转角较短者，
 *    等长取顺时针；
 *  - 两端各自安全但位于不同连通弧（被禁用段隔开）时报告不可达；
 *  - 跨 0°、整圈可行、起终点相同（转角 0，取顺时针）均正确处理。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RoutePlan = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FULL = 360;
  const EPS = 1e-7; // 角度比较容差
  const DETENT_EPS = 1e-6; // 档位命中容差

  function mod(n, m) {
    return ((n % m) + m) % m;
  }

  const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

  /** 圆周弧宽度（°）；优先取 widthDeg，否则按 wraps 由端点求宽。 */
  function arcWidthDeg(arc) {
    if (arc.widthDeg !== undefined) return arc.widthDeg;
    const s = mod(arc.startDeg, FULL);
    const e = arc.wraps ? mod(arc.endDeg, FULL) + FULL : mod(arc.endDeg, FULL);
    return e - s;
  }

  /** 整圈弧（宽 360°）。 */
  function isFullArc(arc) {
    return !!arc && (arc.full === true || arcWidthDeg(arc) >= FULL - EPS);
  }

  /** 角度是否落在圆周弧内（含边界）。 */
  function degInArc(deg, arc) {
    if (isFullArc(arc)) return true;
    const d = mod(deg, FULL);
    const s = mod(arc.startDeg, FULL);
    const e = mod(arc.endDeg, FULL);
    if (arc.wraps) return d >= s - EPS || d <= e + EPS;
    return d >= s - EPS && d <= e + EPS;
  }

  /** 角度是否命中某个可用档位（圆周距离容差）。 */
  function onAvailableDetent(available, deg) {
    return available.some((d) => {
      const diff = Math.abs(mod(d.deg - deg, FULL));
      return Math.min(diff, FULL - diff) <= DETENT_EPS;
    });
  }

  /** 在可行方向中选转角较短者（等长取顺时针）写入结果。 */
  function finishByShorter(result) {
    const { cw, ccw } = result;
    let dir = null;
    if (cw.feasible && ccw.feasible) {
      dir = cw.angleDeg <= ccw.angleDeg + EPS ? 'cw' : 'ccw';
    } else if (cw.feasible) {
      dir = 'cw';
    } else if (ccw.feasible) {
      dir = 'ccw';
    }
    if (!dir) {
      result.status = 'unreachable';
      result.message = '两端各自安全，但被禁用段隔开：沿圆周连续旋转无法全程保持安全角度';
      return result;
    }
    result.reachable = true;
    result.direction = dir;
    result.angleDeg = result[dir].angleDeg;
    const dirName = dir === 'cw' ? '顺时针' : '逆时针';
    result.message = `全程处于安全角度：${dirName}旋转 ${fmt1(result.angleDeg)}° 到达`;
    return result;
  }

  /**
   * 规划调机旋转路径。
   * @param {Array<{startDeg:number,endDeg:number,wraps?:boolean,widthDeg?:number,full?:boolean}>} arcs
   *        安全角度弧（单规格可行段或多规格共用段；空数组表示无安全角度）
   * @param {number} fromDeg 当前角度（°，按整圈归一）
   * @param {number} toDeg 目标角度（°，按整圈归一）
   * @param {object|null} [detents] 启用中的档位结果（含 available:[{deg}]）；未启用传 null
   * @returns {{
   *   fromDeg:number, toDeg:number, reachable:boolean,
   *   status:'ok'|'fromUnsafe'|'toUnsafe'|'fromNotOnDetent'|'toNotOnDetent'|'unreachable',
   *   direction:'cw'|'ccw'|null, angleDeg:number|null,
   *   cw:{angleDeg:number,feasible:boolean}, ccw:{angleDeg:number,feasible:boolean},
   *   message:string
   * }}
   */
  function planRoute(arcs, fromDeg, toDeg, detents) {
    const from = mod(fromDeg, FULL);
    const to = mod(toDeg, FULL);
    const list = (arcs || []).filter(Boolean);
    const full = list.some(isFullArc);

    const result = {
      fromDeg: from,
      toDeg: to,
      reachable: false,
      status: 'ok',
      direction: null,
      angleDeg: null,
      cw: { angleDeg: mod(to - from, FULL), feasible: false },
      ccw: { angleDeg: mod(from - to, FULL), feasible: false },
      message: '',
    };

    // 1) 两端各自安全（落在同一安全弧集合内）
    const fromArc = full ? null : list.find((a) => degInArc(from, a)) || null;
    const toArc = full ? null : list.find((a) => degInArc(to, a)) || null;
    if (!full && !fromArc) {
      result.status = 'fromUnsafe';
      result.message = `起点 ${fmt1(from)}° 不在安全角度段内（无可行位置）`;
      return result;
    }
    if (!full && !toArc) {
      result.status = 'toUnsafe';
      result.message = `目标 ${fmt1(to)}° 不在安全角度段内（无可行位置）`;
      return result;
    }

    // 2) 启用设备档位时，两端还须落在可用档位上
    const available =
      detents && detents.enabled !== false && Array.isArray(detents.available)
        ? detents.available
        : null;
    if (available) {
      if (!onAvailableDetent(available, from)) {
        result.status = 'fromNotOnDetent';
        result.message = `起点 ${fmt1(from)}° 不在可用档位上（已启用设备档位约束）`;
        return result;
      }
      if (!onAvailableDetent(available, to)) {
        result.status = 'toNotOnDetent';
        result.message = `目标 ${fmt1(to)}° 不在可用档位上（已启用设备档位约束）`;
        return result;
      }
    }

    // 3) 起终点相同（模 360）：转角 0，等长取顺时针
    if (result.cw.angleDeg <= EPS) {
      result.reachable = true;
      result.direction = 'cw';
      result.angleDeg = 0;
      result.cw.feasible = true;
      result.ccw.feasible = true;
      result.ccw.angleDeg = 0;
      result.message = '起点与终点角度相同，无需旋转（转角 0°）';
      return result;
    }

    // 4) 整圈可行：两个方向均安全，取转角较短者（等长取顺时针）
    if (full) {
      result.cw.feasible = true;
      result.ccw.feasible = true;
      return finishByShorter(result);
    }

    // 5) 两端各自安全但被禁用段隔开
    if (fromArc !== toArc) {
      result.status = 'unreachable';
      result.message = '两端各自安全，但被禁用段隔开：沿圆周连续旋转无法全程保持安全角度';
      return result;
    }

    // 6) 同一连通弧：提升坐标判断两个方向是否越出弧界（非整圈弧上至多一个方向可行）
    const s = mod(fromArc.startDeg, FULL);
    const f = from < s - EPS ? from + FULL : from;
    const t = to < s - EPS ? to + FULL : to;
    if (t >= f - EPS) result.cw.feasible = true; // 顺时针路径 [f, t] 留在弧内
    if (t <= f + EPS) result.ccw.feasible = true; // 逆时针路径 [t, f] 留在弧内
    return finishByShorter(result);
  }

  return {
    FULL,
    EPS,
    mod,
    arcWidthDeg,
    isFullArc,
    degInArc,
    onAvailableDetent,
    planRoute,
  };
});
