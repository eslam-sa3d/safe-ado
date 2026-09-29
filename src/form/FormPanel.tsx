import * as SDK from "azure-devops-extension-sdk";
import type { IWorkItemFormService } from "azure-devops-extension-api/WorkItemTracking/WorkItemTrackingServices";
import { useCallback, useEffect, useRef, useState } from "react";
import { emptyMeta, loadConfig, metaStore } from "../api/data";
import { hubUrl } from "../api/links";
import { effectivePiRoot, flatten, pathTo } from "../api/org";
import { F, LINK, OrgNode, ProgramIncrement, SafeConfig, Sprint, WorkItem, WorkItemMeta } from "../api/types";
import { openInNewTab } from "../api/urlState";
import { getProgramIncrements, getStateCategories, getWorkItems, isUnder, openWorkItem, relationTargetId } from "../api/wit";
import { ErrorBar, Spinner, LevelPill } from "../components/common";
import { useCanSafe } from "../components/useCanSafe";
import {
  estimatedCompletion,
  isPiAssigned,
  PI_LIMIT_MESSAGE,
  piInvolvement,
  toggleAssignedNode,
  toggleAssignedPi,
} from "./planning";

/** Runtime id of the work item form service (the api package ships AMD, so only its types are imported). */
export const WORK_ITEM_FORM_SERVICE = "ms.vss-work-web.work-item-form";

type FormService = Pick<IWorkItemFormService, "getId" | "getFieldValues"> &
  Partial<Pick<IWorkItemFormService, "getFields" | "setFieldValues">>;

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

/** Fields the panel shows (unit from the area, PI / sprint from the iteration). */
const RELEVANT = new Set<string>([F.area, F.iteration]);

/** Typing in a field fires onFieldChanged per keystroke; reloads wait for a pause this long. */
export const FIELD_CHANGE_DEBOUNCE_MS = 300;

/**
 * Registers the IWorkItemNotificationListener for this contribution. Field changes only
 * refresh (debounced) when a field the panel shows changed; other events refresh at once.
 */
export function registerFormHandlers(sdk: RegisterSdk): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const now = () => {
    cancel();
    notifyFormChange();
  };
  sdk.register(sdk.getContributionId(), {
    onLoaded: now,
    onFieldChanged: (args: { changedFields?: Record<string, unknown> }) => {
      const changed = Object.keys(args?.changedFields ?? {});
      if (changed.length && !changed.some((f) => RELEVANT.has(f))) return;
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        notifyFormChange();
      }, FIELD_CHANGE_DEBOUNCE_MS);
    },
    onSaved: now,
    onRefreshed: now,
    onReset: now,
    onUnloaded: cancel,
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
  iteration?: string;
}

export interface PanelData {
  id: number;
  title: string;
  area: string;
  iteration: string;
  config: SafeConfig | null;
  unit?: OrgNode;
  /** PIs of the unit's cadence. */
  pis: ProgramIncrement[];
  pi?: ProgramIncrement;
  sprint?: Sprint;
  parent?: Linked;
  children: Linked[];
  /** PIs any (not removed) child is planned in, and the finish of the latest such sprint. */
  involvement: ProgramIncrement[];
  completion?: string;
  /** Scheduling date fields (StartDate / TargetDate) the item's type has. */
  dateFields: string[];
  meta: WorkItemMeta;
}

const linked = (w: WorkItem): Linked => ({
  id: w.id,
  title: w.fields[F.title] ?? "",
  type: w.fields[F.type] ?? "",
  state: w.fields[F.state] ?? "",
  iteration: w.fields[F.iteration],
});

const formService = () => SDK.getService<FormService>(WORK_ITEM_FORM_SERVICE);

/** StartDate / TargetDate when the work item's type has them (per the form's field list). */
async function dateFieldsOf(form: FormService): Promise<string[]> {
  try {
    const fields = (await form.getFields?.()) ?? [];
    const names = new Set(fields.map((f) => f.referenceName));
    return [F.startDate, F.targetDate].filter((f) => names.has(f));
  } catch {
    return [];
  }
}

export async function loadPanel(): Promise<PanelData> {
  const form = await formService();
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
    involvement: [],
    dateFields: [],
    meta: emptyMeta(id),
  };

  const config = await loadConfig();
  if (!config) return base;
  const unit = unitForArea(config.root, area);
  if (!unit) return { ...base, config };

  const [pis, dateFields] = await Promise.all([getProgramIncrements(effectivePiRoot(config, unit.id)), dateFieldsOf(form)]);
  const pi = pis.find((p) => isUnder(iteration, p.path));
  const sprint = pi?.sprints.find((s) => isUnder(iteration, s.path));
  const out: PanelData = { ...base, config, unit, pis, pi, sprint, dateFields };
  if (id <= 0) return out;

  const [[self], meta] = await Promise.all([getWorkItems([id], undefined, true), metaStore.get(String(id))]);
  const rels = self?.relations ?? [];
  const parentId = rels.filter((r) => r.rel === LINK.parent).map((r) => relationTargetId(r.url))[0] ?? null;
  const childIds = rels
    .filter((r) => r.rel === LINK.child)
    .map((r) => relationTargetId(r.url))
    .filter((x): x is number => x !== null);
  const related =
    parentId !== null || childIds.length
      ? await getWorkItems([...(parentId !== null ? [parentId] : []), ...childIds], [F.id, F.title, F.type, F.state, F.iteration])
      : [];
  const byId = new Map(related.map((w) => [w.id, w]));
  const parent = parentId !== null ? byId.get(parentId) : undefined;
  const children = childIds.map((c) => byId.get(c)).filter((w): w is WorkItem => !!w).map(linked);
  const categoryOf = await getStateCategories(Array.from(new Set(children.map((c) => c.type))));
  const planned = children.filter((c) => categoryOf(c.type, c.state) !== "Removed").map((c) => c.iteration);
  return {
    ...out,
    parent: parent && linked(parent),
    children,
    involvement: piInvolvement(planned, pis),
    completion: estimatedCompletion(planned, pis),
    meta: meta ?? emptyMeta(id),
  };
}

