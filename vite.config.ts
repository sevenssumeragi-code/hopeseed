import { defineConfig } from "vite";

// GDD第16巻20-2のフォルダ構成に準拠。data/ のJSONマスターデータは
// resolveJsonModule で直接importするため、追加の静的配信設定は不要。
export default defineConfig({
  root: ".",
  // 相対パスで出力し、dist/index.html を file:// で直接開いても
  // /assets/... が解決できずに真っ黒になる問題を防ぐ（サブパス配信にも対応）。
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  server: { port: 5173 },
});
