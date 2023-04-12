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
    useGet: function() {
        return _useGet.useGet;
    },
    useFind: function() {
        return _useFind.useFind;
    },
    useMutation: function() {
        return _useMutation.useMutation;
    },
    Provider: function() {
        return _core.Provider;
    },
    useFigbird: function() {
        return _core.useFigbird;
    },
    useFeathers: function() {
        return _core.useFeathers;
    },
    namespace: function() {
        return _namespace.namespace;
    }
});
var _useGet = require("./useGet");
var _useFind = require("./useFind");
var _useMutation = require("./useMutation");
var _core = require("./core");
var _namespace = require("./namespace");
