function _define_property(obj, key, value) {
    if (key in obj) {
        Object.defineProperty(obj, key, {
            value: value,
            enumerable: true,
            configurable: true,
            writable: true
        });
    } else {
        obj[key] = value;
    }
    return obj;
}
function _object_spread(target) {
    for(var i = 1; i < arguments.length; i++){
        var source = arguments[i] != null ? arguments[i] : {};
        var ownKeys = Object.keys(source);
        if (typeof Object.getOwnPropertySymbols === "function") {
            ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(source).filter(function(sym) {
                return Object.getOwnPropertyDescriptor(source, sym).enumerable;
            }));
        }
        ownKeys.forEach(function(key) {
            _define_property(target, key, source[key]);
        });
    }
    return target;
}
function ownKeys(object, enumerableOnly) {
    var keys = Object.keys(object);
    if (Object.getOwnPropertySymbols) {
        var symbols = Object.getOwnPropertySymbols(object);
        if (enumerableOnly) {
            symbols = symbols.filter(function(sym) {
                return Object.getOwnPropertyDescriptor(object, sym).enumerable;
            });
        }
        keys.push.apply(keys, symbols);
    }
    return keys;
}
function _object_spread_props(target, source) {
    source = source != null ? source : {};
    if (Object.getOwnPropertyDescriptors) {
        Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
    } else {
        ownKeys(Object(source)).forEach(function(key) {
            Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
        });
    }
    return target;
}
function _object_without_properties(source, excluded) {
    if (source == null) return {};
    var target = _object_without_properties_loose(source, excluded);
    var key, i;
    if (Object.getOwnPropertySymbols) {
        var sourceSymbolKeys = Object.getOwnPropertySymbols(source);
        for(i = 0; i < sourceSymbolKeys.length; i++){
            key = sourceSymbolKeys[i];
            if (excluded.indexOf(key) >= 0) continue;
            if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
            target[key] = source[key];
        }
    }
    return target;
}
function _object_without_properties_loose(source, excluded) {
    if (source == null) return {};
    var target = {};
    var sourceKeys = Object.keys(source);
    var key, i;
    for(i = 0; i < sourceKeys.length; i++){
        key = sourceKeys[i];
        if (excluded.indexOf(key) >= 0) continue;
        target[key] = source[key];
    }
    return target;
}
import { useMemo } from 'react';
import { createAtom, createContext as createAtomContext, createHooks as createAtomHooks } from 'tiny-atom';
import { namespace } from './namespace';
import { getIn, setIn, unsetIn, matcher as defaultMatcher, forEachObj } from './helpers';
const initialState = ()=>({
        [namespace]: {
            entities: {},
            queries: {},
            refs: {},
            index: {}
        }
    });
const actions = ({ idField , updatedAtField  })=>({
        feathersFetched: fetched(idField, updatedAtField),
        feathersCreated: created(idField, updatedAtField),
        feathersUpdated: updated(idField, updatedAtField),
        feathersPatched: updated(idField, updatedAtField),
        feathersRemoved: removed(idField, updatedAtField),
        feathersUpdateQueries: updateQuery(idField, updatedAtField)
    });
