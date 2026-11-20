import { Refusal } from "./scores.ts";

export async function respond(run: () => unknown) {
  try {
    return Response.json(await run(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof Refusal) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const body = (req: Request) => req.json().catch(() => ({})) as Promise<Record<string, unknown>>;
