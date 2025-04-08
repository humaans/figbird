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
import { useReducer, useEffect, useCallback, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useFigbird } from './core';
import { useRealtime } from './useRealtime';
import { useCache } from './cache';
import { fetch } from './fetch';
import { hashObject } from './helpers';
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
function reducer(state, action) {
    switch(action.type){
        case 'success':
            return _object_spread_props(_object_spread({}, state), {
                status: 'success',
                dirty: false
            });
        case 'error':
            return _object_spread_props(_object_spread({}, state), {
                status: 'error',
                error: action.error,
                dirty: false
            });
        case 'reset':
            var _action_dirty;
            return _object_spread_props(_object_spread({}, state), {
                status: 'pending',
                error: null,
                dirty: (_action_dirty = action.dirty) !== null && _action_dirty !== void 0 ? _action_dirty : state.dirty || state.status === 'pending'
            });
    }
}
/**
 * A generic abstraction of both get and find
 */ export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
    const { config, feathers } = useFigbird();
    let { skip, allPages, parallel, parallelLimit, realtime = 'merge', fetchPolicy = 'swr', matcher } = options, params = _object_without_properties(options, [
        "skip",
        "allPages",
        "parallel",
        "parallelLimit",
        "realtime",
        "fetchPolicy",
        "matcher"
    ]);
    const { method, id, selectData, transformResponse } = queryHookOptions;
    if (!realtimeModes.includes(realtime)) {
        throw new Error(`Bad realtime option, must be one of ${[
            realtimeModes
        ].join(', ')}`);
    }
    if (!fetchPolicies.includes(fetchPolicy)) {
        throw new Error(`Bad fetchPolicy option, must be one of ${[
            fetchPolicies
        ].join(', ')}`);
    }
    if (config.defaultPageSizeWhenFetchingAll && allPages && (!params.query || !params.query.$limit)) {
        params = _object_spread({}, params);
        params.query = _object_spread({}, params.query);
        params.query.$limit = config.defaultPageSizeWhenFetchingAll;
    } else if (config.defaultPageSize && (!params.query || !params.query.$limit)) {
        params = _object_spread({}, params);
        params.query = _object_spread({}, params.query);
        params.query.$limit = config.defaultPageSize;
    }
    const queryId = useQueryHash({
        serviceName,
        method,
        id,
        params,
        allPages,
        realtime
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    params = useMemo(()=>params, [
        queryId
    ]);
    const [cachedResult, updateCache] = useCache({
        queryId,
        serviceName,
        method,
        params,
        realtime,
        selectData,
        matcher
    });
    const isCacheSufficient = fetchPolicy === 'cache-first' && !!cachedResult;
    const [state, dispatch] = useReducer(reducer, {
        status: isCacheSufficient ? 'success' : 'pending',
        dirty: false,
        error: null
    });
    const isPending = state.status === 'pending';
    const initialisedRef = useRef(false);
    const requestRef = useRef(0);
    useEffect(()=>{
        if (skip) return;
        if (!isPending) return;
        if (isCacheSufficient) return;
        // increment the request ref so we can ignore old requests
        const reqRef = requestRef.current = requestRef.current + 1;
        fetch(feathers, serviceName, method, id, params, {
            queryId,
            allPages,
            parallel,
            parallelLimit,
            transformResponse
        }).then((res)=>{
            if (state.dirty) {
                dispatch({
                    type: 'reset',
                    dirty: false
                });
            } else if (reqRef === requestRef.current) {
                flushSync(()=>{
                    updateCache(res);
                    dispatch({
                        type: 'success'
                    });
                });
            }
        }).catch((error)=>{
            if (state.dirty) {
                dispatch({
                    type: 'reset',
                    dirty: false
                });
            }
            if (reqRef === requestRef.current) {
                dispatch({
                    type: 'error',
                    error
                });
            }
        }).finally(()=>{
            initialisedRef.current = true;
        });
    }, [
        feathers,
        queryId,
        serviceName,
        method,
        id,
        params,
        transformResponse,
        skip,
        allPages,
        parallel,
        parallelLimit,
        updateCache,
        isPending,
        isCacheSufficient,
        state.dirty
    ]);
    const refetch = useCallback(()=>dispatch({
            type: 'reset'
        }), [
        dispatch
    ]);
    // refetch if the query changes
    useEffect(()=>{
        if (!isCacheSufficient && initialisedRef.current) {
            refetch();
        }
    }, [
        refetch,
        queryId,
        isCacheSufficient
    ]);
    // realtime hook subscribes to realtime updates to this service
    useRealtime(serviceName, realtime, refetch);
    let status;
    let isFetching;
    let result = useMemo(()=>({
            data: null
        }), []);
    const error = state.error;
    if (skip) {
        status = 'success';
        isFetching = false;
    } else if (state.status === 'error') {
        status = 'error';
        isFetching = false;
    } else if (fetchPolicy === 'swr') {
        status = cachedResult ? 'success' : 'loading';
        isFetching = isPending || status === 'loading';
        result = cachedResult || result;
    } else if (fetchPolicy === 'cache-first') {
        status = cachedResult ? 'success' : 'loading';
        isFetching = isPending || status === 'loading';
        result = cachedResult || result;
    } else if (fetchPolicy === 'network-only') {
        status = isPending || !cachedResult ? 'loading' : 'success';
        isFetching = isPending || status === 'loading';
        result = isFetching ? result : cachedResult;
    }
    return useMemo(()=>_object_spread_props(_object_spread({}, result), {
            status,
            refetch,
            isFetching,
            error
        }), [
        result,
        status,
        error,
        refetch,
        isFetching
    ]);
}
function useQueryHash({ serviceName, method, id, params, allPages, realtime }) {
    return useMemo(()=>{
        const hash = hashObject({
            serviceName,
            method,
            id,
            params,
            allPages,
            realtime
        });
        return `${method}:${hash}`;
    }, [
        serviceName,
        method,
        id,
        params,
        allPages,
        realtime
    ]);
}
