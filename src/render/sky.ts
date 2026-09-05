import {
  CanvasTexture,
  EquirectangularReflectionMapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";

/**
 * Skyboxes, one per mood. Two layers:
 *
 * 1. `applySky` serves the real thing: public/sky/<Mood>.jpg — CC0 Poly
 *    Haven photographed skies (equirect 2k; picked + baked by
 *    tools/fetch_skies.py, which also documents the pitfalls).
 * 2. Until that loads (or if it's missing), a procedural canvas sky painted
 *    here fills in instantly: gradient + clouds/stars/glow per mood.
 *
 * Both are static textures — zero per-frame cost. The procedural horizon
 * sits at v=0.5 with a muted ground haze below; sun/moon glows are painted
 * at the same azimuth/elevation as the mood's light direction (SceneView
 * presets), so shadows agree with the sky.
 */

const photoSkies = new Map<string, Texture | "failed">();
const photoWaiters = new Map<string, Array<(tex: Texture) => void>>();

/**
 * Hand a texture for the mood to `apply`: the procedural sky immediately,
 * then the photographic one as soon as it's loaded (cached afterwards).
 * `apply` may be called twice — the caller guards against staleness.
 */
export function applySky(mood: string, apply: (tex: Texture) => void): void {
  const hit = photoSkies.get(mood);
  if (hit instanceof Texture) {
    apply(hit);
    return;
  }
  apply(proceduralSky(mood));
  if (hit === "failed") return;
  const waiters = photoWaiters.get(mood);
  if (waiters) {
    waiters.push(apply);
    return;
  }
  photoWaiters.set(mood, [apply]);
  new TextureLoader().load(
    `sky/${mood}.jpg`,
    (tex) => {
      tex.mapping = EquirectangularReflectionMapping;
      tex.colorSpace = SRGBColorSpace;
      photoSkies.set(mood, tex);
      for (const cb of photoWaiters.get(mood) ?? []) cb(tex);
      photoWaiters.delete(mood);
    },
    undefined,
    () => {
      photoSkies.set(mood, "failed");
      photoWaiters.delete(mood);
    },
  );
}

const W = 2048;
const H = 1024;
const HORIZON = H / 2;

interface SkySpec {
  /** Zenith -> horizon color stops (top half). */
  sky: [string, string, string];
  /** Horizon line -> bottom haze (bottom half). */
  ground: [string, string];
  /** Light direction (matches the SceneView preset) for the sun/moon glow. */
  lightDir: [number, number, number];
  glow?: { color: string; size: number; disc?: string };
  clouds?: { tint: string; shade: string; count: number };
  stars?: number;
  /** Extra horizontal band of color hugging the horizon (dawn/dusk fire). */
  band?: { color: string; height: number };
}

const SPECS: Record<string, SkySpec> = {
  Day: {
    sky: ["#2a66c8", "#5f9be0", "#cfe4f4"],
    ground: ["#9fb8c8", "#4e6474"],
    lightDir: [0.6, 1, 0.35],
    glow: { color: "rgba(255,255,240,0.55)", size: 0.36 },
    clouds: { tint: "#ffffff", shade: "#b8cbdc", count: 64 },
  },
  Night: {
    sky: ["#020409", "#060d1c", "#122036"],
    ground: ["#0c1522", "#05080e"],
    lightDir: [0.3, 1, 0.5],
    glow: { color: "rgba(190,210,255,0.30)", size: 0.14, disc: "#e8eeff" },
    stars: 700,
  },
  Sunrise: {
    sky: ["#5a7cb4", "#b393b8", "#ffd9a6"],
    ground: ["#94847a", "#3e3835"],
    lightDir: [1, 0.35, 0.2],
    glow: { color: "rgba(255,214,150,0.75)", size: 0.5, disc: "#fff2d8" },
    clouds: { tint: "#ffe4c8", shade: "#b48ba0", count: 34 },
    band: { color: "rgba(255,190,120,0.5)", height: 0.10 },
  },
  Sunset: {
    sky: ["#31215c", "#a44a72", "#ff8a3c"],
    ground: ["#5e4038", "#22191a"],
    lightDir: [-1, 0.3, -0.25],
    glow: { color: "rgba(255,150,70,0.8)", size: 0.55, disc: "#ffd9a8" },
    clouds: { tint: "#ffb888", shade: "#7a3a5c", count: 34 },
    band: { color: "rgba(255,110,50,0.55)", height: 0.12 },
  },
};

/** Deterministic PRNG so the sky doesn't reshuffle every rebuild. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** three.js equirect shader: u = atan2(z, x) / 2π + 0.5, v = acos(y)/π. */
function uvForDir(dir: [number, number, number]): { u: number; v: number } {
  const len = Math.hypot(...dir);
  return {
    u: Math.atan2(dir[2] / len, dir[0] / len) / (2 * Math.PI) + 0.5,
    v: Math.acos(dir[1] / len) / Math.PI,
  };
}

function paintGradients(ctx: CanvasRenderingContext2D, spec: SkySpec): void {
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON);
  sky.addColorStop(0, spec.sky[0]);
  sky.addColorStop(0.62, spec.sky[1]);
  sky.addColorStop(1, spec.sky[2]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, HORIZON);

  const ground = ctx.createLinearGradient(0, HORIZON, 0, H);
  ground.addColorStop(0, spec.ground[0]);
  ground.addColorStop(0.35, spec.ground[1]);
  ground.addColorStop(1, spec.ground[1]);
  ctx.fillStyle = ground;
  ctx.fillRect(0, HORIZON, W, H - HORIZON);

  if (spec.band) {
    const h = spec.band.height * H;
    const band = ctx.createLinearGradient(0, HORIZON - h, 0, HORIZON + h * 0.4);
    band.addColorStop(0, "rgba(0,0,0,0)");
    band.addColorStop(0.7, spec.band.color);
    band.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = band;
    ctx.fillRect(0, HORIZON - h, W, h * 1.4);
  }
}

