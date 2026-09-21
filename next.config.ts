import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 otherwise re-appends its own block to AGENTS.md on every `next dev`. This repo's
  // AGENTS.md is a fixed contract every task starts by reading; it must stay exactly as written.
  agentRules: false,
};

export default nextConfig;
