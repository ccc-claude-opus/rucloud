import React, { useEffect, useState } from 'react';
import { GameComponentProps } from './GomokuGame';
import { soundFX } from '../../utils/sound';

type Side = 'r' | 'b'; // r = p1 (bottom), b = p2 (top)
type PieceType = 'K' | 'A' | 'E' | 'H' | 'R' | 'C' | 'P';

interface Piece {
  side: Side;
  type: PieceType;
}

type Board = (Piece | null)[][]; // 10 rows x 9 cols

interface XiangqiState {
  board: Board;
  lastMove: { from: [number, number]; to: [number, number] } | null;
}

const PIECE_LABELS: Record<Side, Record<PieceType, string>> = {
  r: { K: '帥', A: '仕', E: '相', H: '傌', R: '俥', C: '炮', P: '兵' },
  b: { K: '將', A: '士', E: '象', H: '馬', R: '車', C: '砲', P: '卒' },
};

function createInitialBoard(): Board {
  const b: Board = Array.from({ length: 10 }, () => Array<Piece | null>(9).fill(null));
  const backRow: PieceType[] = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  backRow.forEach((t, c) => {
    b[0][c] = { side: 'b', type: t };
    b[9][c] = { side: 'r', type: t };
  });
  b[2][1] = { side: 'b', type: 'C' };
  b[2][7] = { side: 'b', type: 'C' };
  b[7][1] = { side: 'r', type: 'C' };
  b[7][7] = { side: 'r', type: 'C' };
  [0, 2, 4, 6, 8].forEach((c) => {
    b[3][c] = { side: 'b', type: 'P' };
    b[6][c] = { side: 'r', type: 'P' };
  });
  return b;
}

function inBounds(r: number, c: number) {
  return r >= 0 && r < 10 && c >= 0 && c < 9;
}

function inPalace(r: number, c: number, side: Side) {
  if (c < 3 || c > 5) return false;
  return side === 'r' ? r >= 7 && r <= 9 : r >= 0 && r <= 2;
}

function getLegalMoves(board: Board, r: number, c: number): [number, number][] {
  const p = board[r][c];
  if (!p) return [];
  const moves: [number, number][] = [];
  const { side, type } = p;

  const addIfValid = (nr: number, nc: number) => {
    if (!inBounds(nr, nc)) return;
    const target = board[nr][nc];
    if (!target || target.side !== side) moves.push([nr, nc]);
  };

  if (type === 'K') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (inPalace(nr, nc, side)) addIfValid(nr, nc);
    }
    // Flying general
    const dir = side === 'r' ? -1 : 1;
    let nr = r + dir;
    while (inBounds(nr, c)) {
      const t = board[nr][c];
      if (t) {
        if (t.type === 'K' && t.side !== side) moves.push([nr, c]);
        break;
      }
      nr += dir;
    }
  } else if (type === 'A') {
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (inPalace(nr, nc, side)) addIfValid(nr, nc);
    }
  } else if (type === 'E') {
    for (const [dr, dc] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
      const nr = r + dr;
      const nc = c + dc;
      const mr = r + dr / 2;
      const mc = c + dc / 2;
      if (!inBounds(nr, nc)) continue;
      if (side === 'r' && nr < 5) continue;
      if (side === 'b' && nr > 4) continue;
      if (!board[mr][mc]) addIfValid(nr, nc);
    }
  } else if (type === 'H') {
    const steps: [number, number, number, number][] = [
      [-2, -1, -1, 0], [-2, 1, -1, 0],
      [2, -1, 1, 0], [2, 1, 1, 0],
      [-1, -2, 0, -1], [1, -2, 0, -1],
      [-1, 2, 0, 1], [1, 2, 0, 1],
    ];
    for (const [dr, dc, lr, lc] of steps) {
      if (inBounds(r + dr, c + dc) && !board[r + lr][c + lc]) {
        addIfValid(r + dr, c + dc);
      }
    }
  } else if (type === 'R') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nr = r + dr;
      let nc = c + dc;
      while (inBounds(nr, nc)) {
        const t = board[nr][nc];
        if (!t) moves.push([nr, nc]);
        else {
          if (t.side !== side) moves.push([nr, nc]);
          break;
        }
        nr += dr;
        nc += dc;
      }
    }
  } else if (type === 'C') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nr = r + dr;
      let nc = c + dc;
      let jumped = false;
      while (inBounds(nr, nc)) {
        const t = board[nr][nc];
        if (!jumped) {
          if (!t) moves.push([nr, nc]);
          else jumped = true;
        } else {
          if (t) {
            if (t.side !== side) moves.push([nr, nc]);
            break;
          }
        }
        nr += dr;
        nc += dc;
      }
    }
  } else if (type === 'P') {
    const forward = side === 'r' ? -1 : 1;
    addIfValid(r + forward, c);
    const crossedRiver = side === 'r' ? r <= 4 : r >= 5;
    if (crossedRiver) {
      addIfValid(r, c - 1);
      addIfValid(r, c + 1);
    }
  }

  return moves;
}

const PIECE_VALUES: Record<PieceType, number> = {
  K: 10000,
  R: 90,
  C: 45,
  H: 40,
  E: 20,
  A: 20,
  P: 10,
};

