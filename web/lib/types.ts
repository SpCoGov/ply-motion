import type { Color, PieceSymbol, Square } from '../vendor/chess.ts';
export type { Color, PieceSymbol, Square };

export type ClassId = 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'forced' | 'book' | 'inaccuracy' | 'mistake' | 'miss' | 'blunder';
export type Phase = 'opening' | 'middlegame' | 'endgame';
export type Outcome = { result: string; winner: Color | null };
export type OutcomeMarker = { square: Square; icon: 'win' | 'loss' | 'draw'; side: Color; title: string };
export type Motif = { kind: string; text: string };
export type Move = {
  san: string; uci: string; from: Square; to: Square; color: Color; flags: string;
  promotion?: PieceSymbol; captured?: PieceSymbol; fenBefore: string; fenAfter: string;
  moveNo: number; nags: number[]; ply: number; cls?: ClassId; motif?: Motif | null;
  cpWhite?: number; mateWhite?: number | null;
};
export type Game = { headers: Record<string, string>; startFen: string; moves: Move[]; pgn: string; outcome: Outcome | null };
export type Evaluation = { cp: number | null; mate: number | null; wdl?: number[] | null; depth?: number; multipv?: number; pv?: string[]; move?: string };
export type EngineNode = { stm?: string; bestmove?: string | null; best: Evaluation | null; played?: Evaluation; lines: Evaluation[] };
export type EngineSettings = { threads: number; hash: number; depth: number; movetime: number; multipv: number };
export type EngineSource = { name: string; url?: string; path?: string };
export type SearchOptions = { depth?: number; movetime?: number; multipv?: number; startFen?: string; moves?: string[]; searchmoves?: string[] };
export type ReviewEngine = { newGame?: () => Promise<unknown>; analyse: (fen: string, options: SearchOptions) => Promise<EngineNode> };
export type AnalyzedMove = Move & {
  reason?: string; cls: ClassId; phase: Phase; cpWhite: number; mateWhite: number | null;
  playedCpWhite: number; playedMateWhite: number | null; bestMove: string | null;
  expectedScoreBest: number; expectedScorePlayed: number; expectedPointsLoss: number; moveAccuracy: number;
  bestSan: string | null; bestFrom: string | null; bestTo: string | null; bestPromo: string | null;
  bestCpWhite: number; bestMateWhite: number | null; bestLine: string[] | null;
  showBetter: boolean; motif: Motif | null; afterLine: string[] | null; sacPiece: PieceSymbol | null;
  sacGiven: number | null; onlyGap: number | null; opening: string | null; loss?: number; cpLoss?: number;
};
export type Review = {
  scoreModel?: string; moves: AnalyzedMove[]; accWhite: number | null; accBlack: number | null;
  phases: Record<Phase, Record<Color, { acc: number; n: number } | null>>;
  est: Record<Color, { elo: number; lo: number; hi: number } | null>;
  counts: Record<Color, Record<ClassId, number>>; opening: string[] | null;
};
export type Easing = 'linear' | 'hold' | number[];
export type Keyframe = { time: number; value: number; easing: Easing };
export type MotionFrame = { offset: number; x: number; y: number; rotation: number; scale: number; opacity: number; easing: Easing };
export type MotionAxis = 'x' | 'y' | 'rotation' | 'scale' | 'opacity';
export type MotionEdit = { frames: MotionFrame[]; easing: Easing; tracks?: Partial<Record<MotionAxis, Keyframe[]>> };
export type Motion = MotionEdit & { id: string; clipId: string; label: string; startMs: number; durationMs: number };
export type SceneObject = { id: string; kind: string; group: string; color?: Color; initialType?: PieceSymbol; initialSquare?: string; visual: Record<string, number>; tracks?: Record<string, Keyframe[]> };
export type MovingPiece = { from: string; to: string; type: PieceSymbol; color: Color; start: number; duration: number };
export type Relation = { kind: 'attack' | 'defense' | 'pin' | 'skewer'; from: string; to: string; via?: string; piece: PieceSymbol; value: number };
export type RelationStep = { square: string; tone: string; attacked: boolean };
export type FreePiece = { from: string; to: string; gain: number; piece: PieceSymbol };
export const EFFECTS = ['previous', 'target', 'move', 'land', 'capture', 'promotion', 'settle', 'relation', 'relation-square', 'relation-exit', 'check', 'hit', 'gift', 'nag', 'result', 'winner', 'nag-exit'] as const;
export type Effect = typeof EFFECTS[number];
export type SoundKind = 'move' | 'capture';
export type PieceKey = `${Color}${PieceSymbol}`;
export type PieceAssetField = 'icon' | SoundKind;
export type BoardTone = 'light' | 'dark';
export type SoundCue = AudioEnvelope & { at: number; kind: SoundKind | 'music'; durationMs: number; muted?: boolean; assetId?: string; offsetMs?: number; volume?: number };
export type EventParams = { piece?: MovingPiece; relation?: Relation; step?: RelationStep; duration?: number; enterDuration?: number; sound?: SoundKind };
export type AnimationEvent = EventParams & { at: number; type: Effect | 'complete'; clipId?: string; motions?: Record<string, MotionEdit>; objectId?: string; hidden?: boolean; copied?: boolean; editorDuration?: number; easing?: Easing };
export type Director = { id: 'classic' | 'focus' | 'lively'; version: number; intensity?: number };
export type AnimationSnapshot = { cls: ClassId | null; pieces: MovingPiece[]; capturedSquare: string | null; relations: Relation[]; fork: boolean; freePiece: FreePiece | null; check: string | null; mate: boolean; nagAt: number; outcome: Outcome | null; director?: Director };
export type AnimationPlan = AnimationSnapshot & { move: Move; duration: number; startMs?: number; events: AnimationEvent[]; identity?: Segment };
export type Segment = { id: string; ply: number; objectId: string; before: Record<string, string>; after: Record<string, string>; capturedObjectId: string | null; capturedSquare: string | null; rookObjectId: string | null; promotion: PieceSymbol | null; durationMs: number; startMs?: number; snapshot: AnimationSnapshot };
export type Clip = { id: string; objectId: string; moveId: string | null; kind: string; effect: Effect | 'sound'; startMs: number; durationMs: number; params: EventParams; hidden?: boolean; copied?: boolean; sourceId?: string; easing?: Easing; motions?: Record<string, MotionEdit> };
export type TrackState = { locked?: boolean; hidden?: boolean; muted?: boolean };
export type CameraPose = { x: number; y: number; scale: number; rotation: number };
export type CameraKey = CameraPose & { time: number; easing: Easing };
export type CameraFocus = { scale: number; durationMs: number };
export type Camera = { keys: CameraKey[]; shakes: { id: string; startMs: number; durationMs: number; strength: number }[];
  follow?: { enabled: boolean; moves: Record<string, CameraFocus> } };
