import React, { useEffect, useState } from 'react';
import { GameComponentProps } from './GomokuGame';
import { soundFX } from '../../utils/sound';

const SIZE = 19;
const KOMI = 6.5;
type Cell = 0 | 1 | 2; // 0 empty, 1 p1 (black), 2 p2 (white)

interface GoState {
  board: Cell[][];
  lastMove: [number, number] | null;
  lastAction: 'stone' | 'pass' | null;
  passes: number;
  captures: { 1: number; 2: number };
  history: string[];
}

function createInitialState(): GoState {
  return {
    board: Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(0)),
    lastMove: null,
    lastAction: null,
    passes: 0,
    captures: { 1: 0, 2: 0 },
    history: [],
  };
}

function normalizeState(raw: Partial<GoState> | null | undefined): GoState {
  const base = createInitialState();
  if (!raw || !Array.isArray(raw.board) || raw.board.length !== SIZE) return base;
  return {
    board: raw.board.map((row) => Array.from(row as Cell[])),
    lastMove: raw.lastMove ?? null,
    lastAction: raw.lastAction ?? null,
    passes: raw.passes ?? 0,
    captures: { 1: raw.captures?.[1] ?? 0, 2: raw.captures?.[2] ?? 0 },
    history: raw.history ?? [],
  };
}

function neighbors(r: number, c: number): [number, number][] {
  const out: [number, number][] = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < SIZE - 1) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < SIZE - 1) out.push([r, c + 1]);
  return out;
}

function groupInfo(board: Cell[][], r: number, c: number) {
  const color = board[r][c];
  const stones: [number, number][] = [];
  const libs = new Set<string>();
  const seen = new Set<string>([`${r},${c}`]);
  const stack: [number, number][] = [[r, c]];
  while (stack.length) {
    const [cr, cc] = stack.pop()!;
    stones.push([cr, cc]);
    for (const [nr, nc] of neighbors(cr, cc)) {
      const v = board[nr][nc];
      if (v === 0) libs.add(`${nr},${nc}`);
      else if (v === color && !seen.has(`${nr},${nc}`)) {
        seen.add(`${nr},${nc}`);
        stack.push([nr, nc]);
      }
    }
  }
  return { stones, libs: libs.size };
}

function boardKey(board: Cell[][]): string {
  return board.map((row) => row.join('')).join('|');
}

function applyMove(
  board: Cell[][],
  r: number,
  c: number,
  player: Cell,
  history: string[]
): { board: Cell[][]; captured: number } | null {
  if (board[r][c] !== 0) return null;
  const next = board.map((row) => [...row]);
  next[r][c] = player;
  const opp: Cell = player === 1 ? 2 : 1;
  let captured = 0;
  for (const [nr, nc] of neighbors(r, c)) {
    if (next[nr][nc] !== opp) continue;
    const g = groupInfo(next, nr, nc);
    if (g.libs === 0) {
      for (const [sr, sc] of g.stones) {
        next[sr][sc] = 0;
        captured++;
      }
    }
  }
  if (groupInfo(next, r, c).libs === 0) return null; // suicide
  const key = boardKey(next);
  if (history.includes(key)) return null; // positional superko
  return { board: next, captured };
}

function scoreBoard(board: Cell[][]): { p1: number; p2: number } {
  let s1 = 0;
  let s2 = KOMI;
  const visited = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 1) s1++;
      else if (board[r][c] === 2) s2++;
    }
  }
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0 || visited[r][c]) continue;
      const region: [number, number][] = [];
      const borders = new Set<Cell>();
      const stack: [number, number][] = [[r, c]];
      visited[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop()!;
        region.push([cr, cc]);
        for (const [nr, nc] of neighbors(cr, cc)) {
          if (board[nr][nc] === 0) {
            if (!visited[nr][nc]) {
              visited[nr][nc] = true;
              stack.push([nr, nc]);
            }
          } else {
            borders.add(board[nr][nc]);
          }
        }
      }
      if (borders.size === 1) {
        if (borders.has(1)) s1 += region.length;
        else s2 += region.length;
      }
    }
  }
  return { p1: s1, p2: s2 };
}

