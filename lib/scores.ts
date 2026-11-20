import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The server decides what each action is worth and how often it can pay out,
// so a client can only claim actions, never a score. It also keeps where each
// cow is and where her hay is, so a claim only pays if she could have done it.
const RULES = {
  hay: { pts: 2, cooldownMs: 1200 }, // eating a bale takes 1.3s
  brush: { pts: 5, cooldownMs: 19_000 }, // the sim pays once per 20s
  herd: { pts: 10, cooldownMs: 59_000 }, // the sim pays once a minute
  moo: { pts: 2, cooldownMs: 400 }, // per cow in the chorus; moos are 500ms apart
} as const;
type Kind = keyof typeof RULES;
const MAX_CHORUS = 8;
const CHORUS_GAP_MS = 2500; // moos less than 2s apart chain, plus lag
const LIVE_MS = 45_000;
const ONLINE_MS = 10_000; // a cow in the pasture reports where she is every second
const BOARD_SIZE = 200;

// the pasture, same layout as the sim
const LIMIT = 45 - 0.8; // the fence, less the cow's radius
const SPAWN = { x: 0, z: 14 };
const BARN = { x: -18, z: -30, w: 14, d: 11 };
const BRUSH = { x: BARN.x - 3, z: BARN.z + BARN.d / 2 + 7 };
const BALES = 12;
const BALE_RESPAWN_MS = 20_000;
// a trot is 7 m/s, and bumping into cows or the barn can push a cow a bit further
const MAX_SPEED = 7 * 1.3;
// a cow can save up to 5s of walking, so reports held up by lag and then sent all at once still add up
const SAVED_WALK_MS = 5_000;
const EAT_RANGE = 4; // the sim eats from 2.8m
const BRUSH_RANGE = 4.5; // the sim brushes from 3.2m
const HERD_RANGE = 8; // the sim wants everyone within 6m
const SEQ_WINDOW = 31;

export class Refusal extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const g = globalThis as { whimFarmDb?: DatabaseSync };

function db(): DatabaseSync {
  if (g.whimFarmDb) return g.whimFarmDb;
  const path = process.env.WHIM_FARM_DB ?? "data/whim-farm.db";
  mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec(`
    pragma journal_mode = wal;
    create table if not exists sessions (
      id text primary key, room text not null, name text not null,
      created_at integer not null, last_seen integer not null);
    create index if not exists sessions_room_seen on sessions (room, last_seen);
    create table if not exists scores (
      room text not null, name text not null, pts integer not null,
      primary key (room, name));
    drop table if exists last_award;
    create table if not exists names (name text primary key, key_hash text not null);
    create table if not exists cows (
      session text primary key, x real not null, z real not null, at integer not null,
      seq integer not null, seen integer not null);
    create table if not exists bales (
      session text not null, i integer not null, x real not null, z real not null, ready_at integer not null,
      primary key (session, i));
    create table if not exists cooldowns (
      room text not null, name text not null, kind text not null, at integer not null,
      primary key (room, name, kind));
    create table if not exists moos (room text not null, name text not null, at integer not null);
    create index if not exists moos_room_at on moos (room, at);
  `);
  g.whimFarmDb = d;
  return d;
}

export const cleanName = (n: unknown) =>
  String(n ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 16);

export const cleanRoom = (r: unknown) =>
  String(r || "pasture")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40) || "pasture";

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

// the first browser to play a name gets its key; after that only that key can play it
function ownName(name: string, keyIn: unknown) {
  if (typeof keyIn !== "string") throw new Refusal(400, "old page, reload");
  const d = db();
  const row = d.prepare("select key_hash from names where name = ?").get(name) as { key_hash: string } | undefined;
  if (row) {
    if (hash(keyIn) !== row.key_hash) throw new Refusal(403, "that name belongs to another cow");
    return keyIn;
  }
  const key = randomBytes(16).toString("hex");
  d.prepare("insert into names values (?, ?)").run(name, hash(key));
  return key;
}

const inBarn = (x: number, z: number, pad: number) =>
  Math.abs(x - BARN.x) < BARN.w / 2 + pad && Math.abs(z - BARN.z) < BARN.d / 2 + pad;

function baleSpot() {
  for (;;) {
    const x = (Math.random() * 2 - 1) * (45 - 4);
    const z = (Math.random() * 2 - 1) * (45 - 4);
    if (!inBarn(x, z, 3) && Math.hypot(x - BRUSH.x, z - BRUSH.z) > 4 && Math.hypot(x - SPAWN.x, z - SPAWN.z) > 6) return { x, z };
  }
}

