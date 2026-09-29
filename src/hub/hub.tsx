import * as SDK from "azure-devops-extension-sdk";
import { createRoot } from "react-dom/client";
import { App } from "../components/App";
import "./styles.css";

async function main() {
  await SDK.init({ loaded: false, applyTheme: true });
  await SDK.ready();
  createRoot(document.getElementById("root")!).render(<App />);
  SDK.notifyLoadSucceeded();
}

main().catch((e) => {
  document.body.textContent = `SAFe Ado failed to load: ${e?.message ?? e}`;
  SDK.notifyLoadFailed(e);
});
