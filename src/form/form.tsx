import * as SDK from "azure-devops-extension-sdk";
import { createRoot } from "react-dom/client";
import "../hub/styles.css";
import { FormPanel, startForm } from "./FormPanel";

startForm(SDK, () => createRoot(document.getElementById("root")!).render(<FormPanel />)).catch((e) => {
  document.body.textContent = `SAFe Ado failed to load: ${e?.message ?? e}`;
  SDK.notifyLoadFailed(e);
});
