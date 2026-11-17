// Vite の import.meta.glob の型（Worker 側は vite/client を読み込まないため）
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options: { query?: string; import?: string; eager: true },
  ): Record<string, T>;
}
