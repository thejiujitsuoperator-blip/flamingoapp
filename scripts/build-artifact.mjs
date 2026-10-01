// Builds the app as one self-contained HTML page for publishing as a claude.ai artifact.
// The artifact host supplies <!doctype>, <head> and <body>, so the output is the page content only.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

execSync("npx vite build --mode artifact", { stdio: "inherit" });

const assets = path.join("dist-artifact", "assets");
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith(".js"));
const css = files.filter((f) => f.endsWith(".css"));
if (js.length !== 1) throw new Error(`Expected one JS bundle, found: ${js.join(", ")}`);

const script = readFileSync(path.join(assets, js[0]), "utf8").replace(/<\/script/gi, "<\\/script");
const style = css.map((f) => readFileSync(path.join(assets, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const page = `<title>Flamingo Members</title>
<style>
${style}
</style>
<div id="root"></div>
<script type="module">
${script}
</script>
`;
const out = path.join("dist-artifact", "flamingo-members.html");
writeFileSync(out, page);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
