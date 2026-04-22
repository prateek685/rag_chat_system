import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for the multi-stage Docker build — produces a self-contained
  // .next/standalone directory that runs without the full node_modules tree.
  output: 'standalone',
};

export default nextConfig;
