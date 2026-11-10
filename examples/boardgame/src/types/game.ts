export type GameType = 'xiangqi' | 'gomoku' | 'chess' | 'checkers' | 'monopoly';
export type GameMode = 'ai' | 'pvp';
export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface PlayerInfo {
  id: string;
  name: string;
  elo: number;
  side?: 'p1' | 'p2';
}

export interface RoomSummary {
  id: string;
  gameType: GameType;
  mode: GameMode;
  status: RoomStatus;
  hostName: string;
  guestName?: string;
  spectatorCount: number;
  moveCount: number;
  currentTurn: 'p1' | 'p2';
  winner?: 'p1' | 'p2' | 'draw' | null;
  createdAt: number;
  boardState?: unknown;
}

export interface ChatMessage {
  id: string;
  roomId: string; // 'global' or specific roomId
  sender: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

export interface LeaderboardEntry {
  name: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  favoriteGame: GameType;
}

export const GAME_META: Record<
  GameType,
  {
    name: string;
    subtitle: string;
    playersLabel: string;
    accent: string;
  }
> = {
  xiangqi: {
    name: '中國象棋',
    subtitle: '楚河漢界，運籌帷幄',
    playersLabel: '雙人對弈',
    accent: '#ef4444',
  },
  gomoku: {
    name: '五子棋',
    subtitle: '縱橫十五路，五子連珠',
    playersLabel: '雙人對弈',
    accent: '#f59e0b',
  },
  chess: {
    name: '西洋棋',
    subtitle: '國際象棋，王車易位與將殺',
    playersLabel: '雙人對弈',
    accent: '#3b82f6',
  },
  checkers: {
    name: '跳棋',
    subtitle: '斜線跳吃，連跳封王',
    playersLabel: '雙人對弈',
    accent: '#10b981',
  },
  monopoly: {
    name: '大富翁',
    subtitle: '地產投資，擲骰致富',
    playersLabel: '雙人對戰',
    accent: '#8b5cf6',
  },
};
