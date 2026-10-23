/* Расчётное ядро Ball Screw Designer — порт app/core/*.py (v2) на JavaScript.
 * Формулы, методики производителей (HIWIN / CSK–KR), допущения и статусы совпадают с Python-ядром
 * (см. docs/FORMULAS.md). Совпадение проверяется автоматически: tests/test_web_parity.py + web/parity_check.js
 * (все позиции базы, несколько сценариев). Единицы: мм, Н, с, об/мин, кг, Н·м, кг·м².
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BSD = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const G = 9.80665, KGF = 9.80665;
  const HIWIN_REF = "HIWIN BS-08-2-EN-1704-K";
  const CSK_REF = "KR Automation / CSK, каталог ШВП SFD/DFD";

  const STATUS = { SUITABLE: "Подходит", CONDITIONAL: "Условно подходит", NO_DATA: "Недостаточно данных",
                   UNSUITABLE: "Не подходит" };
  const STATUS_ORDER = { "Подходит": 0, "Условно подходит": 1, "Недостаточно данных": 2, "Не подходит": 3 };
  const STATUS_SYMBOL = { "Подходит": "✔", "Условно подходит": "◐", "Недостаточно данных": "?", "Не подходит": "✖" };
  const CS = { PASS: "пройдено", WARNING: "пройдено с замечанием", FAIL: "не пройдено", UNVERIFIED: "не проверено",
               INFO: "справочно" };
  const MOUNTING_RU = {
    "fixed-fixed": "Жёсткая заделка – жёсткая заделка",
    "fixed-supported": "Жёсткая заделка – шарнирная опора",
    "supported-supported": "Шарнирная опора – шарнирная опора",
    "fixed-free": "Жёсткая заделка – свободный конец",
  };
  const BEARING_KINDS = {
    unknown: "Не выбрано", angular_contact: "Радиально-упорный шариковый",
    angular_contact_pair: "Сдвоенные радиально-упорные (DB/DF)", ballscrew_support_unit: "Опора ШВП (готовый узел)",
    axial_angular_contact: "Упорно-радиальный шариковый (60°) для ШВП", deep_groove: "Радиальный шариковый",
    other: "Другой",
  };
  const RELIABILITY_FACTORS = { 90: 1.0, 95: 0.63, 96: 0.53, 97: 0.44, 98: 0.33, 99: 0.21 };
  const PRELOAD_LIMIT_PERCENT = { single: 5.0, double: 10.0 };
  const ROOT_ESTIMATE_TOL = { critical_speed: 1.10, buckling: 1.25, yield: 1.15 };
  const E_STEEL = 2.1e5, STEEL_DENSITY = 7850.0;

  const DEFAULT_BEARING = { kind: "unknown", manufacturer: "", model: "", count: null, arrangement: "",
    contact_angle_deg: null, preload_N: null, allowable_axial_N: null, stiffness_N_um: null, takes_axial_load: null };
  const DEFAULT_CUTTING = {
    mode: "none", axial_max_N: null, axial_mean_N: null, radial_N: null, tangential_N: null, resultant_N: null,
    angle_to_axis_deg: null, utilization: 1.0, direction: "against", external_process_N: null, extra_axial_N: null,
    screw_share: 1.0, perpendicular_to_guides: true, process: "milling", kc11_N_mm2: null, mc: null, spindle_rpm: null,
    tool_diameter_mm: null, teeth: null, feed_per_tooth_mm: null, feed_per_rev_mm: null, depth_ap_mm: null,
    width_ae_mm: null, kappa_deg: 90.0, feed_force_ratio: null, workpiece_material: "", tool_description: "",
  };
  const DEFAULT_INPUT = {
    name: "Ось X", machine_type: "", axis_label: "X", orientation: "horizontal", moving_mass_kg: 200.0,
    mass_mode: "total", mass_items: [], stroke_mm: 800.0, rapid_speed_m_min: 20.0, acceleration_m_s2: 2.0,
    accel_time_s: null, feed_speed_mm_min: 2000.0, feed_stroke_fraction: 0.5, dwell_time_s: 2.0, process_force_N: null,
    friction_coefficient: null, guide_resistance_N: null, cycle_mode: "auto", manual_phases: [], cutting: DEFAULT_CUTTING,
    hours_per_day: null, days_per_year: null, unsupported_length_mm: 1100.0, mounting: "fixed-supported",
    thread_margin_mm: 0.0, bearing_span_mm: null, available_total_length_mm: null, end_journals_length_mm: null,
    bearing_fixed: DEFAULT_BEARING, bearing_other: DEFAULT_BEARING, required_life_h: 20000.0, reliability_percent: 90,
    operating_factor_fp: 1.2, static_safety_required: 2.0, preload_percent: 0.0, efficiency_forward: 0.9,
    efficiency_reverse: 0.8, bearing_friction_torque_Nm: null, gear_ratio: 1.0, motor_inertia_kgm2: null,
    motor_rated_torque_Nm: null, motor_peak_torque_Nm: null, motor_max_speed_rpm: null, max_backlash_mm: null,
    required_v300p_um: null, required_rigidity_N_um: null, max_nut_diameter_mm: null, max_nut_length_mm: null,
    max_axial_deflection_um: null, nut_type_pref: "any", coupling_type: "", motor_connection: "coupling",
    manufacturers: [], manufacturing_types: [], diameter_min_mm: null, diameter_max_mm: null, lead_min_mm: null,
    lead_max_mm: null,
  };

  // ---------- форматирование ----------
  function fmt(v, nd) {
    nd = nd || 0;
    if (v === null || v === undefined) return "—";
    if (!isFinite(v)) return "∞";
    const s = Math.abs(v).toFixed(nd).split(".");
    s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (v < 0 && Number(v.toFixed(nd)) !== 0 ? "-" : "") + s.join(".");
  }
  function g(v) { return v === null || v === undefined ? "" : String(Number(Number(v).toPrecision(6))); }
  function sig3(v) { return isFinite(v) ? Number(v).toPrecision(3).replace(/\.?0+e/, "e") : "∞"; }
  const nn = (v) => v === null || v === undefined;
  const nz = (v) => (nn(v) ? 0.0 : Number(v));
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const sum = (a) => a.reduce((s, x) => s + x, 0);

  // ---------- фазы ----------
  function phase(name, duration_s, direction, v0, v1, fproc, extra) {
    return Object.assign({ name, duration_s, direction, v_start_m_min: v0 || 0, v_end_m_min: v1 || 0,
      process_force_N: fproc || 0, phase_type: "", accel_input_m_s2: null, axial_load_N: null, normal_extra_N: 0.0 },
      extra || {});
  }
  const meanSpeed = (p) => 0.5 * (p.v_start_m_min + p.v_end_m_min);
  const accel = (p) => (p.duration_s <= 0 ? 0 : Math.abs(p.v_end_m_min - p.v_start_m_min) / 60.0 / p.duration_s);
  function signedAccel(p) {
    if (p.direction === 0) return 0.0;
    const sgn = p.v_end_m_min >= p.v_start_m_min ? 1.0 : -1.0;
    return p.direction * sgn * accel(p);
  }
  const distance = (p) => meanSpeed(p) * 1000.0 / 60.0 * p.duration_s;
  const effectiveMass = (inp) => (inp.mass_mode === "components" ? sum(inp.mass_items.map((m) => m.mass_kg)) : inp.moving_mass_kg);
  const criticalLength = (inp) => inp.bearing_span_mm || inp.unsupported_length_mm;

  // ---------- силы резания (app/core/cutting.py) ----------
  class CuttingError extends Error {}
  function manualComponents(c) {
    const lines = [];
    let faMax = c.axial_max_N, perp = null;
    if (!nn(c.radial_N) || !nn(c.tangential_N)) {
      perp = Math.hypot(nz(c.radial_N), nz(c.tangential_N));
      lines.push(`F⊥ = √(Fr² + Ft²) = ${perp.toFixed(1)} Н`);
    }
    if (nn(faMax) && !nn(c.resultant_N) && !nn(c.angle_to_axis_deg)) {
      const th = c.angle_to_axis_deg * Math.PI / 180;
      faMax = c.resultant_N * Math.abs(Math.cos(th));
      lines.push(`Fa = F·cos θ = ${g(c.resultant_N)}·cos ${g(c.angle_to_axis_deg)}° = ${faMax.toFixed(1)} Н`);
      if (perp === null) { perp = c.resultant_N * Math.abs(Math.sin(th)); lines.push(`F⊥ = F·sin θ = ${perp.toFixed(1)} Н`); }
    }
    let res = null;
    if (!nn(faMax)) { res = Math.sqrt(faMax ** 2 + (perp || 0.0) ** 2); lines.push(`Результирующая F = ${res.toFixed(1)} Н`); }
    return [nn(faMax) ? null : faMax, nn(c.axial_mean_N) ? null : c.axial_mean_N, perp || 0.0, res, lines];
  }
  function kienzleEstimate(c) {
    const req = { kc11_N_mm2: "kc1.1", mc: "mc", depth_ap_mm: "ap", feed_force_ratio: "Ff/Fc" };
    if (c.process === "milling") Object.assign(req, { tool_diameter_mm: "D инструмента", teeth: "число зубьев z",
      feed_per_tooth_mm: "fz", width_ae_mm: "ae" });
    else req.feed_per_rev_mm = "f (подача на оборот)";
    const missing = Object.keys(req).filter((k) => nn(c[k])).map((k) => req[k]);
    if (missing.length) throw new CuttingError("Для оценки сил резания не заданы: " + missing.join(", "));
    const kappa = c.kappa_deg * Math.PI / 180;
    if (!(kappa > 0 && kappa <= Math.PI / 2)) throw new CuttingError("Угол в плане κ должен быть в диапазоне 0…90°");
    const lines = [];
    let power = null, feed = null, fcMax, fcMean;
    const b = c.depth_ap_mm / Math.sin(kappa);
    if (c.process === "milling") {
      const D = c.tool_diameter_mm, ae = c.width_ae_mm, fz = c.feed_per_tooth_mm, z = Math.trunc(c.teeth);
      if (!(ae > 0 && ae <= D)) throw new CuttingError("Ширина фрезерования ae должна быть в диапазоне 0 < ae ≤ D");
      const phi = Math.acos(1.0 - 2.0 * ae / D);
      const hm = fz * Math.sin(kappa) * (1.0 - Math.cos(phi)) / phi;
      const kc = c.kc11_N_mm2 * Math.pow(hm, -c.mc);
      const ze = z * phi / (2.0 * Math.PI);
      fcMean = ze * kc * b * hm;
      const hmax = fz * Math.sin(kappa) * Math.sin(Math.min(phi, Math.PI / 2));
      fcMax = Math.ceil(ze) * c.kc11_N_mm2 * b * Math.pow(hmax, 1.0 - c.mc);
      lines.push(`hm = ${hm.toFixed(4)} мм; kc = ${kc.toFixed(0)} Н/мм²; ze = ${ze.toFixed(2)}; Fc,ср = ${fcMean.toFixed(0)} Н; Fc,max ≈ ${fcMax.toFixed(0)} Н`);
      if (c.spindle_rpm) {
        const vc = Math.PI * D * c.spindle_rpm / 1000.0;
        power = fcMean * vc / 60.0;
        feed = fz * z * c.spindle_rpm;
      }
    } else {
      const h = c.feed_per_rev_mm * Math.sin(kappa);
      fcMean = fcMax = c.kc11_N_mm2 * b * Math.pow(h, 1.0 - c.mc);
      lines.push(`h = ${h.toFixed(4)} мм; b = ${b.toFixed(2)} мм; Fc = ${fcMax.toFixed(0)} Н`);
      if (c.spindle_rpm) feed = c.feed_per_rev_mm * c.spindle_rpm;
    }
    return [fcMax, fcMean, c.feed_force_ratio, lines, power, feed];
  }
  function cuttingLoad(c) {
    const out = { axial_max_N: 0.0, axial_mean_N: 0.0, perpendicular_N: 0.0, resultant_N: null, utilization: c.utilization,
      direction: c.direction, is_estimate: false, known: false, lines: [], assumptions: [], cutting_power_W: null,
      feed_speed_check_mm_min: null };
    const ext = nz(c.external_process_N) + nz(c.extra_axial_N);
    let faMax, faMean, perp;
    if (c.mode === "none") {
      if (ext) { out.known = true; out.axial_max_N = out.axial_mean_N = ext; }
      return out;
    }
    if (c.mode === "manual") {
      let res, lines;
      [faMax, faMean, perp, res, lines] = manualComponents(c);
      out.lines.push(...lines);
      if (faMax === null) {
        if (ext) {
          out.known = true; out.axial_max_N = out.axial_mean_N = ext;
          out.assumptions.push("Осевая составляющая силы резания не задана — учтены только внешние силы.");
        }
        return out;
      }
      if (faMean === null) {
        faMean = faMax;
        out.assumptions.push("Средняя осевая сила резания не задана — принята равной максимальной (консервативно).");
      }
      out.resultant_N = res;
    } else if (c.mode === "estimate") {
      const [fcMax, fcMean, ratio, lines, power, feed] = kienzleEstimate(c);
      out.is_estimate = true;
      out.lines.push(...lines);
      faMax = ratio * fcMax; faMean = ratio * fcMean;
      out.perpendicular_N = fcMax;
      out.cutting_power_W = power;
      out.feed_speed_check_mm_min = feed;
      out.assumptions.push("Силы резания оценены по модели Кинцле с коэффициентами пользователя — это приближённая оценка, не измеренное значение.");
      out.resultant_N = Math.hypot(faMax, fcMax);
    } else throw new CuttingError(`Неизвестный режим сил резания: ${c.mode}`);
    const k = c.screw_share;
    out.known = true;
    out.axial_max_N = k * faMax + ext;
    out.axial_mean_N = k * faMean + ext;
    if (c.mode === "manual") out.perpendicular_N = perp;
    if (k >= 1.0) out.assumptions.push("Доля осевой силы резания, передаваемая на ШВП, принята k = 1 (вся осевая составляющая воспринимается приводом) — консервативная упрощённая модель.");
    else out.assumptions.push(`Доля осевой силы резания на ШВП k = ${g(k)} задана пользователем — требует обоснования (распределение между направляющими, конструкцией и приводом).`);
    return out;
  }

  // ---------- цикл (app/core/cycle.py) ----------
  function trapezoid(distance_mm, v_max, a, direction, label) {
    if (distance_mm <= 0) return [];
    const s = distance_mm / 1000.0, v = v_max / 60.0;
    const s_acc = v * v / (2.0 * a);
    if (2.0 * s_acc >= s) {
      const vpk = Math.sqrt(s * a), t = vpk / a, vp = vpk * 60.0;
      return [phase(`${label}: разгон`, t, direction, 0, vp, 0, { phase_type: "разгон", accel_input_m_s2: a }),
              phase(`${label}: торможение`, t, direction, vp, 0, 0, { phase_type: "торможение", accel_input_m_s2: a })];
    }
    const t_acc = v / a, t_const = (s - 2.0 * s_acc) / v;
    const kind = direction > 0 ? "быстрый ход" : "обратный ход";
    return [phase(`${label}: разгон`, t_acc, direction, 0, v_max, 0, { phase_type: "разгон", accel_input_m_s2: a }),
            phase(`${label}: v = const`, t_const, direction, v_max, v_max, 0, { phase_type: kind, accel_input_m_s2: 0.0 }),
            phase(`${label}: торможение`, t_acc, direction, v_max, 0, 0, { phase_type: "торможение", accel_input_m_s2: a })];
  }
  function feedPhases(inp, feedLen) {
    const vf = inp.feed_speed_mm_min / 1000.0;
    const tFeed = feedLen / (inp.feed_speed_mm_min / 60.0);
    const cl = cuttingLoad(inp.cutting);
    if (!cl.known) return [phase("Рабочая подача", tFeed, +1, vf, vf, inp.process_force_N || 0.0, { phase_type: "рабочая подача" })];
    const base = inp.process_force_N || 0.0;
    const u = Math.min(Math.max(cl.utilization, 0.0), 1.0);
    const parts = [["макс. сила резания", u, cl.axial_max_N]];
    if (u < 1.0) parts.push(["средняя сила резания", 1.0 - u, cl.axial_mean_N]);
    const out = [];
    parts.forEach(([label, share, force]) => {
      if (share <= 0) return;
      const signs = cl.direction === "against" ? [1.0] : cl.direction === "along" ? [-1.0] : [1.0, -1.0];
      signs.forEach((sg) => {
        const t = tFeed * share / signs.length;
        const name = `Рабочая подача: ${label}` + (signs.length === 1 ? "" : sg > 0 ? " (против)" : " (по ходу)");
        out.push(phase(name, t, +1, vf, vf, base + sg * force, { phase_type: "рабочая подача",
          normal_extra_N: inp.cutting.perpendicular_to_guides ? cl.perpendicular_N : 0.0 }));
      });
    });
    return out;
  }
  function buildCycle(inp) {
    if (inp.cycle_mode === "manual") return inp.manual_phases.map((p) => Object.assign({}, p));
    let ph = [];
    const f = inp.feed_speed_mm_min ? inp.feed_stroke_fraction : 0.0;
    ph = ph.concat(trapezoid(inp.stroke_mm * (1.0 - f), inp.rapid_speed_m_min, inp.acceleration_m_s2, +1, "Быстрый ход вперёд"));
    if (f > 0) ph = ph.concat(feedPhases(inp, inp.stroke_mm * f));
    ph = ph.concat(trapezoid(inp.stroke_mm, inp.rapid_speed_m_min, inp.acceleration_m_s2, -1, "Быстрый ход назад"));
    if (inp.dwell_time_s > 0) ph.push(phase("Стоянка", inp.dwell_time_s, 0, 0, 0, 0, { phase_type: "выдержка" }));
    return ph;
  }
  const maxSpeed = (phases) => phases.reduce((m, p) => Math.max(m, p.v_start_m_min, p.v_end_m_min), 0);

  // ---------- силы (app/core/loads.py) ----------
  function phaseLoad(p, inp) {
    const m = effectiveMass(inp), vertical = inp.orientation === "vertical", d = p.direction;
    const inertia = m * signedAccel(p);
    if (!nn(p.axial_load_N)) {
      return { phase: p, force_N: inertia + p.axial_load_N, components: { "инерция": inertia, "трение": 0.0, "тяжесть": 0.0,
               "технологическая": p.axial_load_N }, non_inertial_force_N: p.axial_load_N };
    }
    const normal = (vertical ? 0.0 : m * G) + (d !== 0 ? p.normal_extra_N : 0.0);
    const fric = d * ((inp.friction_coefficient || 0.0) * normal + (inp.guide_resistance_N || 0.0));
    const gravity = vertical ? m * G : 0.0;
    const proc = d * p.process_force_N;
    const total = inertia + fric + gravity + proc;
    return { phase: p, force_N: total, components: { "инерция": inertia, "трение": fric, "тяжесть": gravity,
             "технологическая": proc }, non_inertial_force_N: total - inertia };
  }

  // ---------- ресурс (app/core/life.py) ----------
  const liftOff = (fpr) => Math.pow(2.0, 1.5) * fpr;
  function sideLoads(force, fpr) {
    const a = Math.abs(force);
    let loaded, other;
    if (fpr <= 0) { loaded = a; other = 0.0; }
    else {
      const flim = liftOff(fpr);
      if (a >= flim) { loaded = a; other = 0.0; }
      else { loaded = fpr * Math.pow(1.0 + a / flim, 1.5); other = loaded - a; }
    }
    return force >= 0 ? [loaded, other] : [other, loaded];
  }
  function equivalentLoads(forces, revs, fp, fpr) {
    const total = sum(revs);
    if (total <= 0) throw new Error("За цикл нет ни одного оборота винта — ресурс не определён");
    let s1 = 0, s2 = 0;
    forces.forEach((f, i) => {
      const r = revs[i];
      if (r <= 0) return;
      const [b1, b2] = sideLoads(f, fpr);
      s1 += Math.pow(b1 * fp, 3) * r;
      s2 += Math.pow(b2 * fp, 3) * r;
    });
    return [Math.pow(s1 / total, 1 / 3), Math.pow(s2 / total, 1 / 3)];
  }
  const ratingLife = (c, fbm) => (fbm <= 0 ? Infinity : Math.pow(c / fbm, 3) * 1e6);
  function combineLife(l1, l2) {
    const s = [l1, l2].filter(isFinite).reduce((a, l) => a + Math.pow(l, -10.0 / 9.0), 0);
    return s === 0 ? Infinity : Math.pow(s, -0.9);
  }
  function lifeResult(fbm1, fbm2, l1, l2, l, lm, revCycle, tCycle, tMotion, nm) {
    return {
      fbm1_N: fbm1, fbm2_N: fbm2, l1_rev: l1, l2_rev: l2, l_rev: l, lm_rev: lm, revolutions_per_cycle: revCycle,
      cycle_time_s: tCycle, motion_time_s: tMotion, nm_rpm: nm,
      km: (lead) => lm * lead / 1e6,
      hours: () => (nm <= 0 ? Infinity : lm / (nm * 60.0)),
      motionHours: () => (revCycle <= 0 ? Infinity : lm / revCycle * tMotion / 3600.0),
      fbm: Math.max(fbm1, fbm2),
    };
  }
  function cycleTimes(revs, durations) {
    const tCycle = sum(durations);
    const tMotion = sum(durations.map((t, i) => (revs[i] > 0 ? t : 0)));
    const revCycle = sum(revs);
    return [revCycle, tCycle, tMotion, tCycle > 0 ? revCycle / tCycle * 60.0 : 0.0];
  }
  function computeLife(c, forces, revs, durations, fp, rel, fpr) {
    const [fbm1, fbm2] = equivalentLoads(forces, revs, fp, fpr || 0);
    const l1 = ratingLife(c, fbm1), l2 = ratingLife(c, fbm2), l = combineLife(l1, l2);
    const [revCycle, tCycle, tMotion, nm] = cycleTimes(revs, durations);
    const fr = RELIABILITY_FACTORS[rel];
    if (fr === undefined) throw new Error(`Надёжность ${rel} % отсутствует в табл. 3.17 HIWIN`);
    return lifeResult(fbm1, fbm2, l1, l2, l, l * fr, revCycle, tCycle, tMotion, nm);
  }
  function computeLifeCsk(c, forces, revs, durations, fw, fr) {
    const total = sum(revs);
    if (total <= 0) throw new Error("За цикл нет ни одного оборота винта — ресурс не определён");
    const fm = Math.pow(sum(forces.map((f, i) => (revs[i] > 0 ? Math.pow(Math.abs(f), 3) * revs[i] : 0))) / total, 1 / 3);
    const l = ratingLife(c, fm * fw);
    const [revCycle, tCycle, tMotion, nm] = cycleTimes(revs, durations);
    return lifeResult(fm * fw, 0.0, l, Infinity, l, l * fr, revCycle, tCycle, tMotion, nm);
  }

  // ---------- методики (app/core/methods.py) ----------
  function makeMethod(o) {
    return Object.assign({
      criticalPerm(dr, L, mnt) {
        if (dr <= 0 || L <= 0) throw new Error("dr и L должны быть положительными");
        return this.key === "csk" ? this.fn[mnt] * dr / (L * L) * 1e7 : 0.8 * 2.71e8 * this.fn[mnt] * dr / (L * L);
      },
      bucklingPerm(dr, L, mnt) {
        if (dr <= 0 || L <= 0) throw new Error("dr и L должны быть положительными");
        return this.key === "csk" ? this.fk[mnt] * Math.pow(dr, 4) / (L * L) * 1e3 * KGF
          : 0.5 * 4.072e5 * this.fk[mnt] * Math.pow(dr, 4) / (L * L);
      },
      criticalSubst(dr, L, mnt) {
        const c = this.fn[mnt];
        return this.key === "csk" ? `n = ${g(c)}·${g(dr)}/${g(L)}²·10⁷` : `0.8·nk = 0.8·2.71·10⁸·${g(c)}·${g(dr)}/${g(L)}²`;
      },
      bucklingSubst(dr, L, mnt) {
        const c = this.fk[mnt];
        return this.key === "csk" ? `P = ${g(c)}·${g(dr)}⁴/${g(L)}²·10³ кгс × 9.80665` : `0.5·Fk = 0.5·4.072·10⁵·${g(c)}·${g(dr)}⁴/${g(L)}²`;
      },
      speedLimits(p, nMax) {
        const out = [];
        if (this.key === "csk") {
          const dm = p.nominal_diameter_mm, dmn = dm * nMax, lead = p.lead_mm;
          let limit = 220000.0, why = "прецизионная ШВП с торцевой крышкой: dm·n ≤ 220 000 (таблица стр. E-14)";
          if (lead >= 10 && lead <= 16) { limit = 120000.0; why = "для шага 10–16 мм dm·n ≤ 120 000 (примечание стр. E-14)"; }
          else if (lead >= 20 && lead <= 25) { limit = 160000.0; why = "для шага 20–25 мм dm·n ≤ 160 000 (примечание стр. E-14)"; }
          out.push({ key: "dmn", title: "Значение dm·n", value: dmn, limit, unit: "мм·об/мин", reference: `${CSK_REF}, стр. E-14`,
            explanation: `dm·n = ${g(dm)}·${nMax.toFixed(0)} = ${fmt(dmn)}; ${why}. dm (делительный диаметр) в каталоге не указан — принят номинальный диаметр (приближённо)`, hard: true });
          out.push({ key: "dmn_normal", title: "dm·n в обычных условиях (рекомендация)", value: dmn, limit: 130000.0, unit: "мм·об/мин",
            reference: `${CSK_REF}, стр. E-14`, explanation: "В нормальных условиях dm·n может достигать 130 000; выше — по согласованию", hard: false });
        } else if (!nn(p.dn_limit)) {
          const dn = p.nominal_diameter_mm * nMax;
          out.push({ key: "dn", title: "Частота вращения (DN)", value: dn, limit: p.dn_limit, unit: "мм·об/мин",
            reference: p.dn_limit_source || `${HIWIN_REF}, разд. 3.7.6`,
            explanation: `DN = d·n_max = ${g(p.nominal_diameter_mm)}·${nMax.toFixed(0)} = ${fmt(dn)}`, hard: true });
        }
        if (!nn(p.max_speed_rpm))
          out.push({ key: "n_catalog", title: "Макс. частота вращения по каталогу", value: nMax, limit: p.max_speed_rpm,
            unit: "об/мин", reference: p.max_speed_source || "каталог", explanation: "Превышение — только по согласованию с производителем", hard: true });
        return out;
      },
      recommendedLoadFactor(v) {
        if (this.key !== "csk") return null;
        return v < 15 ? [1.0, 1.2] : v <= 60 ? [1.2, 1.5] : [1.5, 3.0];
      },
      yieldLimit(dr) { return this.yield_check ? 147.0 * Math.PI * dr * dr / 4.0 : null; },
    }, o);
  }
  const HIWIN = makeMethod({
    key: "hiwin", title: "HIWIN / DIN ISO 3408", reference: HIWIN_REF,
    fn: { "fixed-fixed": 1.0, "fixed-supported": 0.692, "supported-supported": 0.446, "fixed-free": 0.147 },
    fk: { "fixed-fixed": 1.0, "fixed-supported": 0.5, "supported-supported": 0.25, "fixed-free": 0.0625 },
    critical_formula: "nk = 2.71·10⁸·fn·dk/L²; допустимо 0.8·nk (F 3.27–3.28)",
    buckling_formula: "Fk = 4.072·10⁵·fk·dk⁴/L²; допустимо 0.5·Fk (F 3.25–3.26)",
    life_formula: "Fbm = (Σ(Fb·fp)³·n·t/Σn·t)^(1/3) по сторонам гайки; L = (C/Fbm)³·10⁶; L = (L1^(−10/9)+L2^(−10/9))^(−9/10) (F 3.4–3.14)",
    load_factor_name: "fp", nut_rigidity_play_ratio: 0.28, nut_rigidity_preload_ratio: 0.1,
    supports_preload_life: true, yield_check: false,
    static_factor_hint: "Требуемый S0 задаёт пользователь (численной рекомендации в каталоге нет)",
  });
  const CSK = makeMethod({
    key: "csk", title: "CSK / KR Automation", reference: CSK_REF,
    fn: { "fixed-fixed": 21.9, "fixed-supported": 15.1, "supported-supported": 9.7, "fixed-free": 3.4 },
    fk: { "fixed-fixed": 20.3, "fixed-supported": 10.2, "supported-supported": 5.1, "fixed-free": 1.3 },
    critical_formula: "n = f·dr/L²·10⁷ об/мин, α = 0.8 уже учтён (стр. E-13)",
    buckling_formula: "P = m·dr⁴/L²·10³ кгс, α = 0.5 уже учтён (стр. E-12)",
    life_formula: "Fm = (ΣFi³·ni·ti/Σni·ti)^(1/3); L = (Ca/(Fm·fw))³·10⁶; Lt = L/(60·nm) (стр. E-24…E-26)",
    load_factor_name: "fw", nut_rigidity_play_ratio: 0.3, nut_rigidity_preload_ratio: 0.1,
    supports_preload_life: false, yield_check: true,
    static_factor_hint: "fs = C0/Fmax: 1.2–2 нормальная работа, 1.5–3 с вибрацией (стр. E-29)",
  });
  const METHODS = { hiwin: HIWIN, csk: CSK };
  const methodFor = (p) => METHODS[p.calc_method || "hiwin"] || HIWIN;
  const cskPreloadK = (lead, dm) => 0.05 / Math.sqrt(lead / (Math.PI * dm));

  // ---------- жёсткость и момент ----------
  function shaftRigidity(dc, ls, m) {
    return m === "fixed-fixed" ? Math.PI * dc * dc * E_STEEL / (ls * 1e3) : Math.PI * dc * dc * E_STEEL / (4.0 * ls * 1e3);
  }
  function series(...parts) {
    if (parts.some((p) => nn(p) || p <= 0)) return null;
    return 1.0 / sum(parts.map((p) => 1.0 / p));
  }
  const driveTorque = (f, lead, eta) => f * lead / (2000.0 * Math.PI * eta);
  const backTorque = (f, lead, eta2) => f * lead * eta2 / (2000.0 * Math.PI);
  const preloadDrag = (fpr, lead, e1, e2) => (1.0 / e1 - e2) * fpr * lead / (2000.0 * Math.PI);
  function screwInertia(d_mm, len_mm) {
    const d = d_mm / 1000.0, L = len_mm / 1000.0;
    const mass = STEEL_DENSITY * Math.PI * d * d / 4.0 * L;
    return mass * Math.pow(d / 2.0, 2) / 2.0;
  }
  const linInertia = (m, lead) => m * Math.pow(lead / (2000.0 * Math.PI), 2);
  function computeTorque(loads, inp, lead, dnom, fpr, preloadTorque) {
    const i = inp.gear_ratio, e1 = inp.efficiency_forward, e2 = inp.efficiency_reverse;
    const tb = inp.bearing_friction_torque_Nm || 0.0;
    const td = !nn(preloadTorque) ? preloadTorque : fpr > 0 ? preloadDrag(fpr, lead, e1, e2) : 0.0;
    const js = screwInertia(dnom, inp.unsupported_length_mm), jl = linInertia(effectiveMass(inp), lead);
    const jm = inp.motor_inertia_kgm2 || 0.0;
    const jt = jm + (js + jl) / (i * i);
    const phases = loads.map((ld) => {
      const p = ld.phase, fw = ld.non_inertial_force_N, d = p.direction;
      let t = d !== 0 && fw * d >= 0 ? driveTorque(fw, lead, e1) : backTorque(fw, lead, e2);
      t += d * (tb + td);
      const n0 = d * 1000.0 * p.v_start_m_min / lead, n1 = d * 1000.0 * p.v_end_m_min / lead;
      const alpha = p.duration_s > 0 ? 2.0 * Math.PI * (n1 - n0) / 60.0 / p.duration_s : 0.0;
      const ts = t / i, ti = jt * alpha * i, tm = ts + ti;
      const nmax = Math.max(Math.abs(n0), Math.abs(n1));
      return { name: p.name, duration_s: p.duration_s, n_screw_max_rpm: nmax, torque_motor_Nm: tm,
               static_torque_motor_Nm: ts, inertia_torque_motor_Nm: ti, power_W: Math.abs(tm) * 2.0 * Math.PI * nmax * i / 60.0 };
    });
    const tsum = sum(phases.map((p) => p.duration_s));
    return {
      phases, j_screw_kgm2: js, j_linear_kgm2: jl, j_total_motor_kgm2: jt, preload_drag_Nm: td,
      peak_Nm: phases.reduce((m, p) => Math.max(m, Math.abs(p.torque_motor_Nm)), 0),
      rms_Nm: tsum > 0 ? Math.sqrt(sum(phases.map((p) => p.torque_motor_Nm ** 2 * p.duration_s)) / tsum) : 0,
      peak_power_W: phases.reduce((m, p) => Math.max(m, p.power_W), 0),
      inertia_ratio: jm > 0 ? (jt - jm) / jm : null,
    };
  }

  // ---------- проверка исходных данных (app/core/validation.py) ----------
  function validateInput(inp) {
    const errs = [];
    function req(name, title, lo, hi, loIncl, optional) {
      const v = inp[name];
      if (nn(v)) { if (!optional) errs.push([name, `«${title}»: значение не задано`]); return; }
      if (!isNum(v)) { errs.push([name, `«${title}»: требуется число, получено ${v}`]); return; }
      if (lo !== null && (loIncl ? v < lo : v <= lo)) errs.push([name, `«${title}»: должно быть ${loIncl ? "≥" : ">"} ${g(lo)}, задано ${g(v)}`]);
      if (hi !== null && v > hi) errs.push([name, `«${title}»: должно быть ≤ ${g(hi)}, задано ${g(v)}`]);
    }
    if (!["total", "components"].includes(inp.mass_mode)) errs.push(["mass_mode", "Способ задания массы: «total» или «components»"]);
    if (inp.mass_mode === "components") {
      if (!inp.mass_items.length) errs.push(["mass_items", "Масса по компонентам: не задано ни одного компонента"]);
      inp.mass_items.forEach((m, i) => {
        if (!isNum(m.mass_kg) || m.mass_kg < 0) errs.push(["mass_items", `Масса компонента ${i + 1} «${m.name}»: требуется число ≥ 0`]);
      });
      const names = inp.mass_items.map((m) => String(m.name).trim().toLowerCase());
      const dup = [...new Set(names.filter((n) => n && names.indexOf(n) !== names.lastIndexOf(n)))].sort();
      if (dup.length) errs.push(["mass_items", "Компоненты массы повторяются (двойной учёт): " + dup.join(", ")]);
      if (inp.mass_items.length && inp.mass_items.every((m) => isNum(m.mass_kg)) && sum(inp.mass_items.map((m) => m.mass_kg)) <= 0)
        errs.push(["mass_items", "Сумма масс компонентов должна быть > 0"]);
    } else req("moving_mass_kg", "Масса перемещаемого узла", 0, null);
    req("stroke_mm", "Полезный ход", 0, null);
    req("rapid_speed_m_min", "Скорость быстрого перемещения", 0, 300);
    req("acceleration_m_s2", "Ускорение", 0, 100);
    req("feed_speed_mm_min", "Рабочая подача", 0, null, false, true);
    req("feed_stroke_fraction", "Доля хода на подаче", 0, 1, true);
    req("dwell_time_s", "Время стоянки", 0, null, true);
    req("process_force_N", "Технологическая сила", 0, null, true, true);
    req("accel_time_s", "Время разгона", 0, 60, false, true);
    req("hours_per_day", "Часов работы в сутки", 0, 24, false, true);
    req("days_per_year", "Дней работы в году", 0, 366, false, true);
    req("bearing_span_mm", "Расстояние между опорами", 0, null, false, true);
    req("available_total_length_mm", "Доступная общая длина", 0, null, false, true);
    req("end_journals_length_mm", "Длина концов вала вне опор", 0, null, true, true);
    req("max_axial_deflection_um", "Допустимый осевой прогиб", 0, null, false, true);
    req("friction_coefficient", "Коэффициент трения направляющих", 0, 1, true, true);
    req("guide_resistance_N", "Сопротивление уплотнений направляющих", 0, null, true, true);
    req("unsupported_length_mm", "Свободная длина винта", 0, null);
    req("thread_margin_mm", "Запас длины резьбы", 0, null, true);
    req("required_life_h", "Требуемый ресурс", 0, null);
    req("operating_factor_fp", "Коэффициент условий работы fp", 1.0, 5.0, true);
    req("static_safety_required", "Требуемый статический запас S0", 0, null);
    req("preload_percent", "Натяг", 0, 10, true);
    req("efficiency_forward", "КПД прямого хода η1", 0, 1);
    req("efficiency_reverse", "КПД обратного хода η2", 0, 1);
    req("bearing_friction_torque_Nm", "Момент трения опор", 0, null, true, true);
    req("gear_ratio", "Передаточное отношение", 0, null);
    [["motor_inertia_kgm2", "Инерция двигателя"], ["motor_rated_torque_Nm", "Номинальный момент двигателя"],
     ["motor_peak_torque_Nm", "Максимальный момент двигателя"], ["motor_max_speed_rpm", "Макс. частота двигателя"],
     ["required_v300p_um", "Допустимое отклонение хода v300p"], ["required_rigidity_N_um", "Требуемая жёсткость"],
     ["max_nut_diameter_mm", "Макс. диаметр гайки"], ["max_nut_length_mm", "Макс. длина гайки"],
     ["diameter_min_mm", "Мин. диаметр"], ["diameter_max_mm", "Макс. диаметр"], ["lead_min_mm", "Мин. шаг"],
     ["lead_max_mm", "Макс. шаг"]].forEach(([n, t]) => req(n, t, 0, null, false, true));
    req("max_backlash_mm", "Допустимый люфт", 0, null, true, true);
    if (!(inp.reliability_percent in RELIABILITY_FACTORS))
      errs.push(["reliability_percent", "Надёжность: допустимы значения 90, 95, 96, 97, 98, 99 % (табл. 3.17 HIWIN)"]);
    if (!["any", "single", "double"].includes(inp.nut_type_pref)) errs.push(["nut_type_pref", "Тип гайки: any, single или double"]);
    if (!["coupling", "belt", "gear"].includes(inp.motor_connection)) errs.push(["motor_connection", "Соединение с двигателем: coupling, belt или gear"]);
    if (isNum(inp.accel_time_s) && isNum(inp.acceleration_m_s2) && isNum(inp.rapid_speed_m_min) && inp.accel_time_s > 0 && inp.acceleration_m_s2 > 0) {
      const a = inp.rapid_speed_m_min / 60.0 / inp.accel_time_s;
      if (Math.abs(a - inp.acceleration_m_s2) > 0.05 * inp.acceleration_m_s2)
        errs.push(["accel_time_s", `Противоречие: разгон до ${g(inp.rapid_speed_m_min)} м/мин за ${g(inp.accel_time_s)} с даёт a = ${sig3(a)} м/с², а задано ${g(inp.acceleration_m_s2)} м/с² (расхождение > 5 %)`]);
    }
    if (isNum(inp.bearing_span_mm) && isNum(inp.unsupported_length_mm) && inp.mounting !== "fixed-free" &&
        inp.unsupported_length_mm > inp.bearing_span_mm * (1 + 1e-9))
      errs.push(["unsupported_length_mm", "Свободная длина винта больше расстояния между опорами"]);
    if (isNum(inp.available_total_length_mm) && isNum(inp.bearing_span_mm) && inp.bearing_span_mm > inp.available_total_length_mm)
      errs.push(["bearing_span_mm", "Расстояние между опорами больше доступной общей длины"]);
    errs.push(...validateCutting(inp.cutting));
    [["bearing_fixed", inp.bearing_fixed, "Опора 1 (неподвижная)"], ["bearing_other", inp.bearing_other, "Опора 2"]]
      .forEach(([key, b, title]) => validateBearing(b).forEach((m) => errs.push([key, `${title}: ${m}`])));
    if (!["auto", "manual"].includes(inp.cycle_mode)) errs.push(["cycle_mode", "Режим цикла должен быть «auto» или «manual»"]);
    [["diameter_min_mm", "diameter_max_mm", "диаметра"], ["lead_min_mm", "lead_max_mm", "шага"]].forEach(([a, b, t]) => {
      if (isNum(inp[a]) && isNum(inp[b]) && inp[a] > inp[b]) errs.push([a, `Диапазон ${t}: минимум больше максимума`]);
    });
    if (isNum(inp.stroke_mm) && isNum(inp.unsupported_length_mm) && inp.unsupported_length_mm < inp.stroke_mm)
      errs.push(["unsupported_length_mm", "Свободная длина винта меньше полезного хода"]);
    if (inp.cycle_mode === "auto" && isNum(inp.feed_stroke_fraction) && inp.feed_stroke_fraction > 0 && nn(inp.feed_speed_mm_min))
      errs.push(["feed_speed_mm_min", "Задана доля хода на подаче, но не задана скорость подачи"]);
    if (isNum(inp.feed_speed_mm_min) && isNum(inp.rapid_speed_m_min) && inp.feed_speed_mm_min / 1000.0 > inp.rapid_speed_m_min)
      errs.push(["feed_speed_mm_min", "Рабочая подача больше скорости быстрого хода"]);
    if (inp.cycle_mode === "manual") {
      if (!inp.manual_phases.length) errs.push(["manual_phases", "Ручной цикл: не задано ни одной фазы"]);
      let moving = false;
      inp.manual_phases.forEach((ph, i) => {
        validatePhase(ph, inp).forEach((m) => errs.push(["manual_phases", `Фаза ${i + 1} «${ph.name}»: ${m}`]));
        moving = moving || (ph.direction !== 0 && meanSpeed(ph) > 0);
      });
      if (inp.manual_phases.length && !inp.manual_phases.some((ph) => validatePhase(ph, inp).length)) {
        const fwd = sum(inp.manual_phases.filter((p) => p.direction > 0).map(distance));
        const back = sum(inp.manual_phases.filter((p) => p.direction < 0).map(distance));
        if (isNum(inp.stroke_mm)) [[fwd, "вперёд"], [back, "назад"]].forEach(([d, t]) => {
          if (d > inp.stroke_mm * 1.001) errs.push(["manual_phases", `Ручной цикл: путь ${t} ${d.toFixed(1)} мм больше полезного хода ${g(inp.stroke_mm)} мм`]);
        });
      }
      if (inp.manual_phases.length && !moving) errs.push(["manual_phases", "Ручной цикл: нет ни одной фазы с движением"]);
    }
    return errs;
  }
  function validatePhase(ph, inp) {
    const out = [];
    ["duration_s", "v_start_m_min", "v_end_m_min", "process_force_N"].forEach((n) => {
      if (!isNum(ph[n])) out.push(`поле ${n} должно быть числом`);
    });
    if (out.length) return out;
    if (ph.duration_s <= 0) out.push("длительность должна быть > 0");
    if (ph.v_start_m_min < 0 || ph.v_end_m_min < 0) out.push("скорости задаются модулем (≥ 0), направление — отдельно");
    if (![-1, 0, 1].includes(ph.direction)) out.push("направление должно быть −1, 0 или +1");
    if (ph.direction === 0 && (ph.v_start_m_min || ph.v_end_m_min)) out.push("на стоянке (направление 0) скорости должны быть нулевыми");
    if (!nn(ph.accel_input_m_s2)) {
      if (!isNum(ph.accel_input_m_s2) || ph.accel_input_m_s2 < 0) out.push("заданное ускорение должно быть числом ≥ 0");
      else if (ph.duration_s > 0 && Math.abs(accel(ph) - ph.accel_input_m_s2) > Math.max(0.02 * ph.accel_input_m_s2, 1e-3))
        out.push(`противоречие: |v кон − v нач|/t = ${sig3(accel(ph))} м/с², а задано ускорение ${g(ph.accel_input_m_s2)} м/с²`);
    }
    if (!nn(ph.axial_load_N) && !isNum(ph.axial_load_N)) out.push("осевая нагрузка должна быть числом");
    if (inp && ph.duration_s > 0) {
      if (isNum(inp.acceleration_m_s2) && accel(ph) > inp.acceleration_m_s2 * 1.001)
        out.push(`ускорение фазы ${sig3(accel(ph))} м/с² больше максимального ускорения оси ${g(inp.acceleration_m_s2)} м/с²`);
      if (isNum(inp.rapid_speed_m_min) && Math.max(ph.v_start_m_min, ph.v_end_m_min) > inp.rapid_speed_m_min * 1.001)
        out.push(`скорость фазы больше скорости быстрого перемещения ${g(inp.rapid_speed_m_min)} м/мин`);
    }
    return out;
  }
  function validateCutting(c) {
    const errs = [];
    if (!["none", "manual", "estimate"].includes(c.mode)) errs.push(["cutting", "Режим сил резания: none, manual или estimate"]);
    if (!["against", "along", "alternating"].includes(c.direction)) errs.push(["cutting", "Направление силы резания: against, along или alternating"]);
    [["utilization", "Коэффициент использования силы резания"], ["screw_share", "Доля осевой силы на ШВП"]].forEach(([n, t]) => {
      const v = c[n];
      if (!isNum(v) || v < 0 || v > 1) errs.push(["cutting", `«${t}»: требуется число 0…1`]);
    });
    [["axial_max_N", "Осевая сила резания max"], ["axial_mean_N", "Осевая сила резания ср."], ["radial_N", "Радиальная составляющая"],
     ["tangential_N", "Тангенциальная составляющая"], ["resultant_N", "Результирующая сила"],
     ["external_process_N", "Внешние технологические силы"], ["extra_axial_N", "Дополнительные силы"]].forEach(([n, t]) => {
      const v = c[n];
      if (!nn(v) && (!isNum(v) || v < 0)) errs.push(["cutting", `«${t}»: требуется число ≥ 0`]);
    });
    if (!nn(c.angle_to_axis_deg) && (!isNum(c.angle_to_axis_deg) || c.angle_to_axis_deg < 0 || c.angle_to_axis_deg > 90))
      errs.push(["cutting", "Угол результирующей к оси: 0…90°"]);
    if (isNum(c.axial_max_N) && isNum(c.axial_mean_N) && c.axial_mean_N > c.axial_max_N)
      errs.push(["cutting", "Средняя осевая сила резания больше максимальной"]);
    if (c.mode === "estimate") {
      ["kc11_N_mm2", "spindle_rpm", "tool_diameter_mm", "feed_per_tooth_mm", "feed_per_rev_mm", "depth_ap_mm", "width_ae_mm",
       "feed_force_ratio", "teeth"].forEach((n) => {
        const v = c[n];
        if (!nn(v) && (!isNum(v) || v <= 0)) errs.push(["cutting", `Режим резания: «${n}» должно быть числом > 0`]);
      });
      if (!nn(c.mc) && (!isNum(c.mc) || c.mc < 0 || c.mc >= 1)) errs.push(["cutting", "Показатель mc должен быть в диапазоне 0…1"]);
      if (!["milling", "turning"].includes(c.process)) errs.push(["cutting", "Вид обработки: milling или turning"]);
      if (!errs.length) {
        try { kienzleEstimate(c); } catch (e) { if (e instanceof CuttingError) errs.push(["cutting", e.message]); else throw e; }
      }
    }
    return errs;
  }
  function validateBearing(b) {
    const out = [];
    if (!(b.kind in BEARING_KINDS)) out.push(`неизвестный тип опоры «${b.kind}»`);
    if (!nn(b.count) && (!Number.isInteger(b.count) || b.count < 1)) out.push("количество подшипников — целое число ≥ 1");
    [["contact_angle_deg", "контактный угол", 0, 90], ["preload_N", "натяг", 0, null],
     ["allowable_axial_N", "допустимая осевая нагрузка", 0, null], ["stiffness_N_um", "жёсткость", 0, null]].forEach(([n, t, lo, hi]) => {
      const v = b[n];
      if (nn(v)) return;
      if (!isNum(v) || v < lo || (hi !== null && v > hi) || (n !== "preload_N" && v === 0)) out.push(`${t}: недопустимое значение ${v}`);
    });
    return out;
  }

  // ---------- подбор (app/core/selection.py) ----------
  function globalAssumptions(inp, phases) {
    const critical = [], info = [];
    const c = inp.cutting;
    const cl = c.mode !== "none" || c.external_process_N || c.extra_axial_N ? cuttingLoad(c) : null;
    const hasFeed = phases.some((p) => p.phase_type === "рабочая подача" || p.name.toLowerCase().includes("подача"));
    const feedOn = Boolean(inp.feed_speed_mm_min) && inp.feed_stroke_fraction > 0;
    if (inp.cycle_mode === "auto" && feedOn && nn(inp.process_force_N) && (cl === null || !cl.known))
      critical.push("Технологическая сила и силы резания не заданы — на рабочей подаче приняты равными 0 Н.");
    else if (inp.cycle_mode === "auto" && !feedOn)
      info.push("Рабочая подача не задана — цикл состоит только из быстрых перемещений.");
    if (cl !== null) {
      info.push(...cl.assumptions);
      if (cl.is_estimate) critical.push("Силы резания оценены по режиму резания (модель Кинцле) — приближённая оценка.");
    }
    if (inp.mass_mode === "components")
      info.push(`Перемещаемая масса — сумма ${inp.mass_items.length} компонентов: ${g(effectiveMass(inp))} кг (общая масса не используется, двойной учёт исключён).`);
    const muNull = nn(inp.friction_coefficient), grNull = nn(inp.guide_resistance_N);
    if (muNull && grNull) critical.push("Сопротивление направляющих (μ и сила уплотнений) не задано — трение принято равным 0.");
    else if (muNull) info.push("Коэффициент трения μ не задан — учтено только сопротивление уплотнений.");
    else if (grNull) info.push("Сопротивление уплотнений не задано — учтено только трение μ·m·g.");
    if (nn(inp.bearing_friction_torque_Nm)) info.push("Момент трения опор Tb не задан — в моменте привода не учтён.");
    info.push("Инерция муфты/зубчатых колёс не учитывается; инерция винта — по свободной длине ls (сплошной стальной цилиндр, номинальный диаметр).");
    if (inp.cycle_mode === "auto" && hasFeed) info.push("Разгон/торможение на рабочей подаче не моделируются.");
    if (inp.thread_margin_mm === 0) info.push("Запас длины резьбы (перебеги, уплотнения) = 0 мм — проверка размещения гайки и хода выполняется без запаса.");
    const lc = criticalLength(inp);
    info.push(`Схема опор: ${MOUNTING_RU[inp.mounting]}. Критическая частота — по длине ${g(lc)} мм ` +
      `(${inp.bearing_span_mm ? "расстояние между опорами" : "свободная длина ls"}); устойчивость — по ` +
      `свободной длине ls = ${g(inp.unsupported_length_mm)} мм и наибольшей |Fa| (без разделения на сжатие/растяжение).`);
    if (inp.orientation === "vertical")
      info.push("Вертикальная ось: ШВП не самотормозящая (η2 > 0) — необходимы тормоз двигателя и/или уравновешивание; противовес в расчёте сил не учтён.");
    info.push(`Коэффициент нагрузки (fp/fw) = ${g(inp.operating_factor_fp)} задан пользователем.`);
    if (inp.motor_connection === "coupling" && inp.gear_ratio !== 1.0)
      info.push("Соединение через муфту, но передаточное отношение ≠ 1 — проверьте исходные данные привода.");
    return [critical, info];
  }

  function filterProducts(products, inp) {
    const mf = new Set(inp.manufacturers.map((m) => m.toLowerCase()));
    const types = new Set(inp.manufacturing_types);
    return products.filter((p) => {
      if (mf.size && !mf.has(p.manufacturer.toLowerCase())) return false;
      if (types.size && p.manufacturing && !types.has(p.manufacturing)) return false;
      const d = p.nominal_diameter_mm;
      if (!nn(inp.diameter_min_mm) && d < inp.diameter_min_mm) return false;
      if (!nn(inp.diameter_max_mm) && d > inp.diameter_max_mm) return false;
      if (!nn(inp.lead_min_mm) && p.lead_mm < inp.lead_min_mm) return false;
      if (!nn(inp.lead_max_mm) && p.lead_mm > inp.lead_max_mm) return false;
      return true;
    });
  }
  function rootDiameter(p) {
    if (!nn(p.root_diameter_mm)) return [p.root_diameter_mm, false, `dk = ${g(p.root_diameter_mm)} мм (каталог)`];
    if (!nn(p.root_diameter_estimate_mm))
      return [p.root_diameter_estimate_mm, true, `dr ≈ ${g(p.root_diameter_estimate_mm)} мм — ${p.root_diameter_method || "оценка"}`];
    return [null, false, "диаметр по дну резьбы неизвестен"];
  }
  function limitState(value, limit, est, tol, largerOk) {
    const ok = largerOk ? value >= limit : value <= limit;
    if (ok) return est ? CS.WARNING : CS.PASS;
    if (est && (largerOk ? value >= limit / tol : value <= limit * tol)) return CS.UNVERIFIED;
    return CS.FAIL;
  }
  function chk(key, title, state, mandatory, value, limit, unit, explanation, reference, formula, substitution, extra) {
    return Object.assign({ key, title, state, mandatory, value: value === undefined ? null : value,
             limit: limit === undefined ? null : limit, unit: unit || "", explanation: explanation || "",
             reference: reference || "", formula: formula || "", substitution: substitution || "",
             category: "engineering", quality: "" }, extra || {});
  }
  const sourceText = (p) => {
    const s = p.source || {};
    const parts = [s.document || "", s.table || ""];
    if (s.page) parts.push(`стр. ${s.page}`);
    if (s.accessed) parts.push(`проверено ${s.accessed}`);
    return parts.filter((x) => x).join(", ");
  };
  const GEO = (q) => ({ category: "geometry", quality: q });
  const DRIVE = { category: "drive" };
  const DATA = { category: "data" };

  function evaluateCandidate(p, inp, loads, criticalAssumptions) {
    const m = methodFor(p);
    const checks = [], vals = { method: m.key }, add = (c) => checks.push(c);
    const phases = loads.map((l) => l.phase);
    const lead = p.lead_mm;
    const vMax = maxSpeed(phases);
    const nMax = 1000.0 * vMax / lead;
    vals.n_max_rpm = nMax;
    vals.v_max_m_min = vMax;
    const faMax = loads.reduce((mm, l) => Math.max(mm, Math.abs(l.force_N)), 0);
    vals.fa_max_N = faMax;
    const ls = inp.unsupported_length_mm, lc = criticalLength(inp);
    const [dr, drEst, drText] = rootDiameter(p);
    vals.root_diameter_mm = dr;
    vals.root_is_estimate = drEst;
    const mnt = inp.mounting;

    add(chk("n_required", "Требуемая частота вращения винта", CS.INFO, false, nMax, null, "об/мин",
      `при v_max = ${g(vMax)} м/мин и шаге P = ${g(lead)} мм`, "", "n = 1000·v / P", `n = 1000·${g(vMax)}/${g(lead)} = ${nMax.toFixed(0)} об/мин`));
    const lim = m.speedLimits(p, nMax);
    if (!lim.some((l) => l.key === "dn" || l.key === "dmn"))
      add(chk("dn", "Предел частоты вращения (DN / dm·n)", CS.UNVERIFIED, true, null, null, "", "Предельное значение DN/dm·n для изделия неизвестно."));
    lim.forEach((sl) => {
      const ok = sl.value <= sl.limit;
      add(chk(sl.key, sl.title, ok ? CS.PASS : sl.hard ? CS.FAIL : CS.WARNING, sl.hard, sl.value, sl.limit, sl.unit, sl.explanation,
        sl.reference, ["dn", "dmn", "dmn_normal"].includes(sl.key) ? "DN = d·n_max" : "n_max ≤ n_доп", `${fmt(sl.value)} ≤ ${fmt(sl.limit)} ${sl.unit}`));
      if (sl.key === "dn" || sl.key === "dmn") vals.dn = sl.value;
    });

    if (dr === null) add(chk("critical_speed", "Критическая частота вращения", CS.UNVERIFIED, true, null, null, "",
      "Диаметр по дну резьбы неизвестен; номинальный диаметр вместо него не используется.", m.reference, m.critical_formula));
    else {
      const nkp = m.criticalPerm(dr, lc, mnt);
      vals.nk_perm_rpm = nkp; vals.nk_rpm = nkp / 0.8;
      add(chk("critical_speed", "Критическая частота вращения", limitState(nMax, nkp, drEst, ROOT_ESTIMATE_TOL.critical_speed), true,
        nMax, nkp, "об/мин", `${drText}; L = ${g(lc)} мм; схема: ${MOUNTING_RU[mnt]}` + (drEst ? "; приближённо (dr — оценка)" : ""),
        `${m.reference}, ${m.key === "csk" ? "стр. E-13" : "F 3.27–3.28, стр. 28"}`, m.critical_formula,
        `${m.criticalSubst(dr, lc, mnt)} = ${nkp.toFixed(0)} об/мин ≥ n_max = ${nMax.toFixed(0)}`));
    }
    if (dr === null) add(chk("buckling", "Устойчивость при сжатии", CS.UNVERIFIED, true, null, null, "",
      "Диаметр по дну резьбы неизвестен.", m.reference, m.buckling_formula));
    else {
      const fkp = m.bucklingPerm(dr, ls, mnt);
      vals.fk_perm_N = fkp;
      add(chk("buckling", "Устойчивость при сжатии", limitState(faMax, fkp, drEst, ROOT_ESTIMATE_TOL.buckling), true, faMax, fkp, "Н",
        `${drText}; ls = ${g(ls)} мм; |Fa|max = ${fmt(faMax)} Н` + (drEst ? "; приближённо" : ""),
        `${m.reference}, ${m.key === "csk" ? "стр. E-12" : "F 3.25–3.26, стр. 28"}`, m.buckling_formula,
        `${m.bucklingSubst(dr, ls, mnt)} = ${fmt(fkp)} Н ≥ ${fmt(faMax)} Н`));
      const y = m.yieldLimit(dr);
      if (y !== null) {
        vals.yield_perm_N = y;
        add(chk("yield", "Растяжение/сжатие по пределу текучести", limitState(faMax, y, drEst, ROOT_ESTIMATE_TOL.yield), true, faMax, y, "Н",
          drText, `${m.reference}, стр. E-13`, "P = σ·π·dr²/4, σ = 147 МПа", `P = 147·π·${g(dr)}²/4 = ${fmt(y)} Н ≥ ${fmt(faMax)} Н`));
      }
    }

    if (nn(p.static_load_N)) add(chk("static", "Статический запас S0", CS.UNVERIFIED, true, null, null, "", "C0 неизвестна или признана недостоверной."));
    else {
      const s0 = faMax > 0 ? p.static_load_N / faMax : Infinity;
      vals.s0 = s0;
      add(chk("static", "Статический запас S0 (fs)", s0 >= inp.static_safety_required ? CS.PASS : CS.FAIL, true, s0,
        inp.static_safety_required, "", m.static_factor_hint, `${m.reference}, ${m.key === "csk" ? "стр. E-29" : "F 3.3, стр. 24"}`,
        "S0 = C0 / |Fa|max ≥ S0 треб.", `S0 = ${fmt(p.static_load_N)}/${fmt(faMax)} = ${fmt(s0, 2)} ≥ ${g(inp.static_safety_required)}`));
    }

    let fpr = 0.0;
    const isDouble = p.preload_type === "double_nut";
    if (inp.nut_type_pref !== "any") {
      const want = inp.nut_type_pref === "double";
      add(chk("nut_type", "Тип гайки", isDouble === want ? CS.PASS : CS.FAIL, true, null, null, "",
        `Требуется ${want ? "двойная" : "одинарная"} гайка; изделие — ${isDouble ? "двойная" : "одинарная"}`, "", "", "", GEO("confirmed")));
    }
    if (inp.preload_percent > 0) {
      if (isDouble) {
        const l = PRELOAD_LIMIT_PERCENT.double;
        if (p.dynamic_load_N) fpr = inp.preload_percent / 100.0 * p.dynamic_load_N;
        vals.preload_N = fpr;
        add(chk("preload", "Натяг", inp.preload_percent <= l ? CS.PASS : CS.FAIL, true, inp.preload_percent, l, "% C",
          `Fpr = ${g(inp.preload_percent)} %·C = ${fmt(fpr)} Н (двойная гайка, ≤ ${g(l)} %)`, m.reference, "Fpr = fpr·C"));
        if (!m.supports_preload_life) add(chk("preload_life", "Натяг в расчёте ресурса", CS.WARNING, false, null, null, "",
          "Методика каталога CSK не содержит учёта натяга в ресурсе — ресурс рассчитан без натяга (может быть завышен)."));
      } else if (p.preload_type === "none")
        add(chk("preload", "Натяг", CS.FAIL, true, null, null, "", "Требуется натяг, а гайка по каталогу поставляется с осевым зазором."));
      else add(chk("preload", "Натяг", CS.UNVERIFIED, true, null, null, "", "Исполнение гайки по натягу в каталоге не указано — уточнить у производителя."));
    } else if (isDouble) {
      add(chk("preload", "Натяг", CS.WARNING, false, null, null, "",
        "Двойная гайка поставляется с натягом, но его величина не задана: ресурс и момент рассчитаны без натяга (ресурс может быть завышен)."));
    }

    const revs = loads.map((l) => (l.phase.direction !== 0 ? Math.abs(meanSpeed(l.phase)) * 1000.0 / lead * l.phase.duration_s / 60.0 : 0.0));
    const forces = loads.map((l) => l.force_N), durations = loads.map((l) => l.phase.duration_s);
    if (nn(p.dynamic_load_N)) add(chk("life", "Ресурс L10", CS.UNVERIFIED, true, null, null, "", "Динамическая грузоподъёмность неизвестна."));
    else {
      const fr = RELIABILITY_FACTORS[inp.reliability_percent], fp = inp.operating_factor_fp;
      let life, subst, pref;
      if (m.key === "csk") {
        life = computeLifeCsk(p.dynamic_load_N, forces, revs, durations, fp, fr);
        const fm = life.fbm1_N / fp;
        vals.fm_N = fm;
        subst = `Fm = ${fmt(fm)} Н; L = (${fmt(p.dynamic_load_N)}/(${fmt(fm)}·${g(fp)}))³·10⁶ = ${sig3(life.l_rev)} об`;
        pref = `${CSK_REF}, стр. E-24…E-26`;
      } else {
        life = computeLife(p.dynamic_load_N, forces, revs, durations, fp, inp.reliability_percent, m.supports_preload_life ? fpr : 0.0);
        subst = `Fbm1 = ${fmt(life.fbm1_N)} Н, Fbm2 = ${fmt(life.fbm2_N)} Н (с fp = ${g(fp)}); L1 = ${sig3(life.l1_rev)}, L2 = ${sig3(life.l2_rev)} → L = ${sig3(life.l_rev)} об`;
        pref = `${HIWIN_REF}, F 3.4–3.14, стр. 24–26`;
      }
      const lh = life.hours();
      Object.assign(vals, { fbm1_N: life.fbm1_N, fbm2_N: life.fbm2_N, l_rev: life.l_rev, lm_rev: life.lm_rev,
        life_km: life.km(lead), life_h: lh, life_motion_h: life.motionHours(), nm_rpm: life.nm_rpm,
        rev_per_cycle: life.revolutions_per_cycle, cycle_time_s: life.cycle_time_s, equivalent_load_N: life.fbm });
      if (inp.hours_per_day && inp.days_per_year) vals.life_years = lh / (inp.hours_per_day * inp.days_per_year);
      if ((fpr === 0 || !m.supports_preload_life) && isFinite(lh) && lh > 0)
        vals.c_required_N = p.dynamic_load_N * Math.pow(inp.required_life_h / lh, 1.0 / 3.0);
      const years = "life_years" in vals ? `; ≈ ${vals.life_years.toFixed(1)} лет при ${g(inp.hours_per_day)} ч/сут × ${g(inp.days_per_year)} дн/год` : "";
      add(chk("life", "Ресурс L10 (часы работы в цикле)", lh >= inp.required_life_h ? CS.PASS : CS.FAIL, true, lh, inp.required_life_h, "ч",
        `с fr (${inp.reliability_percent} %) Lm = ${sig3(life.lm_rev)} об = ${fmt(life.km(lead))} км = ${fmt(lh)} ч при nm = ${life.nm_rpm.toFixed(1)} об/мин (чистое движение ${fmt(life.motionHours())} ч)${years}`,
        pref, m.life_formula, subst));
      if (m.key === "csk" && inp.reliability_percent !== 90)
        add(chk("reliability_method", "Надёжность ≠ 90 % для каталога CSK", CS.WARNING, false, null, null, "",
          "Каталог CSK приводит ресурс только для 90 %; коэффициент fr взят из DIN ISO 3408 (HIWIN табл. 3.17) — согласуйте с производителем."));
      if (m.key === "hiwin") {
        const ratio = life.fbm / fp / p.dynamic_load_N;
        vals.load_ratio = ratio;
        add(chk("load_ratio", "Средняя нагрузка ≤ 0.2·C (рекомендация)", ratio <= 0.2 ? CS.PASS : CS.WARNING, false, ratio, 0.2, "",
          `Fbm/C = ${ratio.toFixed(3)} (без fp); HIWIN рекомендует ≤ 1/5`, `${HIWIN_REF}, табл. 3.1, стр. 12`, "Fbm / C ≤ 0.2"));
      }
      const rec = m.recommendedLoadFactor(vMax);
      if (rec !== null)
        add(chk("load_factor", `Коэффициент нагрузки ${m.load_factor_name} (рекомендация)`, fp >= rec[0] ? CS.PASS : CS.WARNING, false, fp, rec[0], "",
          `Для v_max = ${g(vMax)} м/мин рекомендовано ${m.load_factor_name} = ${g(rec[0])}…${g(rec[1])}; принято ${g(fp)}`, `${CSK_REF}, стр. E-24`));
    }

    // геометрия
    const span = inp.bearing_span_mm || ls;
    if (nn(p.nut_length_mm)) add(chk("thread_fit", "Ход + гайка между опорами", CS.UNVERIFIED, true, null, null, "", "Длина гайки неизвестна.", "", "", "", GEO("impossible")));
    else {
      const need = inp.stroke_mm + p.nut_length_mm + inp.thread_margin_mm;
      vals.thread_length_needed_mm = need;
      add(chk("thread_fit", "Ход + гайка между опорами", need <= span ? CS.PASS : CS.FAIL, true, need, span, "мм",
        `резьбовая часть: ход ${g(inp.stroke_mm)} + гайка ${g(p.nut_length_mm)} + запас ${g(inp.thread_margin_mm)}`, sourceText(p),
        "L_резьбы = ход + L_гайки + запас ≤ L_между опорами", `${g(inp.stroke_mm)} + ${g(p.nut_length_mm)} + ${g(inp.thread_margin_mm)} = ${g(need)} ≤ ${g(span)} мм`, GEO("confirmed")));
      if (!nn(p.max_thread_length_mm))
        add(chk("thread_max", "Макс. длина резьбы по каталогу", need <= p.max_thread_length_mm ? CS.PASS : CS.FAIL, true, need, p.max_thread_length_mm, "мм", "", "", "", "", GEO("confirmed")));
    }
    let totalLen = null;
    if (!nn(inp.end_journals_length_mm)) { totalLen = span + inp.end_journals_length_mm; vals.total_length_mm = totalLen; }
    if (!nn(inp.available_total_length_mm)) {
      if (totalLen === null) add(chk("total_length", "Общая длина винта в доступном пространстве", CS.WARNING, false, span,
        inp.available_total_length_mm, "мм", "Длина концов вала (цапф) не задана — сравнивается только длина между опорами.", "", "", "", GEO("approximate")));
      else add(chk("total_length", "Общая длина винта в доступном пространстве", totalLen <= inp.available_total_length_mm ? CS.PASS : CS.FAIL, true,
        totalLen, inp.available_total_length_mm, "мм", "", "", "L_общ = L_между опорами + L_концов ≤ L_доступн",
        `${g(span)} + ${g(inp.end_journals_length_mm)} = ${g(totalLen)} ≤ ${g(inp.available_total_length_mm)} мм`, GEO("confirmed")));
    }
    const classes = p.accuracy_classes_v300p_um || {};
    let allowed = classes;
    if (!nn(inp.required_v300p_um)) {
      const keys = Object.keys(classes);
      if (!keys.length) {
        const ref = p.catalog_accuracy_reference_um || {};
        const rk = Object.keys(ref);
        add(chk("accuracy", "Точность хода v300p", CS.UNVERIFIED, true, null, null, "", "Доступные классы точности для этой позиции в каталоге не указаны" +
          (rk.length ? `; каталог в целом: ${rk.map((k) => `${k} ${g(ref[k])} мкм`).join(", ")}` : ""), "", "", "", GEO("needs_drawing")));
      } else {
        allowed = {};
        keys.forEach((c) => { if (classes[c] <= inp.required_v300p_um) allowed[c] = classes[c]; });
        const best = Math.min(...keys.map((c) => classes[c]));
        const ak = Object.keys(allowed);
        add(chk("accuracy", "Точность хода v300p", ak.length ? CS.PASS : CS.FAIL, true, best, inp.required_v300p_um, "мкм",
          "Подходящие классы: " + (ak.length ? ak.join(", ") : "нет") + `; лучший доступный v300p = ${g(best)} мкм`, m.reference));
      }
    }
    const msl = p.max_shaft_length_mm || {};
    const lens = Object.keys(msl).filter((c) => c in allowed && !nn(msl[c])).map((c) => msl[c]);
    const checkLen = totalLen !== null ? totalLen : span;
    if (!lens.length) {
      const pub = p.length_limits_published !== false;
      add(chk("max_length", "Макс. длина вала по каталогу", CS.UNVERIFIED, pub, null, null, "",
        pub ? "Максимальная длина вала для подходящих классов точности не указана." : "Каталог производителя не публикует предельные длины — уточнить у производителя.",
        "", "", "", GEO("needs_drawing")));
    } else {
      const lmax = Math.max(...lens);
      vals.max_shaft_length_mm = lmax;
      add(chk("max_length", "Макс. длина вала по каталогу", checkLen <= lmax ? CS.PASS : CS.FAIL, true, checkLen, lmax, "мм",
        "Проверено необходимое условие" + (totalLen !== null ? "" : " (без длины цапф — она не задана)"), "", "", "",
        GEO(totalLen !== null ? "confirmed" : "approximate")));
    }
    if (!nn(inp.max_backlash_mm)) {
      const play = isDouble ? 0.0 : p.max_axial_play_mm;
      if (nn(play)) add(chk("backlash", "Осевой люфт", CS.UNVERIFIED, true, null, null, "", "Осевой зазор гайки в каталоге не указан."));
      else add(chk("backlash", "Осевой люфт", play <= inp.max_backlash_mm ? CS.PASS : CS.FAIL, true, play, inp.max_backlash_mm, "мм", "Макс. осевой зазор по каталогу", sourceText(p)));
    }
    if (!nn(inp.max_nut_diameter_mm)) {
      const ds = [p.flange_diameter_mm, p.nut_outer_diameter_mm].filter((x) => !nn(x));
      if (!ds.length) add(chk("nut_diameter", "Диаметр гайки/фланца", CS.UNVERIFIED, true, null, null, "", "", "", "", "", GEO("needs_drawing")));
      else {
        const dmax = Math.max(...ds);
        add(chk("nut_diameter", "Диаметр гайки/фланца", dmax <= inp.max_nut_diameter_mm ? CS.PASS : CS.FAIL, true, dmax, inp.max_nut_diameter_mm, "мм", sourceText(p), "", "", "", GEO("confirmed")));
      }
    }
    if (!nn(inp.max_nut_length_mm)) {
      if (nn(p.nut_length_mm)) add(chk("nut_length", "Длина гайки", CS.UNVERIFIED, true, null, null, "", "", "", "", "", GEO("needs_drawing")));
      else add(chk("nut_length", "Длина гайки", p.nut_length_mm <= inp.max_nut_length_mm ? CS.PASS : CS.FAIL, true, p.nut_length_mm, inp.max_nut_length_mm, "мм", sourceText(p), "", "", "", GEO("confirmed")));
    }

    // опоры
    const bf = inp.bearing_fixed;
    if (!nn(bf.allowable_axial_N))
      add(chk("bearing_axial", "Допустимая осевая нагрузка неподвижной опоры", faMax <= bf.allowable_axial_N ? CS.PASS : CS.FAIL, true,
        faMax, bf.allowable_axial_N, "Н", `${bf.manufacturer} ${bf.model}`.trim() || "данные опоры пользователя",
        "данные пользователя / каталог подшипника", "|Fa|max ≤ Fa доп. опоры", `${fmt(faMax)} ≤ ${fmt(bf.allowable_axial_N)} Н`, DRIVE));
    else add(chk("bearing_axial", "Допустимая осевая нагрузка неподвижной опоры", CS.UNVERIFIED, false, null, null, "",
      "Конкретная опора не задана или её допустимая осевая нагрузка неизвестна — опора ещё не проверена.", "", "", "", DRIVE));
    const note = bearingSchemeNote(inp);
    if (note) add(chk("bearing_scheme", "Соответствие опор схеме закрепления", CS.WARNING, false, null, null, "", note, "", "", "", DRIVE));

    // жёсткость
    let rbs = null;
    const notes = [];
    if (dr !== null) {
      const rs = shaftRigidity(dr, ls, mnt);
      vals.shaft_rigidity_N_um = rs;
      let rn = null;
      if (!nn(p.nut_rigidity_N_um) && p.dynamic_load_N) {
        if (isDouble) {
          if (fpr > 0) rn = 0.8 * p.nut_rigidity_N_um * Math.pow(fpr / (m.nut_rigidity_preload_ratio * p.dynamic_load_N), 1 / 3);
          else notes.push("величина натяга не задана");
        } else if ("fbm1_N" in vals) {
          const fbm = Math.max(vals.fbm1_N, vals.fbm2_N) / inp.operating_factor_fp;
          if (fbm > 0) rn = 0.8 * p.nut_rigidity_N_um * Math.pow(fbm / (m.nut_rigidity_play_ratio * p.dynamic_load_N), 1 / 3);
        }
      } else if (nn(p.nut_rigidity_N_um)) notes.push("жёсткость гайки в каталоге не указана");
      if (rn !== null) {
        vals.nut_rigidity_N_um = rn;
        const parts = [rs, rn];
        if (!nn(bf.stiffness_N_um)) parts.push(bf.stiffness_N_um); else notes.push("жёсткость опор не задана");
        rbs = series(...parts);
        vals.rigidity_N_um = rbs;
      }
    }
    const rtext = `Rs = ${fmt("shaft_rigidity_N_um" in vals ? vals.shaft_rigidity_N_um : null)} Н/мкм (dc ≈ dr, наихудшее положение гайки), ` +
      `Rn = ${fmt("nut_rigidity_N_um" in vals ? vals.nut_rigidity_N_um : null)} Н/мкм` + (bf.stiffness_N_um ? `, Rb = ${g(bf.stiffness_N_um)} Н/мкм` : "") +
      `, K = ${fmt(rbs)} Н/мкм; стол не учтён` + (notes.length ? `; ${notes.join("; ")}` : "");
    const rform = "1/K = 1/Rs + 1/Rn (+ 1/Rb)";
    if (!nn(inp.required_rigidity_N_um)) {
      if (rbs === null) add(chk("rigidity", "Осевая жёсткость привода", CS.UNVERIFIED, true, null, null, "", rtext, "", rform));
      else add(chk("rigidity", "Осевая жёсткость привода", rbs >= inp.required_rigidity_N_um ? CS.WARNING : CS.FAIL, true, rbs,
        inp.required_rigidity_N_um, "Н/мкм", rtext + ". Приближённая оценка.", m.reference, rform));
    } else add(chk("rigidity", "Осевая жёсткость (справочно)", CS.INFO, false, rbs, null, "Н/мкм", rtext, "", rform));
    if (!nn(inp.max_axial_deflection_um)) {
      if (rbs === null) add(chk("deflection", "Осевая упругая деформация", CS.UNVERIFIED, true, null, null, "", "Жёсткость не определена: " + rtext, "", "δ = Fa / K"));
      else {
        const delta = faMax / rbs;
        vals.deflection_um = delta;
        add(chk("deflection", "Осевая упругая деформация", delta <= inp.max_axial_deflection_um ? CS.WARNING : CS.FAIL, true, delta,
          inp.max_axial_deflection_um, "мкм", "Приближённо: жёсткость стола и креплений не учтена" + (bf.stiffness_N_um ? "" : ", опоры не учтены — реальный прогиб больше"),
          m.reference, "δ = |Fa|max / K", `δ = ${fmt(faMax)}/${rbs.toFixed(1)} = ${delta.toFixed(1)} мкм`));
      }
    }

    // момент и двигатель
    let td = null;
    if (fpr > 0 && m.key === "csk") {
      td = cskPreloadK(lead, p.nominal_diameter_mm) * fpr * lead / (2000.0 * Math.PI);
      vals.preload_torque_Nm = td;
    }
    const tq = computeTorque(loads, inp, lead, p.nominal_diameter_mm, fpr, td);
    const tConst = tq.phases.filter((pt) => Math.abs(pt.inertia_torque_motor_Nm) < 1e-12 && pt.n_screw_max_rpm > 0)
      .reduce((mm, pt) => Math.max(mm, Math.abs(pt.static_torque_motor_Nm)), 0.0);
    Object.assign(vals, { torque_peak_Nm: tq.peak_Nm, torque_rms_Nm: tq.rms_Nm, power_peak_W: tq.peak_power_W,
      torque_const_max_Nm: tConst, j_screw_kgm2: tq.j_screw_kgm2, j_total_motor_kgm2: tq.j_total_motor_kgm2,
      inertia_ratio: tq.inertia_ratio, n_motor_max_rpm: nMax * inp.gear_ratio });
    vals.torque = tq;
    const tqText = `Пиковый момент на двигателе ${tq.peak_Nm.toFixed(2)} Н·м, при постоянной скорости ${tConst.toFixed(2)} Н·м, ` +
      `среднеквадратичный ${tq.rms_Nm.toFixed(2)} Н·м, пиковая мощность ${tq.peak_power_W.toFixed(0)} Вт, приведённая инерция ${tq.j_total_motor_kgm2.toExponential(3)} кг·м²`;
    const tform = "T = (F·P/(2000π·η1) + Tb + Td)/i + J·α";
    const motorGiven = [inp.motor_peak_torque_Nm, inp.motor_rated_torque_Nm, inp.motor_max_speed_rpm].some((v) => !nn(v));
    if (!nn(inp.motor_peak_torque_Nm)) add(chk("motor_peak", "Пиковый момент двигателя", tq.peak_Nm <= inp.motor_peak_torque_Nm ? CS.PASS : CS.FAIL,
      true, tq.peak_Nm, inp.motor_peak_torque_Nm, "Н·м", tqText, `${HIWIN_REF}, F 3.15–3.22`, tform, "", DRIVE));
    if (!nn(inp.motor_rated_torque_Nm)) {
      add(chk("motor_rms", "Среднеквадратичный момент двигателя", tq.rms_Nm <= inp.motor_rated_torque_Nm ? CS.PASS : CS.FAIL,
        true, tq.rms_Nm, inp.motor_rated_torque_Nm, "Н·м", "", "", "T_rms = √(ΣT²·t/Σt)", "", DRIVE));
      if (m.key === "csk") {
        const l30 = 0.3 * inp.motor_rated_torque_Nm;
        add(chk("motor_const_30", "Момент при постоянной скорости ≤ 30 % номинального (рекомендация)", tConst <= l30 ? CS.PASS : CS.WARNING,
          false, tConst, l30, "Н·м", "", `${CSK_REF}, стр. E-34`, "", "", DRIVE));
      }
    }
    if (!nn(inp.motor_max_speed_rpm)) {
      const nmo = nMax * inp.gear_ratio;
      add(chk("motor_speed", "Частота вращения двигателя", nmo <= inp.motor_max_speed_rpm ? CS.PASS : CS.FAIL, true, nmo, inp.motor_max_speed_rpm, "об/мин", "", "", "", "", DRIVE));
    }
    if (!motorGiven) add(chk("torque", "Момент и мощность привода (справочно)", CS.INFO, false, tq.peak_Nm, null, "Н·м", tqText, `${HIWIN_REF}, F 3.15–3.23`, tform, "", DRIVE));
    else if (nn(inp.bearing_friction_torque_Nm)) add(chk("motor_assumption", "Допущение для проверки двигателя", CS.WARNING, false, null, null, "", "Момент трения опор не задан и не учтён.", "", "", "", DRIVE));

    (p.data_warnings || []).forEach((w) => add(chk("catalog_data", "Достоверность данных каталога", CS.WARNING, false, null, null, "", w, "", "", "", DATA)));
    if (["imported_unverified", "unverified"].includes(p.verification_status || "unverified"))
      add(chk("catalog_verification", "Данные изделия не проверены", CS.WARNING, false, null, null, "", "Изделие импортировано без сверки с первоисточником.", "", "", "", DATA));
    criticalAssumptions.forEach((a) => add(chk("assumption", "Допущение во входных данных", CS.WARNING, false, null, null, "", a, "", "", "", DATA)));
    const [status, reasons] = decideStatus(checks);
    return { product: p, status, checks, values: vals, reasons,
             summary: reasons.length ? reasons.join("; ") : "все обязательные проверки пройдены" };
  }

  function bearingSchemeNote(inp) {
    const notes = [];
    const fixedKinds = new Set(["angular_contact_pair", "ballscrew_support_unit", "axial_angular_contact", "unknown"]);
    const b1 = inp.bearing_fixed, b2 = inp.bearing_other;
    if (b1.kind === "deep_groove")
      notes.push("на неподвижной опоре выбран радиальный подшипник — для осевых нагрузок ШВП обычно применяют сдвоенные радиально-упорные или упорно-радиальные подшипники");
    else if (b1.kind === "angular_contact" && (b1.count || 1) < 2)
      notes.push("одиночный радиально-упорный подшипник воспринимает осевую нагрузку только в одном направлении");
    if (inp.mounting === "fixed-fixed" && !fixedKinds.has(b2.kind))
      notes.push("схема «жёсткая–жёсткая», но вторая опора не относится к упорным/радиально-упорным");
    if (inp.mounting === "fixed-free" && b2.kind !== "unknown") notes.push("схема «жёсткая–свободная», но задана вторая опора");
    return notes.join("; ");
  }

  function decideStatus(checks) {
    const txt = (c) => {
      if (!nn(c.value) && !nn(c.limit))
        return `${c.title}: ${fmt(c.value, Math.abs(c.value) < 10 ? 2 : 0)} при пределе ${fmt(c.limit, Math.abs(c.limit) < 10 ? 2 : 0)} ${c.unit}`.trim();
      return `${c.title}: ${c.explanation || c.state}`;
    };
    const fails = checks.filter((c) => c.state === CS.FAIL);
    if (fails.length) return [STATUS.UNSUITABLE, fails.map(txt)];
    const unver = checks.filter((c) => c.state === CS.UNVERIFIED && c.mandatory);
    if (unver.length) return [STATUS.NO_DATA, unver.map((c) => `${c.title}: не проверено — ${c.explanation || "нет данных"}`)];
    const warns = checks.filter((c) => c.state === CS.WARNING || (c.state === CS.UNVERIFIED && !c.mandatory));
    if (warns.length) return [STATUS.CONDITIONAL, warns.map((c) => `${c.title}: ${c.explanation}`)];
    return [STATUS.SUITABLE, []];
  }

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function sortKey(a, b) {
    return cmp(STATUS_ORDER[a.status], STATUS_ORDER[b.status]) || cmp(a.product.nominal_diameter_mm, b.product.nominal_diameter_mm) ||
      cmp(a.product.dynamic_load_N || 0, b.product.dynamic_load_N || 0) || cmp(a.product.lead_mm, b.product.lead_mm) ||
      cmp(a.product.id, b.product.id);
  }

  function normalizeInput(raw) {
    const inp = Object.assign({}, DEFAULT_INPUT, raw || {});
    inp.manual_phases = (inp.manual_phases || []).map((p) => phase(p.name, p.duration_s, p.direction, p.v_start_m_min,
      p.v_end_m_min, p.process_force_N, { phase_type: p.phase_type || "", accel_input_m_s2: nn(p.accel_input_m_s2) ? null : p.accel_input_m_s2,
        axial_load_N: nn(p.axial_load_N) ? null : p.axial_load_N, normal_extra_N: p.normal_extra_N || 0.0 }));
    inp.mass_items = (inp.mass_items || []).map((m) => ({ name: m.name, mass_kg: m.mass_kg }));
    inp.cutting = Object.assign({}, DEFAULT_CUTTING, inp.cutting || {});
    inp.bearing_fixed = Object.assign({}, DEFAULT_BEARING, inp.bearing_fixed || {});
    inp.bearing_other = Object.assign({}, DEFAULT_BEARING, inp.bearing_other || {});
    inp.manufacturers = inp.manufacturers || [];
    inp.manufacturing_types = inp.manufacturing_types || [];
    return inp;
  }

  function select(products, rawInput) {
    const inp = normalizeInput(rawInput);
    const errors = validateInput(inp);
    if (errors.length) { const e = new Error(errors.map((x) => "• " + x[1]).join("\n")); e.errors = errors; throw e; }
    const phases = buildCycle(inp);
    const loads = phases.map((p) => phaseLoad(p, inp));
    const [critical, info] = globalAssumptions(inp, phases);
    const flt = filterProducts(products, inp);
    const cands = flt.map((p) => evaluateCandidate(p, inp, loads, critical));
    cands.sort(sortKey);
    const counts = {};
    Object.values(STATUS).forEach((s) => (counts[s] = 0));
    cands.forEach((c) => counts[c.status]++);
    return { input: inp, phases, loads, candidates: cands, assumptions: critical.concat(info),
             excluded_by_filter: products.length - flt.length, catalog_size: products.length, counts };
  }

  return { G, STATUS, STATUS_ORDER, STATUS_SYMBOL, CS, MOUNTING_RU, BEARING_KINDS, RELIABILITY_FACTORS, DEFAULT_INPUT,
           fmt, g, buildCycle, trapezoid, phaseLoad, computeLife, computeLifeCsk, cuttingLoad, validateInput, select,
           normalizeInput, meanSpeed, distance, effectiveMass, methodFor, sourceText };
});
