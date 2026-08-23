/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@harnest/core"],
  serverExternalPackages: ["esbuild"]
};

export default nextConfig;
