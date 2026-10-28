/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep `next build` from overwriting the active development server's assets.
  distDir: process.env.NODE_ENV === 'development' ? '.next-development' : '.next',
};

module.exports = nextConfig;
