import { parentPort, workerData } from "node:worker_threads";
import { runMessageControls } from "./application.mjs";

const controls = runMessageControls(workerData);
parentPort.postMessage("ready");
parentPort.on("message", async message => {
  if (message !== "stop") return;
  try { await controls.stop(); }
  catch (error) {
    console.error("Message continuation shutdown failed:", error);
    process.exitCode = 1;
  } finally { parentPort.close(); }
});
