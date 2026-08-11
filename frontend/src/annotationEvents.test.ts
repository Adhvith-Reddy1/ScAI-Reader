import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTest,
  notifyAnnotationsChanged,
  subscribeAnnotationsChanged,
} from "./annotationEvents.ts";

afterEach(() => _resetForTest());

describe("annotationEvents", () => {
  it("delivers the doc id to subscribers on notify", () => {
    const cb = vi.fn();
    subscribeAnnotationsChanged(cb);
    notifyAnnotationsChanged("doc-1");
    expect(cb).toHaveBeenCalledWith("doc-1");
  });

  it("notifies every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeAnnotationsChanged(a);
    subscribeAnnotationsChanged(b);
    notifyAnnotationsChanged("doc-1");
    expect(a).toHaveBeenCalledWith("doc-1");
    expect(b).toHaveBeenCalledWith("doc-1");
  });

  it("stops delivering after unsubscribe", () => {
    const cb = vi.fn();
    const unsub = subscribeAnnotationsChanged(cb);
    unsub();
    notifyAnnotationsChanged("doc-1");
    expect(cb).not.toHaveBeenCalled();
  });
});
