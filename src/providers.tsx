import { ThemeProvider } from "@/components/theme-provider";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { convex } from "@/lib/convexClient";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ConvexAuthProvider client={convex}>
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </ConvexAuthProvider>
    </ThemeProvider>
  );
}
