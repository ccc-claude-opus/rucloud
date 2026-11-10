import React, { useEffect, useRef, useState } from 'react';
import { Send, MessageSquare } from 'lucide-react';
import { ChatMessage } from '../types/game';

interface ChatPanelProps {
  messages: ChatMessage[];
  activeChannel: string; // 'global' or roomId
  onChannelChange?: (channel: string) => void;
  currentRoomId: string | null;
  onSend: (roomId: string, text: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  activeChannel,
  onChannelChange,
  currentRoomId,
  onSend,
}) => {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = messages.filter((m) => m.roomId === activeChannel);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered.length, activeChannel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(activeChannel, input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <MessageSquare className="w-4 h-4 text-emerald-400" />
          <span>即時聊天室</span>
        </div>
        {currentRoomId && onChannelChange && (
          <div className="flex items-center gap-1 p-0.5 bg-slate-800 rounded-lg text-xs">
            <button
              type="button"
              onClick={() => onChannelChange('global')}
              className={`px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
                activeChannel === 'global'
                  ? 'bg-slate-700 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              大廳
            </button>
            <button
              type="button"
              onClick={() => onChannelChange(currentRoomId)}
              className={`px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
                activeChannel === currentRoomId
                  ? 'bg-slate-700 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              對戰房
            </button>
          </div>
        )}
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2.5 min-h-[240px] max-h-[420px]">
        {filtered.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-8">尚無訊息，打聲招呼吧！</div>
        ) : (
          filtered.map((msg) => (
            <div key={msg.id} className={`text-sm leading-relaxed ${msg.isSystem ? 'text-slate-400 italic text-xs' : ''}`}>
              {!msg.isSystem && (
                <span className="font-semibold text-emerald-400 mr-1.5">{msg.sender}:</span>
              )}
              <span className={msg.isSystem ? '' : 'text-slate-200'}>{msg.text}</span>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-2.5 border-t border-slate-800 flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="輸入訊息..."
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          aria-label="傳送訊息"
          className="p-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors shrink-0"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
