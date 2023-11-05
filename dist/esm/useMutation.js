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
    const { feathers, actions } = useFigbird();
    const [state, dispatch] = useReducer(reducer, {
        status: 'idle',
        data: null,
        error: null,
        loading: false
    });
    const mountedRef = useRef();
    useEffect(()=>{
        mountedRef.current = true;
        return ()=>{
            mountedRef.current = false;
        };
    }, []);
    const common = [
        serviceName,
        dispatch,
        feathers,
        mountedRef
    ];
    const create = useMethod('create', actions.feathersCreated, ...common);
    const update = useMethod('update', actions.feathersUpdated, ...common);
    const patch = useMethod('patch', actions.feathersPatched, ...common);
    const remove = useMethod('remove', actions.feathersRemoved, ...common);
    const mutation = useMemo(()=>({
            create,
            update,
            patch,
            remove,
            data: state.data,
            status: state.status,
            error: state.error,
            loading: state.loading
        }), [
        create,
        update,
        patch,
        remove,
        state
    ]);
    return mutation;
}
function reducer(state, action) {
    switch(action.type){
        case 'mutating':
            return _object_spread_props(_object_spread({}, state), {
                status: 'loading',
                loading: true,
                data: null,
                error: null
            });
        case 'success':
            return _object_spread_props(_object_spread({}, state), {
                status: 'success',
                loading: false,
                data: action.payload
            });
        case 'error':
            return _object_spread_props(_object_spread({}, state), {
                status: 'error',
                loading: false,
                error: action.payload
            });
    }
}
function useMethod(method, action, serviceName, dispatch, feathers, mountedRef) {
    return useCallback((...args)=>{
        const service = feathers.service(serviceName);
        dispatch({
            type: 'mutating'
        });
        return service[method](...args).then((item)=>{
            const isMounted = mountedRef.current;
            action({
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
    }, // eslint-disable-next-line react-hooks/exhaustive-deps
    [
        serviceName,
        method,
        action,
        dispatch
    ]);
}
