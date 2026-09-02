import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadingStateWriter } from "./reading-state-persistence";

afterEach(() => {
  vi.useRealTimers();
});

describe("阅读状态写入器", () => {
  it("立即保存首个检查点，并在间隔内只尾写最新状态", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const write = vi.fn();
    const writer = createReadingStateWriter(write, 500);

    writer.schedule({ page: 1, scrollTop: 0 });
    writer.schedule({ page: 1, scrollTop: 20 });
    writer.schedule({ page: 2, scrollTop: 40 });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith({ page: 1, scrollTop: 0 });
    vi.advanceTimersByTime(499);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({ page: 2, scrollTop: 40 });
  });

  it("离开阅读区时立即落盘尚未到期的状态", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const writer = createReadingStateWriter(write, 500);

    writer.schedule({ page: 3 });
    writer.schedule({ page: 4 });
    writer.dispose();
    writer.schedule({ page: 5 });

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({ page: 4 });
  });
});
