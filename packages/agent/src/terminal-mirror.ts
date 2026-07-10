import { SerializeAddon } from "@xterm/addon-serialize";
import Headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const { Terminal } = Headless;

export interface TerminalMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot(): Promise<string>;
  dispose(): void;
}

export class XtermTerminalMirror implements TerminalMirror {
  readonly #terminal: HeadlessTerminal;
  readonly #serializer: SerializeAddon;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  public constructor(cols: number, rows: number, scrollback = 10_000) {
    this.#terminal = new Terminal({
      cols,
      rows,
      scrollback,
      // SerializeAddon reads the headless buffer through xterm's currently
      // proposed API. This is local-only state; no browser-facing proposed API
      // is exposed here.
      allowProposedApi: true,
    });
    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer);
  }

  public write(data: string): void {
    this.#enqueue(
      () => new Promise<void>((resolve) => this.#terminal.write(data, resolve)),
    );
  }

  public resize(cols: number, rows: number): void {
    this.#enqueue(() => {
      this.#terminal.resize(cols, rows);
      return Promise.resolve();
    });
  }

  public snapshot(): Promise<string> {
    if (this.#disposed) {
      return Promise.resolve("");
    }

    const task = this.#queue.then(() => this.#serializer.serialize());
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#serializer.dispose();
    this.#terminal.dispose();
  }

  #enqueue(operation: () => Promise<void>): void {
    if (this.#disposed) {
      return;
    }
    this.#queue = this.#queue.then(operation, operation);
  }
}
