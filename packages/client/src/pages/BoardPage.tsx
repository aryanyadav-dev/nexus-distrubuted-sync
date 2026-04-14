import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import {
  HiOutlineArrowLeft,
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineChatBubbleLeftRight,
  HiCheck,
  HiOutlineSignal,
  HiOutlineSignalSlash,
  HiOutlineBugAnt,
  HiOutlineArrowRightOnRectangle,
  HiOutlineXMark,
} from 'react-icons/hi2';
import { useAuthStore } from '../stores/authStore';
import { useSyncStore, type SyncLogEntry, type LogLevel } from '../stores/syncStore';
import { getDocument, getWorkspaceMembers } from '../lib/api';
import { SyncClient, type SyncEvent } from '../lib/SyncClient';
import type { ChecklistContent, ChecklistItem, Presence, ConflictMeta } from '@dsync/shared';
import { motion, AnimatePresence } from 'framer-motion';
import { getWsUrl } from '../lib/runtimeConfig';

const WS_URL = getWsUrl();

const AVATAR_SHADES = [
  '#444', '#555', '#666', '#777', '#888',
];

type ChatMessage = {
  id: string;
  sender: string;
  text: string;
  ts: number;
};

function getAvatarShade(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_SHADES[Math.abs(hash) % AVATAR_SHADES.length];
}

