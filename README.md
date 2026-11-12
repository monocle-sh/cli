<img width="1500" height="500" alt="Monocle" src="https://github.com/user-attachments/assets/45d9a45e-2b49-40c3-86af-1fe3ce26858d" />

# Monocle CLI

Upload source maps and native debug files, declare deployments, and query local telemetry from [Monocle Studio](https://monocle.sh/docs/studio/overview).

[Documentation](https://monocle.sh/docs) · [npm](https://www.npmjs.com/package/@monocle.sh/cli)

## Install

Requires Node.js 22.12 or later.

```bash
npm install -D @monocle.sh/cli
```

## Use

List commands and their options:

```bash
npx monocle --help
npx monocle <command> --help
```

Follow the setup guide for your task:

- [Source maps](https://monocle.sh/docs/sdks/source-maps): inject debug IDs and upload JavaScript source maps with `monocle sourcemaps`.
- [Native symbols and sources](https://monocle.sh/docs/sdks/native-symbols): upload Linux debug files and source code with `monocle debug-files`.
- [Deployments](https://monocle.sh/docs/features/deployments/cli): declare deployments from CI with `monocle deploy`.
- [Studio commands](https://monocle.sh/docs/studio/cli): query local traces, logs, and errors with `monocle studio`.

Uploads and deployment declarations require a project token in `MONOCLE_API_KEY`. Store the token in your CI secrets.

## Run Studio locally

Install Studio alongside the CLI, then start the server:

```bash
npm install -D @monocle.sh/studio
npx monocle studio dev
```

Follow the [Studio setup guide](https://monocle.sh/docs/studio/overview) to connect your application's telemetry.

## License

[Elastic License 2.0](./LICENSE)
