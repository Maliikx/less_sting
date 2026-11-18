import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the project root so a stray package-lock.json in a parent folder
  // (e.g. C:\Users\<you>\package-lock.json) isn't picked as the workspace root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
