// The living sky: a single <canvas> behind the UI.
//
// Performance rules (this is what keeps scrolling smooth on mid/low-end phones):
//  * drawn at reduced resolution and scaled up by the compositor (the sky is soft anyway)
//  * the gradient background is cached and only redrawn when the scene changes
//  * clouds are pre-rendered sprites; particles are batched into one path per layer
//  * capped at 30 fps (20 in lite mode) and fully paused while scrolling, while a
//    sheet covers the screen, and while the app is in the background

import { kindOf } from "./lib/weather.js";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Clear-sky colours by sun altitude (-1 deep night … 0 horizon … 1 noon): [alt, top, mid, bottom]
const CLEAR = [
  [-1.0, "#040817", "#0a1330", "#18224c"],
  [-0.5, "#081027", "#17204a", "#33305f"],
  [-0.15, "#151d48", "#433670", "#a65a7c"],
  [0.0, "#283a78", "#94598a", "#f0955f"],
  [0.12, "#3667bb", "#8aa4d3", "#f4c58d"],
  [0.35, "#2873cf", "#58a0e4", "#a8d5f4"],
  [1.0, "#1a64ca", "#4a97e5", "#9bcff6"],
].map(([a, t, m, b]) => [a, hex(t), hex(m), hex(b)]);
const OVERCAST_DAY = ["#4f5e75", "#707e95", "#9ba6b6"].map(hex);
const OVERCAST_NIGHT = ["#0a0d14", "#151a25", "#242b39"].map(hex);
const STORM = ["#181528", "#28233f", "#433b5b"].map(hex);
const SNOW_DAY = ["#6f819b", "#97a6bb", "#c6d0dd"].map(hex);

function clearPalette(alt) {
  for (let i = 1; i < CLEAR.length; i++) {
    if (alt <= CLEAR[i][0]) {
      const [a0, ...c0] = CLEAR[i - 1];
      const [a1, ...c1] = CLEAR[i];
      const t = (alt - a0) / (a1 - a0);
      return c0.map((c, j) => mix(c, c1[j], t));
    }
  }
  return CLEAR[CLEAR.length - 1].slice(1);
}

const OVERCAST = { clear: 0, "mostly-clear": 0.04, partly: 0.16, cloudy: 0.62, fog: 0.72, drizzle: 0.74, rain: 0.84, showers: 0.78, freezing: 0.84, "heavy-rain": 0.94, snow: 0.78, "heavy-snow": 0.88, storm: 1, hail: 1 };
const COVER = { clear: 0, "mostly-clear": 0.14, partly: 0.42, cloudy: 0.85, fog: 0.45, drizzle: 0.8, rain: 0.9, showers: 0.75, freezing: 0.85, "heavy-rain": 1, snow: 0.85, "heavy-snow": 0.95, storm: 1, hail: 1 };
const RAIN = { drizzle: 0.3, rain: 0.6, showers: 0.6, freezing: 0.55, "heavy-rain": 1, storm: 0.85, hail: 0.8 };
const SNOWFALL = { snow: 0.6, "heavy-snow": 1 };

