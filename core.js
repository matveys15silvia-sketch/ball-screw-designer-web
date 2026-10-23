/* Расчётное ядро Ball Screw Designer — порт app/core/*.py на JavaScript.
 * Формулы, допущения и статусы совпадают с Python-ядром (см. docs/FORMULAS.md).
 * Совпадение результатов проверяется автоматически: tools/web_parity.py + web/parity_check.js
 * (все позиции базы, несколько сценариев). Единицы: мм, Н, с, об/мин, кг, Н·м, кг·м².
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BSD = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const G = 9.80665;
  const HIWIN_REF = "HIWIN BS-08-2-EN-1704-K";

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
  const FN = { "fixed-fixed": 1.0, "fixed-supported": 0.692, "supported-supported": 0.446, "fixed-free": 0.147 };
  const FK = { "fixed-fixed": 1.0, "fixed-supported": 0.5, "supported-supported": 0.25, "fixed-free": 0.0625 };
  const RELIABILITY_FACTORS = { 90: 1.0, 95: 0.63, 96: 0.53, 97: 0.44, 98: 0.33, 99: 0.21 };
  const E_STEEL = 2.1e5, STEEL_DENSITY = 7850.0;

  const DEFAULT_INPUT = {
    name: "Ось X", orientation: "horizontal", moving_mass_kg: 200.0, stroke_mm: 800.0, rapid_speed_m_min: 20.0,
    acceleration_m_s2: 2.0, feed_speed_mm_min: 2000.0, feed_stroke_fraction: 0.5, dwell_time_s: 2.0,
    process_force_N: null, friction_coefficient: null, guide_resistance_N: null, cycle_mode: "auto",
    manual_phases: [], unsupported_length_mm: 1100.0, mounting: "fixed-supported", thread_margin_mm: 0.0,
    required_life_h: 20000.0, reliability_percent: 90, operating_factor_fp: 1.2, static_safety_required: 2.0,
    preload_percent: 0.0, efficiency_forward: 0.9, efficiency_reverse: 0.8, bearing_friction_torque_Nm: null,
    gear_ratio: 1.0, motor_inertia_kgm2: null, motor_rated_torque_Nm: null, motor_peak_torque_Nm: null,
    motor_max_speed_rpm: null, max_backlash_mm: null, required_v300p_um: null, required_rigidity_N_um: null,
    max_nut_diameter_mm: null, max_nut_length_mm: null, manufacturers: [], manufacturing_types: [],
    diameter_min_mm: null, diameter_max_mm: null, lead_min_mm: null, lead_max_mm: null,
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
  function sig3(v) { return isFinite(v) ? Number(v).toPrecision(3).replace(/\.?0+e/, "e").replace("e+", "e+") : "∞"; }

  // ---------- фазы ----------
  function phase(name, duration_s, direction, v0, v1, fproc) {
    return { name, duration_s, direction, v_start_m_min: v0 || 0, v_end_m_min: v1 || 0, process_force_N: fproc || 0 };
  }
  const meanSpeed = (p) => 0.5 * (p.v_start_m_min + p.v_end_m_min);
  const accel = (p) => (p.duration_s <= 0 ? 0 : Math.abs(p.v_end_m_min - p.v_start_m_min) / 60.0 / p.duration_s);
  function signedAccel(p) {
    if (p.direction === 0) return 0.0;
    const sgn = p.v_end_m_min >= p.v_start_m_min ? 1.0 : -1.0;
    return p.direction * sgn * accel(p);
  }
  const distance = (p) => meanSpeed(p) * 1000.0 / 60.0 * p.duration_s;

  function trapezoid(distance_mm, v_max, a, direction, label) {
    if (distance_mm <= 0) return [];
    const s = distance_mm / 1000.0, v = v_max / 60.0;
    const s_acc = v * v / (2.0 * a);
    if (2.0 * s_acc >= s) {
      const vpk = Math.sqrt(s * a), t = vpk / a, vp = vpk * 60.0;
      return [phase(`${label}: разгон`, t, direction, 0, vp), phase(`${label}: торможение`, t, direction, vp, 0)];
    }
    const t_acc = v / a, t_const = (s - 2.0 * s_acc) / v;
    return [phase(`${label}: разгон`, t_acc, direction, 0, v_max),
            phase(`${label}: v = const`, t_const, direction, v_max, v_max),
            phase(`${label}: торможение`, t_acc, direction, v_max, 0)];
  }

  function buildCycle(inp) {
    if (inp.cycle_mode === "manual") return inp.manual_phases.map((p) => Object.assign({}, p));
    let ph = [];
    const f = inp.feed_speed_mm_min ? inp.feed_stroke_fraction : 0.0;
    ph = ph.concat(trapezoid(inp.stroke_mm * (1.0 - f), inp.rapid_speed_m_min, inp.acceleration_m_s2, +1, "Быстрый ход вперёд"));
    if (f > 0) {
      const vf = inp.feed_speed_mm_min / 1000.0;
      const t = inp.stroke_mm * f / (inp.feed_speed_mm_min / 60.0);
      ph.push(phase("Рабочая подача", t, +1, vf, vf, inp.process_force_N || 0.0));
    }
    ph = ph.concat(trapezoid(inp.stroke_mm, inp.rapid_speed_m_min, inp.acceleration_m_s2, -1, "Быстрый ход назад"));
    if (inp.dwell_time_s > 0) ph.push(phase("Стоянка", inp.dwell_time_s, 0, 0, 0));
    return ph;
  }
  const maxSpeed = (phases) => phases.reduce((m, p) => Math.max(m, p.v_start_m_min, p.v_end_m_min), 0);

  // ---------- силы ----------
  function phaseLoad(p, inp) {
    const m = inp.moving_mass_kg, vertical = inp.orientation === "vertical", d = p.direction;
    const inertia = m * signedAccel(p);
    const normal = vertical ? 0.0 : m * G;
    const fric = d * ((inp.friction_coefficient || 0.0) * normal + (inp.guide_resistance_N || 0.0));
    const gravity = vertical ? m * G : 0.0;
    const proc = d * p.process_force_N;
    const total = inertia + fric + gravity + proc;
    return { phase: p, force_N: total, components: { "инерция": inertia, "трение": fric, "тяжесть": gravity,
             "технологическая": proc }, non_inertial_force_N: total - inertia };
  }

  // ---------- ресурс ----------
  function reliabilityFactor(pct) {
    const f = RELIABILITY_FACTORS[pct];
    if (f === undefined) throw new Error(`Надёжность ${pct} % отсутствует в табл. 3.17 HIWIN`);
    return f;
  }
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
    const total = revs.reduce((s, r) => s + r, 0);
    if (total <= 0) throw new Error("За цикл нет ни одного оборота винта — ресурс не определён");
    let s1 = 0, s2 = 0;
    forces.forEach((f, i) => {
      const r = revs[i];
      if (r <= 0) return;
      const [b1, b2] = sideLoads(f, fpr);
      s1 += Math.pow(b1 * fp, 3) * r;
      s2 += Math.pow(b2 * fp, 3) * r;
    });
    return [Math.cbrt(s1 / total), Math.cbrt(s2 / total)];
  }
  const ratingLife = (c, fbm) => (fbm <= 0 ? Infinity : Math.pow(c / fbm, 3) * 1e6);
  function combineLife(l1, l2) {
    const s = [l1, l2].filter(isFinite).reduce((a, l) => a + Math.pow(l, -10.0 / 9.0), 0);
    return s === 0 ? Infinity : Math.pow(s, -0.9);
  }
  function computeLife(c, forces, revs, durations, fp, rel, fpr) {
    const [fbm1, fbm2] = equivalentLoads(forces, revs, fp, fpr || 0);
    const l1 = ratingLife(c, fbm1), l2 = ratingLife(c, fbm2), l = combineLife(l1, l2);
    const tCycle = durations.reduce((s, t) => s + t, 0);
    const tMotion = durations.reduce((s, t, i) => s + (revs[i] > 0 ? t : 0), 0);
    const revCycle = revs.reduce((s, r) => s + r, 0);
    const nm = tCycle > 0 ? revCycle / tCycle * 60.0 : 0.0;
    const lm = l * reliabilityFactor(rel);
    return {
      fbm1_N: fbm1, fbm2_N: fbm2, l1_rev: l1, l2_rev: l2, l_rev: l, lm_rev: lm, revolutions_per_cycle: revCycle,
      cycle_time_s: tCycle, motion_time_s: tMotion, nm_rpm: nm,
      km: (lead) => lm * lead / 1e6,
      hours: () => (nm <= 0 ? Infinity : lm / (nm * 60.0)),
      motionHours: () => (revCycle <= 0 ? Infinity : lm / revCycle * tMotion / 3600.0),
      fbm: Math.max(fbm1, fbm2),
    };
  }

  // ---------- пределы ----------
  function criticalSpeed(dk, ls, m) {
    if (dk <= 0 || ls <= 0) throw new Error("dk и ls должны быть положительными");
    return 2.71e8 * FN[m] * dk / (ls * ls);
  }
  function bucklingLoad(dk, ls, m) {
    if (dk <= 0 || ls <= 0) throw new Error("dk и ls должны быть положительными");
    return 4.072e5 * FK[m] * Math.pow(dk, 4) / (ls * ls);
  }
  const staticSafety = (c0, fa) => (fa <= 0 ? Infinity : c0 / fa);

  // ---------- жёсткость ----------
  function shaftRigidity(dc, ls, m) {
    return m === "fixed-fixed" ? Math.PI * dc * dc * E_STEEL / (ls * 1e3) : Math.PI * dc * dc * E_STEEL / (4.0 * ls * 1e3);
  }
  const nutRigPreloaded = (r, fpr, c) => 0.8 * r * Math.cbrt(fpr / (0.1 * c));
  const nutRigPlay = (k, fbm, c) => 0.8 * k * Math.cbrt(fbm / (0.28 * c));
  function series(...parts) {
    if (parts.some((p) => p === null || p === undefined || p <= 0)) return null;
    return 1.0 / parts.reduce((s, p) => s + 1.0 / p, 0);
  }

  // ---------- момент ----------
  const driveTorque = (f, lead, eta) => f * lead / (2000.0 * Math.PI * eta);
  const backTorque = (f, lead, eta2) => f * lead * eta2 / (2000.0 * Math.PI);
  const preloadDrag = (fpr, lead, e1, e2) => (1.0 / e1 - e2) * fpr * lead / (2000.0 * Math.PI);
  function screwInertia(d_mm, len_mm) {
    const d = d_mm / 1000.0, L = len_mm / 1000.0;
    const mass = STEEL_DENSITY * Math.PI * d * d / 4.0 * L;
    return mass * Math.pow(d / 2.0, 2) / 2.0;
  }
  const linInertia = (m, lead) => m * Math.pow(lead / (2000.0 * Math.PI), 2);

  function computeTorque(loads, inp, lead, dnom, fpr) {
    const i = inp.gear_ratio, e1 = inp.efficiency_forward, e2 = inp.efficiency_reverse;
    const tb = inp.bearing_friction_torque_Nm || 0.0;
    const td = fpr > 0 ? preloadDrag(fpr, lead, e1, e2) : 0.0;
    const js = screwInertia(dnom, inp.unsupported_length_mm), jl = linInertia(inp.moving_mass_kg, lead);
    const jm = inp.motor_inertia_kgm2 || 0.0;
    const jt = jm + (js + jl) / (i * i);
    const phases = loads.map((ld) => {
      const p = ld.phase, fw = ld.non_inertial_force_N, d = p.direction;
      let t = d !== 0 && fw * d >= 0 ? driveTorque(fw, lead, e1) : backTorque(fw, lead, e2);
      t += d * (tb + td);
      const n0 = d * 1000.0 * p.v_start_m_min / lead, n1 = d * 1000.0 * p.v_end_m_min / lead;
      const alpha = p.duration_s > 0 ? 2.0 * Math.PI * (n1 - n0) / 60.0 / p.duration_s : 0.0;
      const tm = t / i + jt * alpha * i;
      const nmax = Math.max(Math.abs(n0), Math.abs(n1));
      return { name: p.name, duration_s: p.duration_s, n_screw_max_rpm: nmax, torque_motor_Nm: tm,
               power_W: Math.abs(tm) * 2.0 * Math.PI * nmax * i / 60.0 };
    });
    const tsum = phases.reduce((s, p) => s + p.duration_s, 0);
    return {
      phases, j_screw_kgm2: js, j_linear_kgm2: jl, j_total_motor_kgm2: jt, preload_drag_Nm: td,
      peak_Nm: phases.reduce((m, p) => Math.max(m, Math.abs(p.torque_motor_Nm)), 0),
      rms_Nm: tsum > 0 ? Math.sqrt(phases.reduce((s, p) => s + p.torque_motor_Nm ** 2 * p.duration_s, 0) / tsum) : 0,
      peak_power_W: phases.reduce((m, p) => Math.max(m, p.power_W), 0),
      inertia_ratio: jm > 0 ? (jt - jm) / jm : null,
    };
  }

  // ---------- проверка исходных данных ----------
  const isNum = (v) => typeof v === "number" && isFinite(v);
  function validateInput(inp) {
    const errs = [];
    function req(name, title, lo, hi, loIncl, optional) {
      const v = inp[name];
      if (v === null || v === undefined) { if (!optional) errs.push([name, `«${title}»: значение не задано`]); return; }
      if (!isNum(v)) { errs.push([name, `«${title}»: требуется число, получено ${v}`]); return; }
      if (lo !== null && (loIncl ? v < lo : v <= lo)) errs.push([name, `«${title}»: должно быть ${loIncl ? "≥" : ">"} ${g(lo)}, задано ${g(v)}`]);
      if (hi !== null && v > hi) errs.push([name, `«${title}»: должно быть ≤ ${g(hi)}, задано ${g(v)}`]);
    }
    req("moving_mass_kg", "Масса перемещаемого узла", 0, null);
    req("stroke_mm", "Полезный ход", 0, null);
    req("rapid_speed_m_min", "Скорость быстрого перемещения", 0, 300);
    req("acceleration_m_s2", "Ускорение", 0, 100);
    req("feed_speed_mm_min", "Рабочая подача", 0, null, false, true);
    req("feed_stroke_fraction", "Доля хода на подаче", 0, 1, true);
    req("dwell_time_s", "Время стоянки", 0, null, true);
    req("process_force_N", "Технологическая сила", 0, null, true, true);
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
    if (!["auto", "manual"].includes(inp.cycle_mode)) errs.push(["cycle_mode", "Режим цикла должен быть «auto» или «manual»"]);
    [["diameter_min_mm", "diameter_max_mm", "диаметра"], ["lead_min_mm", "lead_max_mm", "шага"]].forEach(([a, b, t]) => {
      if (isNum(inp[a]) && isNum(inp[b]) && inp[a] > inp[b]) errs.push([a, `Диапазон ${t}: минимум больше максимума`]);
    });
    if (isNum(inp.stroke_mm) && isNum(inp.unsupported_length_mm) && inp.unsupported_length_mm < inp.stroke_mm)
      errs.push(["unsupported_length_mm", "Свободная длина винта меньше полезного хода"]);
    if (inp.cycle_mode === "auto" && isNum(inp.feed_stroke_fraction) && inp.feed_stroke_fraction > 0 &&
        (inp.feed_speed_mm_min === null || inp.feed_speed_mm_min === undefined))
      errs.push(["feed_speed_mm_min", "Задана доля хода на подаче, но не задана скорость подачи"]);
    if (isNum(inp.feed_speed_mm_min) && isNum(inp.rapid_speed_m_min) && inp.feed_speed_mm_min / 1000.0 > inp.rapid_speed_m_min)
      errs.push(["feed_speed_mm_min", "Рабочая подача больше скорости быстрого хода"]);
    if (inp.cycle_mode === "manual") {
      if (!inp.manual_phases.length) errs.push(["manual_phases", "Ручной цикл: не задано ни одной фазы"]);
      let moving = false;
      inp.manual_phases.forEach((ph, i) => {
        validatePhase(ph).forEach((m) => errs.push(["manual_phases", `Фаза ${i + 1} «${ph.name}»: ${m}`]));
        moving = moving || (ph.direction !== 0 && meanSpeed(ph) > 0);
      });
      if (inp.manual_phases.length && !moving) errs.push(["manual_phases", "Ручной цикл: нет ни одной фазы с движением"]);
    }
    return errs;
  }
  function validatePhase(ph) {
    const out = [];
    ["duration_s", "v_start_m_min", "v_end_m_min", "process_force_N"].forEach((n) => {
      if (!isNum(ph[n])) out.push(`поле ${n} должно быть числом`);
    });
    if (out.length) return out;
    if (ph.duration_s <= 0) out.push("длительность должна быть > 0");
    if (ph.v_start_m_min < 0 || ph.v_end_m_min < 0) out.push("скорости задаются модулем (≥ 0), направление — отдельно");
    if (![-1, 0, 1].includes(ph.direction)) out.push("направление должно быть −1, 0 или +1");
    if (ph.direction === 0 && (ph.v_start_m_min || ph.v_end_m_min)) out.push("на стоянке (направление 0) скорости должны быть нулевыми");
    if (ph.process_force_N < 0) out.push("технологическая сила должна быть ≥ 0");
    return out;
  }

  // ---------- подбор ----------
  function globalAssumptions(inp, phases) {
    const critical = [], info = [];
    const hasFeed = phases.some((p) => p.process_force_N > 0 || p.name.toLowerCase().includes("подача"));
    const feedOn = inp.feed_speed_mm_min && inp.feed_stroke_fraction > 0;
    if (inp.cycle_mode === "auto" && feedOn && (inp.process_force_N === null || inp.process_force_N === undefined))
      critical.push("Технологическая сила не задана — на рабочей подаче принята равной 0 Н.");
    else if (inp.cycle_mode === "auto" && !feedOn)
      info.push("Рабочая подача не задана — цикл состоит только из быстрых перемещений.");
    const muNull = inp.friction_coefficient === null || inp.friction_coefficient === undefined;
    const grNull = inp.guide_resistance_N === null || inp.guide_resistance_N === undefined;
    if (muNull && grNull) critical.push("Сопротивление направляющих (μ и сила уплотнений) не задано — трение принято равным 0.");
    else if (muNull) info.push("Коэффициент трения μ не задан — учтено только сопротивление уплотнений.");
    else if (grNull) info.push("Сопротивление уплотнений не задано — учтено только трение μ·m·g.");
    if (inp.bearing_friction_torque_Nm === null || inp.bearing_friction_torque_Nm === undefined)
      info.push("Момент трения опор Tb не задан — в моменте привода не учтён.");
    info.push("Инерция муфты/зубчатых колёс не учитывается; инерция винта — по свободной длине ls (сплошной стальной цилиндр, номинальный диаметр).");
    if (inp.cycle_mode === "auto" && hasFeed) info.push("Разгон/торможение на рабочей подаче не моделируются.");
    if (inp.thread_margin_mm === 0) info.push("Запас длины резьбы (перебеги, уплотнения) = 0 мм — проверка размещения гайки и хода выполняется без запаса.");
    info.push(`Схема опор: ${MOUNTING_RU[inp.mounting]}; одна свободная длина ls = ${g(inp.unsupported_length_mm)} мм используется и для критической скорости, и для устойчивости (для устойчивости берётся наибольшая |Fa| без разделения на сжатие/растяжение).`);
    if (inp.orientation === "vertical")
      info.push("Вертикальная ось: ШВП не самотормозящая (η2 > 0) — необходимы тормоз двигателя и/или уравновешивание; противовес в расчёте сил не учтён.");
    info.push(`Коэффициент условий работы fp = ${g(inp.operating_factor_fp)} задан пользователем (HIWIN: 1.1–1.2 без ударов, 1.3–1.8 нормальные условия, 2–3 удары/вибрации).`);
    return [critical, info];
  }

  function filterProducts(products, inp) {
    const mf = new Set(inp.manufacturers.map((m) => m.toLowerCase()));
    const types = new Set(inp.manufacturing_types);
    const has = (v) => v !== null && v !== undefined;
    return products.filter((p) => {
      if (mf.size && !mf.has(p.manufacturer.toLowerCase())) return false;
      if (types.size && !types.has(p.manufacturing)) return false;
      const d = p.nominal_diameter_mm;
      if (has(inp.diameter_min_mm) && d < inp.diameter_min_mm) return false;
      if (has(inp.diameter_max_mm) && d > inp.diameter_max_mm) return false;
      if (has(inp.lead_min_mm) && p.lead_mm < inp.lead_min_mm) return false;
      if (has(inp.lead_max_mm) && p.lead_mm > inp.lead_max_mm) return false;
      return true;
    });
  }

  function chk(key, title, state, mandatory, value, limit, unit, explanation, reference) {
    return { key, title, state, mandatory, value: value === undefined ? null : value,
             limit: limit === undefined ? null : limit, unit: unit || "", explanation: explanation || "",
             reference: reference || "" };
  }
  const nn = (v) => v === null || v === undefined;

  function evaluateCandidate(p, inp, loads, criticalAssumptions) {
    const checks = [], vals = {}, add = (c) => checks.push(c);
    const phases = loads.map((l) => l.phase);
    const lead = p.lead_mm;
    const nMax = 1000.0 * maxSpeed(phases) / lead;
    vals.n_max_rpm = nMax;
    const faMax = loads.reduce((m, l) => Math.max(m, Math.abs(l.force_N)), 0);
    vals.fa_max_N = faMax;
    const dk = nn(p.root_diameter_mm) ? null : p.root_diameter_mm;
    const ls = inp.unsupported_length_mm;

    if (nn(p.dn_limit)) add(chk("dn", "Частота вращения (DN)", CS.UNVERIFIED, true, null, null, "", "Предельное значение DN для изделия неизвестно."));
    else {
      const dn = p.nominal_diameter_mm * nMax;
      vals.dn = dn;
      add(chk("dn", "Частота вращения (DN)", dn <= p.dn_limit ? CS.PASS : CS.FAIL, true, dn, p.dn_limit, "мм·об/мин",
        `DN = d·n_max = ${g(p.nominal_diameter_mm)}·${nMax.toFixed(0)} = ${fmt(dn)}; допустимо ${fmt(p.dn_limit)}`, p.dn_limit_source || ""));
    }
    if (!nn(p.max_speed_rpm))
      add(chk("n_catalog", "Паспортная макс. частота", nMax <= p.max_speed_rpm ? CS.PASS : CS.FAIL, true, nMax, p.max_speed_rpm, "об/мин"));

    if (dk === null) add(chk("critical_speed", "Критическая частота вращения", CS.UNVERIFIED, true, null, null, "",
      "Диаметр по дну резьбы dk неизвестен; номинальный диаметр вместо dk не используется."));
    else {
      const nk = criticalSpeed(dk, ls, inp.mounting), nkp = 0.8 * nk;
      vals.nk_rpm = nk; vals.nk_perm_rpm = nkp;
      add(chk("critical_speed", "Критическая частота вращения", nMax <= nkp ? CS.PASS : CS.FAIL, true, nMax, nkp, "об/мин",
        `nk = 2.71e8·fn·dk/ls² = ${nk.toFixed(0)} об/мин; допустимо 0.8·nk = ${nkp.toFixed(0)}; n_max = ${nMax.toFixed(0)} об/мин`,
        `${HIWIN_REF}, F 3.27–3.28, стр. 28`));
    }
    if (dk === null) add(chk("buckling", "Устойчивость при сжатии", CS.UNVERIFIED, true, null, null, "", "dk неизвестен."));
    else {
      const fk = bucklingLoad(dk, ls, inp.mounting), fkp = 0.5 * fk;
      vals.fk_N = fk; vals.fk_perm_N = fkp;
      add(chk("buckling", "Устойчивость при сжатии", faMax <= fkp ? CS.PASS : CS.FAIL, true, faMax, fkp, "Н",
        `Fk = 4.072e5·fk·dk⁴/ls² = ${fmt(fk)} Н; допустимо 0.5·Fk = ${fmt(fkp)} Н; |Fa|max = ${fmt(faMax)} Н`,
        `${HIWIN_REF}, F 3.25–3.26, стр. 28`));
    }
    if (nn(p.static_load_N)) add(chk("static", "Статический запас S0", CS.UNVERIFIED, true, null, null, "", "C0 неизвестна или признана недостоверной."));
    else {
      const s0 = staticSafety(p.static_load_N, faMax);
      vals.s0 = s0;
      add(chk("static", "Статический запас S0", s0 >= inp.static_safety_required ? CS.PASS : CS.FAIL, true, s0,
        inp.static_safety_required, "", `S0 = C0/|Fa|max = ${fmt(p.static_load_N)}/${fmt(faMax)} = ${fmt(s0, 2)}; требуется ≥ ${g(inp.static_safety_required)}`,
        `${HIWIN_REF}, F 3.3, стр. 24`));
    }

    let fpr = 0.0;
    if (inp.preload_percent > 0) {
      if (p.preload_type === "double_nut") {
        const lim = 10.0;
        if (p.dynamic_load_N) fpr = inp.preload_percent / 100.0 * p.dynamic_load_N;
        vals.preload_N = fpr;
        add(chk("preload", "Натяг", inp.preload_percent <= lim ? CS.PASS : CS.FAIL, true, inp.preload_percent, lim, "% Cdyn",
          `Fpr = ${g(inp.preload_percent)} %·Cdyn = ${fmt(fpr)} Н (двойная гайка, ≤ ${g(lim)} %)`, `${HIWIN_REF}, стр. 24`));
      } else if (p.preload_type === "none") {
        add(chk("preload", "Натяг", CS.FAIL, true, null, null, "", "Требуется натяг, а гайка по каталогу поставляется с осевым зазором."));
      } else {
        add(chk("preload", "Натяг", CS.UNVERIFIED, true, null, null, "", "Исполнение гайки по натягу в таблице не указано — нужно уточнить у производителя."));
      }
    } else if (p.preload_type === "double_nut") {
      add(chk("preload", "Натяг", CS.WARNING, false, null, null, "",
        "Двойная гайка поставляется с натягом, но его величина не задана: ресурс и момент рассчитаны без натяга (ресурс может быть завышен)."));
    }

    const revs = loads.map((l) => (l.phase.direction !== 0 ? Math.abs(meanSpeed(l.phase)) * 1000.0 / lead * l.phase.duration_s / 60.0 : 0.0));
    if (nn(p.dynamic_load_N)) add(chk("life", "Ресурс L10", CS.UNVERIFIED, true, null, null, "", "Cdyn неизвестна."));
    else {
      const life = computeLife(p.dynamic_load_N, loads.map((l) => l.force_N), revs, loads.map((l) => l.phase.duration_s),
        inp.operating_factor_fp, inp.reliability_percent, fpr);
      const lh = life.hours();
      Object.assign(vals, { fbm1_N: life.fbm1_N, fbm2_N: life.fbm2_N, l_rev: life.l_rev, lm_rev: life.lm_rev,
        life_km: life.km(lead), life_h: lh, life_motion_h: life.motionHours(), nm_rpm: life.nm_rpm,
        rev_per_cycle: life.revolutions_per_cycle, cycle_time_s: life.cycle_time_s });
      if (fpr === 0 && isFinite(lh) && lh > 0) vals.c_required_N = p.dynamic_load_N * Math.cbrt(inp.required_life_h / lh);
      add(chk("life", "Ресурс L10 (часы работы в цикле)", lh >= inp.required_life_h ? CS.PASS : CS.FAIL, true, lh,
        inp.required_life_h, "ч",
        `Fbm1 = ${fmt(life.fbm1_N)} Н, Fbm2 = ${fmt(life.fbm2_N)} Н (с fp = ${g(inp.operating_factor_fp)}); L = ${sig3(life.l_rev)} об; ` +
        `с fr (${inp.reliability_percent} %) Lm = ${sig3(life.lm_rev)} об = ${fmt(life.km(lead))} км = ${fmt(lh)} ч при nm = ${life.nm_rpm.toFixed(1)} об/мин ` +
        `(чистое движение ${fmt(life.motionHours())} ч)`, `${HIWIN_REF}, F 3.4–3.14, стр. 24–26`));
      const ratio = life.fbm / inp.operating_factor_fp / p.dynamic_load_N;
      vals.load_ratio = ratio;
      add(chk("load_ratio", "Средняя нагрузка ≤ 0.2·Cdyn (рекомендация)", ratio <= 0.2 ? CS.PASS : CS.WARNING, false, ratio, 0.2, "",
        `Fbm/Cdyn = ${ratio.toFixed(3)} (без fp); HIWIN рекомендует ≤ 1/5`, `${HIWIN_REF}, табл. 3.1, стр. 12`));
    }

    if (nn(p.nut_length_mm)) add(chk("thread_fit", "Ход + гайка в свободной длине", CS.UNVERIFIED, true, null, null, "", "Длина гайки неизвестна."));
    else {
      const need = inp.stroke_mm + p.nut_length_mm + inp.thread_margin_mm;
      vals.thread_length_needed_mm = need;
      add(chk("thread_fit", "Ход + гайка в свободной длине", need <= ls ? CS.PASS : CS.FAIL, true, need, ls, "мм",
        `ход ${g(inp.stroke_mm)} + гайка ${g(p.nut_length_mm)} + запас ${g(inp.thread_margin_mm)} = ${g(need)} мм ≤ ls = ${g(ls)} мм`));
      if (!nn(p.max_thread_length_mm))
        add(chk("thread_max", "Макс. длина резьбы по каталогу", need <= p.max_thread_length_mm ? CS.PASS : CS.FAIL, true, need, p.max_thread_length_mm, "мм"));
    }

    const classes = p.accuracy_classes_v300p_um || {};
    let allowed = classes;
    if (!nn(inp.required_v300p_um)) {
      const keys = Object.keys(classes);
      if (!keys.length) add(chk("accuracy", "Точность хода v300p", CS.UNVERIFIED, true, null, null, "", "Классы точности изделия неизвестны."));
      else {
        allowed = {};
        keys.forEach((c) => { if (classes[c] <= inp.required_v300p_um) allowed[c] = classes[c]; });
        const best = Math.min(...keys.map((c) => classes[c]));
        const ak = Object.keys(allowed);
        add(chk("accuracy", "Точность хода v300p", ak.length ? CS.PASS : CS.FAIL, true, best, inp.required_v300p_um, "мкм",
          "Подходящие классы: " + (ak.length ? ak.join(", ") : "нет") + `; лучший доступный v300p = ${g(best)} мкм`, `${HIWIN_REF}, табл. 3.3, стр. 15`));
      }
    }
    const msl = p.max_shaft_length_mm || {};
    const lens = Object.keys(msl).filter((c) => c in allowed && !nn(msl[c])).map((c) => msl[c]);
    if (!lens.length) add(chk("max_length", "Макс. длина вала по каталогу", CS.UNVERIFIED, true, null, null, "",
      "Максимальная длина вала для подходящих классов точности не указана."));
    else {
      const lmax = Math.max(...lens);
      vals.max_shaft_length_mm = lmax;
      add(chk("max_length", "Макс. длина вала по каталогу", ls <= lmax ? CS.PASS : CS.FAIL, true, ls, lmax, "мм",
        `Проверено необходимое условие ls ≤ L_max (${g(lmax)} мм); длина цапф не известна и должна быть добавлена при оформлении заказа.`));
    }

    if (!nn(inp.max_backlash_mm)) {
      const play = p.preload_type === "double_nut" ? 0.0 : p.max_axial_play_mm;
      if (nn(play)) add(chk("backlash", "Осевой люфт", CS.UNVERIFIED, true, null, null, "", "Осевой зазор гайки в каталоге не указан."));
      else add(chk("backlash", "Осевой люфт", play <= inp.max_backlash_mm ? CS.PASS : CS.FAIL, true, play, inp.max_backlash_mm, "мм", "Макс. осевой зазор по каталогу"));
    }
    if (!nn(inp.max_nut_diameter_mm)) {
      const ds = [p.flange_diameter_mm, p.nut_outer_diameter_mm].filter((x) => !nn(x));
      if (!ds.length) add(chk("nut_diameter", "Диаметр гайки/фланца", CS.UNVERIFIED, true));
      else {
        const dmax = Math.max(...ds);
        add(chk("nut_diameter", "Диаметр гайки/фланца", dmax <= inp.max_nut_diameter_mm ? CS.PASS : CS.FAIL, true, dmax, inp.max_nut_diameter_mm, "мм"));
      }
    }
    if (!nn(inp.max_nut_length_mm)) {
      if (nn(p.nut_length_mm)) add(chk("nut_length", "Длина гайки", CS.UNVERIFIED, true));
      else add(chk("nut_length", "Длина гайки", p.nut_length_mm <= inp.max_nut_length_mm ? CS.PASS : CS.FAIL, true, p.nut_length_mm, inp.max_nut_length_mm, "мм"));
    }

    let rbs = null, rigNote = "";
    if (dk !== null) {
      const rs = shaftRigidity(dk, ls, inp.mounting);
      vals.shaft_rigidity_N_um = rs;
      let rn = null;
      if (!nn(p.nut_rigidity_N_um) && p.dynamic_load_N) {
        if (p.preload_type === "double_nut") {
          if (fpr > 0) rn = nutRigPreloaded(p.nut_rigidity_N_um, fpr, p.dynamic_load_N);
          else rigNote = "величина натяга не задана";
        } else if ("fbm1_N" in vals) {
          const fbm = Math.max(vals.fbm1_N, vals.fbm2_N) / inp.operating_factor_fp;
          if (fbm > 0) rn = nutRigPlay(p.nut_rigidity_N_um, fbm, p.dynamic_load_N);
        }
      } else if (nn(p.nut_rigidity_N_um)) rigNote = "жёсткость гайки в каталоге не указана";
      if (rn !== null) { vals.nut_rigidity_N_um = rn; rbs = series(rs, rn); vals.rigidity_N_um = rbs; }
    }
    const rtext = `Rs = ${fmt(vals.shaft_rigidity_N_um === undefined ? null : vals.shaft_rigidity_N_um)} Н/мкм (dc≈dk, наихудшее положение гайки), ` +
      `Rn = ${fmt(vals.nut_rigidity_N_um === undefined ? null : vals.nut_rigidity_N_um)} Н/мкм, Rbs = ${fmt(rbs)} Н/мкм; опоры и стол не учтены` + (rigNote ? `; ${rigNote}` : "");
    if (!nn(inp.required_rigidity_N_um)) {
      if (rbs === null) add(chk("rigidity", "Осевая жёсткость ШВП", CS.UNVERIFIED, true, null, null, "", rtext));
      else add(chk("rigidity", "Осевая жёсткость ШВП", rbs >= inp.required_rigidity_N_um ? CS.WARNING : CS.FAIL, true, rbs,
        inp.required_rigidity_N_um, "Н/мкм", rtext + ". Приближённая оценка (dc ≈ dk) — требует инженерной проверки.", `${HIWIN_REF}, F 3.29–3.35, стр. 29–30`));
    } else add(chk("rigidity", "Осевая жёсткость ШВП (справочно)", CS.INFO, false, rbs, null, "Н/мкм", rtext));

    const tq = computeTorque(loads, inp, lead, p.nominal_diameter_mm, fpr);
    Object.assign(vals, { torque_peak_Nm: tq.peak_Nm, torque_rms_Nm: tq.rms_Nm, power_peak_W: tq.peak_power_W,
      j_screw_kgm2: tq.j_screw_kgm2, j_total_motor_kgm2: tq.j_total_motor_kgm2, inertia_ratio: tq.inertia_ratio,
      n_motor_max_rpm: nMax * inp.gear_ratio });
    vals.torque = tq;
    const tqText = `Пиковый момент на двигателе ${tq.peak_Nm.toFixed(2)} Н·м, среднеквадратичный ${tq.rms_Nm.toFixed(2)} Н·м, ` +
      `пиковая мощность ${tq.peak_power_W.toFixed(0)} Вт, приведённая инерция ${tq.j_total_motor_kgm2.toExponential(3)} кг·м²`;
    const motorGiven = [inp.motor_peak_torque_Nm, inp.motor_rated_torque_Nm, inp.motor_max_speed_rpm].some((v) => !nn(v));
    if (!nn(inp.motor_peak_torque_Nm)) add(chk("motor_peak", "Пиковый момент двигателя", tq.peak_Nm <= inp.motor_peak_torque_Nm ? CS.PASS : CS.FAIL,
      true, tq.peak_Nm, inp.motor_peak_torque_Nm, "Н·м", tqText, `${HIWIN_REF}, F 3.15–3.22`));
    if (!nn(inp.motor_rated_torque_Nm)) add(chk("motor_rms", "Среднеквадратичный момент двигателя", tq.rms_Nm <= inp.motor_rated_torque_Nm ? CS.PASS : CS.FAIL,
      true, tq.rms_Nm, inp.motor_rated_torque_Nm, "Н·м"));
    if (!nn(inp.motor_max_speed_rpm)) {
      const nmo = nMax * inp.gear_ratio;
      add(chk("motor_speed", "Частота вращения двигателя", nmo <= inp.motor_max_speed_rpm ? CS.PASS : CS.FAIL, true, nmo, inp.motor_max_speed_rpm, "об/мин"));
    }
    if (!motorGiven) add(chk("torque", "Момент и мощность привода (справочно)", CS.INFO, false, tq.peak_Nm, null, "Н·м", tqText, `${HIWIN_REF}, F 3.15–3.23`));
    else if (nn(inp.bearing_friction_torque_Nm)) add(chk("motor_assumption", "Допущение для проверки двигателя", CS.WARNING, false, null, null, "", "Момент трения опор не задан и не учтён."));

    (p.data_warnings || []).forEach((w) => add(chk("catalog_data", "Достоверность данных каталога", CS.WARNING, false, null, null, "", w)));
    criticalAssumptions.forEach((a) => add(chk("assumption", "Допущение во входных данных", CS.WARNING, false, null, null, "", a)));
    const [status, reasons] = decideStatus(checks);
    return { product: p, status, checks, values: vals, reasons,
             summary: reasons.length ? reasons.join("; ") : "все обязательные проверки пройдены" };
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
    inp.manual_phases = (inp.manual_phases || []).map((p) => phase(p.name, p.duration_s, p.direction, p.v_start_m_min, p.v_end_m_min, p.process_force_N));
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

  return { G, STATUS, STATUS_ORDER, STATUS_SYMBOL, CS, MOUNTING_RU, RELIABILITY_FACTORS, DEFAULT_INPUT, fmt, g,
           buildCycle, trapezoid, phaseLoad, computeLife, criticalSpeed, bucklingLoad, validateInput, select,
           normalizeInput, meanSpeed, distance };
});
