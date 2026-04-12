import React from 'react';
import { useNavigate } from 'react-router-dom';
import { HiOutlineArrowRight } from 'react-icons/hi2';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-transparent text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Background ornaments */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60vw] h-[60vw] bg-indigo-500/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-1/4 right-1/4 w-[30vw] h-[30vw] bg-purple-500/20 rounded-full blur-[100px] pointer-events-none" />

      {/* Content */}
      <main className="z-10 text-center max-w-4xl flex flex-col items-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.05] border border-white/10 text-xs font-medium text-indigo-300 mb-8 backdrop-blur-sm shadow-[0_0_15px_rgba(99,102,241,0.1)]">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
          </span>
          Distributed Sync Engine V1.0
        </div>

        <h1 className="text-6xl md:text-8xl font-bold tracking-tight mb-8 drop-shadow-lg">
          Real-time state, <br className="hidden md:block"/>
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-indigo-400 drop-shadow-sm">
            multiplied.
          </span>
        </h1>
        
        <p className="text-lg md:text-xl text-neutral-400 mb-12 max-w-2xl mx-auto font-light leading-relaxed">
          Connect multiple clients, edit shared state collaboratively, and see live updates across devices instantly. Built with WebSockets, optimistic updates, and conflict resolution.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 items-center justify-center">
          <button 
            onClick={() => navigate('/login')}
            className="flex items-center justify-center gap-2 px-8 py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white text-base font-medium rounded-2xl transition-all duration-300 shadow-[0_0_30px_rgba(99,102,241,0.4)] hover:shadow-[0_0_40px_rgba(99,102,241,0.6)] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:ring-offset-2 focus:ring-offset-[#030303] active:scale-[0.98]"
          >
            Login to Workspace
            <HiOutlineArrowRight className="w-5 h-5" />
          </button>

          <button 
            onClick={() => navigate('/login')}
            className="flex items-center justify-center gap-2 px-8 py-4 bg-white/[0.05] hover:bg-white/[0.1] text-neutral-200 text-base font-medium rounded-2xl border border-white/10 transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-[#030303] active:scale-[0.98]"
          >
            Create Free Account
          </button>
        </div>
      </main>
    </div>
  );
}
