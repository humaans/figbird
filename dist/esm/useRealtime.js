import { useEffect } from 'react';
import { useFeathers } from './core';
import { cache, useDispatch, selector, useSelector } from './cache';
const refsSelector = selector(()=>cache().refs);
/**
 * An internal hook that will listen to realtime updates to a service
 * and update the cache as changes happen.
 */ export function useRealtime(serviceName, mode, cb) {
    const feathers = useFeathers();
    const dispatch = useDispatch();
    const refs = useSelector(refsSelector, []);
    useEffect(()=>{
        // realtime is turned off
        if (mode === 'disabled') return;
        // get the ref store of this service
        refs[serviceName] = refs[serviceName] || {};
        refs[serviceName].realtime = refs[serviceName].realtime || 0;
        refs[serviceName].callbacks = refs[serviceName].callbacks || [];
        const ref = refs[serviceName];
        if (mode === 'refetch' && cb) {
            refs[serviceName].callbacks.push(cb);
        }
        // get the service itself
        const service = feathers.service(serviceName);
        // increment the listener counter
        ref.realtime += 1;
        // bind to the realtime events, but only once globally per service
        if (ref.realtime === 1) {
            ref.created = (item)=>{
                dispatch({
                    event: 'created',
                    serviceName,
                    item
                });
                refs[serviceName].callbacks.forEach((c)=>c({
                        event: 'created',
                        serviceName,
                        item
                    }));
            };
            ref.updated = (item)=>{
                dispatch({
                    event: 'updated',
                    serviceName,
                    item
                });
                refs[serviceName].callbacks.forEach((c)=>c({
                        event: 'updated',
                        serviceName,
                        item
                    }));
            };
            ref.patched = (item)=>{
                dispatch({
                    event: 'patched',
                    serviceName,
                    item
                });
                refs[serviceName].callbacks.forEach((c)=>c({
                        event: 'patched',
                        serviceName,
                        item
                    }));
            };
            ref.removed = (item)=>{
                dispatch({
                    event: 'removed',
                    serviceName,
                    item
                });
                refs[serviceName].callbacks.forEach((c)=>c({
                        event: 'removed',
                        serviceName,
                        item
                    }));
            };
            service.on('created', ref.created);
            service.on('updated', ref.updated);
            service.on('patched', ref.patched);
            service.on('removed', ref.removed);
        }
        return ()=>{
            // decrement the listener counter
            ref.realtime -= 1;
            refs[serviceName].callbacks = refs[serviceName].callbacks.filter((c)=>c !== cb);
            // unbind from the realtime events if nothing is listening anymore
            if (ref.realtime === 0) {
                service.off('created', ref.created);
                service.off('updated', ref.updated);
                service.off('patched', ref.patched);
                service.off('removed', ref.removed);
            }
        };
    }, [
        feathers,
        dispatch,
        refs,
        serviceName,
        mode,
        cb
    ]);
}
