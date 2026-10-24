# @monocle.sh/cli

## 0.5.0

### Minor Changes

- [#5](https://github.com/monocle-sh/cli/pull/5) [`aaff6e2`](https://github.com/monocle-sh/cli/commit/aaff6e2672a0bf9c7203d3d8523201a824ab39ec) Thanks [@Julien-R44](https://github.com/Julien-R44)! - Replace `monocle sourcemaps upload <patterns...>` with debug ID based commands: `monocle sourcemaps inject <directory>` and `monocle sourcemaps upload <directory>`. `--release` is now optional and `--dry-run` is removed. The previous upload endpoint no longer exists.

### Patch Changes

- [`4cc892c`](https://github.com/monocle-sh/cli/commit/4cc892c62b6ce85476113af22d205b20c76f0684) Thanks [@Julien-R44](https://github.com/Julien-R44)! - Point the README documentation link to monocle.sh/docs.

## 0.4.0

### Minor Changes

- [#1](https://github.com/monocle-sh/cli/pull/1) [`9cfae33`](https://github.com/monocle-sh/cli/commit/9cfae33a3acf436519b5d67c20059def95484d78) Thanks [@Julien-R44](https://github.com/Julien-R44)! - Add `monocle deploy` with CI metadata detection, dry-run provenance, and optional strict failure handling.

- [#2](https://github.com/monocle-sh/cli/pull/2) [`dff92d7`](https://github.com/monocle-sh/cli/commit/dff92d755666ea45bcffd2ec4360f0a6191144b1) Thanks [@Julien-R44](https://github.com/Julien-R44)! - Update dependencies and require Node.js 22.12.0 or newer for Commander 15. Preserve Studio requests and deployment error details with ky 2.
