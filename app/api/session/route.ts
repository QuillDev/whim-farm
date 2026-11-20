import { body, respond } from "../../../lib/respond.ts";
import { startSession } from "../../../lib/scores.ts";

export const POST = (req: Request) =>
  respond(async () => {
    const b = await body(req);
    return startSession(b.name, b.room);
  });
