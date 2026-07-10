import { describe, expect, it } from "vitest";
import { AttachmentNonceStore } from "./attachment-nonces.js";

describe("AttachmentNonceStore", () => {
  it("issues scoped, single-use attachment grants", () => {
    let now = 1_000;
    const store = new AttachmentNonceStore(20_000, () => now);
    const { nonce } = store.create("me", "host", "session");
    expect(store.consume(nonce, "someone-else")).toBeNull();
    expect(store.consume(nonce, "me")).toBeNull();

    const second = store.create("me", "host", "session");
    expect(store.consume(second.nonce, "me")).toMatchObject({ hostId: "host", sessionId: "session" });
    expect(store.consume(second.nonce, "me")).toBeNull();

    const third = store.create("me", "host", "session");
    now += 20_001;
    expect(store.consume(third.nonce, "me")).toBeNull();
  });
});
