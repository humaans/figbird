"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    Provider: function() {
        return Provider;
    },
    atom: function() {
        return atom;
    },
    cache: function() {
        return cache;
    },
    selector: function() {
        return selector;
    },
    useCache: function() {
        return useCache;
    },
    useDispatch: function() {
        return useDispatch;
    },
    useReducer: function() {
        return useReducer;
    },
    useSelector: function() {
        return useSelector;
    }
});
var _react = require("react");
var _kinfolk = require("kinfolk");
var _core = require("./core");
var _helpers = require("./helpers");
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
var _createContext = (0, _kinfolk.createContext)();
var Provider = _createContext.Provider, atom = _createContext.atom, selector = _createContext.selector, useSelector = _createContext.useSelector, useReducer = _createContext.useReducer;
var cache = atom({
    entities: {},
    queries: {},
    refs: {},
    index: {}
}, {
    label: "figbird"
});
var reducers = {
    fetched: fetched,
    created: created,
    updated: updated,
    patched: patched,
    removed: removed
};
function useDispatch() {
    var config = (0, _core.useFigbird)().config;
    var idField = config.idField, updatedAtField = config.updatedAtField;
    var reducer = (0, _react.useCallback)(function(state, payload) {
        return reducers[payload.event](state, payload, {
            idField: idField,
            updatedAtField: updatedAtField
        });
    }, [
        idField,
        updatedAtField
    ]);
    return useReducer(cache, reducer);
}
function useCache(resourceDescriptor) {
    var serviceName = resourceDescriptor.serviceName, queryId = resourceDescriptor.queryId, method = resourceDescriptor.method, id = resourceDescriptor.id, params = resourceDescriptor.params, realtime = resourceDescriptor.realtime, selectData = resourceDescriptor.selectData, transformResponse = resourceDescriptor.transformResponse, matcher = resourceDescriptor.matcher;
    var dispatch = useDispatch();
    var cachedData = useSelector(function() {
        var query = (0, _helpers.getIn)(cache(), [
            "queries",
            serviceName,
            queryId
        ]);
        if (query) {
            var data = query.data;
            var entities = query.entities || (0, _helpers.getIn)(cache(), [
                "entities",
                serviceName
            ]);
            return selectData(data.map(function(id) {
                return entities[id];
            }));
        } else {
            return null;
        }
    }, [
        serviceName,
        queryId,
        selectData
    ]);
    var cachedResult = useSelector(function() {
        var query = (0, _helpers.getIn)(cache(), [
            "queries",
            serviceName,
            queryId
        ]);
        if (query) {
            var meta = query.meta;
            return _object_spread_props(_object_spread({}, meta), {
                data: cachedData
            });
        } else {
            return {
                data: null
            };
        }
    }, [
        serviceName,
        queryId,
        cachedData
    ]);
    var updateCache = (0, _react.useCallback)(function(data) {
        return dispatch({
            event: "fetched",
            serviceName: serviceName,
            queryId: queryId,
            method: method,
            params: params,
            data: _object_spread({}, transformResponse(data), id ? {
                id: id
            } : {}),
            realtime: realtime,
            matcher: matcher
        });
    }, // eslint-disable-next-line react-hooks/exhaustive-deps
    [
        dispatch,
        serviceName,
        queryId,
        method,
        realtime,
        matcher
    ]);
    return [
        cachedResult,
        updateCache
    ];
}
function fetched(curr, param, param1) {
    var serviceName = param.serviceName, data = param.data, method = param.method, params = param.params, queryId = param.queryId, realtime = param.realtime, matcher = param.matcher, idField = param1.idField;
    var next = curr;
    var items = data.data, meta = _object_without_properties(data, [
        "data"
    ]);
    var entities = realtime === "merge" ? _object_spread({}, (0, _helpers.getIn)(curr, [
        "entities",
        serviceName
    ])) : {};
    var index = realtime === "merge" ? _object_spread({}, (0, _helpers.getIn)(curr, [
        "index",
        serviceName
    ])) : {};
    var _iteratorNormalCompletion = true, _didIteratorError = false, _iteratorError = undefined;
    try {
        for(var _iterator = items[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true){
            var item = _step.value;
            var itemId = idField(item);
            entities[itemId] = item;
            if (realtime === "merge") {
                var itemIndex = _object_spread({}, index[itemId]);
                itemIndex.queries = _object_spread_props(_object_spread({}, itemIndex.queries), _define_property({}, queryId, true));
                itemIndex.size = itemIndex.size ? itemIndex.size + 1 : 1;
                index[itemId] = itemIndex;
            }
        }
    } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
    } finally{
        try {
            if (!_iteratorNormalCompletion && _iterator.return != null) {
                _iterator.return();
            }
        } finally{
            if (_didIteratorError) {
                throw _iteratorError;
            }
        }
    }
    if (realtime === "merge") {
        // update entities
        next = (0, _helpers.setIn)(next, [
            "entities",
            serviceName
        ], entities);
        next = (0, _helpers.setIn)(next, [
            "index",
            serviceName
        ], index);
    }
    // update queries
    next = (0, _helpers.setIn)(next, [
        "queries",
        serviceName,
        queryId
    ], _object_spread({
        params: params,
        data: items.map(function(x) {
            return idField(x);
        }),
        meta: meta,
        method: method,
        realtime: realtime,
        matcher: matcher
    }, realtime === "merge" ? {} : {
        entities: entities
    }));
    return next;
}
function created(state, param, config) {
    var serviceName = param.serviceName, item = param.item;
    return updateQueries(state, {
        serviceName: serviceName,
        method: "create",
        item: item
    }, config);
}
function updated(curr, param, param1) {
    var serviceName = param.serviceName, item = param.item, idField = param1.idField, updatedAtField = param1.updatedAtField;
    var itemId = idField(item);
    var currItem = (0, _helpers.getIn)(curr, [
        "entities",
        serviceName,
        itemId
    ]);
    // check to see if we should discard this update
    if (currItem) {
        var currUpdatedAt = updatedAtField(currItem);
        var nextUpdatedAt = updatedAtField(item);
        if (nextUpdatedAt && nextUpdatedAt < currUpdatedAt) {
            return curr;
        }
    }
    var next;
    if (currItem) {
        next = (0, _helpers.setIn)(curr, [
            "entities",
            serviceName,
            itemId
        ], item);
    } else {
        var index = {
            queries: {},
            size: 0
        };
        next = (0, _helpers.setIn)(curr, [
            "entities",
            serviceName,
            itemId
        ], item);
        next = (0, _helpers.setIn)(next, [
            "index",
            serviceName,
            itemId
        ], index);
    }
    return updateQueries(next, {
        serviceName: serviceName,
        method: "update",
        item: item
    }, {
        idField: idField,
        updatedAtField: updatedAtField
    });
}
function patched(state, payload, config) {
    return updated(state, payload, config);
}
function removed(curr, param, param1) {
    var serviceName = param.serviceName, itemOrItems = param.item, idField = param1.idField, updatedAtField = param1.updatedAtField;
    var items = Array.isArray(itemOrItems) ? itemOrItems : [
        itemOrItems
    ];
    var exists = items.some(function(item) {
        return (0, _helpers.getIn)(curr, [
            "entities",
            serviceName,
            idField(item)
        ]);
    });
    if (!exists) return curr;
    // updating queries updates state, get a fresh copy
    curr = updateQueries(curr, {
        serviceName: serviceName,
        method: "remove",
        item: itemOrItems
    }, {
        idField: idField,
        updatedAtField: updatedAtField
    });
    // now remove it from entities
    var serviceEntities = _object_spread({}, (0, _helpers.getIn)(curr, [
        "entities",
        serviceName
    ]));
    var next = curr;
    var removedIds = [];
    var _iteratorNormalCompletion = true, _didIteratorError = false, _iteratorError = undefined;
    try {
        for(var _iterator = items[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true){
            var item = _step.value;
            delete serviceEntities[idField(item)];
            next = (0, _helpers.setIn)(next, [
                "entities",
                serviceName
            ], serviceEntities);
            removedIds.push(idField(item));
        }
    } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
    } finally{
        try {
            if (!_iteratorNormalCompletion && _iterator.return != null) {
                _iterator.return();
            }
        } finally{
            if (_didIteratorError) {
                throw _iteratorError;
            }
        }
    }
    return next;
}
function updateQueries(curr, param, param1) {
    var serviceName = param.serviceName, method = param.method, item = param.item, idField = param1.idField, updatedAtField = param1.updatedAtField;
    var items = Array.isArray(item) ? item : [
        item
    ];
    var next = curr;
    var _iteratorNormalCompletion = true, _didIteratorError = false, _iteratorError = undefined;
    try {
        var _loop = function() {
            var item = _step.value;
            var itemId = idField(item);
            var queries = _object_spread({}, (0, _helpers.getIn)(curr, [
                "queries",
                serviceName
            ]));
            var index = _object_spread({}, (0, _helpers.getIn)(curr, [
                "index",
                serviceName,
                itemId
            ]));
            index.queries = _object_spread({}, index.queries);
            index.size = index.size || 0;
            var updateCount = 0;
            (0, _helpers.forEachObj)(queries, function(query, queryId) {
                var matches;
                // do not update non realtime queries
                // those get updated/refetched in a different way
                if (query.realtime !== "merge") {
                    return;
                }
                if (method === "remove") {
                    // optimisation, if method is remove, we want to immediately remove the object
                    // from cache, which means we don't need to match using matcher
                    matches = false;
                } else if (!query.params.query || Object.keys(query.params.query).length === 0) {
                    // another optimisation, if there is no query, the object matches
                    matches = true;
                } else {
                    var matcher = query.matcher ? query.matcher(_helpers.matcher) : _helpers.matcher;
                    matches = matcher(query.params.query)(item);
                }
                if (index.queries[queryId]) {
                    if (!matches) {
                        updateCount++;
                        queries[queryId] = _object_spread_props(_object_spread({}, query), {
                            meta: _object_spread_props(_object_spread({}, query.meta), {
                                total: query.meta.total - 1
                            }),
                            data: query.data.filter(function(id) {
                                return id !== itemId;
                            })
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
                next = (0, _helpers.setIn)(next, [
                    "queries",
                    serviceName
                ], queries);
                next = (0, _helpers.setIn)(next, [
                    "index",
                    serviceName,
                    itemId
                ], index);
                // in case of create, only ever add it to the cache if it's relevant for any of the
                // queries, otherwise, we might end up piling in newly created objects into cache
                // even if the app never uses them
                if (!(0, _helpers.getIn)(next, [
                    "entities",
                    serviceName,
                    itemId
                ])) {
                    next = (0, _helpers.setIn)(next, [
                        "entities",
                        serviceName,
                        itemId
                    ], item);
                }
                // this item is no longer relevant to any query, garbage collect it
                if (index.size === 0) {
                    next = (0, _helpers.unsetIn)(next, [
                        "entities",
                        serviceName,
                        itemId
                    ]);
                    next = (0, _helpers.unsetIn)(next, [
                        "index",
                        serviceName,
                        itemId
                    ]);
                }
            }
        };
        for(var _iterator = items[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true)_loop();
    } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
    } finally{
        try {
            if (!_iteratorNormalCompletion && _iterator.return != null) {
                _iterator.return();
            }
        } finally{
            if (_didIteratorError) {
                throw _iteratorError;
            }
        }
    }
    return next;
}
