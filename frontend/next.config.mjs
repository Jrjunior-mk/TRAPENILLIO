const api = process.env.API_ORIGIN || "http://127.0.0.1:8000";
/** @type {import('next').NextConfig} */
export default {
  output: "standalone",
  reactStrictMode: false,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};
