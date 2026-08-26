/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg'],
  async headers() {
    return [
      {
        // Discovery + MCP must be reachable by third-party agents. The discovery
        // endpoints set their own CORS headers too; this covers the cases Next
        // answers before a route handler runs, such as a preflight it short-circuits.
        source: '/(.well-known/.*|api/mcp|api/discovery/.*)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, DELETE, OPTIONS' },
          { key: 'Access-Control-Expose-Headers', value: 'Mcp-Session-Id, MCP-Protocol-Version' },
        ],
      },
    ];
  },
};
export default nextConfig;