function pickAIMove(board: Board): { from: [number, number]; to: [number, number] } | null {
  const allMoves: { from: [number, number]; to: [number, number]; score: number }[] = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (p && p.side === 'b') {
        const legals = getLegalMoves(board, r, c);
        for (const [nr, nc] of legals) {
          const target = board[nr][nc];
          let score = target ? PIECE_VALUES[target.type] * 10 : 0;
          if (nr > r) score += 2; // advance
          score += Math.random() * 3;
          allMoves.push({ from: [r, c], to: [nr, nc], score });
        }
      }
    }
  }
  if (allMoves.length === 0) return null;
  allMoves.sort((a, b) => b.score - a.score);
  return { from: allMoves[0].from, to: allMoves[0].to };
}

export const XiangqiGame: React.FC<GameComponentProps> = ({
  mode,
  myRole,
  currentTurn,
  boardState,
  winner,
  onMove,
  moveCount,
}) => {
  const state: XiangqiState = (boardState as XiangqiState) || {
    board: createInitialBoard(),
    lastMove: null,
  };

  const [selected, setSelected] = useState<[number, number] | null>(null);
  const canPlay = !winner && myRole !== 'spectator' && (mode === 'ai' ? currentTurn === 'p1' : myRole === currentTurn);
  const mySide: Side = currentTurn === 'p1' ? 'r' : 'b';

  const legalTargets = selected ? getLegalMoves(state.board, selected[0], selected[1]) : [];
  const legalSet = new Set(legalTargets.map(([r, c]) => `${r},${c}`));

  const executeMove = (from: [number, number], to: [number, number]) => {
    const nextBoard = state.board.map((row) => [...row]);
    const moving = nextBoard[from[0]][from[1]];
    const target = nextBoard[to[0]][to[1]];
    nextBoard[to[0]][to[1]] = moving;
    nextBoard[from[0]][from[1]] = null;

    let newWinner: 'p1' | 'p2' | null = null;
    if (target && target.type === 'K') {
      newWinner = currentTurn;
    }

    if (newWinner) soundFX.playWin();
    else if (target) soundFX.playCapture();
    else soundFX.playMove();

    setSelected(null);
    onMove(
      { board: nextBoard, lastMove: { from, to } },
      currentTurn === 'p1' ? 'p2' : 'p1',
      moveCount + 1,
      newWinner
    );
  };

  useEffect(() => {
    if (mode === 'ai' && currentTurn === 'p2' && !winner && myRole === 'p1') {
      const timer = setTimeout(() => {
        const move = pickAIMove(state.board);
        if (move) {
          executeMove(move.from, move.to);
        } else {
          onMove(state, 'p1', moveCount, 'p1');
        }
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [mode, currentTurn, winner, myRole, state.board]);

  const handleCellClick = (r: number, c: number) => {
    if (!canPlay) return;
    const clicked = state.board[r][c];
    if (selected && legalSet.has(`${r},${c}`)) {
      executeMove(selected, [r, c]);
      return;
    }
    if (clicked && clicked.side === mySide) {
      setSelected([r, c]);
    } else {
      setSelected(null);
    }
  };

  return (
    <div className="flex flex-col items-center">
      <div
        className="relative p-3 sm:p-5 rounded-xl shadow-2xl border border-amber-900/50 select-none"
        style={{ backgroundColor: '#e0b376' }}
      >
        <div className="grid grid-cols-9 gap-0 relative">
          {state.board.map((row, r) =>
            row.map((piece, c) => {
              const isSelected = selected && selected[0] === r && selected[1] === c;
              const isLegal = legalSet.has(`${r},${c}`);
              const isLast =
                state.lastMove &&
                ((state.lastMove.from[0] === r && state.lastMove.from[1] === c) ||
                  (state.lastMove.to[0] === r && state.lastMove.to[1] === c));

              return (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  onClick={() => handleCellClick(r, c)}
                  className="relative w-9 h-9 sm:w-11 sm:h-11 flex items-center justify-center focus:outline-none"
                >
                  {/* Horizontal line */}
                  <span
                    className="absolute bg-amber-950/60"
                    style={{
                      height: '1px',
                      left: c === 0 ? '50%' : '0',
                      right: c === 8 ? '50%' : '0',
                      top: '50%',
                    }}
                  />
                  {/* Vertical line (break at river between row 4 and 5 except edges) */}
                  <span
                    className="absolute bg-amber-950/60"
                    style={{
                      width: '1px',
                      top: r === 0 || (r === 5 && c > 0 && c < 8) ? '50%' : '0',
                      bottom: r === 9 || (r === 4 && c > 0 && c < 8) ? '50%' : '0',
                      left: '50%',
                    }}
                  />

                  {isLast && (
                    <span className="absolute inset-1 rounded-full border border-emerald-500/70 pointer-events-none" />
                  )}

                  {isLegal && !piece && (
                    <span className="z-10 w-3 h-3 rounded-full bg-emerald-600/80 shadow" />
                  )}

                  {piece && (
                    <span
                      className={`z-10 w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-bold text-base sm:text-lg shadow-md border-2 transition-transform duration-150 ${
                        piece.side === 'r'
                          ? 'bg-amber-50 text-red-700 border-red-700'
                          : 'bg-amber-50 text-slate-900 border-slate-800'
                      } ${isSelected ? 'scale-110 ring-2 ring-emerald-500' : ''} ${
                        isLegal ? 'ring-2 ring-rose-500' : ''
                      }`}
                    >
                      {PIECE_LABELS[piece.side][piece.type]}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        {/* River label */}
        <div className="flex justify-between px-8 text-xs sm:text-sm font-display font-semibold text-amber-950/70 tracking-widest pointer-events-none -mt-1">
          <span>楚 河</span>
          <span>漢 界</span>
        </div>
      </div>
    </div>
  );
};