export default function BoardPage() {
  const { workspaceId, documentId } = useParams<{ workspaceId: string; documentId: string }>();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const connectionStatus = useSyncStore((s) => s.connectionStatus);
  const content = useSyncStore((s) => s.content);
  const revision = useSyncStore((s) => s.revision);
  const presence = useSyncStore((s) => s.presence);
  const logs = useSyncStore((s) => s.logs);
  const conflicts = useSyncStore((s) => s.conflicts);

  const setConnectionStatus = useSyncStore((s) => s.setConnectionStatus);
  const setDocument = useSyncStore((s) => s.setDocument);
  const applyLocalPatch = useSyncStore((s) => s.applyLocalPatch);
  const applyRemotePatch = useSyncStore((s) => s.applyRemotePatch);
  const setFullContent = useSyncStore((s) => s.setFullContent);
  const setPresence = useSyncStore((s) => s.setPresence);
  const addConflict = useSyncStore((s) => s.addConflict);
  const addLog = useSyncStore((s) => s.addLog);
  const clearLogs = useSyncStore((s) => s.clearLogs);

  const clientRef = useRef<SyncClient | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [newItemText, setNewItemText] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [noteItemId, setNoteItemId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [selectedDetailsId, setSelectedDetailsId] = useState<string | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<Array<{ userId: string; displayName: string }>>([]);

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);

  const chatMessages = React.useMemo(() => {
    if (!content) return [];
    const rawContent = content as Record<string, unknown>;
    return Object.keys(rawContent)
      .filter((k) => k.startsWith('chat_'))
      .map((k) => rawContent[k])
      .filter((message): message is ChatMessage => {
        return !!message
          && typeof message === 'object'
          && typeof (message as ChatMessage).id === 'string'
          && typeof (message as ChatMessage).sender === 'string'
          && typeof (message as ChatMessage).text === 'string'
          && typeof (message as ChatMessage).ts === 'number';
      })
      .sort((a, b) => a.ts - b.ts);
  }, [content]);

  useEffect(() => {
    if (isChatOpen) {
      chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !user) return;
    const msgId = `chat_${Date.now()}_${user.id}`;
    sendPatch({
      [msgId]: {
        id: msgId,
        sender: user.displayName,
        text: chatInput.trim(),
        ts: Date.now(),
      }
    });
    setChatInput('');
  };

  const handleChatTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setChatInput(e.target.value);
    clientRef.current?.sendTyping(documentId!, 'chat');
  };

  const chatTyping = useSyncStore(s => s.typing['chat'] || []);

  useEffect(() => {
    if (!token || !documentId) return;

    if (workspaceId) {
      getWorkspaceMembers(workspaceId).then(res => {
        if (res.ok) {
          setWorkspaceMembers(res.data.map(m => ({ userId: m.userId, displayName: m.user?.displayName || 'Unknown' })));
        }
      });
    }

    const client = new SyncClient({ url: WS_URL, token });
    clientRef.current = client;

    const handler = (event: SyncEvent) => {
      switch (event.type) {
        case 'connected':
          setConnectionStatus('connected');
          addLog('info', 'WebSocket connected');
          break;
        case 'authenticated':
          setConnectionStatus('authenticated');
          addLog('success', `Authenticated as ${event.displayName}`);
          break;
        case 'disconnected':
          setConnectionStatus('disconnected');
          addLog('warning', `Disconnected${event.reason ? `: ${event.reason}` : ''}`);
          break;
        case 'reconnecting':
          setConnectionStatus('connecting');
          addLog('warning', `Reconnecting (attempt ${event.attempt}, ${event.delayMs}ms)`);
          break;
        case 'offline':
          setConnectionStatus('offline');
          addLog('warning', 'Offline — mutations buffered');
          break;
        case 'online':
          addLog('success', 'Back online');
          break;
        case 'snapshot':
          setDocument(documentId, workspaceId!, event.message.content as ChecklistContent, event.message.revision);
          addLog('info', `Snapshot received (rev ${event.message.revision})`);
          break;
        case 'mutation_ack':
          addLog('success', `Mutation acked (rev ${event.message.revision})${event.message.conflictMeta ? ' — conflict' : ''}`);
          if (event.message.conflictMeta) {
            addConflict(event.message.correlationId, event.message.conflictMeta);
            addLog('conflict', `Conflict on fields: ${event.message.conflictMeta.conflictingFields.join(', ')}`);
          }
          break;
        case 'remote_update':
          applyRemotePatch(event.message.patch, event.message.revision);
          addLog('info', `Remote update from ${event.message.displayName} (rev ${event.message.revision})`);
          break;
        case 'presence_update':
          setPresence(event.message.presence);
          break;
        case 'conflict':
          addConflict(event.message.correlationId, event.message.conflictMeta);
          addLog('conflict', `Conflict: ${event.message.conflictMeta.conflictingFields.join(', ')}`);
          break;
        case 'typing_update':
          useSyncStore.getState().setTyping(event.message.userId, event.message.displayName, event.message.context);
          break;
        case 'error':
          addLog('error', `Error: ${event.message.message}`);
          break;
        case 'heartbeat_ack':
          break;
      }
    };

    client.on(handler);
    client.connect();
    client.subscribe(documentId);

    return () => {
      client.unsubscribe(documentId);
      client.disconnect();
      clientRef.current = null;
      setConnectionStatus('disconnected');
    };
  }, [token, documentId]);

  useEffect(() => {
    const timer = setInterval(() => {
      useSyncStore.getState().clearStaleTyping();
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const sendPatch = useCallback((patch: Record<string, unknown>) => {
    clientRef.current?.mutate(documentId!, patch);
    applyLocalPatch(patch);
  }, [documentId]);

  const handleAddItem = () => {
    if (!newItemText.trim() || !user) return;
    const itemId = uuidv4();
    const item: ChecklistItem = {
      id: itemId,
      text: newItemText.trim(),
      completed: false,
      createdBy: user.displayName,
      createdAt: new Date().toISOString(),
      order: Object.keys(content?.items ?? {}).length,
    };
    sendPatch({ items: { [itemId]: item } });
    setNewItemText('');
  };

  const handleToggleItem = (itemId: string) => {
    const item = content?.items?.[itemId];
    if (!item) return;
    sendPatch({ items: { [itemId]: { ...item, completed: !item.completed } } });
  };

  const handleDeleteItem = (itemId: string) => {
    sendPatch({ items: { [itemId]: null } });
  };

  const handleSaveEdit = (itemId: string) => {
    if (!editingText.trim()) { setEditingItemId(null); return; }
    const item = content?.items?.[itemId];
    if (!item) return;
    sendPatch({ items: { [itemId]: { ...item, text: editingText.trim() } } });
    setEditingItemId(null);
  };

  const handleSaveNote = (itemId: string) => {
    const item = content?.items?.[itemId];
    if (!item) return;
    sendPatch({ items: { [itemId]: { ...item, note: noteText } } });
    setNoteItemId(null);
  };

  const handleUpdateTitle = (newTitle: string) => {
    if (!newTitle.trim()) return;
    sendPatch({ title: newTitle.trim() });
  };

  const handleUpdateDescription = (newDesc: string) => {
    sendPatch({ description: newDesc });
  };

  const allItems = Object.values(content?.items ?? {}) as ChecklistItem[];
  const todoItems = allItems.filter((i) => !i.completed).sort((a, b) => a.order - b.order);
  const doneItems = allItems.filter((i) => i.completed).sort((a, b) => a.order - b.order);

  const isConnected = connectionStatus === 'authenticated';

  return (
    <div className="min-h-screen flex flex-col bg-transparent text-white">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-white/[0.02] backdrop-blur-xl">
        <div className="max-w-full mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/workspaces')}
              className="text-neutral-500 hover:text-white transition-colors text-sm flex items-center gap-1"
            >
              <HiOutlineArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="w-px h-5 bg-white/10" />
            <span className="font-semibold tracking-tight text-sm text-indigo-100">
              Nexus
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Connection status */}
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              {isConnected ? (
                <HiOutlineSignal className="w-3.5 h-3.5 text-white" />
              ) : (
                <HiOutlineSignalSlash className="w-3.5 h-3.5 text-neutral-600" />
              )}
              <span>{isConnected ? 'Connected' : connectionStatus}</span>
              <span className="text-neutral-700">rev {revision}</span>
            </div>

            {/* Presence avatars */}
            <div className="flex -space-x-1.5">
              {presence.filter((p) => p.isActive).map((p) => (
                <div
                  key={p.userId}
                  className="w-6 h-6 rounded-full border border-black flex items-center justify-center text-[10px] font-bold text-white"
                  style={{ background: getAvatarShade(p.userId) }}
                  title={p.displayName}
                >
                  {p.displayName.charAt(0).toUpperCase()}
                </div>
              ))}
            </div>

            <button
              onClick={() => setIsChatOpen(!isChatOpen)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-all flex items-center gap-1.5 font-medium ${
                isChatOpen
                  ? 'bg-white/10 border-white/20 text-white shadow-[0_0_15px_rgba(255,255,255,0.1)]'
                  : 'bg-transparent border-white/10 text-neutral-400 hover:text-white hover:border-white/20'
              }`}
            >
              <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" /> Chat
            </button>

            <button
              onClick={() => setShowDebug(!showDebug)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-all flex items-center gap-1.5 font-medium ${
                showDebug
                  ? 'bg-white/10 border-white/20 text-white shadow-[0_0_15px_rgba(255,255,255,0.1)]'
                  : 'bg-transparent border-white/10 text-neutral-400 hover:text-white hover:border-white/20'
              }`}
            >
              <HiOutlineBugAnt className="w-3.5 h-3.5" /> Debug
            </button>

            <div className="w-px h-5 bg-white/10" />
            <span className="text-xs text-neutral-400 font-medium">{user?.displayName}</span>
            <button onClick={logout} className="text-neutral-400 hover:text-white transition-colors p-1.5 hover:bg-white/10 rounded-full" title="Sign Out">
              <HiOutlineArrowRightOnRectangle className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Main content — Kanban */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Title bar */}
          <div className="px-6 pt-6 pb-4">
            {content ? (
              <div className="flex items-baseline gap-3">
                <EditableText
                  value={content.title}
                  onSave={handleUpdateTitle}
                  className="text-xl font-bold"
                  placeholder="Document title"
                />
                <EditableText
                  value={content.description || ''}
                  onSave={handleUpdateDescription}
                  className="text-sm text-neutral-500"
                  placeholder="Add description..."
                />
              </div>
            ) : (
              <div className="animate-pulse">
                <div className="h-8 bg-white/10 rounded-xl w-64 mb-3" />
              </div>
            )}
          </div>

          {/* Kanban columns */}
          <div className="flex-1 flex gap-4 px-6 pb-6 overflow-x-auto">
            {/* TODO column */}
            <div className="flex-1 min-w-[280px] flex flex-col p-2">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-white flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                  To Do <span className="text-neutral-500 text-xs ml-1 bg-white/10 px-2 py-0.5 rounded-full">{todoItems.length}</span>
                </h3>
              </div>

              {/* Add item input */}
              <div className="flex gap-2 mb-4">
                <input
                  className="input py-2 bg-white/[0.02] border-white/5 focus:border-indigo-500/50"
                  placeholder="What needs to be done?"
                  value={newItemText}
                  onChange={(e) => setNewItemText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddItem()}
                />
                <button
                  onClick={handleAddItem}
                  disabled={!newItemText.trim()}
                  className="flex items-center justify-center w-10 h-10 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-xl hover:from-indigo-400 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-[0_0_15px_rgba(99,102,241,0.3)] shrink-0"
                >
                  <HiOutlinePlus className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto pr-2 pb-10">
                <AnimatePresence mode="popLayout">
                  {todoItems.map((item) => (
                    <motion.div
                      key={item.id}
                      layout
                      initial={{ opacity: 0, scale: 0.95, y: 10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                      transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    >
                      <KanbanCard
                        item={item}
                        members={workspaceMembers}
                        isEditing={editingItemId === item.id}
                        editingText={editingText}
                        isNoteEditing={noteItemId === item.id}
                        noteText={noteText}
                        onToggle={() => handleToggleItem(item.id)}
                        onDelete={() => handleDeleteItem(item.id)}
                        onOpenDetails={() => setSelectedDetailsId(item.id)}
                        onStartEdit={() => { setEditingItemId(item.id); setEditingText(item.text); }}
                        onCancelEdit={() => setEditingItemId(null)}
                        onEditingTextChange={setEditingText}
                        onSaveEdit={() => handleSaveEdit(item.id)}
                        onStartNote={() => { setNoteItemId(item.id); setNoteText(item.note || ''); }}
                        onCancelNote={() => setNoteItemId(null)}
                        onNoteTextChange={setNoteText}
                        onSaveNote={() => handleSaveNote(item.id)}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {todoItems.length === 0 && content && (
                  <div className="text-center py-8 text-neutral-700 text-sm">
                    No items yet
                  </div>
                )}
              </div>
            </div>

            {/* DONE column */}
            <div className="flex-1 min-w-[280px] flex flex-col p-2">
              <div className="flex items-center justify-between mb-4 mt-[3.5rem]">
                <h3 className="text-sm font-medium text-white flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
                  Done <span className="text-neutral-500 text-xs ml-1 bg-white/10 px-2 py-0.5 rounded-full">{doneItems.length}</span>
                </h3>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto pr-2 pb-10">
                <AnimatePresence mode="popLayout">
                  {doneItems.map((item) => (
                    <motion.div
                      key={item.id}
                      layout
                      initial={{ opacity: 0, scale: 0.95, y: 10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                      transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    >
                      <KanbanCard
                        item={item}
                        members={workspaceMembers}
                        isEditing={editingItemId === item.id}
                        editingText={editingText}
                        isNoteEditing={noteItemId === item.id}
                        noteText={noteText}
                        onToggle={() => handleToggleItem(item.id)}
                        onDelete={() => handleDeleteItem(item.id)}
                        onOpenDetails={() => setSelectedDetailsId(item.id)}
                        onStartEdit={() => { setEditingItemId(item.id); setEditingText(item.text); }}
                        onCancelEdit={() => setEditingItemId(null)}
                        onEditingTextChange={setEditingText}
                        onSaveEdit={() => handleSaveEdit(item.id)}
                        onStartNote={() => { setNoteItemId(item.id); setNoteText(item.note || ''); }}
                        onCancelNote={() => setNoteItemId(null)}
                        onNoteTextChange={setNoteText}
                        onSaveNote={() => handleSaveNote(item.id)}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {doneItems.length === 0 && (
                  <div className="text-center py-8 text-neutral-700 text-sm">
                    Completed items appear here
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Conflict banner */}
          {conflicts.length > 0 && (
            <div className="mx-6 mb-4 p-3 border border-neutral-700 rounded">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-xs font-semibold text-neutral-400">
                  Conflicts ({conflicts.length})
                </h3>
                <span className="text-[10px] text-neutral-600">Server-wins resolution applied</span>
              </div>
              {conflicts.slice(0, 3).map((c) => (
                <div key={c.correlationId} className="text-[10px] text-neutral-500 font-mono">
                  Fields: {c.meta.conflictingFields.join(', ')}
                </div>
              ))}
            </div>
          )}
        </main>

        <AnimatePresence>
          {selectedDetailsId && content?.items?.[selectedDetailsId] && (
            <TaskDetailsModal
              item={content.items[selectedDetailsId] as ChecklistItem}
              members={workspaceMembers}
              onClose={() => setSelectedDetailsId(null)}
              onUpdatePriority={(priority) => {
                const dId = selectedDetailsId;
                const current = content.items?.[dId] as ChecklistItem;
                if (current) sendPatch({ items: { [dId]: { ...current, priority } } });
              }}
              onUpdateAssignee={(assigneeId) => {
                const dId = selectedDetailsId;
                const current = content.items?.[dId] as ChecklistItem;
                if (current) sendPatch({ items: { [dId]: { ...current, assigneeId } } });
              }}
              onUpdateDueDate={(dueDate) => {
                const dId = selectedDetailsId;
                const current = content.items?.[dId] as ChecklistItem;
                if (current) sendPatch({ items: { [dId]: { ...current, dueDate } } });
              }}
            />
          )}
        </AnimatePresence>

        {/* Debug panel */}
        {showDebug && (
          <aside className="w-72 border-l border-white/10 glass-panel flex flex-col flex-shrink-0 z-10">
            <div className="px-4 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                Sync Log
              </h3>
              <button onClick={clearLogs} className="text-xs text-neutral-400 hover:text-white transition-colors">Clear</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {logs.map((log) => (
                <LogRow key={log.id} log={log} />
              ))}
              {logs.length === 0 && (
                <p className="text-xs text-neutral-700 text-center py-4">No events yet</p>
              )}
            </div>
            <div className="px-4 py-4 border-t border-white/10 text-[10px] text-neutral-400 space-y-1">
              <div>Doc: {documentId?.slice(0, 8)}...</div>
              <div>Rev: {revision}</div>
              <div>Peers: {presence.filter(p => p.isActive).length}</div>
              <div>Status: {connectionStatus}</div>
            </div>
          </aside>
        )}

        {/* Chat Sidebar */}
        {isChatOpen && (
          <aside className="w-80 border-l border-white/10 bg-black/60 flex flex-col glass-panel backdrop-blur-3xl z-10">
            <div className="p-4 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <HiOutlineChatBubbleLeftRight className="w-4 h-4 text-indigo-400" /> Real-time Chat
              </h3>
              <button onClick={() => setIsChatOpen(false)} className="text-neutral-500 hover:text-white transition-colors p-1 rounded-md hover:bg-white/5">
                <HiOutlineXMark className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 custom-scrollbar">
              {chatMessages.length === 0 ? (
                <div className="text-xs text-neutral-500 text-center mt-10">No messages yet.</div>
              ) : (
                chatMessages.map(msg => (
                  <div key={msg.id} className={`flex flex-col ${msg.sender === user?.displayName ? 'items-end' : 'items-start'}`}>
                    <span className="text-[10px] text-neutral-500 mb-0.5 px-1">{msg.sender}</span>
                    <div className={`px-3 py-2 rounded-2xl text-sm max-w-[85%] shadow-sm ${msg.sender === user?.displayName ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white/10 text-neutral-200 rounded-bl-none'}`}>
                      {msg.text}
                    </div>
                  </div>
                ))
              )}
              {chatTyping.length > 0 && (
                <div className="flex bg-black/40 border border-white/5 rounded-2xl px-3 py-2 text-[10px] text-neutral-400 italic w-fit self-start animate-pulse">
                  {chatTyping.map(t => t.displayName).join(', ')} {chatTyping.length === 1 ? 'is' : 'are'} typing...
                </div>
              )}
              <div ref={chatMessagesEndRef} />
            </div>
            <div className="p-3 border-t border-white/10 bg-white/[0.02]">
              <form onSubmit={handleSendChat} className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={handleChatTyping}
                  placeholder="Type a message..."
                  className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-neutral-500 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                />
                <button type="submit" disabled={!chatInput.trim()} className="bg-indigo-500 flex-shrink-0 hover:bg-indigo-400 disabled:bg-neutral-800 disabled:text-neutral-600 text-white p-2 rounded-xl transition-colors">
                  <HiOutlineChatBubbleLeftRight className="w-4 h-4" />
                </button>
              </form>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

function EditableText({ value, onSave, className, placeholder }: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { setText(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const handleSave = () => {
    if (text !== value) onSave(text);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        className={`bg-transparent border-b border-neutral-600 outline-none ${className}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setText(value); setEditing(false); } }}
        placeholder={placeholder}
      />
    );
  }

  return (
    <div
      className={`cursor-pointer hover:text-neutral-300 transition-colors ${className}`}
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value || <span className="text-neutral-700 italic">{placeholder}</span>}
    </div>
  );
}

function TaskDetailsModal({
  item,
  members,
  onClose,
  onUpdatePriority,
  onUpdateAssignee,
  onUpdateDueDate
}: {
  item: ChecklistItem;
  members: Array<{ userId: string; displayName: string }>;
  onClose: () => void;
  onUpdatePriority: (p: 'low' | 'medium' | 'high' | undefined) => void;
  onUpdateAssignee: (id: string | undefined) => void;
  onUpdateDueDate: (date: string | undefined) => void;
}) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    >
      <motion.div 
        initial={{ scale: 0.95, y: 10, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.95, y: 10, opacity: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
        className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl glass-panel relative flex flex-col gap-6"
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-neutral-400 hover:text-white transition-colors">
          <HiOutlineXMark className="w-5 h-5" />
        </button>
        
        <div className="space-y-1 pr-6">
          <h2 className="text-xl font-semibold text-white">{item.text}</h2>
          <p className="text-xs text-neutral-400">Created by {item.createdBy}</p>
        </div>

        <div className="space-y-4">
          {/* Priority */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Priority</label>
            <div className="flex gap-2">
              {(['low', 'medium', 'high'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => onUpdatePriority(item.priority === p ? undefined : p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    item.priority === p 
                      ? p === 'high' ? 'bg-red-500/20 text-red-400 border border-red-500/50' 
                      : p === 'medium' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50'
                      : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50'
                      : 'bg-white/[0.03] text-neutral-400 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Assignee */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Assignee</label>
            <select
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50 appearance-none"
              value={item.assigneeId || ''}
              onChange={(e) => onUpdateAssignee(e.target.value || undefined)}
            >
              <option value="">Unassigned</option>
              {members.map(m => (
                <option key={m.userId} value={m.userId}>{m.displayName}</option>
              ))}
            </select>
          </div>

          {/* Due Date */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Due Date</label>
            <input
              type="date"
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50 appearance-none [color-scheme:dark]"
              value={item.dueDate ? item.dueDate.split('T')[0] : ''}
              onChange={(e) => onUpdateDueDate(e.target.value ? new Date(e.target.value).toISOString() : undefined)}
            />
          </div>
        </div>

      </motion.div>
    </motion.div>
  );
}

function KanbanCard({
  item, members, isEditing, editingText, isNoteEditing, noteText,
  onToggle, onDelete, onOpenDetails, onStartEdit, onCancelEdit, onEditingTextChange,
  onSaveEdit, onStartNote, onCancelNote, onNoteTextChange, onSaveNote
}: {
  item: ChecklistItem;
  members: Array<{ userId: string; displayName: string }>;
  isEditing: boolean;
  editingText: string;
  isNoteEditing: boolean;
  noteText: string;
  onToggle: () => void;
  onDelete: () => void;
  onOpenDetails: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEditingTextChange: (v: string) => void;
  onSaveEdit: () => void;
  onStartNote: () => void;
  onCancelNote: () => void;
  onNoteTextChange: (v: string) => void;
  onSaveNote: () => void;
}) {
  const assigneeName = members.find(m => m.userId === item.assigneeId)?.displayName;

  return (
    <div className={`group relative glass-panel border border-white/5 rounded-2xl p-4 transition-all duration-300 hover:border-indigo-500/50 hover:shadow-[0_8px_30px_rgba(99,102,241,0.15)] ${item.completed ? 'bg-black/20 opacity-60' : 'bg-white/[0.02]'}`}>
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <button
          onClick={onToggle}
          className={`flex-shrink-0 w-5 h-5 rounded-[6px] border flex items-center justify-center transition-all mt-0.5 ${
            item.completed
              ? 'bg-emerald-500 border-emerald-500 text-white shadow-[0_0_10px_rgba(16,185,129,0.4)]'
              : 'border-white/20 hover:border-indigo-400 hover:bg-white/5'
          }`}
        >
          {item.completed && <HiCheck className="w-3.5 h-3.5 stroke-[3]" />}
        </button>

        {/* Text and Badges */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              className="bg-transparent border-b border-neutral-600 text-sm outline-none w-full"
              value={editingText}
              onChange={(e) => onEditingTextChange(e.target.value)}
              onBlur={onSaveEdit}
              onKeyDown={(e) => { if (e.key === 'Enter') onSaveEdit(); if (e.key === 'Escape') onCancelEdit(); }}
              autoFocus
            />
          ) : (
            <div
              className={`text-sm cursor-pointer hover:text-neutral-300 transition-colors ${
                item.completed ? 'line-through text-neutral-600' : 'text-white'
              }`}
              onDoubleClick={onStartEdit}
            >
              {item.text}
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-neutral-600">
            <span>{item.createdBy}</span>
            <span>{new Date(item.createdAt).toLocaleDateString()}</span>
          </div>
          
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {item.priority && (
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider uppercase border ${
                item.priority === 'high' ? 'bg-red-500/10 text-red-400 border-red-500/20' 
                : item.priority === 'medium' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              }`}>
                {item.priority}
              </span>
            )}
            {assigneeName && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 flex items-center gap-1">
                <span className="w-3 h-3 rounded-full bg-indigo-500/30 text-[8px] flex items-center justify-center text-white">{assigneeName.charAt(0).toUpperCase()}</span>
                {assigneeName}
              </span>
            )}
            {item.dueDate && (
              <span className="px-1.5 py-0.5 rounded text-[9px] bg-white/5 text-neutral-400 border border-white/10 flex items-center gap-1 font-medium">
                Due {new Date(item.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onOpenDetails} className="text-neutral-600 hover:text-white p-1 transition-colors" title="Edit Details">
            <HiOutlinePencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onStartNote} className="text-neutral-600 hover:text-white p-1 transition-colors" title="Note">
            <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} className="text-neutral-600 hover:text-white p-1 transition-colors" title="Delete">
            <HiOutlineTrash className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Note */}
      {(item.note || isNoteEditing) && (
        <div className="mt-3 ml-8">
          {isNoteEditing ? (
            <div className="flex gap-2">
              <input
                className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder-neutral-500 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                value={noteText}
                onChange={(e) => onNoteTextChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onSaveNote(); if (e.key === 'Escape') onCancelNote(); }}
                placeholder="Add a note..."
                autoFocus
              />
              <button onClick={onSaveNote} className="text-xs px-3 py-1.5 bg-white text-black rounded-xl hover:bg-indigo-50 font-medium transition-colors shadow-sm">Save</button>
            </div>
          ) : (
            <div
              className="text-xs text-neutral-300 bg-white/[0.03] border border-white/[0.05] rounded-xl px-3 py-2 cursor-pointer hover:bg-white/[0.06] transition-colors"
              onClick={onStartNote}
            >
              {item.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LogRow({ log }: { log: SyncLogEntry }) {
  const colorMap: Record<LogLevel, string> = {
    info: 'text-neutral-500',
    success: 'text-neutral-300',
    warning: 'text-neutral-400',
    error: 'text-neutral-200',
    conflict: 'text-neutral-300',
  };

  return (
    <div className="text-[10px] font-mono px-3 py-2 rounded-lg border-l-2 border-white/10 bg-black/40 mb-1.5 transition-colors duration-300">
      <span className="text-neutral-700 mr-1.5">{new Date(log.ts).toLocaleTimeString()}</span>
      <span className={colorMap[log.level]}>{log.message}</span>
    </div>
  );
}