function balesOf(session: string, now: number) {
  const rows = db().prepare("select x, z, ready_at from bales where session = ? order by i").all(session) as {
    x: number;
    z: number;
    ready_at: number;
  }[];
  return rows.map((b) => ({ x: b.x, z: b.z, in: Math.max(0, b.ready_at - now) }));
}

export function startSession(nameIn: unknown, roomIn: unknown, keyIn: unknown) {
  const name = cleanName(nameIn);
  if (!name) throw new Refusal(400, "name required");
  const room = cleanRoom(roomIn);
  const key = ownName(name, keyIn);
  const id = randomBytes(16).toString("hex");
  const now = Date.now();
  const d = db();
  d.prepare("insert into sessions values (?, ?, ?, ?, ?)").run(id, room, name, now, now);
  d.prepare("insert into cows values (?, ?, ?, ?, 0, 0)").run(id, SPAWN.x, SPAWN.z, now);
  const bale = d.prepare("insert into bales values (?, ?, ?, ?, 0)");
  for (let i = 0; i < BALES; i++) {
    const s = baleSpot();
    bale.run(id, i, s.x, s.z);
  }
  d.prepare("insert into scores values (?, ?, 0) on conflict do nothing").run(room, name);
  return { session: id, name, room, key, pts: ptsOf(room, name), ...SPAWN, bales: balesOf(id, now) };
}

type Cow = { session: string; room: string; name: string; x: number; z: number; at: number; seq: number; seen: number };

function cowOf(id: unknown): Cow {
  const session = String(id ?? "");
  const row = db()
    .prepare(
      "select s.room, s.name, c.x, c.z, c.at, c.seq, c.seen from sessions s join cows c on c.session = s.id where s.id = ?",
    )
    .get(session) as Omit<Cow, "session"> | undefined;
  if (!row) throw new Refusal(404, "unknown session");
  db().prepare("update sessions set last_seen = ? where id = ?").run(Date.now(), session);
  return { session, ...row };
}

// every request carries a number that only goes up, so a copied request can't be sent again.
// requests can overtake each other on the way, so the last 31 numbers are remembered too.
// returns false for a late request (an older number arriving after a newer one).
function takeSeq(cow: Cow, seqIn: unknown) {
  const seq = Number(seqIn);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Refusal(400, "old page, reload");
  if (seq > cow.seq) {
    const shift = seq - cow.seq;
    cow.seen = shift > SEQ_WINDOW ? 0 : ((cow.seen << shift) | (1 << (shift - 1))) & 0x7fffffff;
    cow.seq = seq;
    return true;
  }
  const bit = cow.seq - 1 - seq;
  if (seq === cow.seq || bit >= SEQ_WINDOW || cow.seen & (1 << bit)) throw new Refusal(409, "replayed");
  cow.seen |= 1 << bit;
  return false;
}

// a cow goes where she says, as far as her saved-up walking time takes her at a trot;
// a jump further than that (or past the fence) stops where the trot runs out.
// cow.at is how far her walking time is spent: walking moves it forward, standing still lets it fall behind now.
function walk(cow: Cow, xIn: unknown, zIn: unknown, now: number) {
  let x = Number(xIn);
  let z = Number(zIn);
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Refusal(400, "position required");
  let clamped = Math.abs(x) > LIMIT || Math.abs(z) > LIMIT;
  x = Math.max(-LIMIT, Math.min(LIMIT, x));
  z = Math.max(-LIMIT, Math.min(LIMIT, z));
  const from = Math.min(now, Math.max(cow.at, now - SAVED_WALK_MS));
  const reach = (MAX_SPEED * (now - from)) / 1000;
  let dist = Math.hypot(x - cow.x, z - cow.z);
  if (dist > reach) {
    clamped = true;
    x = cow.x + ((x - cow.x) * reach) / dist;
    z = cow.z + ((z - cow.z) * reach) / dist;
    dist = reach;
  }
  Object.assign(cow, { x, z, at: from + (dist / MAX_SPEED) * 1000 });
  return clamped;
}

function save(cow: Cow) {
  db()
    .prepare("update cows set x = ?, z = ?, at = ?, seq = ?, seen = ? where session = ?")
    .run(cow.x, cow.z, cow.at, cow.seq, cow.seen, cow.session);
}

export function move(sessionId: unknown, seq: unknown, x: unknown, z: unknown) {
  const cow = cowOf(sessionId);
  const now = Date.now();
  const clamped = takeSeq(cow, seq) ? walk(cow, x, z, now) : false;
  save(cow);
  return { x: cow.x, z: cow.z, clamped, bales: balesOf(cow.session, now) };
}

