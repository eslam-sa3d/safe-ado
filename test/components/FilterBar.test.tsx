import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
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

  it("applies the WIQL clause on Enter only", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const wiql = screen.getByLabelText("WIQL clause");
    fireEvent.change(wiql, { target: { value: "[System.Tags] CONTAINS 'MVP'" } });
    fireEvent.keyDown(wiql, { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(wiql, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ wiql: "[System.Tags] CONTAINS 'MVP'" }));
    expect(wiql).toHaveClass("active");
  });

  it("clears filters and resets the WIQL draft", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const clear = screen.getByRole("button", { name: "Clear filters" });
    expect(clear).toBeDisabled();
    const wiql = screen.getByLabelText("WIQL clause");
    fireEvent.change(wiql, { target: { value: "[a] = 1" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
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