function pickAIMove(state: GoState): [number, number] | 'pass' {
  const { board, history } = state;
  const me: Cell = 2;
  const opp: Cell = 1;

  let hasStone = false;
  for (let r = 0; r < SIZE && !hasStone; r++)
    for (let c = 0; c < SIZE; c++)
      if (board[r][c] !== 0) {
        hasStone = true;
        break;
      }
  if (!hasStone) return [9, 9];

  const candidates = new Set<string>();
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 0) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] === 0)
            candidates.add(`${nr},${nc}`);
        }
      }
    }
  }

  let bestScore = -Infinity;
  let bestMove: [number, number] | 'pass' = 'pass';

  for (const key of candidates) {
    const [r, c] = key.split(',').map(Number);
    const result = applyMove(board, r, c, me, history);
    if (!result) continue;
    const myGroup = groupInfo(result.board, r, c);
    if (myGroup.libs <= 1) continue; // avoid self-atari

    let score = 0;
    score += result.captured * 30;

    // save own groups that were in atari
    for (const [nr, nc] of neighbors(r, c)) {
      if (board[nr][nc] === me && groupInfo(board, nr, nc).libs === 1) {
        const after = groupInfo(result.board, nr, nc);
        if (after.libs > 1) score += after.stones.length * 20;
      }
    }

    score += Math.min(myGroup.libs, 6) * 4;
    score += myGroup.stones.length * 2;

    // count opponent groups reduced to atari by this move
    for (const [nr, nc] of neighbors(r, c)) {
      if (result.board[nr][nc] === opp) {
        const g = groupInfo(result.board, nr, nc);
        if (g.libs === 1) score += 12;
      }
    }

    let nearest = Infinity;
    for (let sr = 0; sr < SIZE; sr++) {
      for (let sc = 0; sc < SIZE; sc++) {
        if (board[sr][sc] !== 0) {
          const d = Math.abs(sr - r) + Math.abs(sc - c);
          if (d < nearest) nearest = d;
        }
      }
    }
    score += Math.max(0, 8 - nearest) * 2;
    score -= (Math.abs(r - 9) + Math.abs(c - 9)) * 0.2;
    score += Math.random() * 2;

    if (score > bestScore) {
      bestScore = score;
      bestMove = [r, c];
    }
  }

  if (bestMove === 'pass') return 'pass';
  // board basically settled: pass after opponent passes with no valuable move
  if (state.passes >= 1 && bestScore < 6) return 'pass';
  return bestMove;
}

function resultText(board: Cell[][]): string {
  const s = scoreBoard(board);
  if (s.p1 === s.p2) return `和棋 ${s.p1} : ${s.p2}`;
  const winner = s.p1 > s.p2 ? '黑方' : '白方';
  const diff = Math.abs(s.p1 - s.p2).toFixed(1);
  return `${winner}勝 ${Math.max(s.p1, s.p2)} : ${Math.min(s.p1, s.p2)}（${diff} 子差）`;
}

