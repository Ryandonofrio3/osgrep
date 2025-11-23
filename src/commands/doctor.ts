import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { MODEL_IDS } from "../config";

export const doctor = new Command("doctor")
  .description("Check osgrep health and paths")
  .action(async () => {
    console.log("🏥 osgrep Doctor\n");

    const home = os.homedir();
    const root = path.join(home, ".osgrep");
    const models = path.join(root, "models");
    const data = path.join(root, "data");
    const grammars = path.join(root, "grammars");
    const modelIds = [MODEL_IDS.embed, MODEL_IDS.rerank];

    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✅" : "❌";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Root", root);
    checkDir("Models", models);
    checkDir("Data (Vector DB)", data);
    checkDir("Grammars", grammars);

    const modelStatuses = modelIds.map((id) => {
      const modelPath = path.join(models, ...id.split("/"));
      return { id, path: modelPath, exists: fs.existsSync(modelPath) };
    });

    modelStatuses.forEach(({ id, path: p, exists }) => {
      const symbol = exists ? "✅" : "❌";
      console.log(`${symbol} Model: ${id} (${p})`);
    });

    const missingModels = modelStatuses.filter(({ exists }) => !exists);
    if (missingModels.length > 0) {
      console.log(
        "❌ Some models are missing and will be downloaded automatically on first run.",
      );
    }

    console.log(
      `\nSystem: ${os.platform()} ${os.arch()} | Node: ${process.version}`,
    );
    console.log("\nIf you see ✅ everywhere, you are ready to grep.");

    // Exit cleanly
    process.exit(0);
  });
