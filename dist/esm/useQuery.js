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
import { useReducer, useEffect, useRef, useCallback, useMemo } from 'react';
import { useFigbird } from './core';
import { useRealtime } from './useRealtime';
import { useCache } from './useCache';
import { hashObject, inflight } from './helpers';
const get = inflight((service, id, params, options)=>`${service.path}/${options.queryId}`, getter);
const find = inflight((service, params, options)=>`${service.path}/${options.queryId}`, finder);
const fetchPolicies = [
    'swr',
    'cache-first',
    'network-only'
];
const realtimeModes = [
    'merge',
    'refetch',
    'disabled'
];
/**
 * A generic abstraction of both get and find
 */ export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
    const { method , id , selectData , transformResponse  } = queryHookOptions;
    const { feathers  } = useFigbird();
    const disposed = useRef(false);
    const isInitialMount = useRef(true);
    let { skip , allPages , parallel , realtime ='merge' , fetchPolicy ='swr' , matcher  } = options, params = _object_without_properties(options, [
        "skip",
        "allPages",
        "parallel",
        "realtime",
        "fetchPolicy",
        "matcher"
    ]);
    realtime = realtime || 'disabled';
    if (realtime !== 'disabled' && realtime !== 'merge' && realtime !== 'refetch') {
        throw new Error(`Bad realtime option, must be one of ${[
            realtimeModes
        ].join(', ')}`);
    }
    if (!fetchPolicies.includes(fetchPolicy)) {
        throw new Error(`Bad fetchPolicy option, must be one of ${[
            fetchPolicies
        ].join(', ')}`);
    }
    const queryId = `${method.substr(0, 1)}:${hashObject({
        serviceName,
        method,
        id,
        params,
        realtime
    })}`;
    let [cachedData, updateCache] = useCache({
        serviceName,
        queryId,
        method,
        id,
        params,
        realtime,
        selectData,
        transformResponse,
        matcher
    });
    let hasCachedData = !!cachedData.data;
    const fetched = fetchPolicy === 'cache-first' && hasCachedData;
    const [state, dispatch] = useReducer(reducer, {
        reloading: false,
        fetched,
        fetchedCount: 0,
        refetchSeq: 0,
        error: null
    });
    if (fetchPolicy === 'network-only' && state.fetchedCount === 0) {
        cachedData = {
            data: null
        };
        hasCachedData = false;
    }
    const handleRealtimeEvent = useCallback((payload)=>{
        if (disposed.current) return;
        if (realtime !== 'refetch') return;
        dispatch({
            type: 'refetch'
        });
    }, [
        dispatch,
        realtime,
        disposed
    ]);
    useEffect(()=>{
        return ()=>{
            disposed.current = true;
        };
    }, []);
    useEffect(()=>{
        let disposed = false;
        if (state.fetched) return;
        if (skip) return;
        dispatch({
            type: 'fetching'
        });
        const service = feathers.service(serviceName);
        const result = method === 'get' ? get(service, id, params, {
            queryId
        }) : find(service, params, {
            queryId,
            allPages,
            parallel
        });
        result.then((res)=>{
            // no res means we've piggy backed on an in flight request
            if (res) {
                updateCache(res);
            }
            if (!disposed) {
                dispatch({
                    type: 'success'
                });
            }
        }).catch((err)=>{
            if (!disposed) {
                dispatch({
                    type: 'error',
                    payload: err
                });
            }
        });
        return ()=>{
            disposed = true;
        };
    }, [
        serviceName,
        queryId,
        state.fetched,
        state.refetchSeq,
        skip,
        allPages,
        parallel
    ]);
    // If serviceName or queryId changed, we should refetch the data
    useEffect(()=>{
        if (!isInitialMount.current) {
            dispatch({
                type: 'reset'
            });
        }
    }, [
        serviceName,
        queryId
    ]);
    // realtime hook will make sure we're listening to all of the
    // updates to this service
    useRealtime(serviceName, realtime, handleRealtimeEvent);
    useEffect(()=>{
        if (isInitialMount.current) {
            isInitialMount.current = false;
        }
    }, []);
    // derive the loading/reloading state from other substates
    const loading = !skip && !hasCachedData && !state.error;
    const reloading = loading || state.reloading;
    const refetch = useCallback(()=>dispatch({
            type: 'refetch'
        }), [
        dispatch
    ]);
    return useMemo(()=>_object_spread_props(_object_spread({}, skip ? {
            data: null
        } : cachedData), {
            status: loading ? 'loading' : state.error ? 'error' : 'success',
            refetch,
            isFetching: reloading,
            error: state.error,
            loading,
            reloading
        }), [
        skip,
        cachedData.data,
        loading,
        state.error,
        refetch,
        reloading,
        state.error,
        loading,
        reloading
    ]);
}
function reducer(state, action) {
    switch(action.type){
        case 'fetching':
            return _object_spread_props(_object_spread({}, state), {
                reloading: true,
                error: null
            });
        case 'success':
            return _object_spread_props(_object_spread({}, state), {
                fetched: true,
                fetchedCount: state.fetchedCount + 1,
                reloading: false
            });
        case 'error':
            return _object_spread_props(_object_spread({}, state), {
                reloading: false,
                fetched: true,
                fetchedCount: state.fetchedCount + 1,
                error: action.payload
            });
        case 'refetch':
            return _object_spread_props(_object_spread({}, state), {
                fetched: false,
                refetchSeq: state.refetchSeq + 1
            });
        case 'reset':
            if (state.fetched) {
                return _object_spread_props(_object_spread({}, state), {
                    fetched: false,
                    fetchedCount: 0
                });
            } else {
                return state;
            }
    }
}
function getter(service, id, params) {
    return service.get(id, params);
}
function finder(service, params, { queryId , allPages , parallel  }) {
    if (!allPages) {
        return service.find(params);
    }
    return new Promise((resolve, reject)=>{
        let skip = 0;
        const result = {
            data: [],
            skip: 0
        };
        fetchNext();
        function doFind(skip) {
            return service.find(_object_spread_props(_object_spread({}, params), {
                query: _object_spread_props(_object_spread({}, params.query || {}), {
                    $skip: skip
                })
            }));
        }
        function resolveOrFetchNext(res) {
            if (res.data.length === 0 || result.data.length >= result.total) {
                resolve(result);
            } else {
                skip = result.data.length;
                fetchNext();
            }
        }
        function fetchNextParallel() {
            const requiredFetches = Math.ceil((result.total - result.data.length) / result.limit);
            if (requiredFetches > 0) {
                Promise.all(new Array(requiredFetches).fill().map((_, idx)=>doFind(skip + idx * result.limit))).then((results)=>{
                    const [lastResult] = results.slice(-1);
                    result.limit = lastResult.limit;
                    result.total = lastResult.total;
                    result.data = result.data.concat(results.flatMap((r)=>r.data));
                    resolveOrFetchNext(lastResult);
                }).catch(reject);
            } else {
                resolve(result);
            }
        }
        function fetchNext() {
            if (typeof result.total !== 'undefined' && typeof result.limit !== 'undefined' && parallel === true) {
                fetchNextParallel();
            } else {
                doFind(skip).then((res)=>{
                    result.limit = res.limit;
                    result.total = res.total;
                    result.data = result.data.concat(res.data);
                    resolveOrFetchNext(res);
                }).catch(reject);
            }
        }
    });
}
