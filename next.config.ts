import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @node-rs/argon2 ships a native binary; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["@node-rs/argon2"],
  // Next.js 16 otherwise re-appends its own block to AGENTS.md on every `next dev`. This repo's
  // AGENTS.md is a fixed contract every task starts by reading; it must stay exactly as written.
  agentRules: false,
};

export default nextConfig;