/** A YYYY-MM-DD date as a local-midnight Date for a work item date field (null clears it). */
function fieldDate(value: string | undefined): Date | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

/** The "SAFe" group on the Azure DevOps work item form (Agile Hive's SAFe® Hierarchy panel). */
export function FormPanel() {
  const can = useCanSafe();
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

  /**
   * Saves the SAFe metadata, then the matching work item fields (if any). When the field write
   * fails the metadata is restored, so both stay in step.
   */
  const saveMeta = async (next: WorkItemMeta, fields: Record<string, Date | null> = {}) => {
    if (next.plannedStart && next.plannedEnd && next.plannedEnd < next.plannedStart) {
      setSaveError("The planned end date is before the planned start date.");
      return;
    }
    const before = meta;
    setSaveError(undefined);
    setSaving(true);
    setData((d) => d && { ...d, meta: next });
    let saved: WorkItemMeta | undefined;
    try {
      saved = await metaStore.save(next);
      const names = Object.keys(fields);
      if (names.length) {
        const form = await formService();
        if (!form.setFieldValues) throw new Error("the work item form cannot set field values");
        const result = await form.setFieldValues(fields as Record<string, Object>);
        const failed = names.filter((f) => result?.[f] === false);
        if (failed.length) throw new Error(`Azure DevOps rejected ${failed.join(", ")}`);
      }
      setData((d) => d && { ...d, meta: saved! });
    } catch (e: any) {
      let restored = before;
      let note = "";
      if (saved) {
        try {
          restored = await metaStore.save({ ...before, __etag: saved.__etag });
        } catch (r: any) {
          restored = saved;
          note = ` (the SAFe data could not be restored: ${r?.message ?? r})`;
        }
      }
      setData((d) => d && { ...d, meta: restored });
      setSaveError(`Could not save: ${e?.message ?? e}${note}`);
    } finally {
      setSaving(false);
    }
  };

  const togglePi = (pi: ProgramIncrement) => {
    const next = toggleAssignedPi(meta, pi);
    if (!next) {
      setSaveError(PI_LIMIT_MESSAGE);
      return;
    }
    return saveMeta(next);
  };

  const savePlanned = (key: "plannedStart" | "plannedEnd", value: string) => {
    const field = key === "plannedStart" ? F.startDate : F.targetDate;
    const fields: Record<string, Date | null> = data.dateFields.includes(field) ? { [field]: fieldDate(value) } : {};
    return saveMeta({ ...meta, [key]: value || undefined }, fields);
  };

  const openHub = async () => {
    try {
      await openInNewTab(await hubUrl(`node=${unit.id}&view=workitems`));
    } catch (e: any) {
      setSaveError(`Could not open SAFe Ado: ${e?.message ?? e}`);
    }
  };

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
          <LevelPill level={unit.level} />
          <button className="link safe-form-open" onClick={() => void openHub()}>
            Open in SAFe Ado
          </button>
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
        <span className="field-label">PI involvement</span>
        <span>{data.involvement.length ? data.involvement.map((p) => p.name).join(", ") : <span className="muted">None</span>}</span>
      </div>
      <div className="safe-form-row">
        <span className="field-label">Estimated completion</span>
        <span>{data.completion ?? <span className="muted">Unknown</span>}</span>
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
        <fieldset className="safe-form-meta" disabled={saving || !can.plan}>
          <label className="safe-form-row">
            <span className="field-label">Owning team</span>
            <select value={meta.owningNodeId ?? ""} onChange={(e) => saveMeta({ ...meta, owningNodeId: e.target.value || undefined })}>
              <option value="">–</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {unit.children.length > 0 && (
            <div className="safe-form-row" role="group" aria-label="Assigned teams">
              <span className="field-label">Assigned teams</span>
              <span className="safe-form-pis">
                {unit.children.map((c) => (
                  <label key={c.id} className="check">
                    <input
                      type="checkbox"
                      checked={(meta.assignedNodeIds ?? []).includes(c.id)}
                      onChange={() => saveMeta(toggleAssignedNode(meta, c.id))}
                    />{" "}
                    {c.name}
                  </label>
                ))}
              </span>
            </div>
          )}
          <div className="safe-form-row" role="group" aria-label="Assigned PIs">
            <span className="field-label">Assigned PIs</span>
            <span className="safe-form-pis">
              {data.pis.length === 0 && <span className="muted">No PIs</span>}
              {data.pis.map((p) => (
                <label key={p.path} className="check">
                  <input type="checkbox" checked={isPiAssigned(meta, p)} onChange={() => togglePi(p)} /> {p.name}
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
                onChange={(e) => savePlanned("plannedStart", e.target.value)}
              />
              –
              <input
                type="date"
                aria-label="Planned end"
                value={meta.plannedEnd ?? ""}
                onChange={(e) => savePlanned("plannedEnd", e.target.value)}
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
