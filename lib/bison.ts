// BISON1, one per room. The server plans her moves as straight segments with start and end times,
// so every page draws the same bison at the same moment from the same numbers.
// She roams, notices a cow within 10m, snorts for 1.5s facing her, then charges in a straight line.
// A trotting cow (7 m/s) outruns the charge; the brush and the spawn are safe ground.

export type Seg = {
  mode: "roam" | "snort" | "charge" | "rest";
  x0: number;
  z0: number;
  dx: number; // unit heading
  dz: number;
  speed: number; // m/s
  t0: number; // ms
  t1: number;
  target?: string;
  charge?: Seg; // a snort carries the charge that follows it, so pages know it before it starts
  calmUntil: number; // no new snort before this
};
type Spot = { x: number; z: number };
export type World = { limit: number; barn: { x: number; z: number; w: number; d: number }; brush: Spot; spawn: Spot };

export const BISON = {
  notice: 10,
  roamSpeed: 1.6,
  snortMs: 1500,
  chargeSpeed: 6,
  chargeMax: 12,
  restMs: 1200,
  calmMs: 7000, // after a charge ends
  safe: 7, // cows this close to the brush or spawn can't be picked
  keepOut: 10, // she never heads for a spot this close to the brush or spawn
};

export const at = (s: Seg, t: number) => {
  const k = (s.speed * (Math.min(Math.max(t, s.t0), s.t1) - s.t0)) / 1000;
  return { x: s.x0 + s.dx * k, z: s.z0 + s.dz * k };
};

const near = (p: Spot, q: Spot, r: number) => Math.hypot(p.x - q.x, p.z - q.z) < r;
const inBarn = (w: World, x: number, z: number, pad: number) =>
  Math.abs(x - w.barn.x) < w.barn.w / 2 + pad && Math.abs(z - w.barn.z) < w.barn.d / 2 + pad;
const safeGround = (w: World, p: Spot, r: number) => near(p, w.brush, r) || near(p, w.spawn, r);

function roam(w: World, from: Spot, t: number, calmUntil: number): Seg {
  for (let i = 0; i < 200; i++) {
    const x = (Math.random() * 2 - 1) * (w.limit - 8);
    const z = (Math.random() * 2 - 1) * (w.limit - 8);
    const d = Math.hypot(x - from.x, z - from.z);
    if (d < 8 || inBarn(w, x, z, 5) || safeGround(w, { x, z }, BISON.keepOut)) continue;
    return { mode: "roam", x0: from.x, z0: from.z, dx: (x - from.x) / d, dz: (z - from.z) / d, speed: BISON.roamSpeed, t0: t, t1: t + (d / BISON.roamSpeed) * 1000, calmUntil };
  }
  return { mode: "rest", x0: from.x, z0: from.z, dx: 0, dz: 1, speed: 0, t0: t, t1: t + 3000, calmUntil };
}

// a straight run toward where the cow stood when the snort began; it stops short of the fence, the barn and safe ground
function chargeFrom(w: World, from: Spot, dx: number, dz: number, t: number, target: string): Seg {
  let len = 0;
  while (len < BISON.chargeMax) {
    const x = from.x + dx * (len + 0.25), z = from.z + dz * (len + 0.25);
    if (Math.abs(x) > w.limit - 1.5 || Math.abs(z) > w.limit - 1.5 || inBarn(w, x, z, 2) || safeGround(w, { x, z }, BISON.safe - 2)) break;
    len += 0.25;
  }
  return { mode: "charge", x0: from.x, z0: from.z, dx, dz, speed: BISON.chargeSpeed, t0: t, t1: t + (len / BISON.chargeSpeed) * 1000, target, calmUntil: 0 };
}

export function spawnBison(w: World, now: number): Seg {
  return roam(w, { x: 28, z: -22 }, now, now + 5000);
}

// move her plan forward to now, using where the online cows are
export function stepBison(w: World, s: Seg, now: number, cows: { name: string; x: number; z: number }[]): Seg {
  if (now - s.t1 > 10_000) s = roam(w, at(s, s.t1), now, Math.max(s.calmUntil, now)); // nobody was around to watch
  for (let i = 0; i < 20; i++) {
    if (s.mode === "roam" && now >= s.calmUntil && now < s.t1) {
      const p = at(s, now);
      if (!safeGround(w, p, BISON.safe)) {
        let best: (typeof cows)[number] | null = null, bd = BISON.notice;
        for (const c of cows) {
          const d = Math.hypot(c.x - p.x, c.z - p.z);
          if (d < bd && d > 0.5 && !safeGround(w, c, BISON.safe)) [best, bd] = [c, d];
        }
        if (best) {
          const dx = (best.x - p.x) / bd, dz = (best.z - p.z) / bd;
          const t1 = now + BISON.snortMs;
          s = { mode: "snort", x0: p.x, z0: p.z, dx, dz, speed: 0, t0: now, t1, target: best.name, calmUntil: 0, charge: chargeFrom(w, p, dx, dz, t1, best.name) };
        }
      }
    }
    if (now < s.t1) return s;
    const end = at(s, s.t1);
    if (s.mode === "snort" && s.charge) s = s.charge;
    else if (s.mode === "charge") s = { mode: "rest", x0: end.x, z0: end.z, dx: s.dx, dz: s.dz, speed: 0, t0: s.t1, t1: s.t1 + BISON.restMs, calmUntil: s.t1 + BISON.calmMs };
    else s = roam(w, end, s.t1, s.calmUntil);
  }
  return s;
}
