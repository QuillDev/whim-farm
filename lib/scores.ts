import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The server decides what each action is worth and how often it can pay out,
// so a client can only claim actions, never a score.
const RULES = {
  hay: { pts: 2, cooldownMs: 1200 }, // eating a bale takes 1.3s
  brush: { pts: 5, cooldownMs: 20_000 },
  herd: { pts: 10, cooldownMs: 60_000 },
  chorus: { pts: 2, cooldownMs: 450 }, // per cow in the chorus; moos are 500ms apart
} as const;
type Kind = keyof typeof RULES;
const MAX_CHORUS = 8;
const LIVE_MS = 45_000;
const BOARD_SIZE = 200;

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
    create table if not exists last_award (
      session text not null, kind text not null, at integer not null,
      primary key (session, kind));
    create table if not exists scores (
      room text not null, name text not null, pts integer not null,
      primary key (room, name));
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

export function startSession(nameIn: unknown, roomIn: unknown) {
  const name = cleanName(nameIn);
  if (!name) throw new Refusal(400, "name required");
  const room = cleanRoom(roomIn);
  const id = randomBytes(16).toString("hex");
  const now = Date.now();
  const d = db();
  d.prepare("insert into sessions values (?, ?, ?, ?, ?)").run(id, room, name, now, now);
  d.prepare("insert into scores values (?, ?, 0) on conflict do nothing").run(room, name);
  return { session: id, name, room, pts: ptsOf(room, name) };
}

function sessionRow(id: unknown) {
  const row = db().prepare("select room, name from sessions where id = ?").get(String(id ?? "")) as
    | { room: string; name: string }
    | undefined;
  if (!row) throw new Refusal(404, "unknown session");
  db().prepare("update sessions set last_seen = ? where id = ?").run(Date.now(), String(id));
  return row;
}

function liveCows(room: string) {
  const row = db()
    .prepare("select count(distinct name) as n from sessions where room = ? and last_seen > ?")
    .get(room, Date.now() - LIVE_MS) as { n: number };
  return row.n;
}

function ptsOf(room: string, name: string) {
  const row = db().prepare("select pts from scores where room = ? and name = ?").get(room, name) as
    | { pts: number }
    | undefined;
  return row?.pts ?? 0;
}

export function claim(sessionId: unknown, kindIn: unknown, chorusSize?: unknown) {
  if (typeof kindIn !== "string" || !Object.hasOwn(RULES, kindIn)) throw new Refusal(400, "unknown action");
  const kind = kindIn as Kind;
  const { room, name } = sessionRow(sessionId);
  const d = db();
  const now = Date.now();
  const last = d.prepare("select at from last_award where session = ? and kind = ?").get(String(sessionId), kind) as
    | { at: number }
    | undefined;
  if (last && now - last.at < RULES[kind].cooldownMs) throw new Refusal(429, "too soon");

  let pts: number = RULES[kind].pts;
  if (kind === "herd" && liveCows(room) < 2) throw new Refusal(409, "no herd online");
  if (kind === "chorus") {
    const k = Math.min(Math.floor(Number(chorusSize)) || 0, MAX_CHORUS, liveCows(room));
    if (k < 2) throw new Refusal(409, "no chorus");
    pts *= k;
  }

  d.prepare("insert into last_award values (?, ?, ?) on conflict do update set at = excluded.at").run(
    String(sessionId),
    kind,
    now,
  );
  d.prepare(
    "insert into scores values (?, ?, ?) on conflict do update set pts = pts + excluded.pts",
  ).run(room, name, pts);
  return { awarded: pts, pts: ptsOf(room, name) };
}

export function board(roomIn: unknown, sessionId?: unknown) {
  if (sessionId) sessionRow(sessionId);
  const room = cleanRoom(roomIn);
  const rows = db()
    .prepare("select name, pts from scores where room = ? order by pts desc, name limit ?")
    .all(room, BOARD_SIZE) as { name: string; pts: number }[];
  return { room, live: liveCows(room), board: rows.map((r) => ({ name: r.name, pts: r.pts })) };
}
