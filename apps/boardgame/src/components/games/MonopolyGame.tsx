import React, { useEffect } from 'react';
import { GameComponentProps } from './GomokuGame';
import { soundFX } from '../../utils/sound';

interface Tile {
  id: number;
  name: string;
  type: 'go' | 'prop' | 'chance' | 'tax' | 'jail';
  price?: number;
  rent?: number;
  color?: string;
}

const TILES: Tile[] = [
  { id: 0, name: '起點 +2000', type: 'go' },
  { id: 1, name: '台北車站', type: 'prop', price: 1200, rent: 240, color: '#38bdf8' },
  { id: 2, name: '西門町', type: 'prop', price: 1400, rent: 280, color: '#38bdf8' },
  { id: 3, name: '機會', type: 'chance' },
  { id: 4, name: '忠孝東路', type: 'prop', price: 1800, rent: 360, color: '#f59e0b' },
  { id: 5, name: '所得稅 -1000', type: 'tax' },
  { id: 6, name: '信義計畫', type: 'prop', price: 2400, rent: 500, color: '#f59e0b' },
  { id: 7, name: '休息站', type: 'jail' },
  { id: 8, name: '台中逢甲', type: 'prop', price: 1600, rent: 320, color: '#10b981' },
  { id: 9, name: '命運', type: 'chance' },
  { id: 10, name: '台南安平', type: 'prop', price: 1800, rent: 360, color: '#10b981' },
  { id: 11, name: '高雄巨蛋', type: 'prop', price: 2200, rent: 440, color: '#ef4444' },
  { id: 12, name: '豪華稅 -1200', type: 'tax' },
  { id: 13, name: '花蓮太魯閣', type: 'prop', price: 2000, rent: 400, color: '#ef4444' },
  { id: 14, name: '機會', type: 'chance' },
  { id: 15, name: '台北 101', type: 'prop', price: 3200, rent: 700, color: '#a855f7' },
];

interface MonopolyState {
  pos: { p1: number; p2: number };
  money: { p1: number; p2: number };
  owners: Record<number, 'p1' | 'p2'>;
  lastDice: number;
  log: string;
}

function createInitialState(): MonopolyState {
  return {
    pos: { p1: 0, p2: 0 },
    money: { p1: 10000, p2: 10000 },
    owners: {},
    lastDice: 0,
    log: '遊戲開始！每位玩家初始資金 $10,000。',
  };
}