/** Radial glow (and optional disc) painted with x-wrap so seams never split it. */
function paintGlow(ctx: CanvasRenderingContext2D, spec: SkySpec): void {
  if (!spec.glow) return;
  const { u, v } = uvForDir(spec.lightDir);
  const r = spec.glow.size * H;
  for (const wrap of [-1, 0, 1]) {
    const x = (u + wrap) * W;
    const y = v * H;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, spec.glow.color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    if (spec.glow.disc) {
      const disc = ctx.createRadialGradient(x, y, 0, x, y, r * 0.12);
      disc.addColorStop(0, spec.glow.disc);
      disc.addColorStop(0.7, spec.glow.disc);
      disc.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = disc;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
}

/**
 * Fluffy cumulus banked in the distance: clusters of soft blobs hugging the
 * horizon, larger overhead-ish, smaller and flatter as they recede toward
 * the horizon line. A darker under-shade gives them volume.
 */
function paintClouds(ctx: CanvasRenderingContext2D, spec: SkySpec, rnd: () => number): void {
  if (!spec.clouds) return;
  for (let i = 0; i < spec.clouds.count; i++) {
    const cx = rnd() * W;
    // 0 = right on the horizon line, 1 = top of the cloud band. Biased low:
    // the editor camera looks down, so the horizon band is what it sees.
    const height = rnd() * rnd();
    const cy = HORIZON - (0.008 + height * 0.11) * H;
    const scale = 0.3 + height * 1.0;
    const puffs = 7 + Math.floor(rnd() * 8);
    const spread = (50 + rnd() * 100) * scale;

    for (let p = 0; p < puffs; p++) {
      const px = cx + (rnd() - 0.5) * spread * 2.2;
      const py = cy - Math.abs(rnd() - 0.5) * spread * 0.4;
      const pr = (18 + rnd() * 32) * scale;
      const alpha = 0.18 + rnd() * 0.18;
      const shadeAlpha = 0.08 + rnd() * 0.08;
      for (const wrap of [-W, 0, W]) {
        // Squash puffs into soft ellipses — round blobs read as popcorn.
        ctx.save();
        ctx.translate(px + wrap, py);
        ctx.scale(1, 0.55);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, pr);
        g.addColorStop(0, spec.clouds.tint);
        g.addColorStop(0.4, spec.clouds.tint);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalAlpha = alpha;
        ctx.fillStyle = g;
        ctx.fillRect(-pr, -pr, pr * 2, pr * 2);
        // flat under-shade for volume
        const s = ctx.createRadialGradient(0, pr * 0.5, 0, 0, pr * 0.5, pr * 0.8);
        s.addColorStop(0, spec.clouds.shade);
        s.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = shadeAlpha;
        ctx.fillStyle = s;
        ctx.fillRect(-pr, 0, pr * 2, pr);
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = 1;
}

function paintStars(ctx: CanvasRenderingContext2D, spec: SkySpec, rnd: () => number): void {
  if (!spec.stars) return;
  for (let i = 0; i < spec.stars; i++) {
    const x = rnd() * W;
    // Spread evenly down to the horizon (the editor camera mostly sees the
    // low band), fading only in the last sliver of horizon haze. Stay clear
    // of the zenith: everything there converges to one point (see pole caps).
    const y = (0.08 + rnd() * 0.905) * HORIZON;
    const horizonFade = Math.min(1, (HORIZON - y) / (HORIZON * 0.08));
    const mag = rnd() * horizonFade;
    const r = mag > 0.97 ? 1.8 + rnd() : mag > 0.8 ? 1.2 : 0.7;
    ctx.globalAlpha = 0.25 + mag * 0.75;
    ctx.fillStyle = mag > 0.9 ? "#ffffff" : mag > 0.5 ? "#dbe6ff" : "#9fb2d8";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (mag > 0.97) {
      // a faint twinkle halo on the brightest few
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      g.addColorStop(0, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Pole caps: in an equirect map the whole top (and bottom) pixel row meets
 * at a single point, so ANY horizontal variation there smears into a
 * pinwheel when you look straight up/down. Converge each pole to one solid
 * color — the zenith blue / the ground haze — fading out over ~12% height.
 */
function paintPoleCaps(ctx: CanvasRenderingContext2D, spec: SkySpec): void {
  // Fade to the SAME color at alpha 0 (fading to transparent black would
  // darken the blend midway — canvas interpolates unpremultiplied RGBA).
  const clear = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`;
  };
  const capH = 0.12 * H;
  const top = ctx.createLinearGradient(0, 0, 0, capH);
  top.addColorStop(0, spec.sky[0]);
  top.addColorStop(0.5, spec.sky[0]);
  top.addColorStop(1, clear(spec.sky[0]));
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, capH);

  const bottom = ctx.createLinearGradient(0, H - capH, 0, H);
  bottom.addColorStop(0, clear(spec.ground[1]));
  bottom.addColorStop(0.5, spec.ground[1]);
  bottom.addColorStop(1, spec.ground[1]);
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H - capH, W, capH);
}

const proceduralCache = new Map<string, CanvasTexture>();

/** Painted stand-in sky for a mood (instant; no network, no assets). */
function proceduralSky(mood: string): CanvasTexture {
  const hit = proceduralCache.get(mood);
  if (hit) return hit;

  const spec = SPECS[mood] ?? SPECS.Day;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const rnd = mulberry32(1337);

  paintGradients(ctx, spec);
  paintGlow(ctx, spec);
  paintStars(ctx, spec, rnd);
  paintClouds(ctx, spec, rnd);
  paintPoleCaps(ctx, spec);

  const tex = new CanvasTexture(canvas);
  tex.mapping = EquirectangularReflectionMapping;
  tex.colorSpace = SRGBColorSpace;
  proceduralCache.set(mood, tex);
  return tex;
}
