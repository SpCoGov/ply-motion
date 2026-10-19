# Third-party sources and notices

Original PlyMotion code is licensed under Apache-2.0; see `LICENSE`. Third-party code and assets retain their own licenses. The GPLv3-derived application code listed below remains GPLv3, and distribution of the combined application remains subject to GPLv3; the Apache-2.0 declaration does not relicense upstream code. See https://www.apache.org/licenses/GPL-compatibility.html.

## Interface icons — Google Material Symbols (Apache-2.0)

- Source: https://github.com/google/material-design-icons, commit `bd8cb85bd4bad964fe6918f79665bb40c3a8efef`.
- Original Outlined SVGs in `web/assets/material/`, with their Apache-2.0 license and source manifest. Paths are not redrawn; CSS masks inherit interface colors. These assets are bundled for offline use.
- Applies to interface controls only. Chess pieces and move-evaluation artwork retain their existing sources below.

## Application analysis code — GPLv3

- Source: https://github.com/Barabosik/chess-analyzer
- Local source revision: `b89cbf1`, read from `D:\chess-analyzer`.
- Adapted files, migrated to TypeScript: `web/lib/review.ts`, `motifs.ts`, `engine.ts`, `board.ts`.
- Upstream author/contributors retain their copyright and GPLv3 license. GPL version 3 text is preserved in `LICENSE-GPL-3.0`.
- PlyMotion modifications: Forced/Miss classifications, SVG marks, transposition-aware opening-position matching, full UCI move history, worker cancellation/errors, Chess.com local piece selection and image accessibility.
- Terminal detection uses chess.js board/history and explicit PGN termination metadata; it does not reproduce all platform adjudication rules.

## chess.js — BSD-2-Clause

- https://github.com/jhlywa/chess.js
- `web/vendor/chess.ts`: original TypeScript source from upstream tag `v1.1.0` (`src/chess.ts`), matching the previously bundled chess.js API and implementation.
- Copyright (c) 2025 Jeff Hlywa. Complete copyright, conditions and disclaimer remain at the beginning of that file.

## Stockfish.js 18 — GPLv3

- https://github.com/nmrugg/stockfish.js
- https://github.com/official-stockfish/Stockfish
- `web/vendor/stockfish/stockfish-18-lite-single.js` and matching `.wasm`, copied unchanged from the upstream revision above.
- `web/vendor/stockfish/stockfish-18-lite-single.ts` is PlyMotion's typed worker entry; the JavaScript file is the generated Emscripten runtime resource, not application source.
- Loader identifies itself as Stockfish.js 18, copyright 2026 Chess.com, LLC. This open-source engine license does not apply to Chess.com website artwork or sounds.
- For redistribution, supply corresponding engine source and build materials for the exact binaries; the vendor snapshot identifies the binaries, not a substitute for their corresponding source. Do this before publishing release binaries.

## Lichess opening lines — CC0-1.0

- https://github.com/lichess-org/chess-openings
- Source files `a.tsv`–`e.tsv`, refreshed 2026-10-09. Derived typed position index: `web/vendor/openings.ts`, rebuilt by `scripts/build-openings.mjs` from each legal move's resulting FEN (first four fields).
- This is an opening-name/representative-line dataset, not a complete theory book or Chess.com's Book classification database.
- https://github.com/lichess-org/chess-openings/blob/master/COPYING.txt
- Dataset is a collection of facts; any applicable copyright is dedicated under CC0.

## cburnett fallback pieces — GPL

- Colin M. L. Burnett; https://github.com/lichess-org/lila
- `web/vendor/pieces/cburnett/`, copied unchanged from the upstream analyzer. Original SVG metadata is preserved. These are the default fallback when local Chess.com files are absent.

## User-provided extracted SVG icons — separate rights

- `web/assets/icons/`: 25 SVGs copied byte-for-byte from the user-provided `D:/ply-motion/svg-extracted/svg/` directory, including the free-piece icon used by animations. The asset README records the exact mappings.
- The extraction manifest describes a JavaScript bundle supplied by the user; this does not establish an open redistribution license. These assets are not relicensed by the application's Apache-2.0 notice. Verify the original rights before redistribution.
- The application uses only asset-directory copies. It does not load extraction scripts, templates, or source fragments at runtime. These SVGs replace the previous handwritten marks and ten classification PNGs.

## Chess.com local-only pieces and sounds — NOT GPL

- Neo piece PNGs: `https://images.chesscomfiles.com/chess-themes/pieces/neo/150/{w,b}{p,n,b,r,q,k}.png`
- Move audio: https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/move-self.mp3
- Capture audio: https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/capture.mp3
- Terms reviewed: https://www.chess.com/legal/user-agreement (2026-09-27).
- No open redistribution grant verified. Rights remain with the original owners. `web/assets/chesscom/` is ignored by Git; its generated manifest records actual URLs, byte lengths and hashes. Do not describe these assets as GPL or Apache-2.0.
- A local Tauri build embeds these files when present. Before distributing binaries, obtain permission or replace both these optional files and the extracted SVG icons with assets whose redistribution rights are established.

## Desktop runtime

- Tauri: https://github.com/tauri-apps/tauri (MIT / Apache-2.0 as applicable).
- Resolved Rust dependency versions are recorded in `Cargo.lock`.
- Original project `icon.svg` is retained as supplied and used to generate the application icon.

## Video encoder — external executable

- Video export invokes the user's locally installed FFmpeg through its CLI: https://ffmpeg.org/ffmpeg.html.
- No FFmpeg binary or source is bundled. The installed build must include `libx264` and, for audio exports, `aac`. Its own build configuration and license remain applicable.
- Frames are rendered using the existing piece/icon assets; video export does not change their licenses or grant additional asset rights.

## Editor UI and frontend build

- Resolved JavaScript versions: `pnpm-lock.yaml`.
- React / React DOM, Dockview React 8.3.1 (core MIT, no enterprise package), Zustand, Radix UI, Tailwind CSS, class-variance-authority, clsx, tailwind-merge and Vite: MIT.
- TypeScript: Apache-2.0. Lucide React: ISC, with MIT notices for inherited Feather icons.
- `@xzdarcy/react-timeline-editor` 1.0.0: MIT; development-only feasibility probe, excluded from the production bundle.
- PlyMotion applies the reproducible patch in `patches/` to its ESM entry and corresponding TypeScript source: pointer-origin geometry, nearest snapping, minimum resize duration, and disabled auto-scroll handling. Upstream copyrights and license are unchanged; unused CJS/UMD bundles are not patched.
- Vite writes bundled package notices to `dist/dependency-licenses.md`. Original package license files are retained in the dependency installation.
- `web/editor/ui/button.tsx` and `dropdown-menu.tsx` adapt the shadcn/ui composition pattern. Upstream: https://github.com/shadcn-ui/ui ; license: https://github.com/shadcn-ui/ui/blob/main/LICENSE.md . Full notice follows.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