export type AudioEnvelope = { volume?: number; offsetMs?: number; fadeInMs?: number; fadeOutMs?: number };
export type Music = AudioEnvelope & { assetId: string; startMs: number; offsetMs: number; durationMs: number; volume: number };
export type Overlay = { id: string; kind: 'text' | 'image'; text: string; assetId?: string; startMs: number; durationMs: number; x: number; y: number; width: number; fontSize: number; color: string; align: 'left' | 'center' | 'right'; opacity: number; rotation: number; fadeInMs: number; fadeOutMs: number; hidden: boolean; locked: boolean };
export type Composition = { x: number; y: number; scale: number; rotation: number; background: string; coordinates: boolean };
export type Edits = {
  objects: Record<string, { visual?: Record<string, number>; tracks?: Record<string, Keyframe[]> }>;
  clips: Record<string, { startMs?: number; durationMs?: number; hidden?: boolean; easing?: Easing; motions?: Record<string, MotionEdit> }>;
  copies: { id: string; sourceId: string; startMs: number; durationMs: number }[];
  segments: Record<string, { durationMs: number }>;
  camera?: Camera; music?: Music; beats?: number[]; beatSync?: Record<string, number>; beatOffsets?: Record<string, number>; beatStarts?: Record<string, number>;
  pending?: Pick<Clip, 'id' | 'objectId' | 'moveId' | 'effect' | 'durationMs'>[];
  trackStates?: Record<string, TrackState>; assets?: Asset[];
  pieceAssets?: Partial<Record<PieceKey, Partial<Record<PieceAssetField, string>>>>;
  boardStyle?: Partial<Record<BoardTone, { color?: string; texture?: string }>>;
  overlays?: Overlay[]; composition?: Composition; coordinates?: { x: number; y: number; scale: number; rotation: number; opacity: number }; audio?: Record<string, AudioEnvelope>;
};
export type VideoSettings = { width: number; height: number; fps: number; crf: number; bitrate: number; speed: number; sound: boolean; showNames: boolean; showMove: boolean; showEvaluation: boolean };
export type Output = VideoSettings & { flip: boolean };
export type Asset = { id: string; kind: string; source: { kind: 'builtin'; id: string } | { kind: 'relative'; path: string } | { kind: 'embedded'; name: string; data: string; durationMs?: number } };
export type Project = { schemaVersion: number; director: Director; pgn: string; analysis: { engine: string; depth: number; settings?: EngineSettings; review: Review } | null; objects: SceneObject[]; segments: Segment[]; clips: Clip[]; edits: Edits; assets: Asset[]; output: Output };
export type TimelineOptions = { signal?: AbortSignal; dispatch: (event: AnimationEvent) => void; seek?: (time: number) => void; now?: () => number };
export type TimelineDriver = (events: AnimationEvent[], duration: number, options: TimelineOptions) => Promise<boolean>;
export type Scene = { seek: (time: number) => void; dispose: () => void; motions: Motion[] };
export type BoardElement = HTMLElement & { animationOwner?: object };
export type SceneOptions = { flip?: boolean; chesscom?: boolean; project?: Project; outcome?: Outcome | null; identity?: Segment | null; speed?: number; plan?: AnimationPlan | null; previousMove?: Move | null; signal?: AbortSignal; reduced?: boolean; timeline?: TimelineDriver; onLand?: () => void; onEvaluation?: () => void; onPhase?: (phase: string) => void };

declare global {
  interface Window {
    __TAURI__?: { core: { invoke<T = unknown>(command: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array, options?: { headers: Record<string, string> }): Promise<T> } };
  }
}
