import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UIState {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isSidebarOpen: boolean;
  setSidebarOpen: (isOpen: boolean) => void;
  // Admin mode — persisted to localStorage so it survives page reloads
  isAdminMode: boolean;
  setAdminMode: (enabled: boolean) => void;
  // Dashboard rankings column visibility: explicit per-device overrides only,
  // so columns keep their defaults (built-ins on, tagged form fields off).
  rankingColumns: Record<string, boolean>;
  setRankingColumn: (id: string, visible: boolean) => void;
  resetRankingColumns: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeTab: "dashboard",
      setActiveTab: (tab) => set({ activeTab: tab }),
      isSidebarOpen: true,
      setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
      isAdminMode: false,
      setAdminMode: (enabled) => set({ isAdminMode: enabled }),
      rankingColumns: {},
      setRankingColumn: (id, visible) =>
        set((s) => ({ rankingColumns: { ...s.rankingColumns, [id]: visible } })),
      resetRankingColumns: () => set({ rankingColumns: {} }),
    }),
    {
      name: "falconscout_ui",
      // Persist admin mode + column prefs — tab and sidebar should reset naturally
      partialize: (state) => ({ isAdminMode: state.isAdminMode, rankingColumns: state.rankingColumns }),
    }
  )
);
