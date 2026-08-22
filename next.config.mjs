/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg'],
  async headers() {
    return [
      {
        // Discovery + MCP must be reachable by third-party agents.
        source: '/(.well-known/.*|api/mcp)',
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
