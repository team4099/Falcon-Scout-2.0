import { create } from "zustand";

interface UIState {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isSidebarOpen: boolean;
  setSidebarOpen: (isOpen: boolean) => void;
  // Admin mode — in-memory only; expires on page refresh
  isAdminMode: boolean;
  setAdminMode: (enabled: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: "dashboard",
  setActiveTab: (tab) => set({ activeTab: tab }),
  isSidebarOpen: true,
  setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
  isAdminMode: false,
  setAdminMode: (enabled) => set({ isAdminMode: enabled }),
}));
