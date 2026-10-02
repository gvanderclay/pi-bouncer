# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

The first public release, 0.1.0, will collect everything below. Before it, the
bouncer lived in its author's dotfiles.

### Added

- MIT license and npm package metadata.
- CI on Node 22.19 and 24, and a check of the published file list.
- `auto.jev.model` picks Jev's provider: any classifier model in Pi's
  catalogue as `provider/id`, such as `openrouter/typesafe/jev-1.13` or
  `typesafe/jev-latest`, called through Pi with no retries. Without it Jev
  still uses OpenCode Zen and the opencode-go key. `/auto status`, the log and
  the notices name the model. The Jev bench takes `--model`. The cutoffs were
  measured through Zen only.

### Changed

- `auto.jev.model` is no longer an unknown key; a value that is not
  `provider/id` is a config problem and leaves Jev off.

- The process-wide key that keeps the bouncer mode across `/reload` is now
  `Symbol.for("pi-bouncer.mode")`. A Pi process that updates the bouncer and
  then runs `/reload` drops back to normal mode once.
- The source moved under `src/`; Pi now loads `src/index.ts`. A checkout loaded
  with `pi -e <path to the checkout>` is unaffected; anything that pointed at
  `index.ts` directly must point at `src/index.ts`.
