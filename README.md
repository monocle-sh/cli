<h1 align="center">Monocle CLI</h1>

<p align="center">
  Command-line companion for <a href="https://monocle.sh">Monocle</a> and <a href="https://github.com/monocle-sh/studio">Monocle Studio</a>.
  <br />
  Start Studio, query traces and logs, and manage your projects from the terminal.
</p>

<p align="center">
  <a href="https://docs.monocle.sh/studio/overview">Docs</a>
  ·
  <a href="https://monocle.sh">Website</a>
  ·
  <a href="https://npmjs.com/package/@monocle.sh/cli">npm</a>
</p>

---

## Installation

```bash
npm install -D @monocle.sh/cli
```

## Studio

Start the local Studio dev server, query traces, logs, and errors from the terminal.

```bash
# Start the Studio server
monocle studio dev

# Query recent traces
monocle studio traces

# Query recent logs
monocle studio logs

# Query recent errors
monocle studio errors

# Add Studio instructions to AGENTS.md / CLAUDE.md
monocle studio install-agents
```

### Options

```
monocle studio dev
  --port     Custom port (default: 4200)
  --host     Bind to a specific host
  --open     Auto-open browser on start
  --clean    Clear stored data
  --db-path  Custom database location

monocle studio traces
  -p, --port       Studio server port (default: 4200)
  -f, --format     Output format: pretty, json, short (default: pretty)
  -n, --limit      Number of traces to fetch (default: 25)
  -s, --service    Filter by service name
  --trace-id       Filter by trace ID

monocle studio logs
  -p, --port       Studio server port (default: 4200)
  -f, --format     Output format: pretty, json, short (default: pretty)
  -n, --limit      Number of logs to fetch (default: 50)
  --severity       Filter by severity (error, warn, info, debug)
  --search         Search in log body and attributes
  --trace-id       Filter by trace ID

monocle studio errors
  -p, --port       Studio server port (default: 4200)
  -f, --format     Output format: pretty, json, short (default: pretty)
  -n, --limit      Number of errors to fetch (default: 25)
  --trace-id       Filter by trace ID
```

## Monocle Cloud

This CLI is part of **[Monocle](https://monocle.sh)** - the full observability platform. Traces, errors, metrics, uptime monitoring, custom dashboards, and more. All in one tool, zero config.

## License

[Elastic License 2.0](./LICENSE)
