import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.WHIM_FARM_DB = join(mkdtempSync(join(tmpdir(), "whim-farm-")), "test.db");
const { POST: session } = await import("../app/api/session/route.ts");
const { POST: points } = await import("../app/api/points/route.ts");
const { GET: board } = await import("../app/api/board/route.ts");

const post = async (route: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await route(new Request("http://farm/api", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const boardOf = async (room: string) =>
  (await (await board(new Request(`http://farm/api/board?room=${room}`))).json()).board;

test("the server prices each action and the board keeps the total per room", async () => {
  const a = (await post(session, { name: "daisy", room: "test-a" })).body.session;
  const b = (await post(session, { name: "bessie", room: "test-a" })).body.session;
  await post(session, { name: "loner", room: "test-b" });

  assert.deepEqual((await post(points, { session: a, kind: "hay" })).body, { awarded: 2, pts: 2 });
  // a chorus can't be bigger than the cows actually in the room (2 here), whatever the client says
  assert.deepEqual((await post(points, { session: a, kind: "chorus", chorus: 8 })).body, { awarded: 4, pts: 6 });
  assert.deepEqual((await post(points, { session: b, kind: "herd" })).body, { awarded: 10, pts: 10 });
  assert.deepEqual((await post(points, { session: b, kind: "brush" })).body, { awarded: 5, pts: 15 });

  assert.deepEqual(await boardOf("test-a"), [
    { name: "bessie", pts: 15 },
    { name: "daisy", pts: 6 },
  ]);
  assert.deepEqual(await boardOf("test-b"), [{ name: "loner", pts: 0 }]);
});

test("claims the rules don't allow are refused and score nothing", async () => {
  const s = (await post(session, { name: "cheat", room: "test-c" })).body.session;
  await post(points, { session: s, kind: "brush" });

  const refusals: [unknown, number][] = [
    [{ session: s, kind: "brush" }, 429], // brush pays once per 20s
    [{ session: s, kind: "herd" }, 409], // a herd needs two cows online
    [{ session: s, kind: "chorus", chorus: 8 }, 409], // so does a chorus
    [{ session: s, kind: "pts", pts: 9999 }, 400],
    [{ session: "made-up", kind: "hay" }, 404],
  ];
  for (const [claim, status] of refusals) {
    assert.deepEqual([claim, (await post(points, claim)).status], [claim, status]);
  }
  assert.deepEqual(await boardOf("test-c"), [{ name: "cheat", pts: 5 }]);
});
