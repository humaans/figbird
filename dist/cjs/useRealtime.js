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
var _namespace = require("./namespace");
var _helpers = require("./helpers");
function useRealtime(serviceName, mode, cb) {
    var _useFigbird = (0, _core.useFigbird)(), feathers = _useFigbird.feathers, atom = _useFigbird.atom, actions = _useFigbird.actions;
    (0, _react.useEffect)(function() {
        // realtime is turned off
        if (mode === "disabled") return;
        // get the ref store of this service
        var refs = (0, _helpers.getIn)(atom.get(), [
            _namespace.namespace,
            "refs"
        ]);
        refs[serviceName] = refs[serviceName] || {};
        refs[serviceName].realtime = refs[serviceName].realtime || 0;
        refs[serviceName].callbacks = refs[serviceName].callbacks || [];
        var ref = refs[serviceName];
        if (mode === "refetch" && cb) {
            refs[serviceName].callbacks.push(cb);
        }
        // get the service itself
        var service = feathers.service(serviceName);
        // increment the listener counter
        ref.realtime += 1;
        // bind to the realtime events, but only once globally per service
        if (ref.realtime === 1) {
            ref.created = function(item) {
                actions.feathersCreated({
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
                actions.feathersUpdated({
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
                actions.feathersPatched({
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
                actions.feathersRemoved({
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
                return c !== cb;
            });
            // unbind from the realtime events if nothing is listening anymore
            if (ref.realtime === 0) {
                service.off("created", ref.created);
                service.off("updated", ref.updated);
                service.off("patched", ref.patched);
                service.off("removed", ref.removed);
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        serviceName,
        mode,
        cb
    ]);
}
