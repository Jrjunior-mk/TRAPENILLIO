// A hosted build has no API on its own loopback address, so it only proxies when API_ORIGIN is set.
const api = process.env.API_ORIGIN || (process.env.VERCEL ? "" : "http://127.0.0.1:8000");
/** @type {import('next').NextConfig} */
export default {
  output: "standalone",
  reactStrictMode: false,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    return api ? [{ source: "/api/:path*", destination: `${api}/api/:path*` }] : [];
  },
};
