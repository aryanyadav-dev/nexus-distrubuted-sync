import React, { useEffect, useState } from 'react';
import {
  HiOutlineArrowRightOnRectangle,
  HiOutlinePlus,
  HiOutlineArrowRight,
  HiOutlineTrash,
} from 'react-icons/hi2';
import { useAuthStore } from '../stores/authStore';
import { listWorkspaces, listDocuments, createWorkspace, createDocument, deleteDocument, deleteWorkspace } from '../lib/api';

interface WorkspaceInfo {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

interface DocumentInfo {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
}

interface Props {
  onSelectDocument: (workspaceId: string, documentId: string) => void;
}

export default function WorkspacePage({ onSelectDocument }: Props) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedWs, setSelectedWs] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [newWsName, setNewWsName] = useState('');
  const [newDocTitle, setNewDocTitle] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  useEffect(() => {
    if (selectedWs) loadDocuments(selectedWs);
  }, [selectedWs]);

  const loadWorkspaces = async () => {
    setLoading(true);
    const res = await listWorkspaces();
    if (res.ok) {
      setWorkspaces(res.data);
      if (res.data.length > 0 && !selectedWs) setSelectedWs(res.data[0].id);
    }
    setLoading(false);
  };

  const loadDocuments = async (wsId: string) => {
    const res = await listDocuments(wsId);
    if (res.ok) setDocuments(res.data as any);
  };

  const handleCreateWorkspace = async () => {
    if (!newWsName.trim()) return;
    const res = await createWorkspace(newWsName.trim());
    if (res.ok) {
      setNewWsName('');
      loadWorkspaces();
    }
  };

  const handleCreateDocument = async () => {
    if (!newDocTitle.trim() || !selectedWs) return;
    const initial = {
      title: newDocTitle.trim(),
      description: '',
      items: {},
    };
    const res = await createDocument(selectedWs, newDocTitle.trim(), initial);
    if (res.ok) {
      setNewDocTitle('');
      loadDocuments(selectedWs);
    }
  };

  const handleDeleteDocument = async (e: React.MouseEvent, docId: string) => {
    e.stopPropagation();
    if (!selectedWs || !window.confirm('Are you sure you want to delete this document?')) return;
    const res = await deleteDocument(selectedWs, docId);
    if (res.ok) {
      loadDocuments(selectedWs);
    }
  };

  const handleDeleteWorkspace = async (e: React.MouseEvent, wsId: string) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this workspace and all its documents?')) return;
    const res = await deleteWorkspace(wsId);
    if (res.ok) {
      if (selectedWs === wsId) setSelectedWs(null);
      loadWorkspaces();
    }
  };

  return (
    <div className="min-h-screen bg-transparent text-white">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-white/[0.02] backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <span className="font-semibold tracking-tight text-sm">Nexus</span>
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-neutral-400 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
              <span className="text-white">{user?.displayName}</span>
              <span className="text-neutral-500 hidden sm:inline">{user?.email}</span>
            </span>
            <div className="w-px h-4 bg-white/10" />
            <button onClick={logout} className="text-neutral-400 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-full" title="Sign Out" id="logout-btn">
              <HiOutlineArrowRightOnRectangle className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Workspaces Panel */}
          <div className="card p-6">
            <h2 className="text-sm font-medium text-white mb-6 flex items-center gap-2">
              Workspaces
            </h2>

            {loading ? (
              <div className="flex items-center gap-2 text-indigo-400 text-sm">
                <span className="animate-spin w-4 h-4 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full" />
                Loading...
              </div>
            ) : (
              <div className="space-y-2">
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => setSelectedWs(ws.id)}
                    className={`group w-full px-4 py-3 rounded-xl transition-all duration-300 ${
                      selectedWs === ws.id
                        ? 'bg-white/10 border border-white/20 text-white shadow-[0_4px_20px_rgba(0,0,0,0.2)]'
                        : 'bg-transparent hover:bg-white/[0.05] text-neutral-400 border border-transparent hover:border-white/10'
                    }`}
                    id={`ws-${ws.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-left">
                        <div className="font-medium text-sm">{ws.name}</div>
                        <div className="text-xs text-neutral-500 mt-1">
                          {new Date(ws.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      {user?.id === ws.ownerId && (
                        <button
                          onClick={(e) => handleDeleteWorkspace(e, ws.id)}
                          className="p-1.5 text-neutral-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200"
                          title="Delete workspace"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </button>
                ))}

                {workspaces.length === 0 && (
                  <p className="text-xs text-neutral-600">No workspaces yet.</p>
                )}
              </div>
            )}

            {/* Create workspace */}
            <div className="mt-6 pt-6 border-t border-white/10">
              <div className="flex gap-2">
                <input
                  className="input text-xs py-2"
                  placeholder="New workspace name"
                  value={newWsName}
                  onChange={(e) => setNewWsName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateWorkspace()}
                  id="new-workspace-input"
                />
                <button onClick={handleCreateWorkspace} className="btn-primary text-xs px-3 py-2 whitespace-nowrap" id="create-workspace-btn">
                  <HiOutlinePlus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Documents Panel */}
          <div className="card p-6 lg:col-span-2">
            <h2 className="text-sm font-medium text-white mb-6 flex items-center gap-2">
              Documents
              {selectedWs && (
                <span className="text-neutral-500 font-light ml-2">
                  in <span className="text-indigo-400 font-medium">{workspaces.find((w) => w.id === selectedWs)?.name}</span>
                </span>
              )}
            </h2>

            {!selectedWs ? (
              <p className="text-xs text-neutral-600">Select a workspace to view documents.</p>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {documents.map((doc) => (
                    <button
                      key={doc.id}
                      onClick={() => onSelectDocument(selectedWs, doc.id)}
                      className="text-left p-5 bg-white/[0.02] hover:bg-white/[0.06] rounded-xl border border-white/10 hover:border-indigo-500/50 transition-all duration-300 group shadow-sm hover:shadow-[0_4px_20px_rgba(99,102,241,0.15)] flex flex-col justify-between"
                      id={`doc-${doc.id}`}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-medium text-base text-white group-hover:text-indigo-300 transition-colors">
                            {doc.title}
                          </div>
                          <div className="text-xs text-neutral-500 mt-1 flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px]">Rev {doc.revision}</span>
                            <span>{new Date(doc.updatedAt).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <div className="flex flex-col items-center gap-2">
                          <button
                            onClick={(e) => handleDeleteDocument(e, doc.id)}
                            className="p-1.5 text-neutral-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200"
                            title="Delete document"
                          >
                            <HiOutlineTrash className="w-4 h-4" />
                          </button>
                          <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-1">
                            <HiOutlineArrowRight className="w-4 h-4 text-indigo-400" />
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                {documents.length === 0 && (
                  <p className="text-xs text-neutral-600 mb-4">No documents yet. Create one below.</p>
                )}

                <div className="mt-6 pt-6 border-t border-white/10">
                  <div className="flex gap-2">
                    <input
                      className="input text-xs py-2"
                      placeholder="New document title"
                      value={newDocTitle}
                      onChange={(e) => setNewDocTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateDocument()}
                      id="new-document-input"
                    />
                    <button onClick={handleCreateDocument} className="btn-primary text-xs px-3 py-2 whitespace-nowrap" id="create-document-btn">
                      <HiOutlinePlus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
