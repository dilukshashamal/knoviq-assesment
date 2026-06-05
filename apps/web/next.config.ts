import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,

  // Prevent Next.js from trying to bundle server-only modules that
  // should be resolved from node_modules at runtime.
  serverExternalPackages: [],

  // Disable response body buffering for all API routes globally.
  // Individual routes still need export const dynamic = "force-dynamic"
  // if they read request headers/cookies, but this ensures no route
  // silently buffers a streaming body.
  experimental: {
    // Allows the Node.js HTTP server to flush SSE chunks immediately
    // without waiting for the response to finish.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
