// ビルド後処理: dist/index.html の外部JS/CSSをインライン化し、
// file:// で直接開いても動く自己完結型の単一HTMLにする。
// （ESモジュールを外部srcで読むと file:// では crossorigin/CORS でブロックされるため、
//  インライン <script type="module"> にして外部フェッチ自体を無くす）
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const indexPath = join(dist, "index.html");
let html = readFileSync(indexPath, "utf8");

// <link rel="stylesheet" ... href="...css"> を <style> に置換
html = html.replace(
  /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
  (_m, href) => {
    const file = join(dist, href.replace(/^\.?\//, ""));
    const css = existsSync(file) ? readFileSync(file, "utf8") : "";
    return `<style>\n${css}\n</style>`;
  },
);

// <script type="module" ... src="...js"></script> を インライン化
html = html.replace(
  /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g,
  (_m, src) => {
    const file = join(dist, src.replace(/^\.?\//, ""));
    let js = existsSync(file) ? readFileSync(file, "utf8") : "";
    // sourcemap参照はfile://で404になるため除去（デバッグは dev サーバーで）
    js = js.replace(/\n\/\/#\s*sourceMappingURL=.*$/m, "");
    return `<script type="module">\n${js}\n</script>`;
  },
);

writeFileSync(indexPath, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`inlined → dist/index.html (${kb} KB, 自己完結・ダブルクリックで起動可)`);
