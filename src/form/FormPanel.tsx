import * as SDK from "azure-devops-extension-sdk";
import type { IWorkItemFormService } from "azure-devops-extension-api/WorkItemTracking/WorkItemTrackingServices";
import { useCallback, useEffect, useRef, useState } from "react";
import { emptyMeta, loadConfig, metaStore } from "../api/data";
import { flatten, LEVEL_COLOR, pathTo } from "../api/org";
import { F, LEVEL_LABEL, LINK, OrgNode, ProgramIncrement, SafeConfig, Sprint, WorkItem, WorkItemMeta } from "../api/types";
import { getProgramIncrements, getWorkItems, isUnder, openWorkItem, relationTargetId } from "../api/wit";
import { ErrorBar, Spinner } from "../components/common";

/** Runtime id of the work item form service (the api package ships AMD, so only its types are imported). */
export const WORK_ITEM_FORM_SERVICE = "ms.vss-work-web.work-item-form";

type FormService = Pick<IWorkItemFormService, "getId" | "getFieldValues">;

// ---------------------------------------------------------------------------------------------
// Host notifications -> panel refresh
// ---------------------------------------------------------------------------------------------

const listeners = new Set<() => void>();

/** Subscribes to form notifications (load, field change, save, refresh, reset). */
export function onFormChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyFormChange(): void {
  listeners.forEach((l) => l());
}

type RegisterSdk = { register: (id: string, instance: object) => void; getContributionId: () => string };

const RELEVANT = new Set<string>([F.area, F.iteration, F.title, F.type]);

/**
 * Registers the IWorkItemNotificationListener for this contribution. Field changes only
 * refresh when a field the panel shows changed.
 */
export function registerFormHandlers(sdk: RegisterSdk): void {
  sdk.register(sdk.getContributionId(), {
    onLoaded: () => notifyFormChange(),
    onFieldChanged: (args: { changedFields?: Record<string, unknown> }) => {
      const changed = Object.keys(args?.changedFields ?? {});
      if (!changed.length || changed.some((f) => RELEVANT.has(f))) notifyFormChange();
    },
    onSaved: () => notifyFormChange(),
    onRefreshed: () => notifyFormChange(),
    onReset: () => notifyFormChange(),
    onUnloaded: () => undefined,
  });
}

