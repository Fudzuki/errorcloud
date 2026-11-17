import { useQuery } from "@tanstack/react-query";

export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { ok: boolean };
    },
  });

  return (
    <main>
      <h1>errorcloud</h1>
      <p>API: {health.isPending ? "確認中…" : health.data?.ok ? "OK" : "NG"}</p>
    </main>
  );
}
