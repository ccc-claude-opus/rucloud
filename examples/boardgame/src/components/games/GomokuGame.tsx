import React, { useEffect, useState } from 'react';
import { soundFX } from '../../utils/sound';

export interface GameComponentProps {
  mode: 'ai' | 'pvp';
  myRole: 'p1' | 'p2' | 'spectator';
  currentTurn: 'p1' | 'p2';
  boardState: unknown;
  winner: 'p1' | 'p2' | 'draw' | null;
  onMove: (
    newBoardState: unknown,
    nextTurn: 'p1' | 'p2',
    moveCount: number,
    winner?: 'p1' | 'p2' | 'draw' | null
  ) => void;
  moveCount: number;
}

const SIZE = 15;
type Cell = 0 | 1 | 2; // 0 empty, 1 p1 (black), 2 p2 (white)

interface GomokuState {
  board: Cell[][];
  lastMove: [number, number] | null;
}

function createInitialState(): GomokuState {
  return {
    board: Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(0)),
    lastMove: null,
  };
}

function checkWin(board: Cell[][], r: number, c: number, player: Cell): boolean {
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let k = 1; k < 5; k++) {
      const nr = r + dr * k;
      const nc = c + dc * k;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] === player) count++;
      else break;
    }
    for (let k = 1; k < 5; k++) {
      const nr = r - dr * k;
      const nc = c - dc * k;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] === player) count++;
      else break;
    }
    if (count >= 5) return true;
  }
  return false;
}

function evaluatePoint(board: Cell[][], r: number, c: number, player: Cell): number {
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  let score = 0;
  for (const [dr, dc] of dirs) {
    let count = 1;
    let openEnds = 0;
    for (let k = 1; k < 5; k++) {
      const nr = r + dr * k;
      const nc = c + dc * k;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
        if (board[nr][nc] === player) count++;
        else {
          if (board[nr][nc] === 0) openEnds++;
          break;
        }
      } else break;
    }
    for (let k = 1; k < 5; k++) {
      const nr = r - dr * k;
      const nc = c - dc * k;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
        if (board[nr][nc] === player) count++;
        else {
          if (board[nr][nc] === 0) openEnds++;
          break;
        }
      } else break;
    }
    if (count >= 5) score += 100000;
    else if (count === 4 && openEnds === 2) score += 10000;
    else if (count === 4 && openEnds === 1) score += 1500;
    else if (count === 3 && openEnds === 2) score += 1000;
    else if (count === 3 && openEnds === 1) score += 200;
    else if (count === 2 && openEnds === 2) score += 100;
    else score += count * 10;
  }
  return score;
}

function pickAIMove(board: Cell[][]): [number, number] {
  let bestScore = -1;
  let bestMoves: [number, number][] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0) continue;
      const attack = evaluatePoint(board, r, c, 2);
      const defend = evaluatePoint(board, r, c, 1) * 1.1;
      const centerBias = 14 - (Math.abs(r - 7) + Math.abs(c - 7));
      const total = Math.max(attack, defend) + centerBias;
      if (total > bestScore) {
        bestScore = total;
        bestMoves = [[r, c]];
      } else if (total === bestScore) {
        bestMoves.push([r, c]);
      }
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)] || [7, 7];
}

export const GomokuGame: React.FC<GameComponentProps> = ({
  mode,
  myRole,
  currentTurn,
  boardState,
  winner,
  onMove,
  moveCount,
}) => {
  const state: GomokuState = (boardState as GomokuState) || createInitialState();
  const [hover, setHover] = useState<[number, number] | null>(null);

  const canPlay = !winner && myRole !== 'spectator' && (mode === 'ai' ? currentTurn === 'p1' : myRole === currentTurn);

  useEffect(() => {
    if (mode === 'ai' && currentTurn === 'p2' && !winner && myRole === 'p1') {
      const timer = setTimeout(() => {
        const [r, c] = pickAIMove(state.board);
        const nextBoard = state.board.map((row) => [...row]);
        nextBoard[r][c] = 2;
        const won = checkWin(nextBoard, r, c, 2);
        if (won) soundFX.playWin();
        else soundFX.playMove();
        onMove({ board: nextBoard, lastMove: [r, c] }, 'p1', moveCount + 1, won ? 'p2' : null);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [mode, currentTurn, winner, myRole, state.board, moveCount, onMove]);

  const handleCellClick = (r: number, c: number) => {
    if (!canPlay || state.board[r][c] !== 0) return;
    const playerNum: Cell = currentTurn === 'p1' ? 1 : 2;
    const nextBoard = state.board.map((row) => [...row]);
    nextBoard[r][c] = playerNum;
    const won = checkWin(nextBoard, r, c, playerNum);
    if (won) soundFX.playWin();
    else soundFX.playMove();
    onMove(
      { board: nextBoard, lastMove: [r, c] },
      currentTurn === 'p1' ? 'p2' : 'p1',
      moveCount + 1,
      won ? currentTurn : null
    );
  };

  const starPoints = new Set(['3,3', '3,11', '7,7', '11,3', '11,11']);

  return (
    <div className="flex flex-col items-center">
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
                  className="relative w-6 h-6 sm:w-8 sm:h-8 flex items-center justify-center focus:outline-none"
                  aria-label={`Row ${r + 1} Col ${c + 1}`}
                >
                  {/* Grid lines */}
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
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-950/80 z-0" />
                  )}
                  {cell !== 0 && (
                    <span
                      className={`z-10 w-5 h-5 sm:w-6.5 sm:h-6.5 rounded-full shadow-md transition-transform duration-150 ${
                        cell === 1
                          ? 'bg-gradient-to-br from-slate-700 to-slate-950 border border-slate-800'
                          : 'bg-gradient-to-br from-white to-slate-200 border border-slate-300'
                      } ${isLast ? 'ring-2 ring-emerald-400' : ''}`}
                    />
                  )}
                  {cell === 0 && canPlay && hover && hover[0] === r && hover[1] === c && (
                    <span
                      className={`z-10 w-4 h-4 sm:w-5 sm:h-5 rounded-full opacity-40 ${
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
    </div>
  );
};
