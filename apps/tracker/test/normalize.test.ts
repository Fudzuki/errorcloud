import { describe, expect, it } from "vitest";
import {
  culpritOf,
  dropReason,
  fingerprintOf,
  maskUrl,
  maskUrlsInText,
  normalizeMessage,
  parseStack,
  stripBuildHash,
} from "../src/worker/pipeline/normalize";
import { browserEvent } from "./helpers";

describe("parseStack", () => {
  it("Chrome 形式を読む", () => {
    const frames = parseStack(
      [
        "TypeError: x is undefined",
        "    at r (https://example.com/assets/app-3f9a.js:1:2345)",
        "    at https://cdn.example.net/lib.js:10:5",
        "    at chrome-extension://abc/content.js:1:1",
      ].join("\n"),
      "https://example.com/items/1",
    );
    expect(frames).toEqual([
      {
        function: "r",
        file: "https://example.com/assets/app-3f9a.js",
        line: 1,
        column: 2345,
        inApp: true,
      },
      {
        function: undefined,
        file: "https://cdn.example.net/lib.js",
        line: 10,
        column: 5,
        inApp: false,
      },
      {
        function: undefined,
        file: "chrome-extension://abc/content.js",
        line: 1,
        column: 1,
        inApp: false,
      },
    ]);
  });

  it("Firefox / Safari 形式を読む", () => {
    const frames = parseStack(
      "handleClick@https://example.com/assets/app.js:3:14\n@https://example.com/assets/app.js:9:1",
      "https://example.com/",
    );
    expect(frames.map((f) => [f.function, f.line, f.column])).toEqual([
      ["handleClick", 3, 14],
      [undefined, 9, 1],
    ]);
  });
});

describe("stripBuildHash", () => {
  it.each([
    ["https://example.com/assets/app-3f9a.js", "/assets/app.js"],
    ["https://example.com/assets/index-BxK2jF9a.js?v=1", "/assets/index.js"],
    ["https://example.com/static/js/main.5f2c8d1e.js", "/static/js/main.js"],
    ["https://example.com/app.component.js", "/app.component.js"],
    ["/assets/plain.js", "/assets/plain.js"],
  ])("%s → %s", (input, expected) => {
    expect(stripBuildHash(input)).toBe(expected);
  });
});

describe("normalizeMessage", () => {
  it("数値、UUID、16進数列、URL を置き換える", () => {
    expect(
      normalizeMessage(
        "Item 42 not found (id=9f1c2a4e-1b2c-4d5e-8f90-123456789abc, hash deadbeef01, at https://x.test/a?b=1, 0xff)",
      ),
    ).toBe("Item <n> not found (id=<uuid>, hash <hex>, at <url> <hex>)");
  });
});

describe("maskUrl", () => {
  it("クエリ文字列の値だけ伏せる", () => {
    expect(maskUrl("https://example.com/a?token=abc&x=1&flag#frag")).toBe(
      "https://example.com/a?token=[Filtered]&x=[Filtered]&flag#frag",
    );
    expect(maskUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("文中の URL も伏せる", () => {
    expect(maskUrlsInText("failed to load https://example.com/a?key=secret now")).toBe(
      "failed to load https://example.com/a?key=[Filtered] now",
    );
  });
});

describe("dropReason", () => {
  it("拡張機能、Script error.、ボットを除外する", () => {
    expect(dropReason(browserEvent({ message: "Script error." }), undefined)).toBe("script-error");
    expect(
      dropReason(
        browserEvent({ stack: "Error\n    at chrome-extension://abc/x.js:1:1" }),
        undefined,
      ),
    ).toBe("extension");
    expect(dropReason(browserEvent(), "Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("bot");
    expect(dropReason(browserEvent(), "Mozilla/5.0 (Macintosh) Chrome/140")).toBeNull();
  });
});

describe("fingerprintOf", () => {
  it("リリースが変わって行番号やハッシュが変わっても同じになる", async () => {
    const a = browserEvent({
      message: "Cannot read properties of undefined (reading 'id') at item 42",
      stack: "TypeError\n    at r (https://example.com/assets/app-3f9a2c1d.js:1:2345)",
    });
    const b = browserEvent({
      message: "Cannot read properties of undefined (reading 'id') at item 7",
      stack: "TypeError\n    at q (https://example.com/assets/app-77aa1b2c.js:1:999)",
    });
    const fa = await fingerprintOf(a, culpritOf(parseStack(a.stack, a.url)));
    const fb = await fingerprintOf(b, culpritOf(parseStack(b.stack, b.url)));
    expect(fa).toBe(fb);
  });

  it("ファイルが違えば別になる", async () => {
    const a = browserEvent({ stack: "TypeError\n    at r (https://example.com/assets/a.js:1:1)" });
    const b = browserEvent({ stack: "TypeError\n    at r (https://example.com/assets/b.js:1:1)" });
    expect(await fingerprintOf(a, culpritOf(parseStack(a.stack, a.url)))).not.toBe(
      await fingerprintOf(b, culpritOf(parseStack(b.stack, b.url))),
    );
  });

  it("SDK が指定した fingerprint を優先する", async () => {
    const a = browserEvent({ fingerprint: ["checkout"] });
    const b = browserEvent({ type: "RangeError", fingerprint: ["checkout"] });
    expect(await fingerprintOf(a, null)).toBe(await fingerprintOf(b, "/other.js"));
  });
});