/** Turn weather + sun position into renderer parameters. */
export function deriveScene({ code, cloud, precip, wind, windDir, sun, moonPhase }) {
  const kind = kindOf(code);
  const alt = clamp(sun?.alt ?? 0.5, -1, 1);
  const cloudFrac = typeof cloud === "number" ? clamp(cloud / 100, 0, 1) : null;
  let cover = COVER[kind] ?? 0.5;
  if (cloudFrac != null && kind !== "clear") cover = Math.max(cover * 0.7, cloudFrac * 0.95);
  if (kind === "clear" && cloudFrac != null) cover = Math.min(0.12, cloudFrac * 0.3);
  const boost = 0.65 + Math.min(precip ?? 0, 8) / 8 * 0.7;
  const bearing = ((windDir ?? 270) + 180) * (Math.PI / 180);
  const dx = Math.sin(bearing);
  return {
    kind,
    alt,
    p: clamp(sun?.p ?? 0.5, 0, 1),
    day: sun ? !!sun.day : true,
    overcast: OVERCAST[kind] ?? 0.5,
    cover,
    rain: RAIN[kind] ? clamp(RAIN[kind] * boost, 0.15, 1.2) : 0,
    snow: SNOWFALL[kind] ? clamp(SNOWFALL[kind] * boost, 0.2, 1.2) : 0,
    lightning: kind === "storm" || kind === "hail",
    fog: kind === "fog",
    hail: kind === "hail",
    windX: (Math.abs(dx) < 0.2 ? 0.2 * Math.sign(dx || 1) : dx) * clamp(0.5 + (wind ?? 10) / 25, 0.5, 2.6),
    slant: clamp(dx * (wind ?? 0) / 70, -0.4, 0.4),
    moonPhase: moonPhase ?? 0.5,
  };
}

function paletteFor(sc) {
  const base = clearPalette(sc.alt);
  const dayness = smooth(-0.25, 0.2, sc.alt);
  let over = OVERCAST_NIGHT.map((c, i) => mix(c, OVERCAST_DAY[i], dayness));
  if (sc.snow > 0) over = over.map((c, i) => mix(c, mix(OVERCAST_NIGHT[i], SNOW_DAY[i], dayness), 0.8));
  if (sc.lightning) over = over.map((c, i) => mix(c, STORM[i], 0.75));
  return base.map((c, i) => mix(c, over[i], sc.overcast));
}

function cloudTint(sc) {
  const dayness = smooth(-0.2, 0.15, sc.alt);
  const golden = sc.day ? 1 - smooth(0.04, 0.22, sc.alt) : 0;
  let hi = hex("#ffffff"), mid = hex("#eef3fb"), lo = hex("#c3cfe2");
  if (golden > 0) { hi = mix(hi, hex("#ffe6d2"), golden); mid = mix(mid, hex("#f3b9a4"), golden); lo = mix(lo, hex("#9c7a9e"), golden); }
  const dark = clamp((sc.overcast - 0.55) / 0.45, 0, 1);
  hi = mix(hi, hex("#c5ccd8"), dark); mid = mix(mid, hex("#98a3b5"), dark); lo = mix(lo, hex("#6c788d"), dark);
  if (sc.lightning) { hi = mix(hi, hex("#7c8098"), 0.8); mid = mix(mid, hex("#555a72"), 0.8); lo = mix(lo, hex("#33364a"), 0.8); }
  // Night: moonlit, desaturated blue
  const nhi = hex("#4c587c"), nmid = hex("#2f3858"), nlo = hex("#1b2240");
  return { hi: mix(nhi, hi, dayness), mid: mix(nmid, mid, dayness), lo: mix(nlo, lo, dayness), a: lerp(0.85, 0.96, dayness) };
}

