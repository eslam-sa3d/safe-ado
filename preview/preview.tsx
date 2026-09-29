/**
 * Local visual preview: renders the hub against the in-memory fake Azure DevOps backend used
 * by the tests. URL params: ?view=<ViewKey>&node=<nodeId>&theme=light|dark
 * Build with `npm run preview`, then open preview-dist/index.html.
 */
import { createRoot } from "react-dom/client";
import { App } from "../src/components/App";
import "../src/hub/styles.css";
import { dataStore, fake, fetchMock, makeConfig, PI1, PI2, PI2_S1, PI2_S2, resetFake, seedConfig, seedDocs } from "../test/fakeAdo";
import { ADO_THEMES } from "./themes";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
Object.entries(ADO_THEMES[theme]).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
document.body.dataset.theme = theme;

resetFake();
(window as any).fetch = fetchMock;

const config = makeConfig();
config.root.children[0].members = [
  { name: "Rita Engineer", role: "RTE" },
  { name: "Paul Manager", role: "Product Manager" },
  { name: "Sam Architect", role: "System Architect" },
];
seedConfig(config);
seedDocs("objectives", [
  { id: "o1", nodeId: "n-red", piPath: PI2, title: "Launch card payments", committed: true, plannedBV: 8, actualBV: 7, featureIds: [10] },
  { id: "o2", nodeId: "n-red", piPath: PI2, title: "Wallet beta", committed: false, plannedBV: 3, actualBV: 2, featureIds: [14] },
  { id: "o3", nodeId: "n-blue", piPath: PI2, title: "New checkout UI", committed: true, plannedBV: 10, actualBV: 6, featureIds: [11] },
  { id: "o4", nodeId: "n-arta", piPath: PI2, title: "PCI compliance", committed: true, plannedBV: 6, actualBV: null, featureIds: [] },
  { id: "o5", nodeId: "n-red", piPath: PI1, title: "Previous PI goal", committed: true, plannedBV: 5, actualBV: 4, featureIds: [] },
]);
seedDocs("risks", [
  { id: "r1", nodeId: "n-red", piPath: PI2, title: "Payment vendor API delay", description: "", owner: "Sam", impact: "High", status: "Unroamed", createdAt: "2026-09-01", probability: "Likely", impactLevel: "Major", residualProbability: "Unlikely", residualImpact: "Moderate", workItemId: 10 },
  { id: "r2", nodeId: "n-blue", piPath: PI2, title: "Test environment shortage", description: "", owner: "Priya", impact: "Medium", status: "Owned", createdAt: "2026-09-01", probability: "Very Likely", impactLevel: "Minor" },
  { id: "r3", nodeId: "n-arta", piPath: PI2, title: "Key engineer on leave", description: "", owner: "", impact: "Low", status: "Mitigated", createdAt: "2026-09-01" },
]);
dataStore.collections.set(`milestones-${fake.projectId}`, new Map([
  ["m1", { id: "m1", nodeId: "n-arta", title: "Beta release", date: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), __etag: 1 }],
]));
dataStore.collections.set(`capacity-${fake.projectId}`, new Map([
  [`n-red|${PI2_S1}`, { id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 12, __etag: 1 }],
  [`n-red|${PI2_S2}`, { id: `n-red|${PI2_S2}`, nodeId: "n-red", iterationPath: PI2_S2, capacity: 2, __etag: 1 }],
]));

localStorage.setItem(
  `safe-ado-prefs-${fake.projectId}`,
  JSON.stringify({ nodeId: params.get("node") ?? "n-arta", view: params.get("view") ?? "reports", piPath: "" })
);

createRoot(document.getElementById("root")!).render(<App />);
