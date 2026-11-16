import React, { useEffect, useState } from 'react';
import { GameComponentProps } from './GomokuGame';
import { soundFX } from '../../utils/sound';

type Side = 'w' | 'b'; // w = p1, b = p2
type PieceType = 'K' | 'Q' | 'R' | 'B' | 'N' | 'P';

interface Piece {
  side: Side;
  type: PieceType;
}

type Board = (Piece | null)[][];

interface ChessState {
  board: Board;
  lastMove: { from: [number, number]; to: [number, number] } | null;
}

const SYMBOLS: Record<Side, Record<PieceType, string>> = {
  w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
  b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' },
};

function createInitialBoard(): Board {
  const b: Board = Array.from({ length: 8 }, () => Array<Piece | null>(8).fill(null));
  const back: PieceType[] = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  back.forEach((t, c) => {
    b[0][c] = { side: 'b', type: t };
    b[7][c] = { side: 'w', type: t };
  });
  for (let c = 0; c < 8; c++) {
    b[1][c] = { side: 'b', type: 'P' };
    b[6][c] = { side: 'w', type: 'P' };
  }
  return b;
}

function inBounds(r: number, c: number) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function getLegalMoves(board: Board, r: number, c: number): [number, number][] {
  const p = board[r][c];
  if (!p) return [];
  const moves: [number, number][] = [];
  const { side, type } = p;

  const slide = (dirs: [number, number][]) => {
    for (const [dr, dc] of dirs) {
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
  };

  if (type === 'P') {
    const dir = side === 'w' ? -1 : 1;
    const startRow = side === 'w' ? 6 : 1;
    if (inBounds(r + dir, c) && !board[r + dir][c]) {
      moves.push([r + dir, c]);
      if (r === startRow && !board[r + dir * 2][c]) {
        moves.push([r + dir * 2, c]);
      }
    }
    for (const dc of [-1, 1]) {
      if (inBounds(r + dir, c + dc)) {
        const t = board[r + dir][c + dc];
        if (t && t.side !== side) moves.push([r + dir, c + dc]);
      }
    }
  } else if (type === 'N') {
    for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc)) {
        const t = board[nr][nc];
        if (!t || t.side !== side) moves.push([nr, nc]);
      }
    }
  } else if (type === 'B') {
    slide([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
  } else if (type === 'R') {
    slide([[1, 0], [-1, 0], [0, 1], [0, -1]]);
  } else if (type === 'Q') {
    slide([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);
  } else if (type === 'K') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (inBounds(nr, nc)) {
          const t = board[nr][nc];
          if (!t || t.side !== side) moves.push([nr, nc]);
        }
      }
    }
  }

  return moves;
}

const VALUES: Record<PieceType, number> = { K: 1000, Q: 90, R: 50, B: 30, N: 30, P: 10 };

function pickAIMove(board: Board): { from: [number, number]; to: [number, number] } | null {
  const candidates: { from: [number, number]; to: [number, number]; score: number }[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.side === 'b') {
        for (const [nr, nc] of getLegalMoves(board, r, c)) {
          const target = board[nr][nc];
          let score = target ? VALUES[target.type] * 10 : 0;
          if (nr > r) score += 2;
          score += Math.random() * 2;
          candidates.push({ from: [r, c], to: [nr, nc], score });
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return { from: candidates[0].from, to: candidates[0].to };
}

export const ChessGame: React.FC<GameComponentProps> = ({
  mode,
  myRole,
  currentTurn,
  boardState,
  winner,
  onMove,
  moveCount,
}) => {
  const state: ChessState = (boardState as ChessState) || {
    board: createInitialBoard(),
    lastMove: null,
  };
  const [selected, setSelected] = useState<[number, number] | null>(null);

  const canPlay = !winner && myRole !== 'spectator' && (mode === 'ai' ? currentTurn === 'p1' : myRole === currentTurn);
  const mySide: Side = currentTurn === 'p1' ? 'w' : 'b';

  const legalTargets = selected ? getLegalMoves(state.board, selected[0], selected[1]) : [];
  const legalSet = new Set(legalTargets.map(([r, c]) => `${r},${c}`));

  const executeMove = (from: [number, number], to: [number, number]) => {
    const nextBoard = state.board.map((row) => [...row]);
    const moving = nextBoard[from[0]][from[1]];
    const target = nextBoard[to[0]][to[1]];

    if (moving && moving.type === 'P' && (to[0] === 0 || to[0] === 7)) {
      nextBoard[to[0]][to[1]] = { side: moving.side, type: 'Q' };
    } else {
      nextBoard[to[0]][to[1]] = moving;
    }
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
        if (move) executeMove(move.from, move.to);
        else onMove(state, 'p1', moveCount, 'p1');
      }, 550);
      return () => clearTimeout(timer);
    }
  }, [mode, currentTurn, winner, myRole, state.board]);

  const handleCellClick = (r: number, c: number) => {
    if (!canPlay) return;
    if (selected && legalSet.has(`${r},${c}`)) {
      executeMove(selected, [r, c]);
      return;
    }
    const clicked = state.board[r][c];
    if (clicked && clicked.side === mySide) {
      setSelected([r, c]);
    } else {
      setSelected(null);
    }
  };

  return (
    <div className="flex flex-col items-center">
      <div className="p-2 sm:p-3 rounded-xl bg-slate-800 border border-slate-700 shadow-2xl select-none">
        <div className="grid grid-cols-8 border border-slate-700 overflow-hidden rounded-lg">
          {state.board.map((row, r) =>
            row.map((piece, c) => {
              const isDark = (r + c) % 2 === 1;
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
                  className={`relative w-10 h-10 sm:w-13 sm:h-13 flex items-center justify-center text-3xl sm:text-4xl transition-colors focus:outline-none ${
                    isDark ? 'bg-slate-600' : 'bg-slate-200'
                  } ${isSelected ? 'ring-2 ring-inset ring-emerald-400 bg-emerald-500/30' : ''} ${
                    isLast ? 'bg-amber-400/30' : ''
                  }`}
                >
                  {isLegal && !piece && (
                    <span className="w-3.5 h-3.5 rounded-full bg-emerald-500/70" />
                  )}
                  {isLegal && piece && (
                    <span className="absolute inset-1 rounded-full border-2 border-rose-500 pointer-events-none" />
                  )}
                  {piece && (
                    <span
                      className={`drop-shadow ${
                        piece.side === 'w' ? 'text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]' : 'text-slate-950'
                      }`}
                    >
                      {SYMBOLS[piece.side][piece.type]}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