/** Entry point used by form.tsx. */
export async function startForm(
  sdk: Pick<typeof SDK, "init" | "ready" | "notifyLoadSucceeded"> & RegisterSdk,
  render: () => void
): Promise<void> {
  await sdk.init({ loaded: false, applyTheme: true });
  await sdk.ready();
  registerFormHandlers(sdk);
  render();
  sdk.notifyLoadSucceeded();
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/** Deepest configured unit whose area path contains `area`. */
export function unitForArea(root: OrgNode, area: string | undefined): OrgNode | undefined {
  let best: OrgNode | undefined;
  let depth = -1;
  for (const n of flatten(root)) {
    if (!n.areaPath || !isUnder(area, n.areaPath)) continue;
    const d = n.areaPath.split("\\").length;
    if (d > depth) {
      best = n;
      depth = d;
    }
  }
  return best;
}

interface Linked {
  id: number;
  title: string;
  type: string;
  state: string;
}

export interface PanelData {
  id: number;
  title: string;
  area: string;
  iteration: string;
  config: SafeConfig | null;
  unit?: OrgNode;
  pis: ProgramIncrement[];
  pi?: ProgramIncrement;
  sprint?: Sprint;
  parent?: Linked;
  children: Linked[];
  meta: WorkItemMeta;
}

const linked = (w: WorkItem): Linked => ({
  id: w.id,
  title: w.fields[F.title] ?? "",
  type: w.fields[F.type] ?? "",
  state: w.fields[F.state] ?? "",
});

export async function loadPanel(): Promise<PanelData> {
  const form = await SDK.getService<FormService>(WORK_ITEM_FORM_SERVICE);
  const id = await form.getId();
  const values = (await form.getFieldValues([F.title, F.area, F.iteration, F.type])) as Record<string, any>;
  const area = String(values[F.area] ?? "");
  const iteration = String(values[F.iteration] ?? "");
  const base: PanelData = {
    id,
    title: String(values[F.title] ?? ""),
    area,
    iteration,
    config: null,
    pis: [],
    children: [],
    meta: emptyMeta(id),
  };

  const config = await loadConfig();
  if (!config) return base;
  const unit = unitForArea(config.root, area);
  if (!unit) return { ...base, config };

  const pis = await getProgramIncrements(config.piRootIteration);
  const pi = pis.find((p) => isUnder(iteration, p.path));
  const sprint = pi?.sprints.find((s) => isUnder(iteration, s.path));
  const out: PanelData = { ...base, config, unit, pis, pi, sprint };
  if (id <= 0) return out;

  const [self] = await getWorkItems([id], undefined, true);
  const rels = self?.relations ?? [];
  const parentId = rels.filter((r) => r.rel === LINK.parent).map((r) => relationTargetId(r.url))[0] ?? null;
  const childIds = rels
    .filter((r) => r.rel === LINK.child)
    .map((r) => relationTargetId(r.url))
    .filter((x): x is number => x !== null);
  const [related, metas] = await Promise.all([
    parentId !== null || childIds.length
      ? getWorkItems([...(parentId !== null ? [parentId] : []), ...childIds], [F.id, F.title, F.type, F.state])
      : Promise.resolve([] as WorkItem[]),
    metaStore.list(),
  ]);
  const byId = new Map(related.map((w) => [w.id, w]));
  const parent = parentId !== null ? byId.get(parentId) : undefined;
  return {
    ...out,
    parent: parent && linked(parent),
    children: childIds.map((c) => byId.get(c)).filter((w): w is WorkItem => !!w).map(linked),
    meta: metas.find((m) => m.workItemId === id) ?? emptyMeta(id),
  };
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

/** The "SAFe" group on the Azure DevOps work item form (Agile Hive's SAFe® Hierarchy panel). */
export function FormPanel() {
  const [data, setData] = useState<PanelData>();
  const [error, setError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const call = useRef(0);

  const load = useCallback(() => {
    const n = ++call.current;
    setError(undefined);
    loadPanel()
      .then((d) => n === call.current && setData(d))
      .catch((e) => n === call.current && setError(e?.message ?? String(e)));
  }, []);

  useEffect(() => {
    load();
    return onFormChange(load);
  }, [load]);

  if (error) return <ErrorBar message={`Could not load SAFe details: ${error}`} />;
  if (!data) return <Spinner label="Loading SAFe details…" />;
  if (!data.config) return <div className="safe-form muted">SAFe Ado is not configured for this project.</div>;
  if (!data.unit) {
    return (
      <div className="safe-form">
        <p className="muted">Not part of the SAFe organization</p>
        <p className="small muted">Area path {data.area || "(none)"} is not inside any unit of the SAFe hierarchy.</p>
      </div>
    );
  }

  const { config, unit, meta } = data;
  const teams = flatten(config.root).filter((n) => n.level === "team");

  const saveMeta = async (patch: Partial<WorkItemMeta>) => {
    const next = { ...meta, ...patch };
    if (next.plannedStart && next.plannedEnd && next.plannedEnd < next.plannedStart) {
      setSaveError("The planned end date is before the planned start date.");
      return;
    }
    const before = meta;
    setSaveError(undefined);
    setSaving(true);
    setData((d) => d && { ...d, meta: next });
    try {
      const saved = await metaStore.save(next);
      setData((d) => d && { ...d, meta: saved });
    } catch (e: any) {
      setData((d) => d && { ...d, meta: before });
      setSaveError(`Could not save: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  const togglePi = (path: string) =>
    saveMeta({
      assignedPiPaths: meta.assignedPiPaths.includes(path)
        ? meta.assignedPiPaths.filter((p) => p !== path)
        : [...meta.assignedPiPaths, path],
    });

  const editable = data.id > 0;

  return (
    <div className="safe-form">
      <div className="safe-form-row">
        <span className="field-label">SAFe unit</span>
        <span className="safe-form-unit">
          {pathTo(config.root, unit.id).map((n, i, all) => (
            <span key={n.id}>
              {n.name}
              {i < all.length - 1 && <span className="sep">›</span>}
            </span>
          ))}
          <span className="level-badge" style={{ background: LEVEL_COLOR[unit.level] }}>
            {LEVEL_LABEL[unit.level]}
          </span>
        </span>
      </div>
      <div className="safe-form-row">
        <span className="field-label">PI</span>
        <span>
          {data.pi ? data.pi.name : <span className="muted">Not planned in a PI</span>}
          {data.sprint && <span className="muted"> · {data.sprint.name}</span>}
        </span>
      </div>
      <div className="safe-form-row">
        <span className="field-label">Parent</span>
        <span>{data.parent ? <LinkedItem item={data.parent} /> : <span className="muted">None</span>}</span>
      </div>
      <div className="safe-form-row">
        <span className="field-label">Children</span>
        <span className="safe-form-children">
          {data.children.length ? data.children.map((c) => <LinkedItem key={c.id} item={c} />) : <span className="muted">None</span>}
        </span>
      </div>

      <ErrorBar message={saveError} onClose={() => setSaveError(undefined)} />
      {!editable ? (
        <p className="small muted">Save the work item to edit its SAFe planning data.</p>
      ) : (
        <fieldset className="safe-form-meta" disabled={saving}>
          <label className="safe-form-row">
            <span className="field-label">Owning team</span>
            <select value={meta.owningNodeId ?? ""} onChange={(e) => saveMeta({ owningNodeId: e.target.value || undefined })}>
              <option value="">–</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="safe-form-row" role="group" aria-label="Assigned PIs">
            <span className="field-label">Assigned PIs</span>
            <span className="safe-form-pis">
              {data.pis.length === 0 && <span className="muted">No PIs</span>}
              {data.pis.map((p) => (
                <label key={p.path} className="check">
                  <input type="checkbox" checked={meta.assignedPiPaths.includes(p.path)} onChange={() => togglePi(p.path)} /> {p.name}
                </label>
              ))}
            </span>
          </div>
          <div className="safe-form-row">
            <span className="field-label">Planned</span>
            <span className="safe-form-dates">
              <input
                type="date"
                aria-label="Planned start"
                value={meta.plannedStart ?? ""}
                onChange={(e) => saveMeta({ plannedStart: e.target.value || undefined })}
              />
              –
              <input
                type="date"
                aria-label="Planned end"
                value={meta.plannedEnd ?? ""}
                onChange={(e) => saveMeta({ plannedEnd: e.target.value || undefined })}
              />
            </span>
          </div>
        </fieldset>
      )}
    </div>
  );
}

function LinkedItem({ item }: { item: Linked }) {
  return (
    <button className="link" onClick={() => openWorkItem(item.id)} title={`${item.type} · ${item.state}`}>
      {item.type} #{item.id}: {item.title}
    </button>
  );
}