function fetched(idField, updatedAtField) {
    return ({ get , set , actions  }, { serviceName , data , method , params , queryId , realtime , matcher  })=>{
        const curr = getIn(get(), [
            namespace
        ]);
        let next = curr;
        const { data: items  } = data, meta = _object_without_properties(data, [
            "data"
        ]);
        const entities = realtime === 'merge' ? _object_spread({}, getIn(curr, [
            'entities',
            serviceName
        ])) : {};
        const index = realtime === 'merge' ? _object_spread({}, getIn(curr, [
            'index',
            serviceName
        ])) : {};
        for (const item of items){
            const itemId = idField(item);
            entities[itemId] = item;
            if (realtime === 'merge') {
                const itemIndex = _object_spread({}, index[itemId]);
                itemIndex.queries = _object_spread_props(_object_spread({}, itemIndex.queries), {
                    [queryId]: true
                });
                itemIndex.size = itemIndex.size ? itemIndex.size + 1 : 1;
                index[itemId] = itemIndex;
            }
        }
        if (realtime === 'merge') {
            // update entities
            next = setIn(next, [
                'entities',
                serviceName
            ], entities);
            next = setIn(next, [
                'index',
                serviceName
            ], index);
        }
        // update queries
        next = setIn(next, [
            'queries',
            serviceName,
            queryId
        ], _object_spread({
            params,
            data: items.map((x)=>idField(x)),
            meta,
            method,
            realtime,
            matcher
        }, realtime === 'merge' ? {} : {
            entities
        }));
        const l = items.length;
        const msg = `${serviceName} ${l} item${l === 1 ? '' : 's'}`;
        set({
            [namespace]: next
        }, msg);
    };
}
function created(idField, updatedAtField) {
    return ({ get , set , actions  }, { serviceName , item  })=>{
        actions.feathersUpdateQueries({
            serviceName,
            method: 'create',
            item
        });
    };
}
// applies to both update and patch
function updated(idField, updatedAtField) {
    return ({ get , set , actions  }, { serviceName , item  })=>{
        const itemId = idField(item);
        const curr = getIn(get(), [
            namespace
        ]);
        const currItem = getIn(curr, [
            'entities',
            serviceName,
            itemId
        ]);
        // check to see if we should discard this update
        if (currItem) {
            const currUpdatedAt = updatedAtField(currItem);
            const nextUpdatedAt = updatedAtField(item);
            if (nextUpdatedAt && nextUpdatedAt < currUpdatedAt) {
                return;
            }
        }
        let next;
        if (currItem) {
            next = setIn(curr, [
                'entities',
                serviceName,
                itemId
            ], item);
        } else {
            const index = {
                queries: {},
                size: 0
            };
            next = setIn(curr, [
                'entities',
                serviceName,
                itemId
            ], item);
            next = setIn(next, [
                'index',
                serviceName,
                itemId
            ], index);
        }
        const msg = `${serviceName} ${itemId} updated`;
        set({
            [namespace]: next
        }, msg);
        actions.feathersUpdateQueries({
            serviceName,
            method: 'update',
            item
        });
    };
}
function removed(idField) {
    return ({ get , set , actions  }, { serviceName , item: itemOrItems  })=>{
        const items = Array.isArray(itemOrItems) ? itemOrItems : [
            itemOrItems
        ];
        let curr = getIn(get(), [
            namespace
        ]);
        const exists = items.some((item)=>getIn(curr, [
                'entities',
                serviceName,
                idField(item)
            ]));
        if (!exists) return;
        // remove this item from all the queries that reference it
        actions.feathersUpdateQueries({
            serviceName,
            method: 'remove',
            item: itemOrItems
        });
        // updating queries updates state, get a fresh copy
        curr = getIn(get(), [
            namespace
        ]);
        // now remove it from entities
        const serviceEntities = _object_spread({}, getIn(curr, [
            'entities',
            serviceName
        ]));
        let next = curr;
        const removedIds = [];
        for (const item of items){
            delete serviceEntities[idField(item)];
            next = setIn(next, [
                'entities',
                serviceName
            ], serviceEntities);
            removedIds.push(idField(item));
        }
        const msg = `removed ${serviceName} ${removedIds.join(',')}`;
        set({
            [namespace]: next
        }, msg);
    };
}
function updateQuery(idField, updatedAtField) {
    return function feathersUpdateQueries({ get , set  }, { serviceName , method , item  }) {
        const items = Array.isArray(item) ? item : [
            item
        ];
        for (const item of items){
            const itemId = idField(item);
            const curr = getIn(get(), [
                namespace
            ]);
            const queries = _object_spread({}, getIn(curr, [
                'queries',
                serviceName
            ]));
            const index = _object_spread({}, getIn(curr, [
                'index',
                serviceName,
                itemId
            ]));
            index.queries = _object_spread({}, index.queries);
            index.size = index.size || 0;
            let updateCount = 0;
            forEachObj(queries, (query, queryId)=>{
                let matches;
                // do not update non realtime queries
                // those get updated/refetched in a different way
                if (query.realtime !== 'merge') {
                    return;
                }
                if (method === 'remove') {
                    // optimisation, if method is remove, we want to immediately remove the object
                    // from cache, which means we don't need to match using matcher
                    matches = false;
                } else if (!query.params.query || Object.keys(query.params.query).length === 0) {
                    // another optimisation, if there is no query, the object matches
                    matches = true;
                } else {
                    const matcher = query.matcher ? query.matcher(defaultMatcher) : defaultMatcher;
                    matches = matcher(query.params.query)(item);
                }
                if (index.queries[queryId]) {
                    if (!matches) {
                        updateCount++;
                        queries[queryId] = _object_spread_props(_object_spread({}, query), {
                            meta: _object_spread_props(_object_spread({}, query.meta), {
                                total: query.meta.total - 1
                            }),
                            data: query.data.filter((id)=>id !== itemId)
                        });
                        delete index.queries[queryId];
                        index.size -= 1;
                    }
                } else {
                    // only add if query has fetched all of the data..
                    // if it hasn't fetched all of the data then leave this
                    // up to the consumer of the figbird to decide if data
                    // should be refetched
                    if (matches && query.data.length <= query.meta.total) {
                        updateCount++;
                        // TODO - sort
                        queries[queryId] = _object_spread_props(_object_spread({}, query), {
                            meta: _object_spread_props(_object_spread({}, query.meta), {
                                total: query.meta.total + 1
                            }),
                            data: query.data.concat(itemId)
                        });
                        index.queries[queryId] = true;
                        index.size += 1;
                    }
                }
            });
            if (updateCount > 0) {
                let next = curr;
                next = setIn(next, [
                    'queries',
                    serviceName
                ], queries);
                next = setIn(next, [
                    'index',
                    serviceName,
                    itemId
                ], index);
                // in case of create, only ever add it to the cache if it's relevant for any of the
                // queries, otherwise, we might end up piling in newly created objects into cache
                // even if the app never uses them
                if (!getIn(next, [
                    'entities',
                    serviceName,
                    itemId
                ])) {
                    next = setIn(next, [
                        'entities',
                        serviceName,
                        itemId
                    ], item);
                }
                // this item is no longer relevant to any query, garbage collect it
                if (index.size === 0) {
                    next = unsetIn(next, [
                        'entities',
                        serviceName,
                        itemId
                    ]);
                    next = unsetIn(next, [
                        'index',
                        serviceName,
                        itemId
                    ]);
                }
                const msg = `updated ${updateCount} ${updateCount === 1 ? 'query' : 'queries'}`;
                set({
                    [namespace]: next
                }, msg);
            }
        }
    };
}
export const useCacheInstance = (atom, config)=>{
    return useMemo(()=>{
        atom = atom || createAtom();
        // Create an atom context and a set of hooks separate from the
        // main context used in tiny-atom. This way our store and actions
        // and everything do not interfere with the main atom. Use this
        // secondary context even if we use an existing atom – there is no
        // issue with that.
        const { AtomContext , Provider: AtomProvider  } = createAtomContext();
        const { useSelector  } = createAtomHooks(AtomContext);
        // configure atom with initial state and figbird actions
        atom.fuse({
            state: initialState(),
            actions: actions(config)
        });
        return {
            atom,
            AtomProvider,
            useSelector
        };
    }, []);
};
