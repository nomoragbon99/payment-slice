import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @node-rs/argon2 ships a native binary; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["@node-rs/argon2"],
  // Next.js 16 otherwise re-appends its own block to AGENTS.md on every `next dev`. This repo's
  // AGENTS.md is a fixed contract every task starts by reading; it must stay exactly as written.
  agentRules: false,
  // The payment status page shows a person's order and depends on Paystack's answer at that moment:
  // no browser or proxy may store it, so a later visit (or someone else on a shared computer) never
  // sees a stale or someone else's status. Set explicitly instead of relying on Next's defaults.
  async headers() {
    return [
      {
        source: "/checkout/return",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
