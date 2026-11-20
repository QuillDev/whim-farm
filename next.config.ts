import type { NextConfig } from "next";

const config: NextConfig = {
  // the game is plain static pages in public/; next only adds the score api
  rewrites: async () => [{ source: "/", destination: "/index.html" }],
};

export default config;
