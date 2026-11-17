// ブラウザSDK（技術定義書 2章）。現時点では設定を保持するだけの雛形。

export type InitOptions = {
  /** プロジェクトの公開キー */
  key: string;
  /** 送信先。既定は同一ドメインの /_e */
  endpoint?: string;
  release?: string;
  environment?: string;
};

let options: Required<Pick<InitOptions, "key" | "endpoint">> & InitOptions;

export function init(opts: InitOptions): void {
  options = { endpoint: "/_e", ...opts };
}

export function getOptions(): InitOptions | undefined {
  return options;
}
