import { useState } from "react";
import { scopeAreas } from "../api/org";
import { baseFields, scopeQuery } from "../api/queries";
import { F, WorkItem } from "../api/types";
import { getFieldNames, getStates, openNewWorkItem, openWorkItem, queryWorkItems, setFields } from "../api/wit";
import { Empty, ErrorBar, Info, Spinner, useAsync, Icon } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { wsjfOf } from "../api/rules";

/**
 * WSJF = Cost of Delay / Job Size. Stock processes carry Business Value and Time Criticality;
 * Risk Reduction/Opportunity Enablement is read from a custom field when present.
 */
const RROE_FIELD = "Custom.RROEValue";

const wsjf = (item: WorkItem) => wsjfOf(item.fields, RROE_FIELD);

export function PortfolioKanban() {
  const { config, node } = useSafe();
  const canPlan = useCan().plan;
  const epic = config.types.epic;
  const areas = scopeAreas(node);
  const [sortByWsjf, setSortByWsjf] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>();

  const { data, loading, error, reload, setData } = useAsync(async () => {
    // Only request WSJF fields that exist; the batch API rejects unknown field names.
    const known = new Set((await getFieldNames()).map((f) => f.referenceName));
    const wsjfFields = [F.businessValue, F.timeCriticality, F.effort, RROE_FIELD].filter((f) => known.has(f));
    const [states, items] = await Promise.all([
      getStates(epic),
      queryWorkItems(scopeQuery([epic], areas), [...baseFields(config), ...wsjfFields]),
    ]);
    const visible = states.filter((s) => s.category !== "Removed");
    // Items in Removed (or unknown) states have no column, so they are not counted either.
    return { states: visible, items: items.filter((i) => visible.some((s) => s.name === i.fields[F.state])) };
  }, [epic, areas.join("|")]);

  if (!epic) return <Empty title="No Epic type mapped">Set the Epic work item type in Setup.</Empty>;
  if (loading && !data) return <Spinner label="Loading portfolio…" />;

  const move = async (id: number, state: string) => {
    setData({ ...data!, items: data!.items.map((i) => (i.id === id ? { ...i, fields: { ...i.fields, [F.state]: state } } : i)) });
    try {
      await setFields(id, { [F.state]: state });
    } catch (e: any) {
      setActionError(`Could not move #${id}: ${e.message}`);
    }
    reload(true);
  };

  const sorted = (list: WorkItem[]) =>
    sortByWsjf ? [...list].sort((a, b) => (wsjf(b) ?? -1) - (wsjf(a) ?? -1)) : list;

  return (
    <div>
      <div className="toolbar">
        <strong>{data?.items.length ?? 0} {epic}s</strong>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={sortByWsjf} onChange={(e) => setSortByWsjf(e.target.checked)} /> Sort by WSJF
        </label>
        {canPlan && (
          <button className="btn" onClick={() => openNewWorkItem(epic, { [F.area]: areas[0] }).then(() => reload(true))}>
            <Icon name="Add" /> New {epic}
          </button>
        )}
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <ErrorBar message={error ?? actionError} onClose={() => setActionError(undefined)} />
      {!canPlan && <Info>You have read-only access: {epic}s can be viewed but not moved or created here.</Info>}
      <div className="kanban">
        {data?.states.map((s) => {
          const col = sorted(data.items.filter((i) => i.fields[F.state] === s.name));
          return (
            <div
              key={s.name}
              role="group"
              aria-label={`${s.name} column`}
              className={"kanban-col" + (over === s.name ? " drop-over" : "")}
              onDragOver={(e) => {
                if (!canPlan) return;
                e.preventDefault();
                setOver(s.name);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (!canPlan) return;
                const id = Number(e.dataTransfer.getData("text/plain"));
                const item = data.items.find((i) => i.id === id);
                if (item && item.fields[F.state] !== s.name) move(id, s.name);
              }}
            >
              <div className="kanban-header" style={{ borderTopColor: `#${s.color}` }}>
                <span>{s.name}</span>
                <span className="count">{col.length}</span>
              </div>
              {col.map((i) => {
                const score = wsjf(i);
                return (
                  <div
                    key={i.id}
                    className="card"
                    style={{ borderLeftColor: "#ff7b00" }}
                    draggable={canPlan}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i.id))}
                    onClick={() => openWorkItem(i.id).then(() => reload(true))}
                  >
                    <div className="card-title">{i.fields[F.title]}</div>
                    <div className="card-meta">
                      <span className="muted">#{i.id}</span>
                      {score !== null && (
                        <span className="pill" title="(Business Value + Time Criticality + RR/OE) ÷ Effort">
                          WSJF {score}
                        </span>
                      )}
                      {i.fields[F.assignedTo]?.displayName && <span className="muted">{i.fields[F.assignedTo].displayName}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
