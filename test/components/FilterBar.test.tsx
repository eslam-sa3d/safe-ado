import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { dataStore, docs } from "../fakeAdo";
import { EMPTY_FILTER, ItemFilter } from "../../src/api/filters";
import { FilterBar } from "../../src/components/FilterBar";

const OPTIONS = { types: ["Epic", "Feature"], states: ["New"], assignees: ["Ada"], tags: [] };

function Harness({ onChange }: { onChange: (f: ItemFilter) => void }) {
  const [f, setF] = useState(EMPTY_FILTER);
  return (
    <FilterBar
      value={f}
      options={OPTIONS}
      onChange={(next) => {
        setF(next);
        onChange(next);
      }}
    />
  );
}

describe("FilterBar", () => {
  it("filters by text and toggles facet values", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Filter text"), { target: { value: "pay" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: "pay" }));

    const types = screen.getByRole("group", { name: "Type filter" });
    fireEvent.click(within(types).getByLabelText("Feature"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: ["Feature"] }));
    expect(screen.getByText("Type (1)")).toHaveClass("primary");
    fireEvent.click(within(types).getByLabelText("Feature"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: [] }));
    expect(within(screen.getByRole("group", { name: "Tags filter" })).getByText("No values")).toBeInTheDocument();
  });

  it("applies the WIQL clause on Enter only", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const wiql = screen.getByLabelText("WIQL clause");
    fireEvent.change(wiql, { target: { value: "[System.Tags] CONTAINS 'MVP'" } });
    fireEvent.keyDown(wiql, { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(wiql, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ wiql: "[System.Tags] CONTAINS 'MVP'" })));
    expect(wiql).toHaveClass("active");
  });

  it("clears filters and resets the WIQL draft", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const clear = screen.getByRole("button", { name: "Clear filters" });
    expect(clear).toBeDisabled();
    const wiql = screen.getByLabelText("WIQL clause");
    fireEvent.change(wiql, { target: { value: "[System.State] = 'New'" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    await waitFor(() => expect(clear).toBeEnabled());
    fireEvent.click(clear);
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTER);
    expect(wiql).toHaveValue("");
  });

  it("copies the filter as WIQL and tolerates a blocked clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      render(<Harness onChange={() => {}} />);
      const copy = screen.getByRole("button", { name: "Copy WIQL" });
      expect(copy).toBeDisabled();
      fireEvent.click(within(screen.getByRole("group", { name: "State filter" })).getByLabelText("New"));
      await act(async () => fireEvent.click(copy));
      expect(writeText).toHaveBeenCalledWith("[System.State] IN ('New')");
      expect(copy).toHaveTextContent("Copied");
      act(() => vi.advanceTimersByTime(1600));
      expect(copy).toHaveTextContent("Copy WIQL");

      writeText.mockRejectedValueOnce(new Error("blocked"));
      await act(async () => fireEvent.click(copy));
      expect(copy).toHaveTextContent("Copy WIQL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("can hide the WIQL box", () => {
    render(<FilterBar value={EMPTY_FILTER} options={OPTIONS} onChange={() => {}} showWiql={false} />);
    expect(screen.queryByLabelText("WIQL clause")).toBeNull();
  });
});

