# Figbird

Effortless realtime data management for React + Feathers applications. Used in [Humaans](https://humaans.io/).

## Install

    $ npm install figbird

## Usage

...

## Features

### Idiomatic React Hooks

Fetch some data with `const { data } = useFind('notes')` and your components will rerender in realtime as the data changes upstream. Modify the data using the `const { patch } = useMutation('notes')` and the upates will be instantly propagated to all components referencing the same objects.

- `useGet`
- `useFind`
- `useMutation`

### Live Queries

Works with Feathers realtime events and with local data mutations. Once a record is created/modified/removed all queries referencing this record get updated. For example, if your data is fetched using `useFind('notes', { query: { tag: 'ideas' } })` and you then patch some note with `patch({ tag: 'ideas' })` - the query will updated immediately and rerender all components referencing that query. Adjust behaviour per query:

- `merge` - merge realtime events into cached queries as they come (default)
- `refetch` - refetch data for this query from the server when a realtime event is received
- `disabled` - ignore realtime events for this query

### Fetch policies

Fetch policies allow you to fine tune Figbird to your requirements. With the default `swr` (stale-while-revalidate) Figbir's uses cached data when possible for maximum responsiveness, but refetches in the background on mount to make sure data is up to date. The other policies are `cache-first` which will use cache and not refresh from the server (compatible with realtime)

- `swr` - show cached data if possible and refetch in the background (default)
- `cache-first` - show cached data if possible and avoid fetching if data is there
- `network-only` - always refetch data on mount

## API Reference

Visit the [documentation site](https://humaans.github.io/figbird/) for full API reference.
