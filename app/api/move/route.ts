import { body, respond } from "../../../lib/respond.ts";
import { move } from "../../../lib/scores.ts";

export const POST = (req: Request) =>
  respond(async () => {
    const b = await body(req);
    return move(b.session, b.seq, b.x, b.z);
  });
