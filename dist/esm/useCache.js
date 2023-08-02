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
import { useRef } from 'react';
import { useFigbird } from './core';
import { namespace } from './namespace';
import { getIn } from './helpers';
export function useCache(resourceDescriptor) {
    const { serviceName, queryId, method, id, params, realtime, selectData, transformResponse, matcher } = resourceDescriptor;
    const { actions, useSelector } = useFigbird();
    // we'll use a cheeky ref to store the previous mapped data array
    // because if the underlying list of data didn't change we don't
    // want consumers of useFind to have to worry about changing reference
    const dataRef = useRef([]);
    const cachedData = useSelector((state)=>{
        const query = getIn(state, [
            namespace,
            'queries',
            serviceName,
            queryId
        ]);
        if (query) {
            let { data, meta } = query;
            const entities = query.entities || getIn(state, [
                namespace,
                'entities',
                serviceName
            ]);
            data = data.map((id)=>entities[id]);
            if (same(data, dataRef.current)) {
                data = dataRef.current;
            } else {
                dataRef.current = data;
            }
            data = selectData(data);
            return _object_spread_props(_object_spread({}, meta), {
                data
            });
        } else {
            return {
                data: null
            };
        }
    }, {
        deps: [
            serviceName,
            queryId,
            selectData
        ]
    });
    const onFetched = (data)=>actions.feathersFetched({
            serviceName,
            queryId,
            method,
            params,
            data: _object_spread({}, transformResponse(data), id ? {
                id
            } : {}),
            realtime,
            matcher
        });
    return [
        cachedData,
        onFetched
    ];
}
function same(a, b) {
    if (a.length !== b.length) return false;
    for(let i = 0; i < a.length; i++){
        if (a[i] !== b[i]) return false;
    }
    return true;
}
