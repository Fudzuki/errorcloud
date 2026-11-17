// 受信口で使うリクエスト本文の読み出し。サイズの上限を守りながら、gzip / deflate を展開する。

export type BodyResult = { ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 | 415 };

/** limit を超えたら読むのをやめる。展開後のサイズにも同じ上限をかける */
export async function readBody(req: Request, limit: number): Promise<BodyResult> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  const encoding = (req.headers.get("Content-Encoding") ?? "identity").toLowerCase();
  if (encoding === "identity" && declared > limit) return { ok: false, status: 413 };
  if (!req.body) return { ok: true, bytes: new Uint8Array() };

  let stream: ReadableStream<Uint8Array> = req.body;
  if (encoding === "gzip" || encoding === "deflate") {
    stream = stream.pipeThrough(new DecompressionStream(encoding) as never);
  } else if (encoding !== "identity") {
    return { ok: false, status: 415 };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    // 壊れた圧縮データ
    return { ok: false, status: 400 };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes };
}

/** 定数時間での文字列比較（トークンの照合用） */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
