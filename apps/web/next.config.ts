import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ["@banna/shared", "@banna/generator", "@banna/integrations", "@banna/backends", "@banna/spec", "@banna/policy"],
};

export default config;
