import { describe, expect, it } from "vitest";
import { ControlLease } from "./control-lease.js";

describe("ControlLease", () => {
  it("allows only one writer unless takeover is explicit", () => {
    let now = 1_000;
    const lease = new ControlLease(5_000, () => now);
    expect(lease.claim("desktop", "local").granted).toBe(true);
    expect(lease.claim("phone", "remote").granted).toBe(false);
    expect(lease.claim("phone", "remote", true).granted).toBe(true);
    expect(lease.isHolder("phone")).toBe(true);
    expect(lease.isHolder("desktop")).toBe(false);

    now += 5_001;
    expect(lease.current()).toBeNull();
  });

  it("renews on holder activity and releases on detach", () => {
    let now = 10_000;
    const lease = new ControlLease(2_000, () => now);
    lease.claim("phone", "remote");
    now += 1_500;
    expect(lease.touch("phone")).toBe(true);
    now += 1_500;
    expect(lease.isHolder("phone")).toBe(true);
    expect(lease.release("phone")).toBe(true);
    expect(lease.current()).toBeNull();
  });
});
