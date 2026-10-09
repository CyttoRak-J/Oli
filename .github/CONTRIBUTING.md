# Contributing to Oli

Thanks for your interest in improving Oli! Bug reports, ideas, and pull requests are all welcome.
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/CyttoRak-J/Oli/issues) first.
- Use the issue templates. For bugs, include your Oli version, platform (Windows, macOS, Android),
  and steps to reproduce.
- For security problems, do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js (LTS) and npm.

```bash
npm install
npm run dev        # start the desktop app in development mode
```

Packaging scripts are in `package.json`; the Android project lives in `android/`.

> Dev mode uses your real library data. Back it up before testing destructive changes.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm test
```

All three must pass. CI runs them on every pull request.

## Pull request guidelines

- Keep each PR focused on one change; open an issue first for large features.
- Match the surrounding code style, naming, and comment density.
- Add or update tests for behavior changes.
- Update the README or docs if user-facing behavior changes.
- Describe what changed and why, and how you tested it.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](../LICENSE).
