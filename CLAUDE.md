# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Figbird is a realtime data management library for React + Feathers applications. It provides React hooks for fetching data that automatically update via realtime events.

## Commands

```bash
npm run tsc       # Type check
npm run lint      # ESLint
npm run ava       # Run tests (AVA)
npm run test      # Full suite: tsc + oxlint + oxfmt + tests with coverage
npm run format    # Format code with oxfmt
npm run build     # Build to dist/
```

Run a single test file:
```bash
npx ava test/figbird-instance.test.ts
```
