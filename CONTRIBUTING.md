# Contributing to Nightdrop

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/404Dealer/nightdrop.git
cd nightdrop
npm install
cp config.example.yaml config.yaml
# Set up a test Telegram bot via @BotFather and add your token + user ID
npm run dev
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build` to verify TypeScript compiles cleanly
4. Test your changes with the `log-only` provider before testing with real providers
5. Open a PR with a clear description of what changed and why

## Adding a Provider

New providers are the easiest way to contribute:

1. Create `src/providers/your-provider.ts` implementing the `Provider` interface
2. Add your provider's config type to the `ProviderSchema` union in `src/config.ts`
3. Register it in `src/providers/index.ts`
4. Add a section to `config.example.yaml`
5. Document it in the README

## Code Style

- TypeScript strict mode
- ESM modules (`"type": "module"`)
- No external HTTP libraries — use native `fetch`
- Minimize dependencies
- Fail hard on config errors — no silent defaults for secrets

## Security

If you find a security vulnerability, **please do not open a public issue.** Email the maintainer directly (see package.json) or open a private security advisory on GitHub.

## Good First Issues

Look for issues tagged `good first issue` — these are scoped and approachable.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
