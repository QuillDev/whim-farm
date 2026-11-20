import { respond } from "../../../lib/respond.ts";
import { board } from "../../../lib/scores.ts";

export const dynamic = "force-dynamic";

export const GET = (req: Request) =>
  respond(() => {
    const q = new URL(req.url).searchParams;
    return board(q.get("room"), q.get("session"));
  });
