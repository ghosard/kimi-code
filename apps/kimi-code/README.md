# @ghosard/kimi-coded

> An unofficial Kimi Code CLI fork with ChatGPT subscription login and OpenAI Codex models.

[![npm](https://img.shields.io/npm/v/@ghosard/kimi-coded)](https://www.npmjs.com/package/@ghosard/kimi-coded) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)  [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/)

This fork adds browser OAuth and device-code login for ChatGPT subscriptions. The OAuth and
provider behavior is adapted from the MIT-licensed
[Pi](https://github.com/earendil-works/pi) project; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What is Kimi Code CLI

Kimi Code CLI is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

## Install

Use Node.js 22.19.0 or later:

```sh
npm install -g @ghosard/kimi-coded
```

Or with pnpm:

```sh
pnpm add -g @ghosard/kimi-coded
```

Then run `kimi-coded --version` in a new terminal session. This fork does not replace the
upstream `kimi` command, so both packages can be installed at the same time.

For upgrade and uninstall instructions, see the [Getting Started guide](https://moonshotai.github.io/kimi-code/en/guides/getting-started).

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
kimi-coded
```

On first launch, run `/login` inside Kimi Code CLI and choose either Kimi Code OAuth or a Kimi Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **Single-binary distribution.** Install with one command — no Node.js setup, no PATH gymnastics, no global module conflicts.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Documentation

- Full docs: https://moonshotai.github.io/kimi-code/en/
- 中文文档: https://moonshotai.github.io/kimi-code/zh/
- Getting Started: https://moonshotai.github.io/kimi-code/en/guides/getting-started

## Repository & Issues

- Fork source: https://github.com/ghosard/kimi-code
- Fork issues: https://github.com/ghosard/kimi-code/issues
- Upstream: https://github.com/MoonshotAI/kimi-code
- Security: see SECURITY.md in the main repository

## License

MIT
