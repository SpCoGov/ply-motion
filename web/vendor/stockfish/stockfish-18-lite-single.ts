// Classic worker entry; the matching Emscripten runtime and WASM remain generated assets.
declare function importScripts(...urls: string[]): void;
importScripts('/vendor/stockfish/stockfish-18-lite-single.js');
