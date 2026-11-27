import path from 'node:path';
import type { NextConfig } from 'next';

// The browser only ever talks to one origin; /api is forwarded to the API.
// This value is fixed at build time.
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
const root = path.join(import.meta.dirname, '../..');

const config: NextConfig = {
  // Set in the Dockerfile to produce a small self-contained server.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // Stops `next dev` writing AGENTS.md into the repository.
  agentRules: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/((?!api/).*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
        ],
      },
    ];
  },
};

export default config;
