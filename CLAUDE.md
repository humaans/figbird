# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Figbird is a realtime data management library for React + Feathers applications. It provides React hooks for fetching data that automatically update via realtime events.

## Commands

```bash
npm run tsc       # Type check
npm run lint      # ESLint
npm run ava       # Run tests (AVA)
npm run test      # Full suite: tsc + eslint + prettier + tests with coverage
npm run format    # Format code with Prettier
npm run build     # Build to dist/
```

Run a single test file:
```bash
npx ava test/figbird-instance.test.ts
```

## Architecture

### Core (`lib/core/`)
- **figbird.ts** - Main `Figbird` class and `QueryStore`. Manages query state, caching, and realtime event processing. Queries are identified by a hash of their descriptor + config.
- **schema.ts** - TypeScript schema system using phantom types for type-safe service definitions. `createSchema()` and `service()` enable full type inference.

### Adapters (`lib/adapters/`)
- **adapter.ts** - Generic `Adapter` interface defining get/find/findAll/mutate/subscribe methods
- **feathers.ts** - `FeathersAdapter` implementation for Feathers.js backends
- **matcher.ts** - Query matcher using `sift` library for client-side filtering of realtime events

### React (`lib/react/`)
- **createHooks.ts** - Factory function that creates typed `useFind`, `useGet`, `useMutation` hooks from a Figbird instance
- **useQuery.ts** - Core hook implementation using `useSyncExternalStore` to subscribe to query state
- **useMutation.ts** - Mutation hook providing `create`, `update`, `patch`, `remove` methods

### Data Flow
1. Hooks call `figbird.query()` to create a `QueryRef`
2. `QueryRef.subscribe()` materializes the query in `QueryStore` and triggers fetching
3. Results are cached in `ServiceState` (entities map + queries map)
4. Realtime events flow through `#queueEvent` -> batch processing -> `#updateQueriesFromEvents`
5. Matching queries update their state and notify subscribers

## Code Style

- Avoid `any` unless absolutely necessary for public API simplicity; use eslint-ignore comments with justification
- Don't add tests unless explicitly requested
- Update existing tests when code changes require it
