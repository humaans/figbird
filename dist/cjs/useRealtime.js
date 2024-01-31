"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "useRealtime", {
    enumerable: true,
    get: function() {
        return useRealtime;
    }
});
var _react = require("react");
var _core = require("./core");
var _cache = require("./cache");
var refsSelector = (0, _cache.selector)(function() {
    return (0, _cache.cache)().refs;
});
function useRealtime(serviceName, mode, refetch) {
    var feathers = (0, _core.useFeathers)();
    var dispatch = (0, _cache.useDispatch)();
    var refs = (0, _cache.useSelector)(refsSelector, []);
    (0, _react.useEffect)(function() {
        // realtime is turned off
        if (mode === "disabled") return;
        // get the ref store of this service
        refs[serviceName] = refs[serviceName] || {};
        refs[serviceName].realtime = refs[serviceName].realtime || 0;
        refs[serviceName].callbacks = refs[serviceName].callbacks || [];
        var ref = refs[serviceName];
        if (mode === "refetch" && refetch) {
            refs[serviceName].callbacks.push(refetch);
        }
        // get the service itself
        var service = feathers.service(serviceName);
        // increment the listener counter
        ref.realtime += 1;
        // bind to the realtime events, but only once globally per service
        if (ref.realtime === 1) {
            ref.created = function(item) {
                dispatch({
                    event: "created",
                    serviceName: serviceName,
                    item: item
                });
                refs[serviceName].callbacks.forEach(function(c) {
                    return c({
                        event: "created",
                        serviceName: serviceName,
                        item: item
                    });
                });
            };
            ref.updated = function(item) {
                dispatch({
                    event: "updated",
                    serviceName: serviceName,
                    item: item
                });
                refs[serviceName].callbacks.forEach(function(c) {
                    return c({
                        event: "updated",
                        serviceName: serviceName,
                        item: item
                    });
                });
            };
            ref.patched = function(item) {
                dispatch({
                    event: "patched",
                    serviceName: serviceName,
                    item: item
                });
                refs[serviceName].callbacks.forEach(function(c) {
                    return c({
                        event: "patched",
                        serviceName: serviceName,
                        item: item
                    });
                });
            };
            ref.removed = function(item) {
                dispatch({
                    event: "removed",
                    serviceName: serviceName,
                    item: item
                });
                refs[serviceName].callbacks.forEach(function(c) {
                    return c({
                        event: "removed",
                        serviceName: serviceName,
                        item: item
                    });
                });
            };
            service.on("created", ref.created);
            service.on("updated", ref.updated);
            service.on("patched", ref.patched);
            service.on("removed", ref.removed);
        }
        return function() {
            // decrement the listener counter
            ref.realtime -= 1;
            refs[serviceName].callbacks = refs[serviceName].callbacks.filter(function(c) {
                return c !== refetch;
            });
            // unbind from the realtime events if nothing is listening anymore
            if (ref.realtime === 0) {
                service.off("created", ref.created);
                service.off("updated", ref.updated);
                service.off("patched", ref.patched);
                service.off("removed", ref.removed);
            }
        };
    }, [
        feathers,
        dispatch,
        refs,
        serviceName,
        mode,
        refetch
    ]);
}
