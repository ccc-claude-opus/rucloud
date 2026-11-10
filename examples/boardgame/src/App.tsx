import React, { useEffect, useRef, useState } from 'react';
import { Eye, Trophy, Users, Volume2, VolumeX, RotateCcw, LogOut, Bot, Swords } from 'lucide-react';
import {
  ChatMessage,
  GAME_META,
  GameMode,
  GameType,
  LeaderboardEntry,
  RoomSummary,
} from './types/game';
import { GomokuGame } from './components/games/GomokuGame';
import { XiangqiGame } from './components/games/XiangqiGame';
import { ChessGame } from './components/games/ChessGame';
import { CheckersGame } from './components/games/CheckersGame';
import { MonopolyGame } from './components/games/MonopolyGame';
import { ChatPanel } from './components/ChatPanel';
import { soundFX } from './utils/sound';

type Tab = 'lobby' | 'monitor' | 'leaderboard' | 'arena';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('lobby');
  const [playerName, setPlayerName] = useState<string>(() => `棋友_${Math.floor(100 + Math.random() * 900)}`);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatChannel, setChatChannel] = useState<string>('global');

  const [currentRoom, setCurrentRoom] = useState<RoomSummary | null>(null);
  const [myRole, setMyRole] = useState<'p1' | 'p2' | 'spectator'>('p1');
  const [muted, setMuted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const { type, payload } = JSON.parse(event.data);
      if (type === 'init') {
        setRooms(payload.rooms || []);
        setLeaderboard(payload.leaderboard || []);
        setMessages(payload.globalChat || []);
      } else if (type === 'rooms:update') {
        setRooms(payload);
      } else if (type === 'leaderboard:update') {
        setLeaderboard(payload);
      } else if (type === 'room:joined') {
        setCurrentRoom(payload.room);
        setMyRole(payload.role);
        setChatChannel(payload.room.id);
        if (payload.chat) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const newMsgs = (payload.chat as ChatMessage[]).filter((m) => !existingIds.has(m.id));
            return [...prev, ...newMsgs];
          });
        }
        setActiveTab('arena');
      } else if (type === 'room:state') {
        setCurrentRoom(payload);
      } else if (type === 'chat:message') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === payload.id)) return prev;
          return [...prev, payload];
        });
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const sendWs = (type: string, payload: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  };

  const handleCreateRoom = (gameType: GameType, mode: GameMode) => {
    sendWs('room:create', { gameType, mode, hostName: playerName });
  };

  const handleJoinRoom = (roomId: string) => {
    sendWs('room:join', { roomId, guestName: playerName });
  };

  const handleSpectateRoom = (roomId: string) => {
    sendWs('room:spectate', { roomId });
  };

  const handleLeaveRoom = () => {
    if (currentRoom) {
      sendWs('room:leave', { roomId: currentRoom.id, role: myRole });
    }
    setCurrentRoom(null);
    setChatChannel('global');
    setActiveTab('lobby');
  };

  const handleMove = (
    boardState: unknown,
    nextTurn: 'p1' | 'p2',
    moveCount: number,
    winner?: 'p1' | 'p2' | 'draw' | null
  ) => {
    if (!currentRoom) return;
    sendWs('room:move', {
      roomId: currentRoom.id,
      boardState,
      nextTurn,
      moveCount,
      winner,
    });
  };

  const handleResetRoom = () => {
    if (!currentRoom) return;
    sendWs('room:reset', { roomId: currentRoom.id, boardState: null });
  };

  const handleSendChat = (roomId: string, text: string) => {
    sendWs('chat:send', { roomId, sender: playerName, text });
  };

  const toggleMute = () => {
    soundFX.muted = !muted;
    setMuted(!muted);
  };

  const renderGameBoard = () => {
    if (!currentRoom) return null;
    const props = {
      mode: currentRoom.mode,
      myRole,
      currentTurn: currentRoom.currentTurn,
      boardState: currentRoom.boardState,
      winner: currentRoom.winner || null,
      onMove: handleMove,
      moveCount: currentRoom.moveCount,
    };

    switch (currentRoom.gameType) {
      case 'xiangqi':
        return <XiangqiGame {...props} />;
      case 'gomoku':
        return <GomokuGame {...props} />;
      case 'chess':
        return <ChessGame {...props} />;
      case 'checkers':
        return <CheckersGame {...props} />;
      case 'monopoly':
        return <MonopolyGame {...props} />;
    }
  };

  return (
    <div className="min-h-screen bg-[#0b1120] text-slate-100 flex flex-col">
      {/* Top Bar Contract: 3 zones */}
      <header className="border-b border-slate-800/80 bg-[#0b1120]/95 sticky top-0 z-30 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('lobby')}
            className="text-xl font-display font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            棋藝軒
          </button>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            <button
              type="button"
              onClick={() => setActiveTab('lobby')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'lobby' ? 'text-white' : ''
              }`}
            >
              遊戲大廳
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('monitor')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'monitor' ? 'text-white' : ''
              }`}
            >
              即時賽況
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('leaderboard')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'leaderboard' ? 'text-white' : ''
              }`}
            >
              積分排行
            </button>
            {currentRoom && (
              <button
                type="button"
                onClick={() => setActiveTab('arena')}
                className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'arena' ? 'text-emerald-400' : 'text-emerald-500'
                }`}
              >
                返回對戰室
              </button>
            )}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => handleCreateRoom('gomoku', 'ai')}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              快速開局
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 xl:col-span-9 space-y-6">
          {activeTab === 'lobby' && (
            <>
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 border-b border-slate-800/80">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-display font-bold text-white">
                    經典棋類與桌遊對戰平台
                  </h1>
                  <p className="text-sm text-slate-400 mt-1">
                    選擇喜愛的棋類，立即與 AI 機器人切磋或建立雙人連線房間。
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="player-name" className="text-xs text-slate-400 whitespace-nowrap">
                    玩家暱稱
                  </label>
                  <input
                    id="player-name"
                    type="text"
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    maxLength={16}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500 w-36"
                  />
                </div>
              </div>

              {/* 5 Game Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {(Object.keys(GAME_META) as GameType[]).map((type) => {
                  const meta = GAME_META[type];
                  return (
                    <div
                      key={type}
                      className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between hover:border-slate-700 transition-colors"
                    >
                      <div>
                        <div className="text-xs text-slate-400 mb-1">{meta.playersLabel}</div>
                        <h2 className="text-xl font-display font-bold text-white">{meta.name}</h2>
                        <p className="text-sm text-slate-400 mt-1 mb-5">{meta.subtitle}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2.5">
                        <button
                          type="button"
                          onClick={() => handleCreateRoom(type, 'ai')}
                          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium transition-colors cursor-pointer"
                        >
                          <Bot className="w-3.5 h-3.5 text-emerald-400" />
                          <span>人機對戰</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCreateRoom(type, 'pvp')}
                          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors cursor-pointer"
                        >
                          <Swords className="w-3.5 h-3.5" />
                          <span>雙人連線</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Waiting Rooms */}
              <div className="pt-2">
                <h3 className="text-base font-semibold text-white mb-3">等待加入的對戰房</h3>
                {rooms.filter((r) => r.status === 'waiting').length === 0 ? (
                  <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-6 text-center text-sm text-slate-400">
                    目前沒有等待中的雙人房間，點擊上方「雙人連線」即可建立新房間。
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {rooms
                      .filter((r) => r.status === 'waiting')
                      .map((room) => (
                        <div
                          key={room.id}
                          className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between"
                        >
                          <div>
                            <div className="text-sm font-semibold text-white">
                              {GAME_META[room.gameType].name} · #{room.id}
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5">
                              房主：{room.hostName}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleJoinRoom(room.id)}
                            className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors cursor-pointer"
                          >
                            加入對戰
                          </button>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'monitor' && (
            <div className="space-y-4">
              <div>
                <h1 className="text-2xl font-display font-bold text-white">即時賽況監控</h1>
                <p className="text-sm text-slate-400 mt-1">
                  即時追蹤所有進行中與剛結束的對局，點擊「觀戰」即可同步觀看棋盤動態。
                </p>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-800 text-xs text-slate-400 bg-slate-900">
                      <tr>
                        <th className="px-4 py-3 font-medium">房號</th>
                        <th className="px-4 py-3 font-medium">遊戲項目</th>
                        <th className="px-4 py-3 font-medium">對戰雙方</th>
                        <th className="px-4 py-3 font-medium">回合數</th>
                        <th className="px-4 py-3 font-medium">狀態</th>
                        <th className="px-4 py-3 font-medium text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {rooms.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                            目前尚無對局紀錄
                          </td>
                        </tr>
                      ) : (
                        rooms.map((room) => (
                          <tr key={room.id} className="hover:bg-slate-800/40">
                            <td className="px-4 py-3 font-mono text-slate-300">#{room.id}</td>
                            <td className="px-4 py-3 font-medium text-white">
                              {GAME_META[room.gameType].name}
                            </td>
                            <td className="px-4 py-3 text-slate-300">
                              {room.hostName} vs {room.guestName || '等待中...'}
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-300">{room.moveCount}</td>
                            <td className="px-4 py-3 text-xs">
                              {room.status === 'playing' && (
                                <span className="text-emerald-400">進行中</span>
                              )}
                              {room.status === 'waiting' && (
                                <span className="text-amber-400">等待加入</span>
                              )}
                              {room.status === 'finished' && (
                                <span className="text-slate-400">已結束</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => handleSpectateRoom(room.id)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 transition-colors cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>觀戰</span>
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'leaderboard' && (
            <div className="space-y-4">
              <div>
                <h1 className="text-2xl font-display font-bold text-white flex items-center gap-2">
                  <Trophy className="w-6 h-6 text-amber-400" />
                  <span>積分排名系統</span>
                </h1>
                <p className="text-sm text-slate-400 mt-1">
                  採用 ELO 等級分制度，每次完成對局後系統將自動結算並更新全球排名。
                </p>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-800 text-xs text-slate-400 bg-slate-900">
                      <tr>
                        <th className="px-4 py-3 font-medium">排名</th>
                        <th className="px-4 py-3 font-medium">玩家名稱</th>
                        <th className="px-4 py-3 font-medium">ELO 積分</th>
                        <th className="px-4 py-3 font-medium">勝 / 敗 / 和</th>
                        <th className="px-4 py-3 font-medium">勝率</th>
                        <th className="px-4 py-3 font-medium">擅長項目</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {leaderboard.map((entry, idx) => {
                        const total = entry.wins + entry.losses + entry.draws;
                        const winRate = total > 0 ? Math.round((entry.wins / total) * 100) : 0;
                        return (
                          <tr key={entry.name} className="hover:bg-slate-800/40">
                            <td className="px-4 py-3 font-mono font-semibold text-slate-300">
                              {idx + 1}
                            </td>
                            <td className="px-4 py-3 font-medium text-white">{entry.name}</td>
                            <td className="px-4 py-3 font-mono font-semibold text-amber-400">
                              {entry.elo}
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-300">
                              {entry.wins} / {entry.losses} / {entry.draws}
                            </td>
                            <td className="px-4 py-3 font-mono text-emerald-400">{winRate}%</td>
                            <td className="px-4 py-3 text-slate-300">
                              {GAME_META[entry.favoriteGame]?.name || '象棋'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'arena' && currentRoom && (
            <div className="space-y-4">
              {/* Arena HUD */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{GAME_META[currentRoom.gameType].name}</span>
                    <span>·</span>
                    <span className="font-mono">#{currentRoom.id}</span>
                    <span>·</span>
                    <span>{currentRoom.mode === 'ai' ? '人機對戰' : '雙人連線'}</span>
                    {myRole === 'spectator' && (
                      <>
                        <span>·</span>
                        <span className="text-amber-400">觀戰模式</span>
                      </>
                    )}
                  </div>
                  <div className="text-base font-semibold text-white mt-0.5 flex items-center gap-2">
                    <span>{currentRoom.hostName}</span>
                    <span className="text-slate-500 text-xs">vs</span>
                    <span>{currentRoom.guestName || '等待對手加入...'}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="px-3 py-1.5 rounded-lg bg-slate-800 text-xs font-mono text-slate-300">
                    回合 {currentRoom.moveCount} ·{' '}
                    {currentRoom.winner
                      ? currentRoom.winner === 'p1'
                        ? `${currentRoom.hostName} 獲勝`
                        : `${currentRoom.guestName || '對手'} 獲勝`
                      : currentRoom.currentTurn === 'p1'
                      ? `${currentRoom.hostName} 行動`
                      : `${currentRoom.guestName || '對手'} 行動`}
                  </div>
                  <button
                    type="button"
                    onClick={toggleMute}
                    title={muted ? '開啟音效' : '靜音'}
                    className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                  >
                    {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  </button>
                  {myRole !== 'spectator' && (
                    <button
                      type="button"
                      onClick={handleResetRoom}
                      title="重新開始"
                      className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleLeaveRoom}
                    className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 text-xs font-medium cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>離開</span>
                  </button>
                </div>
              </div>

              {/* Game Board */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 sm:p-6 flex justify-center">
                {renderGameBoard()}
              </div>
            </div>
          )}
        </div>

        {/* Right Sidebar: Chatroom & Quick Stats */}
        <aside className="lg:col-span-4 xl:col-span-3 flex flex-col gap-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-emerald-400" />
              <span>線上對戰房</span>
            </div>
            <span className="font-mono font-semibold text-white text-sm">{rooms.length}</span>
          </div>

          <div className="flex-1 min-h-[380px]">
            <ChatPanel
              messages={messages}
              activeChannel={chatChannel}
              onChannelChange={setChatChannel}
              currentRoomId={currentRoom?.id || null}
              onSend={handleSendChat}
            />
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
