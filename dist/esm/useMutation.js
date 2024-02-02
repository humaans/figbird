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
import { useReducer, useMemo, useCallback, useEffect, useRef } from 'react';
import { useFigbird } from './core';
import { useDispatch } from './cache';
/**
 * Simple mutation hook exposing crud methods
 * of any feathers service. The resulting state
 * of calling these operations needs to be handled
 * by the caller. as you create/update/patch/remove
 * entities using this helper, the entities cache gets updated
 *
 * e.g.
 *
 * const { create, patch, remove, status, data, error } = useMutation('notes')
 */ export function useMutation(serviceName) {
    const { feathers, config } = useFigbird();
    const cacheDispatch = useDispatch();
    const { debug } = config;
    const [state, dispatch] = useReducer(mutationReducer, {
        status: 'idle',
        data: null,
        error: null
    });
    const mountedRef = useRef();
    useEffect(()=>{
        mountedRef.current = true;
        return ()=>{
            mountedRef.current = false;
        };
    }, []);
    const mutate = useCallback((method, event, ...args)=>{
        const service = feathers.service(serviceName);
        dispatch({
            type: 'mutating'
        });
        log({
            serviceName,
            method,
            debug
        }, 'mutating', ...args);
        return service[method](...args).then((item)=>{
            const isMounted = mountedRef.current;
            cacheDispatch({
                event,
                serviceName,
                item
            });
            isMounted && dispatch({
                type: 'success',
                payload: item
            });
            return item;
        }).catch((err)=>{
            const isMounted = mountedRef.current;
            isMounted && dispatch({
                type: 'error',
                payload: err
            });
            throw err;
        });
    }, [
        feathers,
        serviceName,
        dispatch,
        cacheDispatch,
        mountedRef,
        debug
    ]);
    const create = useCallback((...args)=>mutate('create', 'created', ...args), [
        mutate
    ]);
    const update = useCallback((...args)=>mutate('update', 'updated', ...args), [
        mutate
    ]);
    const patch = useCallback((...args)=>mutate('patch', 'patched', ...args), [
        mutate
    ]);
    const remove = useCallback((...args)=>mutate('remove', 'removed', ...args), [
        mutate
    ]);
    return useMemo(()=>({
            create,
            update,
            patch,
            remove,
            data: state.data,
            status: state.status,
            error: state.error
        }), [
        create,
        update,
        patch,
        remove,
        state
    ]);
}
function mutationReducer(state, action) {
    switch(action.type){
        case 'mutating':
            return _object_spread_props(_object_spread({}, state), {
                status: 'loading',
                data: null,
                error: null
            });
        case 'success':
            return _object_spread_props(_object_spread({}, state), {
                status: 'success',
                data: action.payload
            });
        case 'error':
            return _object_spread_props(_object_spread({}, state), {
                status: 'error',
                error: action.payload
            });
    }
}
function log({ serviceName, method, debug }, ...ctx) {
    if (debug) {
        console.log(`✨ Mutating ${serviceName}#${method}`, ...ctx);
    }
}
