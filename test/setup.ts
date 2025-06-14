// Make this a module by exporting something
export {}

// Extend the global namespace to include IS_REACT_ACT_ENVIRONMENT
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

global.IS_REACT_ACT_ENVIRONMENT = true