export const GoGame: React.FC<GameComponentProps> = ({
  mode,
  myRole,
  currentTurn,
  boardState,
  winner,
  onMove,
  moveCount,
}) => {
  const state = normalizeState(boardState as GoState);
  const [hover, setHover] = useState<[number, number] | null>(null);

  const canPlay =
    !winner && myRole !== 'spectator' && (mode === 'ai' ? currentTurn === 'p1' : myRole === currentTurn);

  useEffect(() => {
    if (mode === 'ai' && currentTurn === 'p2' && !winner && myRole === 'p1') {
      const timer = setTimeout(() => {
        const move = pickAIMove(state);
        if (move === 'pass') {
          const passes = state.passes + 1;
          if (passes >= 2) {
            const s = scoreBoard(state.board);
            const w: 'p1' | 'p2' | 'draw' = s.p1 > s.p2 ? 'p1' : s.p2 > s.p1 ? 'p2' : 'draw';
            soundFX.playWin();
            onMove({ ...state, lastAction: 'pass', passes }, 'p1', moveCount + 1, w);
          } else {
            soundFX.playMove();
            onMove({ ...state, lastAction: 'pass', passes }, 'p1', moveCount + 1, null);
          }
          return;
        }
        const [r, c] = move;
        const result = applyMove(state.board, r, c, 2, state.history);
        if (!result) return;
        const next: GoState = {
          board: result.board,
          lastMove: [r, c],
          lastAction: 'stone',
          passes: 0,
          captures: { 1: state.captures[1], 2: state.captures[2] + result.captured },
          history: [...state.history, boardKey(state.board)],
        };
        soundFX.playMove();
        onMove(next, 'p1', moveCount + 1, null);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [mode, currentTurn, winner, myRole, state, moveCount, onMove]);

  const finishByScore = (board: Cell[][]) => {
    const s = scoreBoard(board);
    const w: 'p1' | 'p2' | 'draw' = s.p1 > s.p2 ? 'p1' : s.p2 > s.p1 ? 'p2' : 'draw';
    soundFX.playWin();
    return w;
  };

  const handleCellClick = (r: number, c: number) => {
    if (!canPlay || state.board[r][c] !== 0) return;
    const playerNum: Cell = currentTurn === 'p1' ? 1 : 2;
    const result = applyMove(state.board, r, c, playerNum, state.history);
    if (!result) return;
    const next: GoState = {
      board: result.board,
      lastMove: [r, c],
      lastAction: 'stone',
      passes: 0,
      captures: {
        1: playerNum === 1 ? state.captures[1] + result.captured : state.captures[1],
        2: playerNum === 2 ? state.captures[2] + result.captured : state.captures[2],
      },
      history: [...state.history, boardKey(state.board)],
    };
    soundFX.playMove();
    onMove(
      next,
      currentTurn === 'p1' ? 'p2' : 'p1',
      moveCount + 1,
      null
    );
  };

  const handlePass = () => {
    if (!canPlay) return;
    const passes = state.passes + 1;
    if (passes >= 2) {
      soundFX.playWin();
      onMove({ ...state, lastAction: 'pass', passes }, currentTurn === 'p1' ? 'p2' : 'p1', moveCount + 1, finishByScore(state.board));
    } else {
      soundFX.playMove();
      onMove({ ...state, lastAction: 'pass', passes }, currentTurn === 'p1' ? 'p2' : 'p1', moveCount + 1, null);
    }
  };

  const starPoints = new Set<string>();
  for (const a of [3, 9, 15]) for (const b of [3, 9, 15]) starPoints.add(`${a},${b}`);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-4 text-xs text-slate-300">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-gradient-to-br from-slate-700 to-slate-950 border border-slate-800" />
          黑（P1）提子 {state.captures[1]}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-gradient-to-br from-white to-slate-200 border border-slate-300" />
          白（P2）提子 {state.captures[2]}
        </span>
        <span className="text-slate-500">貼目 {KOMI}</span>
        {state.lastAction === 'pass' && <span className="text-amber-400">對手已虛手（停一手）</span>}
      </div>

      <div
        className="relative p-3 sm:p-4 rounded-xl shadow-2xl border border-amber-900/40 select-none"
        style={{ backgroundColor: '#d9a76a' }}
      >
        <div
          className="grid gap-0"
          style={{
            gridTemplateColumns: `repeat(${SIZE}, minmax(0, 1fr))`,
          }}
        >
          {state.board.map((row, r) =>
            row.map((cell, c) => {
              const isLast = state.lastMove && state.lastMove[0] === r && state.lastMove[1] === c;
              const isStar = starPoints.has(`${r},${c}`);
              return (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  onClick={() => handleCellClick(r, c)}
                  onMouseEnter={() => setHover([r, c])}
                  onMouseLeave={() => setHover(null)}
                  disabled={!canPlay || cell !== 0}
                  className="relative w-4 h-4 sm:w-5 sm:h-5 flex items-center justify-center focus:outline-none"
                  aria-label={`Row ${r + 1} Col ${c + 1}`}
                >
                  <span
                    className="absolute bg-amber-950/60"
                    style={{
                      height: '1px',
                      left: c === 0 ? '50%' : '0',
                      right: c === SIZE - 1 ? '50%' : '0',
                      top: '50%',
                    }}
                  />
                  <span
                    className="absolute bg-amber-950/60"
                    style={{
                      width: '1px',
                      top: r === 0 ? '50%' : '0',
                      bottom: r === SIZE - 1 ? '50%' : '0',
                      left: '50%',
                    }}
                  />
                  {isStar && cell === 0 && (
                    <span className="w-1 h-1 rounded-full bg-amber-950/80 z-0" />
                  )}
                  {cell !== 0 && (
                    <span
                      className={`z-10 w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full shadow-md transition-transform duration-150 ${
                        cell === 1
                          ? 'bg-gradient-to-br from-slate-700 to-slate-950 border border-slate-800'
                          : 'bg-gradient-to-br from-white to-slate-200 border border-slate-300'
                      } ${isLast ? 'ring-2 ring-emerald-400' : ''}`}
                    />
                  )}
                  {cell === 0 && canPlay && hover && hover[0] === r && hover[1] === c && (
                    <span
                      className={`z-10 w-3 h-3 sm:w-3.5 sm:h-3.5 rounded-full opacity-40 ${
                        currentTurn === 'p1' ? 'bg-slate-900' : 'bg-white'
                      }`}
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {canPlay && (
          <button
            type="button"
            onClick={handlePass}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium transition-colors cursor-pointer"
          >
            虛手（Pass）
          </button>
        )}
        {winner && (
          <span className="px-4 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 text-xs font-semibold">
            終局：{resultText(state.board)}
          </span>
        )}
      </div>
    </div>
  );
};
