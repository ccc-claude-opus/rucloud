import React, { useEffect, useState } from 'react';
import { GameComponentProps } from './GomokuGame';
import { soundFX } from '../../utils/sound';

type Side = 'r' | 'b'; // r = p1 (bottom), b = p2 (top)
interface Piece {
  side: Side;
  king: boolean;
}
type Board = (Piece | null)[][];

interface CheckersState {
  board: Board;
}

interface Move {
  from: [number, number];
  to: [number, number];
  captured?: [number, number];
}

function createInitialBoard(): Board {
  const b: Board = Array.from({ length: 8 }, () => Array<Piece | null>(8).fill(null));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) b[r][c] = { side: 'b', king: false };
    }
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) b[r][c] = { side: 'r', king: false };
    }
  }
  return b;
}

function inBounds(r: number, c: number) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function getMovesForPiece(board: Board, r: number, c: number): Move[] {
  const p = board[r][c];
  if (!p) return [];
  const moves: Move[] = [];
  const dirs = p.king
    ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
    : p.side === 'r'
    ? [[-1, -1], [-1, 1]]
    : [[1, -1], [1, 1]];

  for (const [dr, dc] of dirs) {
    const nr = r + dr;
    const nc = c + dc;
    if (inBounds(nr, nc) && !board[nr][nc]) {
      moves.push({ from: [r, c], to: [nr, nc] });
    }
    const jr = r + dr * 2;
    const jc = c + dc * 2;
    if (inBounds(jr, jc) && !board[jr][jc] && board[nr]?.[nc] && board[nr][nc]!.side !== p.side) {
      moves.push({ from: [r, c], to: [jr, jc], captured: [nr, nc] });
    }
  }
  return moves;
}

function countPieces(board: Board, side: Side): number {
  let count = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.side === side) count++;
    }
  }
  return count;
}

function pickAIMove(board: Board): Move | null {
  const all: Move[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.side === 'b') {
        all.push(...getMovesForPiece(board, r, c));
      }
    }
  }
  if (all.length === 0) return null;
  const captures = all.filter((m) => m.captured);
  if (captures.length > 0) return captures[Math.floor(Math.random() * captures.length)];
  return all[Math.floor(Math.random() * all.length)];
}

export const CheckersGame: React.FC<GameComponentProps> = ({
  mode,
  myRole,
  currentTurn,
  boardState,
  winner,
  onMove,
  moveCount,
}) => {
  const state: CheckersState = (boardState as CheckersState) || { board: createInitialBoard() };
  const [selected, setSelected] = useState<[number, number] | null>(null);

  const canPlay = !winner && myRole !== 'spectator' && (mode === 'ai' ? currentTurn === 'p1' : myRole === currentTurn);
  const mySide: Side = currentTurn === 'p1' ? 'r' : 'b';

  const legalMoves = selected ? getMovesForPiece(state.board, selected[0], selected[1]) : [];
  const legalMap = new Map(legalMoves.map((m) => [`${m.to[0]},${m.to[1]}`, m]));

  const executeMove = (move: Move) => {
    const nextBoard = state.board.map((row) => [...row]);
    const piece = nextBoard[move.from[0]][move.from[1]]!;
    nextBoard[move.from[0]][move.from[1]] = null;
    if (move.captured) {
      nextBoard[move.captured[0]][move.captured[1]] = null;
    }
    const promoted = piece.king || (piece.side === 'r' && move.to[0] === 0) || (piece.side === 'b' && move.to[0] === 7);
    nextBoard[move.to[0]][move.to[1]] = { side: piece.side, king: promoted };

    const oppSide: Side = currentTurn === 'p1' ? 'b' : 'r';
    const oppCount = countPieces(nextBoard, oppSide);
    const newWinner = oppCount === 0 ? currentTurn : null;

    if (newWinner) soundFX.playWin();
    else if (move.captured) soundFX.playCapture();
    else soundFX.playMove();

    setSelected(null);
    onMove(
      { board: nextBoard },
      currentTurn === 'p1' ? 'p2' : 'p1',
      moveCount + 1,
      newWinner
    );
  };

  useEffect(() => {
    if (mode === 'ai' && currentTurn === 'p2' && !winner && myRole === 'p1') {
      const timer = setTimeout(() => {
        const move = pickAIMove(state.board);
        if (move) executeMove(move);
        else onMove(state, 'p1', moveCount, 'p1');
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [mode, currentTurn, winner, myRole, state.board]);

  const handleCellClick = (r: number, c: number) => {
    if (!canPlay) return;
    const move = legalMap.get(`${r},${c}`);
    if (move) {
      executeMove(move);
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
              const isLegal = legalMap.has(`${r},${c}`);

              return (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  onClick={() => handleCellClick(r, c)}
                  className={`relative w-10 h-10 sm:w-12 sm:h-12 flex items-center justify-center focus:outline-none ${
                    isDark ? 'bg-emerald-950' : 'bg-amber-100'
                  } ${isSelected ? 'ring-2 ring-inset ring-amber-400' : ''}`}
                >
                  {isLegal && (
                    <span className="w-4 h-4 rounded-full bg-emerald-400/70 animate-pulse" />
                  )}
                  {piece && (
                    <span
                      className={`w-7 h-7 sm:w-9 sm:h-9 rounded-full shadow-lg border-2 flex items-center justify-center text-xs font-bold ${
                        piece.side === 'r'
                          ? 'bg-rose-600 border-rose-300 text-white'
                          : 'bg-slate-900 border-slate-400 text-amber-300'
                      }`}
                    >
                      {piece.king ? '♛' : ''}
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
