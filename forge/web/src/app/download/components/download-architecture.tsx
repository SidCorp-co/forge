// Pure SVG architecture diagram — no images, no JS layout work, scales
// crisply at every size. Mirrors the data flow described in
// `forge/CLAUDE.md`: web/dev → core REST/WS → Postgres + device-runner
// → Claude CLI. The "engine" framing keeps the visual continuous with
// the landing's mechanical metaphor.

export function DownloadArchitecture() {
  return (
    <section
      id="architecture"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-24 border-t border-outline-variant/20"
    >
      <div className="pointer-events-none absolute top-[15%] right-[-12%] w-[440px] h-[440px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.05)_0%,transparent_70%)]" />

      <div className="text-center mb-14">
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Architecture
        </p>
        <h2 className="font-serif text-3xl sm:text-4xl md:text-5xl tracking-tight mb-3">
          One control plane,{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            three surfaces
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base font-light leading-relaxed">
          The web UI, the desktop runner, and your AI assistants all speak the
          same protocol against the same Hono+Drizzle core. No data leaves
          your hardware unless you decide it should.
        </p>
      </div>

      <div className="rounded-2xl border border-outline-variant/20 bg-white shadow-sm p-6 sm:p-10">
        <svg
          role="img"
          aria-labelledby="forge-arch-title forge-arch-desc"
          viewBox="0 0 800 460"
          className="w-full h-auto"
        >
          <title id="forge-arch-title">Forge Beta architecture diagram</title>
          <desc id="forge-arch-desc">
            Web and desktop clients call the Hono+Drizzle core over REST and
            WebSocket. The core dispatches jobs to the device-runner inside
            forge/dev which runs Claude CLI locally. MCP clients reach the
            same handlers via /mcp. Postgres with pg-boss + pgvector is the
            single store.
          </desc>

          <defs>
            <linearGradient id="amber" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#855300" />
              <stop offset="100%" stopColor="#f59e0b" />
            </linearGradient>
            <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.15" />
              <stop offset="50%" stopColor="#f59e0b" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.15" />
            </linearGradient>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
            </marker>
          </defs>

          {/* Top tier: clients */}
          <g>
            {/* forge/web */}
            <rect
              x="40"
              y="40"
              width="180"
              height="80"
              rx="14"
              fill="white"
              stroke="#d4d4d4"
            />
            <text x="130" y="68" textAnchor="middle" fontFamily="serif" fontSize="16" fill="#1a1c1c" fontWeight="500">
              forge/web
            </text>
            <text x="130" y="88" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="#666">
              Next.js cloud UI
            </text>
            <text x="130" y="104" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#999">
              browser
            </text>

            {/* forge/dev */}
            <rect
              x="310"
              y="40"
              width="180"
              height="80"
              rx="14"
              fill="white"
              stroke="#d4d4d4"
            />
            <text x="400" y="68" textAnchor="middle" fontFamily="serif" fontSize="16" fill="#1a1c1c" fontWeight="500">
              forge/dev
            </text>
            <text x="400" y="88" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="#666">
              Tauri desktop app
            </text>
            <text x="400" y="104" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#999">
              your machine
            </text>

            {/* MCP clients */}
            <rect
              x="580"
              y="40"
              width="180"
              height="80"
              rx="14"
              fill="white"
              stroke="#d4d4d4"
            />
            <text x="670" y="68" textAnchor="middle" fontFamily="serif" fontSize="16" fill="#1a1c1c" fontWeight="500">
              MCP clients
            </text>
            <text x="670" y="88" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="#666">
              Claude / agents
            </text>
            <text x="670" y="104" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#999">
              /forge-* skills
            </text>
          </g>

          {/* Connector lines from clients to core */}
          <g stroke="url(#line)" strokeWidth="1.6" fill="none" markerEnd="url(#arrow)">
            <path d="M 130 120 C 130 165, 360 175, 400 200" />
            <path d="M 400 120 L 400 200" />
            <path d="M 670 120 C 670 165, 440 175, 400 200" />
          </g>

          {/* Connector labels */}
          <g fontFamily="ui-monospace, monospace" fontSize="10" fill="#999">
            <text x="220" y="156">REST · /api/*</text>
            <text x="364" y="148">WS · /ws</text>
            <text x="500" y="156">/mcp</text>
          </g>

          {/* Core box (the engine) */}
          <g>
            <rect
              x="240"
              y="200"
              width="320"
              height="100"
              rx="16"
              fill="url(#amber)"
            />
            <text x="400" y="232" textAnchor="middle" fontFamily="serif" fontSize="20" fill="white" fontWeight="500">
              forge/core
            </text>
            <text x="400" y="254" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="white" opacity="0.85">
              Hono · Drizzle · pg-boss · WS · MCP
            </text>
            <text x="400" y="278" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="white" opacity="0.6">
              one process · one Postgres
            </text>
          </g>

          {/* Bottom tier: data + runner */}
          <g stroke="url(#line)" strokeWidth="1.6" fill="none" markerEnd="url(#arrow)">
            <path d="M 320 300 L 220 350" />
            <path d="M 480 300 L 580 350" />
          </g>

          <g fontFamily="ui-monospace, monospace" fontSize="10" fill="#999">
            <text x="240" y="328">jobs · vectors · data</text>
            <text x="500" y="328">job.assigned</text>
          </g>

          {/* Postgres */}
          <g>
            <rect
              x="80"
              y="350"
              width="280"
              height="74"
              rx="12"
              fill="white"
              stroke="#d4d4d4"
            />
            <text x="220" y="380" textAnchor="middle" fontFamily="serif" fontSize="15" fill="#1a1c1c" fontWeight="500">
              Postgres
            </text>
            <text x="220" y="400" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="#666">
              data + jobs + pgvector
            </text>
            <text x="220" y="416" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#999">
              single store
            </text>
          </g>

          {/* Device runner — Claude CLI */}
          <g>
            <rect
              x="440"
              y="350"
              width="280"
              height="74"
              rx="12"
              fill="white"
              stroke="#d4d4d4"
            />
            <text x="580" y="380" textAnchor="middle" fontFamily="serif" fontSize="15" fill="#1a1c1c" fontWeight="500">
              Claude CLI
            </text>
            <text x="580" y="400" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="#666">
              spawned by forge/dev
            </text>
            <text x="580" y="416" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#999">
              your subscription · your hardware
            </text>
          </g>
        </svg>
      </div>

      {/* Architectural takeaways — each card gets a distinct edge color so
          the row reads as three principles, not three identical chips. */}
      <ul className="mt-8 grid gap-3 sm:grid-cols-3 text-xs font-mono text-primary-fixed">
        <li className="rounded-lg border border-outline-variant/30 bg-white px-4 py-3 border-l-2 border-l-warning">
          <span className="block text-on-surface mb-1">No proxy</span>
          Claude credentials stay on your device — never on the server.
        </li>
        <li className="rounded-lg border border-outline-variant/30 bg-white px-4 py-3 border-l-2 border-l-info">
          <span className="block text-on-surface mb-1">One store</span>
          Postgres holds data, jobs (pg-boss), and embeddings (pgvector).
        </li>
        <li className="rounded-lg border border-outline-variant/30 bg-white px-4 py-3 border-l-2 border-l-success">
          <span className="block text-on-surface mb-1">Same protocol</span>
          REST, WS, and MCP all hit the same Hono handlers — no surface drift.
        </li>
      </ul>
    </section>
  );
}
