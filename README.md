# @monocle.sh/cli

CLI for Monocle - upload source maps to enable readable stack traces in your error monitoring.

## Installation

```bash
npm install -g @monocle.sh/cli
# or use npx
npx @monocle.sh/cli sourcemaps upload ...
```

## Usage

### Upload Source Maps

Upload source maps after your build process:

```bash
monocle-cli sourcemaps upload \
  --api-key=mk_live_xxx \
  --release=v1.2.3 \
  ./dist/**/*.map
```

With environment variable:

```bash
MONOCLE_API_KEY=mk_live_xxx monocle-cli sourcemaps upload \
  --release=$(git rev-parse HEAD) \
  ./dist/**/*.map
```

### Options

| Option                | Description                                        | Default                  |
| --------------------- | -------------------------------------------------- | ------------------------ |
| `--api-key <key>`     | Monocle API key (or set `MONOCLE_API_KEY` env var) | -                        |
| `--release <version>` | Release version (e.g., `v1.2.3` or git SHA)        | -                        |
| `--url <url>`         | Monocle API URL                                    | `https://api.monocle.sh` |
| `--dry-run`           | Show what would be uploaded without uploading      | `false`                  |

### Release Identifier

The release identifier links exceptions to their source maps. It must match the `serviceVersion` configured in your Monocle agent:

```typescript
// config/monocle.ts
export default defineConfig({
  serviceVersion: env.get("APP_VERSION"), // e.g., "v1.2.3" or git SHA
});
```

Best practices:

- Use git commit SHA for precise matching: `$(git rev-parse HEAD)`
- Use semver for human-readable releases: `v1.2.3`
- Must match exactly between upload and runtime config

## CI/CD Integration

### GitHub Actions

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Upload Source Maps
        run: |
          npx @monocle.sh/cli sourcemaps upload \
            --api-key=${{ secrets.MONOCLE_API_KEY }} \
            --release=${{ github.sha }} \
            ./dist/**/*.map

      - name: Deploy
        run: # your deploy command
```

### GitLab CI

```yaml
deploy:
  stage: deploy
  script:
    - npm ci
    - npm run build
    - npx @monocle.sh/cli sourcemaps upload
      --api-key=$MONOCLE_API_KEY
      --release=$CI_COMMIT_SHA
      ./dist/**/*.map
    -  # your deploy command
```

### CircleCI

```yaml
version: 2.1

jobs:
  deploy:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: npm ci
      - run: npm run build
      - run:
          name: Upload Source Maps
          command: |
            npx @monocle.sh/cli sourcemaps upload \
              --api-key=$MONOCLE_API_KEY \
              --release=$CIRCLE_SHA1 \
              ./dist/**/*.map
      - run: # your deploy command
```

## AdonisJS Configuration

For AdonisJS projects using `tsc` and Node.js (no bundler):

### 1. Enable source maps in tsconfig.json

```json
{
  "compilerOptions": {
    "sourceMap": true,
    "inlineSources": true,
    "sourceRoot": "/"
  }
}
```

### 2. Configure Monocle agent with release version

```typescript
// config/monocle.ts
import env from "#start/env";

export default defineConfig({
  serviceVersion: env.get("APP_VERSION"),
});
```

### 3. Set APP_VERSION in your deployment

```bash
# In your CI/CD or .env
APP_VERSION=$(git rev-parse HEAD)
```

### 4. Upload source maps after build

```yaml
# GitHub Actions example
- name: Build
  run: node ace build

- name: Upload Source Maps
  run: |
    npx @monocle.sh/cli sourcemaps upload \
      --api-key=${{ secrets.MONOCLE_API_KEY }} \
      --release=${{ github.sha }} \
      ./build/**/*.map

- name: Deploy
  run: # rsync, docker push, etc.
```

The `--release` value must match `APP_VERSION` used at runtime.

### 5. (Optional) Delete source maps before deploy

Source maps can expose your source code. Delete them after upload:

```yaml
- name: Upload Source Maps
  run: npx @monocle.sh/cli sourcemaps upload ...

- name: Remove source maps from build
  run: find ./build -name "*.map" -delete

- name: Deploy
  run: # deploy without .map files
```

## Troubleshooting

### No source map files found

- Check that your build generates `.map` files
- Verify your glob patterns match the output location
- Try using `--dry-run` to see what would be matched

### Authentication failed

- Verify your API key is correct
- Ensure the API key has write permissions for source maps
- Check that `MONOCLE_API_KEY` environment variable is set correctly

### Stack traces not resolving

- Ensure the `--release` value matches `serviceVersion` in your Monocle agent config
- Verify source maps were uploaded successfully
- Check that the source map filenames match the ones referenced in your minified code
