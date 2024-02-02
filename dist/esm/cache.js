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
import { useCallback } from 'react';
import { createContext } from 'kinfolk';
import { useFigbird } from './core';
import { getIn, setIn, unsetIn, matcher as defaultMatcher, forEachObj } from './helpers';
export const { Provider, atom, selector, useSelector, useReducer } = createContext();
export const cache = atom({
    entities: {},
    queries: {},
    refs: {},
    index: {},
    lookups: {
        serviceNamesByQueryId: {}
    }
}, {
    label: 'figbird'
});
const reducers = {
    fetched,
    created,
    updated,
    patched,
    removed
};
export function useDispatch() {
    const { config } = useFigbird();
    const { idField, updatedAtField } = config;
    const reducer = useCallback((state, payload)=>reducers[payload.event](state, payload, {
            idField,
            updatedAtField
        }), [
        idField,
        updatedAtField
    ]);
    return useReducer(cache, reducer);
}
const dataSelector = selector((queryId)=>{
    const { queries, entities, lookups } = cache();
    const serviceName = getIn(lookups, [
        'serviceNamesByQueryId',
        queryId
    ]);
    const query = getIn(queries, [
        serviceName,
        queryId
    ]);
    if (query) {
        const items = query.entities || entities[serviceName];
        return query.selectData(query.data.map((id)=>items[id]));
    } else {
        return null;
    }
}, {
    label: 'figbird:data',
    persist: false
});
const metaSelector = selector((queryId)=>{
    const { queries, lookups } = cache();
    const serviceName = getIn(lookups, [
        'serviceNamesByQueryId',
        queryId
    ]);
    const query = getIn(queries, [
        serviceName,
        queryId
    ]);
    if (query) {
        return query.meta;
    } else {
        return null;
    }
}, {
    label: 'figbird:meta',
    persist: false
});
export const querySelector = selector((queryId)=>{
    const data = dataSelector(queryId);
    const meta = metaSelector(queryId);
    return data ? _object_spread_props(_object_spread({}, meta), {
        data
    }) : null;
}, {
    label: 'figbird:query',
    persist: false
});
export function useCache(resourceDescriptor) {
    const { queryId, serviceName, method, params, realtime, selectData, matcher } = resourceDescriptor;
    const dispatch = useDispatch();
    const cachedResult = useSelector(()=>querySelector(queryId), [
        queryId
    ], {
        label: 'figbird:cache'
    });
    const updateCache = useCallback((data)=>dispatch({
            event: 'fetched',
            queryId,
            serviceName,
            method,
            params,
            realtime,
            selectData,
            matcher,
            data
        }), [
        dispatch,
        queryId,
        serviceName,
        method,
        params,
        realtime,
        selectData,
        matcher
    ]);
    return [
        cachedResult,
        updateCache
    ];
}
function fetched(curr, { serviceName, data, method, params, queryId, realtime, matcher, selectData }, { idField }) {
    // we already inserted this response to cache
    const prevData = getIn(curr, [
        'queries',
        serviceName,
        queryId,
        'res'
    ]);
    if (prevData === data) {
        return curr;
    }
    let next = curr;
    const { data: items } = data, meta = _object_without_properties(data, [
        "data"
    ]);
    const entities = realtime === 'merge' ? _object_spread({}, getIn(next, [
        'entities',
        serviceName
    ])) : {};
    const index = realtime === 'merge' ? _object_spread({}, getIn(next, [
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
        matcher,
        selectData,
        res: data
    }, realtime === 'merge' ? {} : {
        entities
    }));
    // update queryId index
    if (getIn(next, [
        'lookups',
        'serviceNamesByQueryId',
        queryId
    ]) !== serviceName) {
        next = setIn(next, [
            'lookups',
            'serviceNamesByQueryId',
            queryId
        ], serviceName);
    }
    return next;
}
function created(state, { serviceName, item }, config) {
    return updateQueries(state, {
        serviceName,
        method: 'create',
        item
    }, config);
}
function updated(curr, { serviceName, item }, { idField, updatedAtField }) {
    const itemId = idField(item);
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
            return curr;
        }
    }
    let next = curr;
    if (currItem) {
        next = setIn(next, [
            'entities',
            serviceName,
            itemId
        ], item);
    } else {
        const index = {
            queries: {},
            size: 0
        };
        next = setIn(next, [
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
    return updateQueries(next, {
        serviceName,
        method: 'update',
        item
    }, {
        idField,
        updatedAtField
    });
}
function patched(state, payload, config) {
    return updated(state, payload, config);
}
function removed(curr, { serviceName, item: itemOrItems }, { idField, updatedAtField }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [
        itemOrItems
    ];
    const exists = items.some((item)=>getIn(curr, [
            'entities',
            serviceName,
            idField(item)
        ]));
    if (!exists) return curr;
    // updating queries updates state, get a fresh copy
    let next = curr;
    next = updateQueries(next, {
        serviceName,
        method: 'remove',
        item: itemOrItems
    }, {
        idField,
        updatedAtField
    });
    // now remove it from entities
    const serviceEntities = _object_spread({}, getIn(next, [
        'entities',
        serviceName
    ]));
    const removedIds = [];
    for (const item of items){
        delete serviceEntities[idField(item)];
        next = setIn(next, [
            'entities',
            serviceName
        ], serviceEntities);
        removedIds.push(idField(item));
    }
    return next;
}
function updateQueries(curr, { serviceName, method, item: itemOrItems }, { idField, updatedAtField }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [
        itemOrItems
    ];
    let next = curr;
    for (const item of items){
        const itemId = idField(item);
        const queries = _object_spread({}, getIn(next, [
            'queries',
            serviceName
        ]));
        const index = _object_spread({}, getIn(next, [
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
        }
    }
    return next;
}