export function createSky(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const bg = document.createElement("canvas");
  const bgx = bg.getContext("2d", { alpha: false });

  let cssW = 0, cssH = 0, k = 1;
  let quality = "full";
  let animate = true;
  let fps = 30;
  let scene = null;
  let pal = null, palFrom = null, palTo = null, palT = 1;
  let tintKey = "";
  let sprites = [], sunSprite = null, moonSprite = null, fogSprite = null;
  let clouds = [], drops = [], flakes = [], stars = [], fogs = [];
  let flash = 0, nextFlash = 3, bolt = null;
  let raf = 0, last = 0, clock = 0;
  const paused = new Set();
  let bgDirty = true;

  // ---- sizing -------------------------------------------------------------
  function resize(force = false) {
    const w = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
    let h = Math.max(1, window.innerHeight);
    // Keep full height while the keyboard is open (same width, shorter viewport).
    if (!force && w === cssW && h < cssH) h = cssH;
    const dpr = window.devicePixelRatio || 1;
    const nk = quality === "lite" ? Math.max(0.4, Math.min(dpr, 1) * 0.5) : Math.min(dpr, 1.5);
    if (!force && w === cssW && h === cssH && nk === k) return false;
    cssW = w; cssH = h; k = nk;
    canvas.width = bg.width = Math.round(w * k);
    canvas.height = bg.height = Math.round(h * k);
    if (scene) rebuild(true);
    return true;
  }

  // ---- sprites -------------------------------------------------------------
  function makeCloud(wCss, hCss, tint, seed) {
    const c = document.createElement("canvas");
    const w = Math.max(8, Math.round(wCss * k));
    const hh = Math.max(4, Math.round(hCss * k));
    c.width = w; c.height = hh;
    const g = c.getContext("2d");
    const rnd = mulberry32(seed);
    const puffs = 10 + Math.floor(rnd() * 6);
    for (let i = 0; i < puffs; i++) {
      const t = i / (puffs - 1);
      const bump = Math.sin(t * Math.PI);
      const x = w * (0.13 + 0.74 * t + (rnd() - 0.5) * 0.06);
      const r = hh * (0.17 + 0.23 * bump + rnd() * 0.09);
      const y = hh * 0.66 - r * 0.42 * bump;
      const gr = g.createRadialGradient(x - r * 0.15, y - r * 0.4, r * 0.08, x, y, r);
      gr.addColorStop(0, rgba(tint.hi, tint.a));
      gr.addColorStop(0.5, rgba(tint.mid, tint.a * 0.82));
      gr.addColorStop(1, rgba(tint.lo, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }

  const sprite = (size) => {
    const c = document.createElement("canvas");
    c.width = c.height = Math.max(4, Math.round(size));
    return [c, c.getContext("2d"), c.width / 2];
  };

  /** Sun as two sprites: a wide soft glow and a crisp disc (faded separately by cloud). */
  function makeSun() {
    const R = Math.min(cssW, cssH) * 0.06 * k; // disc radius in canvas px
    const [glow, g, m] = sprite(R * 11);
    const gr = g.createRadialGradient(m, m, 0, m, m, m);
    gr.addColorStop(0, "rgba(255,246,214,0.9)");
    gr.addColorStop(0.1, "rgba(255,230,160,0.6)");
    gr.addColorStop(0.24, "rgba(255,204,120,0.22)");
    gr.addColorStop(0.55, "rgba(255,190,110,0.06)");
    gr.addColorStop(1, "rgba(255,190,110,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, glow.width, glow.height);
    const [disc, d, dm] = sprite(R * 2.6);
    const dg = d.createRadialGradient(dm, dm, R * 0.7, dm, dm, dm);
    dg.addColorStop(0, "rgba(255,250,232,1)");
    dg.addColorStop(0.75, "rgba(255,244,210,0.35)");
    dg.addColorStop(1, "rgba(255,244,210,0)");
    d.fillStyle = dg;
    d.fillRect(0, 0, disc.width, disc.height);
    d.fillStyle = "#fffbec";
    d.beginPath();
    d.arc(dm, dm, R, 0, Math.PI * 2);
    d.fill();
    return { glow, disc };
  }

  /** Moon as glow + disc showing the real phase (bright limb, faint earthshine). */
  function makeMoon(phase) {
    const R = Math.min(cssW, cssH) * 0.045 * k;
    const lit = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    const [glow, g, m] = sprite(R * 8);
    const gr = g.createRadialGradient(m, m, R * 0.9, m, m, m);
    gr.addColorStop(0, `rgba(214,224,255,${(0.12 + 0.3 * lit).toFixed(3)})`);
    gr.addColorStop(0.45, `rgba(214,224,255,${(0.04 + 0.08 * lit).toFixed(3)})`);
    gr.addColorStop(1, "rgba(214,224,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, glow.width, glow.height);
    const [disc, d, dm] = sprite(R * 2.2);
    d.fillStyle = "rgba(70,82,120,0.6)"; // earthshine on the dark side
    d.beginPath();
    d.arc(dm, dm, R, 0, Math.PI * 2);
    d.fill();
    if (lit > 0.01) {
      const waxing = phase < 0.5;
      d.fillStyle = "#fbf6e2";
      d.beginPath();
      d.arc(dm, dm, R, -Math.PI / 2, Math.PI / 2, !waxing); // lit limb
      d.ellipse(dm, dm, Math.max(0.01, Math.abs(1 - 2 * lit) * R), R, 0, Math.PI / 2, -Math.PI / 2, lit > 0.5 ? !waxing : waxing); // terminator
      d.fill();
      // subtle maria for texture
      d.fillStyle = "rgba(170,165,140,0.18)";
      for (const [x, y, rr] of [[-0.25, -0.2, 0.22], [0.2, 0.15, 0.18], [-0.05, 0.35, 0.14]]) {
        d.beginPath();
        d.arc(dm + x * R, dm + y * R, rr * R, 0, Math.PI * 2);
        d.fill();
      }
    }
    return { glow, disc };
  }

  function makeFog() {
    const w = Math.round(cssW * 1.7 * k), hh = Math.round(cssH * 0.3 * k);
    const c = document.createElement("canvas");
    c.width = Math.max(4, w); c.height = Math.max(4, hh);
    const g = c.getContext("2d");
    g.save();
    g.scale(1, hh / w);
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, "rgba(235,240,247,0.6)");
    gr.addColorStop(0.6, "rgba(235,240,247,0.25)");
    gr.addColorStop(1, "rgba(235,240,247,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
    g.restore();
    return c;
  }

  // ---- scene construction -------------------------------------------------
  function rebuild(sizeChanged = false) {
    const sc = scene;
    const rnd = mulberry32(1234);
    const area = cssW * cssH;
    const liteF = quality === "lite" ? 0.5 : 1;

    const tint = cloudTint(sc);
    const key = [tint.hi, tint.mid, tint.lo].flat().map((v) => Math.round(v / 8)).join(",") + `|${k}|${cssW}`;
    if (key !== tintKey || sizeChanged) {
      tintKey = key;
      sprites = [0, 1, 2, 3, 4].map((i) => {
        const w = cssW * (0.55 + 0.12 * i);
        return makeCloud(w, w * (0.36 + 0.03 * (i % 3)), tint, 77 + i * 131);
      });
    }
    sunSprite = makeSun();
    moonSprite = makeMoon(sc.moonPhase);
    fogSprite = sc.fog ? makeFog() : null;

    // Clouds in three parallax layers.
    const count = Math.round(sc.cover * (cssW / 412) * 10 * (quality === "lite" ? 0.7 : 1));
    clouds = [];
    for (let i = 0; i < count; i++) {
      const layer = i % 3;
      clouds.push({
        layer,
        sprite: Math.floor(rnd() * sprites.length),
        x: (rnd() * 1.8 - 0.6) * cssW,
        y: cssH * ([0.0, 0.06, 0.16][layer] + rnd() * [0.26, 0.4, 0.55][layer]) - cssW * 0.12,
        scale: [0.55, 0.8, 1.1][layer] * (0.85 + rnd() * 0.3),
        alpha: [0.5, 0.72, 0.92][layer],
        speed: [3.5, 6.5, 11][layer],
      });
    }
    clouds.sort((a, b) => a.layer - b.layer);

    stars = [];
    const nStars = Math.round((area / 4200) * liteF);
    for (let i = 0; i < nStars; i++) {
      stars.push({ x: rnd() * cssW, y: rnd() * cssH * 0.8, s: 0.6 + rnd() * 1.2, w: 0.6 + rnd() * 2.2, ph: rnd() * 6.28, b: 0.4 + rnd() * 0.6 });
    }

    drops = [];
    if (sc.rain > 0) {
      const n = Math.round((sc.rain * area) / 2300 * liteF);
      for (let i = 0; i < n; i++) {
        const near = rnd() < 0.45;
        drops.push({
          x: rnd() * cssW * 1.2 - cssW * 0.1, y: rnd() * cssH, near,
          len: (near ? 18 : 11) * (0.8 + sc.rain * 0.5) * (0.8 + rnd() * 0.4),
          v: (near ? 1150 : 820) * (0.85 + rnd() * 0.3),
        });
      }
    }
    flakes = [];
    if (sc.snow > 0) {
      const n = Math.round((sc.snow * area) / 2600 * liteF);
      for (let i = 0; i < n; i++) {
        const near = rnd() < 0.4;
        flakes.push({
          x: rnd() * cssW, y: rnd() * cssH, near,
          r: near ? 2.2 + rnd() * 1.4 : 1 + rnd() * 1,
          v: (near ? 65 : 35) * (0.8 + rnd() * 0.4),
          amp: 8 + rnd() * 18, w: 0.5 + rnd(), ph: rnd() * 6.28,
        });
      }
    }
    fogs = sc.fog ? [0.28, 0.44, 0.6, 0.76, 0.9].map((y, i) => ({ x: -cssW * (0.15 + 0.22 * i), y: cssH * y, v: (i % 2 ? -1 : 1) * (4 + i * 1.5) })) : [];
    bgDirty = true;
  }

  // ---- drawing -------------------------------------------------------------
  function drawBackground() {
    const W = bg.width, H = bg.height;
    const g = bgx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgba(pal[0]));
    g.addColorStop(0.55, rgba(pal[1]));
    g.addColorStop(1, rgba(pal[2]));
    bgx.fillStyle = g;
    bgx.fillRect(0, 0, W, H);
    // Warm horizon glow around sunrise/sunset.
    const glow = scene.day ? 1 - smooth(0.02, 0.3, scene.alt) : smooth(-0.38, -0.02, scene.alt);
    const strength = glow * (1 - scene.overcast * 0.85);
    if (strength > 0.02) {
      const x = (scene.day ? 0.15 + 0.7 * scene.p : scene.p < 0.5 ? 0.85 : 0.15) * W;
      const rg = bgx.createRadialGradient(x, H * 0.62, 0, x, H * 0.62, W * 1.1);
      rg.addColorStop(0, `rgba(255,170,110,${0.45 * strength})`);
      rg.addColorStop(0.45, `rgba(255,130,120,${0.16 * strength})`);
      rg.addColorStop(1, "rgba(255,130,120,0)");
      bgx.fillStyle = rg;
      bgx.fillRect(0, 0, W, H);
    }
    // Ground mist for fog: a soft pale band rising from the bottom.
    if (scene.fog) {
      const day = smooth(-0.2, 0.15, scene.alt);
      const mg = bgx.createLinearGradient(0, H * 0.25, 0, H);
      mg.addColorStop(0, "rgba(220,228,236,0)");
      mg.addColorStop(1, `rgba(220,228,236,${(0.18 + 0.32 * day).toFixed(3)})`);
      bgx.fillStyle = mg;
      bgx.fillRect(0, 0, W, H);
    }
    bgDirty = false;
  }

  function draw(t, dt) {
    if (palT < 1) {
      palT = Math.min(1, palT + dt / 1.2);
      const e = smooth(0, 1, palT);
      pal = palFrom.map((c, i) => mix(c, palTo[i], e));
      bgDirty = true;
    }
    if (bgDirty) drawBackground();
    ctx.drawImage(bg, 0, 0);
    ctx.save();
    ctx.scale(k, k);

    const sc = scene;
    const night = 1 - smooth(-0.2, 0.08, sc.alt);

    // Stars
    const starVis = night * (1 - sc.cover) * (1 - sc.overcast);
    if (starVis > 0.03 && stars.length) {
      ctx.fillStyle = "#fff";
      for (const s of stars) {
        const tw = animate ? 0.55 + 0.45 * Math.sin(t * s.w + s.ph) : 0.8;
        ctx.globalAlpha = starVis * s.b * tw;
        ctx.fillRect(s.x, s.y, s.s, s.s);
      }
      ctx.globalAlpha = 1;
    }

    // Sun / moon: under thick cloud only a diffuse glow shows through, never a grey disc.
    const discFade = 1 - smooth(0.35, 0.7, sc.overcast);
    const glowFade = 1 - sc.overcast * 0.7;
    const body = (spr, x, y, vis) => {
      const G = spr.glow.width / k, D = spr.disc.width / k;
      ctx.globalAlpha = vis * glowFade;
      ctx.drawImage(spr.glow, x - G / 2, y - G / 2, G, G);
      if (discFade > 0.02) {
        ctx.globalAlpha = vis * discFade;
        ctx.drawImage(spr.disc, x - D / 2, y - D / 2, D, D);
      }
      ctx.globalAlpha = 1;
    };
    if (sc.day) {
      const vis = smooth(-0.06, 0.06, sc.alt);
      if (vis > 0.02) body(sunSprite, cssW * (0.15 + 0.7 * sc.p), cssH * (0.5 - 0.36 * clamp(sc.alt, 0, 1)), vis);
    } else if (night > 0.02) {
      body(moonSprite, cssW * (0.2 + 0.6 * sc.p), cssH * (0.42 - 0.26 * Math.sin(sc.p * Math.PI)), night);
    }

    // Clouds
    for (const c of clouds) {
      const sp = sprites[c.sprite];
      const w = (sp.width / k) * c.scale;
      const hgt = (sp.height / k) * c.scale;
      if (animate) {
        c.x += c.speed * sc.windX * dt;
        if (sc.windX > 0 && c.x > cssW + 20) c.x = -w - 20;
        if (sc.windX < 0 && c.x < -w - 20) c.x = cssW + 20;
      }
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(sp, c.x, c.y, w, hgt);
    }
    ctx.globalAlpha = 1;

    // Fog banks
    if (fogs.length && fogSprite) {
      const fw = fogSprite.width / k, fh = fogSprite.height / k;
      ctx.globalAlpha = sc.day ? 0.85 : 0.45;
      for (const f of fogs) {
        if (animate) {
          f.x += f.v * dt;
          if (f.x > cssW * 0.2) f.v = -Math.abs(f.v);
          if (f.x < -fw + cssW * 0.8) f.v = Math.abs(f.v);
        }
        ctx.drawImage(fogSprite, f.x, f.y - fh / 2, fw, fh);
      }
      ctx.globalAlpha = 1;
    }

    // Rain (two batched layers)
    if (drops.length) {
      const sl = sc.slant;
      for (const near of [false, true]) {
        ctx.beginPath();
        for (const d of drops) {
          if (d.near !== near) continue;
          if (animate) {
            d.y += d.v * dt;
            d.x += d.v * sl * dt;
            if (d.y - d.len > cssH) { d.y = -d.len - Math.random() * 60; d.x = Math.random() * cssW * 1.2 - cssW * 0.1; }
          }
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - sl * d.len, d.y - d.len);
        }
        ctx.strokeStyle = sc.hail ? `rgba(240,246,255,${near ? 0.7 : 0.4})` : `rgba(200,222,255,${near ? 0.5 : 0.27})`;
        ctx.lineWidth = near ? 1.5 : 1;
        ctx.stroke();
      }
    }

    // Snow (two batched layers)
    if (flakes.length) {
      for (const near of [false, true]) {
        ctx.beginPath();
        for (const f of flakes) {
          if (f.near !== near) continue;
          if (animate) {
            f.y += f.v * dt;
            if (f.y - f.r > cssH) { f.y = -6; f.x = Math.random() * cssW; }
          }
          const x = f.x + Math.sin(t * f.w + f.ph) * f.amp + sc.windX * 4;
          ctx.moveTo(x + f.r, f.y);
          ctx.arc(x, f.y, f.r, 0, Math.PI * 2);
        }
        ctx.fillStyle = near ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.55)";
        ctx.fill();
      }
    }

    // Lightning
    if (sc.lightning && animate) {
      if (t > nextFlash) {
        flash = 1;
        bolt = Math.random() < 0.65 ? makeBolt() : null;
        nextFlash = t + 3 + Math.random() * 7;
      }
      if (flash > 0) {
        const flicker = flash > 0.6 || (flash > 0.25 && flash < 0.4) ? 1 : 0.35;
        ctx.fillStyle = `rgba(225,230,255,${0.42 * flash * flicker})`;
        ctx.fillRect(0, 0, cssW, cssH);
        if (bolt && flash > 0.35) {
          ctx.strokeStyle = "rgba(200,210,255,0.35)";
          ctx.lineWidth = 6;
          ctx.stroke(bolt);
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 1.8;
          ctx.stroke(bolt);
        }
        flash = Math.max(0, flash - dt / 0.45);
      }
    }
    ctx.restore();
  }

  function makeBolt() {
    const p = new Path2D();
    let x = cssW * (0.2 + Math.random() * 0.6), y = -10;
    p.moveTo(x, y);
    const end = cssH * (0.35 + Math.random() * 0.25);
    while (y < end) {
      x += (Math.random() - 0.5) * 34;
      y += 14 + Math.random() * 22;
      p.lineTo(x, y);
      if (Math.random() < 0.12) {
        // short side branch, then continue the main channel
        p.lineTo(x + (Math.random() - 0.5) * 60, y + 30 + Math.random() * 30);
        p.moveTo(x, y);
      }
    }
    return p;
  }

  // ---- loop ----------------------------------------------------------------
  function frame(ts) {
    raf = 0;
    if (!scene || paused.size || !animate) return;
    const interval = 1000 / fps;
    if (last && ts - last < interval - 3) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
    last = ts;
    clock += dt;
    draw(clock, dt);
    raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (!scene) return;
    if (!animate || paused.size) {
      // Static: draw exactly one frame (palette transitions complete instantly).
      if (palT < 1) { palT = 1; pal = palTo; bgDirty = true; }
      draw(clock, 0);
      return;
    }
    if (!raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  // ---- public API ----------------------------------------------------------
  function setScene(sc) {
    const target = paletteFor(sc);
    const first = !scene;
    const changed = first || ["kind", "day", "fog", "lightning"].some((k2) => scene[k2] !== sc[k2]) ||
      Math.abs(scene.cover - sc.cover) > 0.08 || Math.abs(scene.rain - sc.rain) > 0.1 || Math.abs(scene.snow - sc.snow) > 0.1 ||
      Math.abs(scene.alt - sc.alt) > 0.04 || Math.abs(scene.p - sc.p) > 0.02 || Math.abs(scene.moonPhase - sc.moonPhase) > 0.01;
    scene = sc;
    if (first) {
      pal = palTo = target;
      palT = 1;
      resize(true); // sizes the canvas and builds the scene
    } else {
      palFrom = pal;
      palTo = target;
      palT = 0;
      if (changed) rebuild();
    }
    kick();
  }

  function setQuality(q) {
    const nq = q === "lite" ? "lite" : "full";
    if (nq === quality) return;
    quality = nq;
    fps = nq === "lite" ? 20 : 30;
    if (scene) { resize(true); kick(); }
  }

  function setAnimate(on) {
    animate = !!on;
    if (!animate && raf) { cancelAnimationFrame(raf); raf = 0; }
    kick();
  }

  function pause(reason) {
    paused.add(reason);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function resume(reason) {
    if (!paused.delete(reason)) return;
    if (!paused.size) kick();
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (resize()) kick(); }, 120);
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? pause("hidden") : resume("hidden")));

  return {
    setScene, setQuality, setAnimate, pause, resume,
    /** Darkened mid-sky colour, used to tint glass so text stays readable on bright skies. */
    tint() {
      const c = palTo || pal;
      if (!c) return [20, 30, 60];
      return mix(c[1], [8, 14, 32], 0.45).map(Math.round);
    },
    get fps() { return fps; },
  };
}
