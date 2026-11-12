export type WidgetPreferences = {
  visible: boolean;
  pinned: boolean;
  collapsed: boolean;
  scale: number;
  quotaKey: string;
};
declare global {
  interface Window {
    aiwmDesktop?: {
      widget(
        action: string,
        value?: string | boolean | number,
      ): Promise<WidgetPreferences>;
      onWidgetError(callback: (message: string) => void): () => void;
    };
  }
}
export const desktopBridge = () =>
  typeof window === "undefined" ? undefined : window.aiwmDesktop;
