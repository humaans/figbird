"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "useCacheInstance", {
    enumerable: true,
    get: function() {
        return useCacheInstance;
    }
});
var _react = require("react");
var _tinyatom = require("tiny-atom");
var _namespace = require("./namespace");
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
var initialState = function() {
    return _define_property({}, _namespace.namespace, {
        entities: {},
        queries: {},
        refs: {},
        index: {}
    });
};
var actions = function(param) {
    var idField = param.idField, updatedAtField = param.updatedAtField;
    return {
        feathersFetched: fetched(idField, updatedAtField),
        feathersCreated: created(idField, updatedAtField),
        feathersUpdated: updated(idField, updatedAtField),
        feathersPatched: updated(idField, updatedAtField),
        feathersRemoved: removed(idField, updatedAtField),
        feathersUpdateQueries: updateQuery(idField, updatedAtField)
    };
};
function fetched(idField, updatedAtField) {
    return function(param, param1) {
        var get = param.get, set = param.set, actions = param.actions, serviceName = param1.serviceName, data = param1.data, method = param1.method, params = param1.params, queryId = param1.queryId, realtime = param1.realtime, matcher = param1.matcher;
        var curr = (0, _helpers.getIn)(get(), [
            _namespace.namespace
        ]);
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
        var l = items.length;
        var msg = "".concat(serviceName, " ").concat(l, " item").concat(l === 1 ? "" : "s");
        set(_define_property({}, _namespace.namespace, next), msg);
    };
}
function created(idField, updatedAtField) {
    return function(param, param1) {
        var get = param.get, set = param.set, actions = param.actions, serviceName = param1.serviceName, item = param1.item;
        actions.feathersUpdateQueries({
            serviceName: serviceName,
            method: "create",
            item: item
        });
    };
}
// applies to both update and patch
function updated(idField, updatedAtField) {
    return function(param, param1) {
        var get = param.get, set = param.set, actions = param.actions, serviceName = param1.serviceName, item = param1.item;
        var itemId = idField(item);
        var curr = (0, _helpers.getIn)(get(), [
            _namespace.namespace
        ]);
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
                return;
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
        var msg = "".concat(serviceName, " ").concat(itemId, " updated");
        set(_define_property({}, _namespace.namespace, next), msg);
        actions.feathersUpdateQueries({
            serviceName: serviceName,
            method: "update",
            item: item
        });
    };
}
function removed(idField) {
    return function(param, param1) {
        var get = param.get, set = param.set, actions = param.actions, serviceName = param1.serviceName, itemOrItems = param1.item;
        var items = Array.isArray(itemOrItems) ? itemOrItems : [
            itemOrItems
        ];
        var curr = (0, _helpers.getIn)(get(), [
            _namespace.namespace
        ]);
        var exists = items.some(function(item) {
            return (0, _helpers.getIn)(curr, [
                "entities",
                serviceName,
                idField(item)
            ]);
        });
        if (!exists) return;
        // remove this item from all the queries that reference it
        actions.feathersUpdateQueries({
            serviceName: serviceName,
            method: "remove",
            item: itemOrItems
        });
        // updating queries updates state, get a fresh copy
        curr = (0, _helpers.getIn)(get(), [
            _namespace.namespace
        ]);
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
        var msg = "removed ".concat(serviceName, " ").concat(removedIds.join(","));
        set(_define_property({}, _namespace.namespace, next), msg);
    };
}
function updateQuery(idField, updatedAtField) {
    return function feathersUpdateQueries(param, param1) {
        var get = param.get, set = param.set, serviceName = param1.serviceName, method = param1.method, item = param1.item;
        var items = Array.isArray(item) ? item : [
            item
        ];
        var _iteratorNormalCompletion = true, _didIteratorError = false, _iteratorError = undefined;
        try {
            var _loop = function() {
                var item = _step.value;
                var itemId = idField(item);
                var curr = (0, _helpers.getIn)(get(), [
                    _namespace.namespace
                ]);
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
                    var next = curr;
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
                    var msg = "updated ".concat(updateCount, " ").concat(updateCount === 1 ? "query" : "queries");
                    set(_define_property({}, _namespace.namespace, next), msg);
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
    };
}
var useCacheInstance = function(atom, config) {
    return (0, _react.useMemo)(function() {
        atom = atom || (0, _tinyatom.createAtom)();
        // Create an atom context and a set of hooks separate from the
        // main context used in tiny-atom. This way our store and actions
        // and everything do not interfere with the main atom. Use this
        // secondary context even if we use an existing atom – there is no
        // issue with that.
        var _createAtomContext = (0, _tinyatom.createContext)(), AtomContext = _createAtomContext.AtomContext, AtomProvider = _createAtomContext.Provider;
        var useSelector = (0, _tinyatom.createHooks)(AtomContext).useSelector;
        // configure atom with initial state and figbird actions
        atom.fuse({
            state: initialState(),
            actions: actions(config)
        });
        return {
            atom: atom,
            AtomProvider: AtomProvider,
            useSelector: useSelector
        };
    }, []);
};