describe("FilterBar — extended facets, validation and quick filters", () => {
  it("shows Priority and Iteration facets when options are given, plus view-specific SAFe facets", () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        value={EMPTY_FILTER}
        onChange={onChange}
        options={{ ...OPTIONS, priorities: ["1", "2"], iterations: ["Sprint 1"] }}
        extraFacets={[{ key: "pis", label: "Assigned PIs", options: ["PI 2"], values: () => [] }]}
        quickFilters={false}
      />
    );
    fireEvent.click(within(screen.getByRole("group", { name: "Priority filter" })).getByLabelText("2"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ priorities: ["2"] }));
    fireEvent.click(within(screen.getByRole("group", { name: "Assigned PIs filter" })).getByLabelText("PI 2"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extra: { pis: ["PI 2"] } }));
    expect(screen.queryByRole("group", { name: "Quick filters" })).toBeNull();
  });

  it("toggles extra facet values off again", () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        value={{ ...EMPTY_FILTER, extra: { pis: ["PI 2"] }, priorities: ["1"] }}
        onChange={onChange}
        options={{ ...OPTIONS, priorities: ["1"] }}
        extraFacets={[{ key: "pis", label: "Assigned PIs", options: ["PI 2"], values: () => [] }]}
        quickFilters={false}
      />
    );
    fireEvent.click(within(screen.getByRole("group", { name: "Assigned PIs filter" })).getByLabelText("PI 2"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extra: { pis: [] } }));
    fireEvent.click(within(screen.getByRole("group", { name: "Priority filter" })).getByLabelText("1"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ priorities: [] }));
  });

  it("rejects an invalid WIQL clause with the server's message", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const wiql = screen.getByLabelText("WIQL clause");
    fireEvent.change(wiql, { target: { value: "[System.State] = " } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/TF51005/);
    expect(wiql).toHaveAttribute("aria-invalid", "true");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(wiql, { target: { value: "" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(wiql, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ wiql: "" })));
  });

  it("saves, applies (AND) and deletes shared quick filters", async () => {
    const onChange = vi.fn();
    function Q() {
      const [f, setF] = useState<ItemFilter>({ ...EMPTY_FILTER, states: ["New"] });
      return (
        <FilterBar
          value={f}
          options={OPTIONS}
          onChange={(n) => {
            setF(n);
            onChange(n);
          }}
        />
      );
    }
    render(<Q />);
    const menu = screen.getByRole("group", { name: "Quick filters" });
    expect(await within(menu).findByText("No quick filters yet")).toBeInTheDocument();
    fireEvent.change(within(menu).getByLabelText("Quick filter name"), { target: { value: "New work" } });
    fireEvent.click(within(menu).getByRole("button", { name: "Save" }));
    const box = await within(menu).findByLabelText("New work");
    expect(docs("quickfilters")[0]).toMatchObject({ name: "New work", filter: expect.objectContaining({ states: ["New"] }) });

    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ quick: [expect.objectContaining({ name: "New work" })] }));
    expect(screen.getByText("Quick filters (1)")).toBeInTheDocument();
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ quick: [] }));

    fireEvent.click(within(menu).getByRole("button", { name: "Delete quick filter New work" }));
    await waitFor(() => expect(within(menu).queryByLabelText("New work")).toBeNull());
    expect(docs("quickfilters")).toEqual([]);
  });

  it("shows quick filter storage errors", async () => {
    dataStore.failures.push({ op: "setDocument", error: new Error("quota") });
    render(<Harness onChange={() => {}} />);
    fireEvent.click(within(screen.getByRole("group", { name: "State filter" })).getByLabelText("New"));
    const menu = screen.getByRole("group", { name: "Quick filters" });
    fireEvent.change(within(menu).getByLabelText("Quick filter name"), { target: { value: "X" } });
    fireEvent.keyDown(within(menu).getByLabelText("Quick filter name"), { key: "Enter" });
    expect(await within(menu).findByText("quota")).toBeInTheDocument();
  });

  it("compact: shows only search and a Filters toggle until opened; counts active facets", () => {
    function Compact() {
      const [f, setF] = useState<ItemFilter>(EMPTY_FILTER);
      return (
        <FilterBar
          value={f}
          options={OPTIONS}
          onChange={setF}
          extraFacets={[{ key: "team", label: "Team", options: ["Red"], values: () => [] }]}
          showWiql={false}
          quickFilters={false}
          compact
        />
      );
    }
    render(<Compact />);
    const toggle = screen.getByRole("button", { name: "Filters" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Type filter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.click(within(screen.getByRole("group", { name: "Type filter" })).getByLabelText("Epic"));
    fireEvent.click(within(screen.getByRole("group", { name: "Team filter" })).getByLabelText("Red"));
    expect(screen.getByRole("button", { name: "Filters (2)" })).toHaveClass("primary");
    // Collapsed with active filters: Clear stays reachable.
    fireEvent.click(screen.getByRole("button", { name: "Filters (2)" }));
    expect(screen.queryByRole("group", { name: "Type filter" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Filters" })).not.toHaveClass("primary");
  });
});
