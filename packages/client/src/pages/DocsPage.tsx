import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  HiOutlineArrowLeft,
  HiOutlineArrowRightOnRectangle,
  HiOutlineSignal,
  HiOutlineSignalSlash,
  HiOutlinePencilSquare,
  HiOutlineSparkles,
  HiOutlineDocumentText,
  HiOutlineLink,
  HiOutlineClipboardDocument,
  HiOutlineArrowTopRightOnSquare,
  HiOutlineUserCircle,
  HiOutlineTrash,
} from 'react-icons/hi2';
import { SyncClient, type SyncEvent } from '../lib/SyncClient';
import { createDemoSyncClientIfNeeded } from '../lib/DemoSyncClient';
import { useAuthStore } from '../stores/authStore';
import { getDocument, getWorkspaceMembers, listDocuments, updateDocument } from '../lib/api';
import { inferDocumentKind } from '../lib/documentTemplates';
import { getWsUrl } from '../lib/runtimeConfig';

const WS_URL = getWsUrl();

interface DocTask {
  id: string;
  text: string;
  assigneeId?: string;
  boardId?: string;
  boardItemId?: string;
  completed: boolean;
  createdAt: string;
}

interface WorkspaceBoardInfo {
  id: string;
  title: string;
}

interface DocContent {
  kind?: 'doc' | 'board';
  title?: string;
  body?: string;
  comments?: Record<string, unknown>;
  tasks?: Record<string, DocTask>;
  [key: string]: unknown;
}

interface WorkspaceMemberInfo {
  userId: string;
  displayName: string;
  role: string;
}

interface CollabTypingUser {
  userId: string;
  displayName: string;
  ts: number;
  context: string;
}

const AVATAR_SHADES = ['#3f3f46', '#52525b', '#64748b', '#0f766e', '#2563eb'];

function getAvatarShade(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_SHADES[Math.abs(hash) % AVATAR_SHADES.length];
}

function safeUuid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeContent(content: Record<string, unknown> | null | undefined): DocContent {
  const current = (content ?? {}) as DocContent;
  return {
    ...current,
    comments: (current.comments as Record<string, unknown>) ?? {},
    tasks: (current.tasks as Record<string, DocTask>) ?? {},
    kind: current.kind ?? 'doc',
    title: typeof current.title === 'string' ? current.title : 'Untitled doc',
    body: typeof current.body === 'string' ? current.body : '',
  };
}

function mergeContent(current: DocContent, patch: Partial<DocContent>): DocContent {
  return normalizeContent({ ...current, ...patch });
}