// Grid positions for 16 tiles around a 5x5 perimeter
const TILE_GRID_POS: [number, number][] = [
  [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
  [1, 4], [2, 4], [3, 4], [4, 4],
  [4, 3], [4, 2], [4, 1], [4, 0],
  [3, 0], [2, 0], [1, 0],
];

export const MonopolyGame: React.FC<GameComponentProps> = ({
  mode,
  myRole,
  currentTurn,
  boardState,
  winner,
  onMove,
  moveCount,
}) => {
  const state: MonopolyState = (boardState as MonopolyState) || createInitialState();
  const canPlay = !winner && myRole !== 'spectator' && (mode === 'ai' ? currentTurn === 'p1' : myRole === currentTurn);

  const rollAndMove = (player: 'p1' | 'p2') => {
    const dice = Math.floor(Math.random() * 6) + 1;
    const oldPos = state.pos[player];
    const newPos = (oldPos + dice) % TILES.length;
    const passedGo = oldPos + dice >= TILES.length;

    const nextMoney = { ...state.money };
    const nextOwners = { ...state.owners };
    const nextPos = { ...state.pos, [player]: newPos };
    const pLabel = player === 'p1' ? '玩家一' : mode === 'ai' ? 'AI 機器人' : '玩家二';
    let log = `${pLabel} 擲出 ${dice} 點，來到「${TILES[newPos].name}」。`;

    if (passedGo) {
      nextMoney[player] += 2000;
      log += ' 經過起點獲得 $2,000！';
    }

    const tile = TILES[newPos];
    const opp = player === 'p1' ? 'p2' : 'p1';

    if (tile.type === 'prop' && tile.price && tile.rent) {
      const owner = nextOwners[tile.id];
      if (!owner) {
        if (nextMoney[player] >= tile.price) {
          nextMoney[player] -= tile.price;
          nextOwners[tile.id] = player;
          log += ` 花費 $${tile.price} 買下此地產！`;
          soundFX.playCapture();
        } else {
          soundFX.playMove();
        }
      } else if (owner !== player) {
        nextMoney[player] -= tile.rent;
        nextMoney[owner] += tile.rent;
        log += ` 支付過路費 $${tile.rent}！`;
        soundFX.playCapture();
      } else {
        soundFX.playMove();
      }
    } else if (tile.type === 'tax') {
      const tax = tile.id === 5 ? 1000 : 1200;
      nextMoney[player] -= tax;
      log += ` 繳納稅金 $${tax}。`;
      soundFX.playMove();
    } else if (tile.type === 'chance') {
      const bonus = Math.random() > 0.45 ? 800 : -600;
      nextMoney[player] += bonus;
      log += bonus > 0 ? ` 獲得投資分紅 $${bonus}！` : ` 意外修繕支出 $${Math.abs(bonus)}。`;
      soundFX.playMove();
    } else {
      soundFX.playMove();
    }

    let newWinner: 'p1' | 'p2' | null = null;
    if (nextMoney[player] < 0) {
      newWinner = opp;
      log += ` ${pLabel} 破產了！`;
      soundFX.playWin();
    }

    onMove(
      {
        pos: nextPos,
        money: nextMoney,
        owners: nextOwners,
        lastDice: dice,
        log,
      },
      opp,
      moveCount + 1,
      newWinner
    );
  };

  useEffect(() => {
    if (mode === 'ai' && currentTurn === 'p2' && !winner && myRole === 'p1') {
      const timer = setTimeout(() => {
        rollAndMove('p2');
      }, 750);
      return () => clearTimeout(timer);
    }
  }, [mode, currentTurn, winner, myRole, moveCount]);

  return (
    <div className="flex flex-col items-center w-full max-w-xl">
      {/* Player Money Bar */}
      <div className="w-full grid grid-cols-2 gap-3 mb-4">
        <div className={`p-3 rounded-xl border ${currentTurn === 'p1' ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-700 bg-slate-800/60'}`}>
          <div className="text-xs text-slate-400">玩家一 (藍方)</div>
          <div className="text-xl font-mono font-semibold text-white">${state.money.p1.toLocaleString()}</div>
        </div>
        <div className={`p-3 rounded-xl border ${currentTurn === 'p2' ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 bg-slate-800/60'}`}>
          <div className="text-xs text-slate-400">{mode === 'ai' ? 'AI 機器人 (紅方)' : '玩家二 (紅方)'}</div>
          <div className="text-xl font-mono font-semibold text-white">${state.money.p2.toLocaleString()}</div>
        </div>
      </div>

      {/* 5x5 Perimeter Board */}
      <div className="relative w-full aspect-square max-w-[460px] grid grid-cols-5 grid-rows-5 gap-1.5 p-2 bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl">
        {TILES.map((tile, idx) => {
          const [r, c] = TILE_GRID_POS[idx];
          const owner = state.owners[tile.id];
          const hasP1 = state.pos.p1 === idx;
          const hasP2 = state.pos.p2 === idx;

          return (
            <div
              key={tile.id}
              style={{ gridRowStart: r + 1, gridColumnStart: c + 1 }}
              className={`relative rounded-lg p-1.5 flex flex-col justify-between border text-[11px] leading-tight select-none ${
                owner === 'p1'
                  ? 'border-sky-500 bg-sky-950/50'
                  : owner === 'p2'
                  ? 'border-rose-500 bg-rose-950/50'
                  : 'border-slate-700 bg-slate-800/90'
              }`}
            >
              {tile.color && (
                <div className="h-1.5 w-full rounded-sm mb-0.5" style={{ backgroundColor: tile.color }} />
              )}
              <div className="font-medium text-slate-100 truncate">{tile.name}</div>
              {tile.price && (
                <div className="font-mono text-[10px] text-slate-400">${tile.price}</div>
              )}
              <div className="flex items-center gap-1 mt-0.5 min-h-[14px]">
                {hasP1 && <span className="w-3.5 h-3.5 rounded-full bg-sky-400 border border-white shadow" title="玩家一" />}
                {hasP2 && <span className="w-3.5 h-3.5 rounded-full bg-rose-500 border border-white shadow" title="玩家二" />}
              </div>
            </div>
          );
        })}

        {/* Center Action Area */}
        <div className="col-start-2 col-end-5 row-start-2 row-end-5 flex flex-col items-center justify-center p-4 bg-slate-800/50 rounded-xl border border-slate-700/60 text-center">
          <div className="text-xs text-slate-400 mb-1">最新動態</div>
          <p className="text-xs sm:text-sm text-slate-200 mb-4 line-clamp-3">{state.log}</p>
          {state.lastDice > 0 && (
            <div className="mb-3 text-2xl font-mono font-bold text-amber-400">
              骰子：{state.lastDice}
            </div>
          )}
          <button
            type="button"
            disabled={!canPlay}
            onClick={() => rollAndMove(currentTurn)}
            className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-sm transition-colors shadow-lg cursor-pointer"
          >
            {winner ? '遊戲結束' : canPlay ? '擲骰子前進' : '等待對手行動'}
          </button>
        </div>
      </div>
    </div>
  );
};
