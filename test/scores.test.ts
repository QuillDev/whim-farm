import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

process.env.WHIM_FARM_DB = join(mkdtempSync(join(tmpdir(), "whim-farm-")), "test.db");
const { POST: session } = await import("../app/api/session/route.ts");
const { POST: move } = await import("../app/api/move/route.ts");
const { POST: points } = await import("../app/api/points/route.ts");
const { GET: board } = await import("../app/api/board/route.ts");

mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 20) });
const tick = (ms: number) => mock.timers.tick(ms);

const post = async (route: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await route(new Request("http://farm/api", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const boardOf = async (room: string) =>
  (await (await board(new Request(`http://farm/api/board?room=${room}`))).json()).board;

const BRUSH = { x: -21, z: -17.5 };
type Bale = { x: number; z: number; in: number };

// a cow played the way the page plays her: every request numbered, trotting, saying where she is every second.
// a laggy cow trots flat out and her reports get held up, then arrive three at a time.
async function cow(name: string, room: string, key = "", { speed = 5, lag = false } = {}) {
  const s = (await post(session, { name, room, key })).body;
  const c = {
    session: s.session as string,
    key: s.key as string,
    seq: 0,
    x: s.x as number,
    z: s.z as number,
    bales: s.bales as Bale[],
    async walkTo(x: number, z: number) {
      const held: object[] = [];
      for (;;) {
        const d = Math.hypot(x - c.x, z - c.z);
        tick(1000);
        if (d <= speed) [c.x, c.z] = [x, z];
        else [c.x, c.z] = [c.x + ((x - c.x) * speed) / d, c.z + ((z - c.z) * speed) / d];
        held.push({ session: c.session, seq: ++c.seq, x: c.x, z: c.z });
        const arrived = c.x === x && c.z === z;
        if (lag && held.length < 3 && !arrived) continue;
        for (const m of held.splice(0)) c.bales = (await post(move, m)).body.bales;
        if (arrived) return;
      }
    },
    act(kind: string, extra: object = {}) {
      return post(points, { session: c.session, seq: ++c.seq, kind, x: c.x, z: c.z, ...extra });
    },
    async eatNearest() {
      const i = c.bales.findIndex((b) => b.in === 0);
      await c.walkTo(c.bales[i].x + 1.6, c.bales[i].z);
      tick(1300);
      return { bale: i, ...(await c.act("hay", { bale: i })) };
    },
  };
  return c;
}

test("honest cows score for hay, the brush, a herd and a moo chorus", async () => {
  const daisy = await cow("daisy", "test-a");
  const bessie = await cow("bessie", "test-a", "", { speed: 7, lag: true });
  await cow("loner", "test-b");

  assert.equal((await daisy.eatNearest()).body.awarded, 2);
  await daisy.walkTo(BRUSH.x, BRUSH.z + 2);
  assert.equal((await daisy.act("brush")).body.awarded, 5);
  await bessie.walkTo(BRUSH.x + 2, BRUSH.z + 3);
  assert.equal((await bessie.act("herd")).body.awarded, 10);

  // a moo alone pays nothing; a second cow mooing within 2s makes a chorus of two
  assert.equal((await daisy.act("moo")).body.awarded, 0);
  tick(1500);
  assert.equal((await bessie.act("moo")).body.awarded, 4);

  assert.deepEqual(await boardOf("test-a"), [
    { name: "bessie", pts: 14 },
    { name: "daisy", pts: 7 },
  ]);
  assert.deepEqual(await boardOf("test-b"), [{ name: "loner", pts: 0 }]);
});

test("cheats are refused and score nothing", async () => {
  const cheat = await cow("cheat", "test-c");
  const pal = await cow("pal", "test-c");
  const replay = { session: cheat.session, seq: ++cheat.seq, kind: "moo", x: cheat.x, z: cheat.z };
  await post(points, replay);
  tick(60_000);

  // teleporting across the map after a minute standing still only gets her as far as 5s of trotting
  const jump = (await post(move, { session: cheat.session, seq: ++cheat.seq, x: 44, z: -44 })).body;
  assert.equal(jump.clamped, true);
  assert.ok(Math.hypot(jump.x - 0, jump.z - 14) < 46);
  // so does a burst of small hops sent all at once
  let hop = jump;
  for (let i = 1; i <= 20; i++)
    hop = (await post(move, { session: cheat.session, seq: ++cheat.seq, x: jump.x - i, z: jump.z })).body;
  assert.ok(hop.x > jump.x - 0.5);
  // walking out through the fence stops her at the fence
  await cheat.walkTo(40, 14);
  tick(5000);
  const out = (await post(move, { session: cheat.session, seq: ++cheat.seq, x: 999, z: 14 })).body;
  assert.deepEqual([out.x, out.clamped], [44.2, true]);

  const far = cheat.bales.reduce((f, b, i, all) =>
    Math.hypot(b.x - out.x, b.z - out.z) > Math.hypot(all[f].x - out.x, all[f].z - out.z) ? i : f, 0);
  const refusals: [string, object, number][] = [
    ["hay she isn't near", { kind: "hay", bale: far, x: cheat.bales[far].x, z: cheat.bales[far].z }, 409],
    ["hay that isn't there", { kind: "hay", bale: 99, x: out.x, z: out.z }, 409],
    ["the brush from across the map", { kind: "brush", x: BRUSH.x, z: BRUSH.z }, 409],
    ["a herd nobody brought to the brush", { kind: "herd", x: BRUSH.x, z: BRUSH.z }, 409],
    ["a made-up action", { kind: "pts", pts: 9999, x: out.x, z: out.z }, 400],
  ];
  for (const [why, claim, status] of refusals) {
    tick(1000);
    const r = await post(points, { session: cheat.session, seq: ++cheat.seq, ...claim });
    assert.deepEqual([why, r.status], [why, status]);
  }

  // eating the same bale twice
  const eaten = await cheat.eatNearest();
  assert.equal(eaten.body.awarded, 2);
  const regrowing = eaten.body.bales[eaten.bale];
  await cheat.walkTo(regrowing.x + 1.6, regrowing.z);
  assert.equal((await cheat.act("hay", { bale: eaten.bale })).status, 409);
  // sending a request she already sent
  assert.equal((await post(points, replay)).status, 409);
  // mooing faster than a cow can, even with a pal mooing along
  await pal.act("moo");
  assert.equal((await cheat.act("moo")).body.awarded, 4);
  assert.equal((await cheat.act("moo")).status, 429);
  // a fresh session doesn't reset the wait
  const again = await cow("cheat", "test-c", cheat.key);
  assert.equal((await again.act("moo")).status, 429);
  // playing as another cow without her browser's key
  assert.equal((await post(session, { name: "cheat", room: "test-c", key: "guess" })).status, 403);
  assert.equal((await post(session, { name: "cheat", room: "test-c" })).status, 400);
  // a session nobody was given
  assert.equal((await post(points, { session: "made-up", seq: 1, kind: "moo", x: 0, z: 14 })).status, 404);

  // a herd of one, then a herd whose other cow is across the map
  const solo = await cow("solo", "test-d");
  await solo.walkTo(BRUSH.x, BRUSH.z + 2);
  assert.equal((await solo.act("herd")).status, 409);
  const away = await cow("away", "test-d");
  await away.walkTo(away.x, away.z + 1);
  assert.equal((await solo.act("herd")).status, 409);
  // nor one whose other cow came to the brush and then closed her tab
  await away.walkTo(BRUSH.x + 2, BRUSH.z);
  tick(11_000);
  assert.equal((await solo.act("herd")).status, 409);
  assert.deepEqual(await boardOf("test-d"), [
    { name: "away", pts: 0 },
    { name: "solo", pts: 0 },
  ]);

  assert.deepEqual(await boardOf("test-c"), [
    { name: "cheat", pts: 6 },
    { name: "pal", pts: 0 },
  ]);
});

type Seg = { mode: string; x0: number; z0: number; dx: number; dz: number; speed: number; t0: number; t1: number; target?: string; charge?: Seg };
const bisonAt = (b: Seg, t: number) => {
  const k = (b.speed * (Math.min(Math.max(t, b.t0), b.t1) - b.t0)) / 1000;
  return { x: b.x0 + b.dx * k, z: b.z0 + b.dz * k };
};

test("BISON1 notices a cow, snorts at her, then charges slower than a trot; every cow sees the same bison", async () => {
  const bold = await cow("bold", "test-bison");
  const watcher = await cow("watcher", "test-bison");
  let seen: Seg | undefined;
  for (let i = 0; i < 120 && !seen; i++) {
    tick(1000);
    const r = (await post(move, { session: bold.session, seq: ++bold.seq, x: bold.x, z: bold.z })).body;
    if (r.bison.mode === "snort") seen = r.bison;
    else {
      // amble toward her, stopping 6m short, at a walk
      const p = bisonAt(r.bison, r.now), d = Math.hypot(p.x - bold.x, p.z - bold.z);
      if (d > 6) [bold.x, bold.z] = [bold.x + ((p.x - bold.x) * Math.min(3, d - 6)) / d, bold.z + ((p.z - bold.z) * Math.min(3, d - 6)) / d];
    }
  }
  assert.ok(seen, "she snorted");
  assert.equal(seen.target, "bold");
  assert.equal(seen.charge?.mode, "charge");
  assert.equal(seen.charge?.t0, seen.t1);
  assert.ok(seen.charge!.speed < 7, "a trotting cow outruns her");
  assert.ok(seen.t1 - seen.t0 >= 1000, "the charge is telegraphed");
  const w = (await post(move, { session: watcher.session, seq: ++watcher.seq, x: watcher.x, z: watcher.z })).body;
  assert.deepEqual(w.bison, seen);
  // after the charge she rests and calms down before picking anyone again
  tick(seen.charge!.t1 - seen.t0 + 1500);
  const after = (await post(move, { session: bold.session, seq: ++bold.seq, x: bold.x, z: bold.z })).body.bison;
  assert.notEqual(after.mode, "snort");
});

test("BISON1 never picks a cow standing at the brush", async () => {
  const safe = await cow("safe", "test-bison-safe");
  await safe.walkTo(BRUSH.x, BRUSH.z + 2);
  for (let i = 0; i < 300; i++) {
    tick(1000);
    const b = (await post(move, { session: safe.session, seq: ++safe.seq, x: safe.x, z: safe.z })).body.bison;
    assert.notEqual(b.mode, "snort");
  }
});
