import { body, respond } from "../../../lib/respond.ts";
import { claim } from "../../../lib/scores.ts";

export const POST = (req: Request) =>
  respond(async () => {
    const b = await body(req);
    return claim(b.session, b.kind, b.chorus);
  });