function liveCows(room: string) {
  const row = db()
    .prepare("select count(distinct name) as n from sessions where room = ? and last_seen > ?")
    .get(room, Date.now() - LIVE_MS) as { n: number };
  return row.n;
}

// where each cow in the pasture is now (her latest tab if she has two)
function cowsOnline(room: string, now: number) {
  return db()
    .prepare(
      `select s.name, c.x, c.z from sessions s join cows c on c.session = s.id
       where s.room = ? and s.last_seen > ? and s.last_seen = (
         select max(s2.last_seen) from sessions s2 where s2.room = s.room and s2.name = s.name)`,
    )
    .all(room, now - ONLINE_MS) as { name: string; x: number; z: number }[];
}

function ptsOf(room: string, name: string) {
  const row = db().prepare("select pts from scores where room = ? and name = ?").get(room, name) as
    | { pts: number }
    | undefined;
  return row?.pts ?? 0;
}

// moos from different cows less than 2s apart chain into a chorus of every cow in the chain
function chorusSize(room: string, now: number) {
  const moos = db()
    .prepare("select name, at from moos where room = ? and at > ? order by at desc")
    .all(room, now - CHORUS_GAP_MS * MAX_CHORUS * 2) as { name: string; at: number }[];
  const names = new Set<string>();
  let last = now;
  for (const m of moos) {
    if (last - m.at > CHORUS_GAP_MS) break;
    names.add(m.name);
    last = m.at;
  }
  return Math.min(names.size, MAX_CHORUS);
}

export function claim(sessionId: unknown, seq: unknown, kindIn: unknown, x: unknown, z: unknown, baleIn?: unknown) {
  if (typeof kindIn !== "string" || !Object.hasOwn(RULES, kindIn)) throw new Refusal(400, "unknown action");
  const kind = kindIn as Kind;
  const cow = cowOf(sessionId);
  const { room, name } = cow;
  const d = db();
  const now = Date.now();
  if (takeSeq(cow, seq)) walk(cow, x, z, now);
  save(cow);

  const last = d.prepare("select at from cooldowns where room = ? and name = ? and kind = ?").get(room, name, kind) as
    | { at: number }
    | undefined;
  if (last && now - last.at < RULES[kind].cooldownMs) throw new Refusal(429, "too soon");

  let pts: number = RULES[kind].pts;
  if (kind === "hay") {
    const i = Number(baleIn);
    const bale = d.prepare("select x, z, ready_at from bales where session = ? and i = ?").get(cow.session, i) as
      | { x: number; z: number; ready_at: number }
      | undefined;
    if (!bale || bale.ready_at > now + 1500) throw new Refusal(409, "no hay there");
    if (Math.hypot(bale.x - cow.x, bale.z - cow.z) > EAT_RANGE) throw new Refusal(409, "too far from the hay");
    const s = baleSpot();
    d.prepare("update bales set x = ?, z = ?, ready_at = ? where session = ? and i = ?").run(
      s.x,
      s.z,
      now + BALE_RESPAWN_MS,
      cow.session,
      i,
    );
  }
  if (kind === "brush" && Math.hypot(cow.x - BRUSH.x, cow.z - BRUSH.z) > BRUSH_RANGE)
    throw new Refusal(409, "too far from the brush");
  if (kind === "herd") {
    const herd = cowsOnline(room, now);
    if (herd.length < 2) throw new Refusal(409, "no herd online");
    if (herd.some((c) => Math.hypot(c.x - BRUSH.x, c.z - BRUSH.z) > HERD_RANGE))
      throw new Refusal(409, "not everyone is at the brush");
  }
  if (kind === "moo") {
    d.prepare("delete from moos where at < ?").run(now - 60_000);
    d.prepare("insert into moos values (?, ?, ?)").run(room, name, now);
    const k = chorusSize(room, now);
    pts = k >= 2 ? pts * k : 0;
  }

  d.prepare("insert into cooldowns values (?, ?, ?, ?) on conflict do update set at = excluded.at").run(
    room,
    name,
    kind,
    now,
  );
  d.prepare(
    "insert into scores values (?, ?, ?) on conflict do update set pts = pts + excluded.pts",
  ).run(room, name, pts);
  return { awarded: pts, pts: ptsOf(room, name), bales: kind === "hay" ? balesOf(cow.session, now) : undefined };
}

export function board(roomIn: unknown, sessionId?: unknown) {
  if (sessionId) cowOf(sessionId);
  const room = cleanRoom(roomIn);
  const rows = db()
    .prepare("select name, pts from scores where room = ? order by pts desc, name limit ?")
    .all(room, BOARD_SIZE) as { name: string; pts: number }[];
  return { room, live: liveCows(room), board: rows.map((r) => ({ name: r.name, pts: r.pts })) };
}
