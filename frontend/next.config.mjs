const allowedDevOrigins = (process.env.HARNEST_STUDIO_ALLOWED_HOSTS ?? "")
  .split(",").map((host) => host.trim()).filter(Boolean);

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.HARNEST_STUDIO_DIST_DIR?.trim()
    || (process.env.NODE_ENV === "production" ? ".next-build" : ".next"),
  transpilePackages: ["@harnestai/core"],
  serverExternalPackages: ["esbuild"],
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {})
};

export default nextConfig;
