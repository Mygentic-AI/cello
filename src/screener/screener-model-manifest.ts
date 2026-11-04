
export interface ScreenerModelFile {
  path: string;
  localPath?: string;
  size: number;
  sha256: string;
}

export function localPathOf(f: ScreenerModelFile): string {
  return f.localPath ?? f.path;
}

export const SCREENER_MODEL = {
  repo: "patronus-studio/wolf-defender-prompt-injection-small",
  revision: "cdcdf7d0231d68f39cc3bb1b70f6a2bdfca8ad55",
  baseUrl:
    "https://huggingface.co/patronus-studio/wolf-defender-prompt-injection-small/resolve/cdcdf7d0231d68f39cc3bb1b70f6a2bdfca8ad55/",
  windowTokens: 2048,
  windowOverlapTokens: 64,
  files: [
    { path: "onnx/int8_int4_embeddings/model.onnx", localPath: "onnx/model.onnx", size: 96_296_126, sha256: "a6c77496152e458c072e4787f872192af0449a427359d1afbfa1d4d6b116a305" },
    { path: "tokenizer.json", size: 34_363_287, sha256: "7e426c3929b44e6ab4c931770b5f22b913280633f5a1c67c81e9ad64decef55c" },
    { path: "tokenizer_config.json", size: 574, sha256: "14b147f2a4f939d9b12ab36e9633917040dd948fa78ce283b03402e4cf2c9cba" },
    { path: "config.json", size: 2_084, sha256: "b5bfba7b100b4b1aa361e8160e5593695164d81ca09b47f3b26561332b520218" },
    { path: "special_tokens_map.json", size: 173, sha256: "97f6f6ef323755568c9dddf57b7b2bac4c2019e8c10c2ef1262001a9f6487124" },
  ] as ReadonlyArray<ScreenerModelFile>,
} as const;

export function screenerModelTotalBytes(): number {
  return SCREENER_MODEL.files.reduce((n, f) => n + f.size, 0);
}
