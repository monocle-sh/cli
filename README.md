<h1 align="center">Monocle CLI</h1>

<p align="center">
  Command-line companion for <a href="https://monocle.sh">Monocle</a> and <a href="https://github.com/monocle-sh/studio">Monocle Studio</a>.
  <br />
  Start Studio, query traces and logs, and manage your projects from the terminal.
</p>

<p align="center">
  <a href="https://monocle.sh/docs/studio/overview">Docs</a>
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

## Declare a deployment

Use a Deploy key, created in your application settings. Legacy project keys also work. Browser keys and ingest DSNs cannot declare deployments.
The environment slug must already exist in Monocle.

```bash
export MONOCLE_API_KEY="your-private-application-key"
monocle deploy --service api --environment production

# Inspect the payload and each field's source without sending a request.
monocle deploy --service api --environment production --dry-run
```

### Deployment options

| Option                      | Default                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `--service <name>`          | Required                                                                |
| `--environment <slug>`      | `MONOCLE_ENVIRONMENT`, otherwise required                               |
| `--version <version>`       | Explicit version or `MONOCLE_VERSION`; detected SHA goes in `commitSha` |
| `--commit <sha>`            | Detected from the environment or Git                                    |
| `--status <status>`         | `succeeded`; also accepts `started`, `failed`, and `canceled`           |
| `--started-at <timestamp>`  | Omitted; accepts ISO 8601 with a timezone                               |
| `--finished-at <timestamp>` | Omitted; the server uses receipt time for `succeeded`                   |
| `--external-id <id>`        | CI identity; generated UUID outside recognized CI                       |
| `--actor <actor>`           | CI actor                                                                |
| `--ci-url <url>`            | CI run URL                                                              |
| `--api-key <key>`           | `MONOCLE_API_KEY`                                                       |
| `--url <url>`               | `https://api.monocle.sh`                                                |
| `--strict`                  | Disabled                                                                |
| `--dry-run`                 | Disabled; prints payload and provenance, requires no API key            |

The CLI detects GitHub Actions, GitLab CI, CircleCI, Buildkite, and Bitbucket Pipelines.
It also includes the repository URL when the SDK detector provides one.
Flags override detected values. An explicit version is sent unchanged.
Automatically detected revisions are sent only as `commitSha`, so the server can find an existing release by commit.
Dry runs show `commitSha` and its provenance without a `version` field in this case.

The same CI identity updates a deployment from `started` to a terminal status.
GitHub identities include the repository, run ID, run attempt, service, and environment.
GitLab and Buildkite identities include the job ID to distinguish retries: send both calls from the same job.
CircleCI uses the workflow ID. Bitbucket uses the pipeline UUID and step run number.
If calls span jobs with different identities, provide the same `--external-id` to both calls and include your own retry identifier.
Outside CI, each call creates a deployment unless you provide `--external-id`.

Missing API keys, undetectable versions or commits, and request failures print a warning to stderr and exit with code 0. With `--strict`, they exit with code 1.
Usage errors always exit with code 1, including missing service or environment, invalid status or timestamps, and explicitly empty flags.
Each request times out after 5 seconds. Network errors, timeouts, and HTTP 5xx responses retry once after 300 ms.
Outside CI, the CLI generates `cli:<uuid>:<service>:<environment>` once per invocation. Retries reuse this identity.
HTTP 202 means the deployments feature is disabled and no deployment was stored.

### GitHub Actions example

Run both notifications in the same workflow run. `GITHUB_RUN_ATTEMPT` keeps a rerun separate from its original deployment.
The example assumes your repository has `@monocle.sh/cli` installed and a `deploy` npm script.

```yaml
name: Deploy
on:
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      MONOCLE_API_KEY: ${{ secrets.MONOCLE_API_KEY }}
      MONOCLE_ENVIRONMENT: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx --no-install monocle deploy --service api --status started
      - id: rollout
        run: npm run deploy
      - if: ${{ success() }}
        run: npx --no-install monocle deploy --service api --status succeeded
      - if: ${{ failure() && steps.rollout.outcome == 'failure' }}
        run: npx --no-install monocle deploy --service api --status failed
```

## Monocle Cloud

This CLI is part of **[Monocle](https://monocle.sh)** - the full observability platform. Traces, errors, metrics, uptime monitoring, custom dashboards, and more. All in one tool, zero config.

## License

[Elastic License 2.0](./LICENSE)