export default function DocsPage() {
  const { workspaceId, documentId } = useParams<{ workspaceId: string; documentId: string }>();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const clientRef = useRef<SyncClient | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'offline'>('disconnected');
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState<DocContent>(normalizeContent(null));
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMemberInfo[]>([]);
  const [presence, setPresence] = useState<Array<{ userId: string; displayName: string; isActive: boolean }>>([]);
  const [typing, setTyping] = useState<Record<string, CollabTypingUser[]>>({});
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [focusedField, setFocusedField] = useState<'title' | 'body' | null>(null);
  const [draftTitle, setDraftTitle] = useState('Untitled doc');
  const [taskText, setTaskText] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('');
  const [taskBoardId, setTaskBoardId] = useState('');
  const [workspaceBoards, setWorkspaceBoards] = useState<WorkspaceBoardInfo[]>([]);
  const [copiedLink, setCopiedLink] = useState(false);

  const isConnected = connectionStatus === 'authenticated';
  const title = content.title || 'Untitled doc';
  const body = content.body || '';
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';
  const activeCollaborators = useMemo(() => presence.filter((p) => p.isActive), [presence]);
  const memberRoster = useMemo(
    () =>
      workspaceMembers.map((member) => ({
        ...member,
        isActive: presence.some((person) => person.userId === member.userId && person.isActive),
      })),
    [workspaceMembers, presence]
  );
  const activeMemberRoster = useMemo(
    () => memberRoster.filter((member) => member.isActive),
    [memberRoster]
  );
  const titleTyping = useMemo(
    () => (typing.doc_title || []).filter((u) => u.userId !== user?.id),
    [typing, user?.id]
  );
  const bodyTyping = useMemo(
    () => (typing.doc_body || []).filter((u) => u.userId !== user?.id),
    [typing, user?.id]
  );
  const tasks = useMemo(
    () =>
      Object.values(content.tasks || {})
        .filter((task) => !task.completed)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [content.tasks]
  );
  const inferredKind = inferDocumentKind(content);

  useEffect(() => {
    if (focusedField !== 'title') {
      setDraftTitle(title);
    }
  }, [title, focusedField]);

  function queuePatch(patch: Partial<DocContent>, flushNow = false) {
    const nextContent = mergeContent(content, patch);
    setContent(nextContent);
    if (!documentId) return;
    setIsSaving(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const send = () => {
      clientRef.current?.mutate(documentId, patch as Record<string, unknown>);
      setLastSavedAt(new Date().toISOString());
      setIsSaving(false);
    };
    if (flushNow) {
      send();
      return;
    }
    saveTimerRef.current = setTimeout(send, 180);
  }

  function sendTitleTyping() {
    if (!documentId) return;
    clientRef.current?.sendTyping(documentId, 'doc_title');
  }

  function sendBodyTyping() {
    if (!documentId) return;
    clientRef.current?.sendTyping(documentId, 'doc_body');
  }

  async function addTask() {
    if (!taskText.trim() || !user || !taskBoardId) return;
    if (!workspaceId) return;
    const boardRes = await getDocument(workspaceId, taskBoardId);
    if (!boardRes.ok) return;

    const boardContent = boardRes.data.content as Record<string, unknown>;
    const existingItems = ((boardContent.items as Record<string, Record<string, unknown> | null | undefined>) || {});
    const boardItemId = crypto.randomUUID();
    const boardItem = {
      id: boardItemId,
      text: taskText.trim(),
      completed: false,
      createdBy: user.displayName,
      createdAt: new Date().toISOString(),
      order: Object.values(existingItems).filter(Boolean).length,
      assigneeId: taskAssignee || undefined,
    };

    const boardUpdate = await updateDocument(workspaceId, taskBoardId, {
      items: {
        ...existingItems,
        [boardItemId]: boardItem,
      },
    });
    if (!boardUpdate.ok) return;

    const task: DocTask = {
      id: safeUuid('t'),
      text: taskText.trim(),
      assigneeId: taskAssignee || undefined,
      boardId: taskBoardId,
      boardItemId,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    queuePatch(
      {
        tasks: {
          ...(content.tasks || {}),
          [task.id]: task,
        },
      },
      true
    );
    setTaskText('');
    setTaskAssignee('');
    setTaskBoardId('');
  }

  async function deleteTask(taskId: string) {
    const task = content.tasks?.[taskId];
    if (!task) return;

    if (workspaceId && task.boardId && task.boardItemId) {
      const boardRes = await getDocument(workspaceId, task.boardId);
      if (boardRes.ok) {
        const boardContent = boardRes.data.content as Record<string, unknown>;
        const existingItems = ((boardContent.items as Record<string, Record<string, unknown> | null | undefined>) || {});
        const nextItems = { ...existingItems, [task.boardItemId]: null };
        await updateDocument(workspaceId, task.boardId, { items: nextItems });
      }
    }

    const nextTasks = { ...(content.tasks || {}) };
    delete nextTasks[taskId];
    queuePatch({ tasks: nextTasks }, true);
  }

  async function copyShareLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      setCopiedLink(false);
    }
  }

  function openTaskBoard(task: DocTask) {
    if (!workspaceId || !task.boardId) return;
    navigate(`/board/${workspaceId}/${task.boardId}`);
  }

  useEffect(() => {
    if (!token || !workspaceId || !documentId) return;

    getWorkspaceMembers(workspaceId).then((res) => {
      if (res.ok) {
        setWorkspaceMembers(
          res.data.map((m) => ({
            userId: m.userId,
            displayName: m.user?.displayName || 'Unknown',
            role: m.role,
          }))
        );
      }
    });

    listDocuments(workspaceId).then((res) => {
      if (res.ok) {
        setWorkspaceBoards(
          res.data
            .filter((doc) => inferDocumentKind(doc.content) === 'board')
            .map((doc) => ({
              id: doc.id,
              title: doc.title,
            }))
        );
      }
    });

    getDocument(workspaceId, documentId).then((res) => {
      if (res.ok) {
        setContent(normalizeContent(res.data.content));
        setRevision(res.data.revision);
      }
    });

    const demoClient = createDemoSyncClientIfNeeded({ url: WS_URL, token });
    const client = demoClient ?? new SyncClient({ url: WS_URL, token });
    console.log(`[DSync] Sync client: ${demoClient ? 'DemoSyncClient (localStorage)' : `RealSyncClient (${WS_URL})`}`);
    clientRef.current = client as SyncClient;

    const handler = (event: SyncEvent) => {
      switch (event.type) {
        case 'connected':
          setConnectionStatus('connected');
          break;
        case 'authenticated':
          setConnectionStatus('authenticated');
          break;
        case 'disconnected':
          setConnectionStatus('disconnected');
          break;
        case 'reconnecting':
          setConnectionStatus('connecting');
          break;
        case 'offline':
          setConnectionStatus('offline');
          break;
        case 'online':
          break;
        case 'snapshot':
          if (event.message.documentId === documentId) {
            setContent(normalizeContent(event.message.content));
            setRevision(event.message.revision);
          }
          break;
        case 'mutation_ack':
          setRevision(event.message.revision);
          setIsSaving(false);
          setLastSavedAt(new Date().toISOString());
          break;
        case 'remote_update':
          setContent((current) => mergeContent(current, event.message.patch as Partial<DocContent>));
          setRevision(event.message.revision);
          setLastSavedAt(new Date().toISOString());
          break;
        case 'presence_update':
          setPresence(event.message.presence);
          break;
        case 'typing_update':
          setTyping((state) => {
            const currentContextTyping = state[event.message.context] || [];
            const others = currentContextTyping.filter((t) => t.userId !== event.message.userId);
            return {
              ...state,
              [event.message.context]: [
                ...others,
                {
                  userId: event.message.userId,
                  displayName: event.message.displayName,
                  ts: Date.now(),
                  context: event.message.context,
                },
              ],
            };
          });
          break;
        case 'conflict':
        case 'error':
        case 'heartbeat_ack':
          break;
      }
    };

    client.on(handler);
    client.connect();
    client.subscribe(documentId);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      client.unsubscribe(documentId);
      client.disconnect();
      clientRef.current = null;
    };
  }, [token, workspaceId, documentId]);

  useEffect(() => {
    const timer = setInterval(() => {
      setTyping((state) => {
        const now = Date.now();
        const next: typeof state = {};
        let changed = false;
        for (const [ctx, users] of Object.entries(state)) {
          const active = users.filter((u) => now - u.ts < 3000);
          if (active.length !== users.length) changed = true;
          if (active.length > 0) next[ctx] = active;
        }
        return changed ? next : state;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen text-white bg-transparent">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-black/30 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/workspaces')}
              className="text-neutral-500 hover:text-white transition-colors text-sm flex items-center gap-1"
            >
              <HiOutlineArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="w-px h-5 bg-white/10" />
            <span className="font-semibold tracking-tight text-sm text-indigo-100">Nexus Docs</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              {isConnected ? (
                <HiOutlineSignal className="w-3.5 h-3.5 text-emerald-300" />
              ) : (
                <HiOutlineSignalSlash className="w-3.5 h-3.5 text-neutral-600" />
              )}
              <span>{isConnected ? 'Connected' : connectionStatus}</span>
              <span className="text-neutral-700">rev {revision}</span>
            </div>

            <div className="flex -space-x-1.5">
              {activeCollaborators.slice(0, 4).map((p) => (
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

            <div className="w-px h-5 bg-white/10" />
            <span className="text-xs text-neutral-400 font-medium">{user?.displayName}</span>
            <button onClick={logout} className="text-neutral-400 hover:text-white transition-colors p-1.5 hover:bg-white/10 rounded-full" title="Sign Out">
              <HiOutlineArrowRightOnRectangle className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 xl:grid-cols-[1.65fr_0.95fr] gap-6">
          <section className="card p-6 md:p-8 min-h-[78vh] flex flex-col">
            <div className="flex flex-wrap items-center gap-3 mb-6">
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.05] border border-white/10 text-xs text-emerald-200">
                <HiOutlineSparkles className="w-3.5 h-3.5" />
                Live collaborative doc
              </span>
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.05] border border-white/10 text-xs text-neutral-300">
                <HiOutlinePencilSquare className="w-3.5 h-3.5" />
                {inferredKind === 'doc' ? 'Document template' : 'Workspace content'}
              </span>
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.05] border border-white/10 text-xs text-neutral-300">
                Autosave {isSaving ? 'pending' : lastSavedAt ? `saved ${new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'ready'}
              </span>
            </div>

            <input
              value={focusedField === 'title' ? draftTitle : title}
              onChange={(e) => {
                setDraftTitle(e.target.value);
                queuePatch({ title: e.target.value });
              }}
              placeholder="Document title"
              onFocus={() => setFocusedField('title')}
              onBlur={() => {
                queuePatch({ title: draftTitle }, true);
                setFocusedField(null);
              }}
              onInput={sendTitleTyping}
              className="w-full bg-transparent text-4xl md:text-5xl font-bold tracking-tight placeholder:text-neutral-700 focus:outline-none mb-2"
            />

            {titleTyping.length > 0 && focusedField !== 'title' && (
              <p className="mt-1 mb-3 text-xs text-neutral-500">
                {titleTyping.map((u) => u.displayName).join(', ')} {titleTyping.length === 1 ? 'is' : 'are'} editing the title.
              </p>
            )}

            <label className="text-xs uppercase tracking-[0.3em] text-neutral-500 mb-3 mt-4">Body</label>
            <textarea
              ref={editorRef}
              value={body}
              onChange={(e) => queuePatch({ body: e.target.value })}
              onKeyUp={sendBodyTyping}
              onMouseUp={sendBodyTyping}
              onFocus={() => setFocusedField('body')}
              onBlur={() => setFocusedField(null)}
              placeholder="Write your document here..."
              className="flex-1 min-h-[54vh] resize-none rounded-[1.75rem] border border-white/10 bg-black/30 p-6 md:p-8 text-base md:text-lg leading-8 text-white placeholder:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />

            {bodyTyping.length > 0 && focusedField !== 'body' && (
              <div className="mt-3 text-xs text-neutral-500 flex flex-wrap gap-2">
                {bodyTyping.map((u) => (
                  <span key={`${u.userId}-${u.context}`} className="badge badge-viewer">
                    {u.displayName} editing body
                  </span>
                ))}
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <div className="card p-5">
              <h3 className="text-sm font-medium text-white flex items-center gap-2 mb-4">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/30">
                  <HiOutlineUserCircle className="w-4 h-4" />
                </span>
                Live Presence
              </h3>
              <div className="space-y-2">
                {activeMemberRoster.map((person) => (
                  <div key={person.userId} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-full border border-black flex items-center justify-center text-[11px] font-bold text-white"
                        style={{ background: getAvatarShade(person.userId) }}
                      >
                        {person.displayName.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm text-white">{person.displayName}</div>
                        <div className="text-[11px] text-neutral-500 capitalize">{person.role}</div>
                      </div>
                    </div>
                    <span className={`badge ${person.isActive ? 'badge-online' : 'badge-viewer'}`}>
                      {person.isActive ? 'Active' : 'Offline'}
                    </span>
                  </div>
                ))}
                {activeMemberRoster.length === 0 && (
                  <p className="text-sm text-neutral-600">No one is active right now.</p>
                )}
              </div>
            </div>

            <div className="card p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h3 className="text-sm font-medium text-white flex items-center gap-2">
                  <HiOutlineDocumentText className="w-4 h-4 text-indigo-300" />
                  Tasks
                </h3>
              </div>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {tasks.map((task) => (
                  <div key={task.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm text-white">{task.text}</div>
                      <div className="text-[11px] text-neutral-500 mt-1">
                        {task.assigneeId
                          ? `Assigned to ${workspaceMembers.find((member) => member.userId === task.assigneeId)?.displayName || 'teammate'}`
                          : 'Unassigned'}
                        {task.boardId
                          ? ` • Board ${workspaceBoards.find((board) => board.id === task.boardId)?.title || 'Linked board'}`
                          : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {task.boardId && (
                        <button
                          type="button"
                          className="text-xs text-indigo-300 hover:text-white transition-colors inline-flex items-center gap-1"
                          onClick={() => openTaskBoard(task)}
                        >
                          Open board
                          <HiOutlineArrowTopRightOnSquare className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-rose-300 hover:text-white transition-colors inline-flex items-center"
                        onClick={() => deleteTask(task.id)}
                        title="Delete task"
                        aria-label="Delete task"
                      >
                        <HiOutlineTrash className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                {tasks.length === 0 && <p className="text-sm text-neutral-600">No open tasks right now.</p>}
              </div>

              <div className="mt-4 space-y-2">
                <input
                  value={taskText}
                  onChange={(e) => setTaskText(e.target.value)}
                  className="input text-sm"
                  placeholder="Task or next step"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)} className="input text-xs py-2">
                    <option value="">Assign to...</option>
                    {workspaceMembers.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                  <select value={taskBoardId} onChange={(e) => setTaskBoardId(e.target.value)} className="input text-xs py-2">
                    <option value="">Link to board...</option>
                    {workspaceBoards.map((board) => (
                      <option key={board.id} value={board.id}>
                        {board.title}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn-primary text-xs px-3 py-2 w-full disabled:opacity-60" onClick={addTask} disabled={!taskText.trim() || !taskBoardId}>
                  Add Task
                </button>
                {workspaceBoards.length === 0 && (
                  <p className="text-[11px] text-neutral-500">Create a board in this workspace first to link tasks.</p>
                )}
              </div>
            </div>

            <div className="card p-5">
              <h3 className="text-sm font-medium text-white flex items-center gap-2 mb-4">
                <HiOutlineLink className="w-4 h-4 text-indigo-300" />
                Share Link
              </h3>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-xs text-neutral-400 mb-3">
                  Share this doc directly. Anyone with workspace access can open the same live page.
                </p>
                <div className="rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-xs text-neutral-300 break-all">
                  {shareUrl}
                </div>
                <button className="btn-secondary text-xs px-3 py-2 mt-3 w-full inline-flex items-center justify-center gap-2" onClick={copyShareLink}>
                  <HiOutlineClipboardDocument className="w-4 h-4" />
                  {copiedLink ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
