// Imported first by server.mjs: stdout carries MCP messages and nothing else, so
// anything a module logs goes to stderr instead.
console.log = (...a) => console.error(...a);
console.info = console.log;
