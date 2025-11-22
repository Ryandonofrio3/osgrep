import { Command } from "commander";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const doctor = new Command("doctor")
  .description("Check osgrep health and paths")
  .action(async () => {
    console.log("🏥 osgrep Doctor\n");

    const home = os.homedir();
    const root = path.join(home, ".osgrep");
    const models = path.join(root, "models");
    const data = path.join(root, "data");
    const grammars = path.join(root, "grammars");

    const checkDir = (name: string, p: string) => {
        const exists = fs.existsSync(p);
        const symbol = exists ? "✅" : "❌";
        console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Root", root);
    checkDir("Models", models);
    checkDir("Data (Vector DB)", data);
    checkDir("Grammars", grammars);

    if (fs.existsSync(models)) {
        const files = fs.readdirSync(models);
        const modelExists = files.some(f => f.includes("mxbai"));
        console.log(modelExists ? "✅ Model: Cached" : "❌ Model: Not found (will download on first run)");
    }

    console.log(`\nSystem: ${os.platform()} ${os.arch()} | Node: ${process.version}`);
    console.log("\nIf you see ✅ everywhere, you are ready to grep.");
  });
