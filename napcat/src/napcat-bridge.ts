import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

interface RpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: any;
  id?: number;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string };
  method?: string;
  params?: any;
}

export class NapcatRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private nextId = 1;
  private pending = new Map<number | string, (resp: RpcResponse) => void>();
  private listeners: Array<(message: any) => void> = [];
  private starting = false;

  async connect(cliPath = "nap-msg", args: string[] = ["rpc"]): Promise<boolean> {
    if (this.proc || this.starting) return true;
    this.starting = true;
    return new Promise((resolve) => {
      try {
        this.proc = spawn(cliPath, args, { stdio: ["pipe", "pipe", "inherit"] });
        this.rl = createInterface({ input: this.proc.stdout });
        this.rl.on("line", (line) => this.handleLine(line));
        this.proc.on("exit", (code, signal) => {
          console.error(`nap-msg rpc exited code=${code} signal=${signal ?? "none"}`);
          this.cleanup();
        });

        this.initialize()
          .then(() => this.watchSubscribe())
          .then(() => {
            this.starting = false;
            resolve(true);
          })
          .catch((err) => {
            console.error("Failed to init/subscribe nap-msg rpc:", err);
            this.starting = false;
            resolve(false);
          });
      } catch (error) {
        console.error("Failed to start nap-msg rpc:", error);
        this.starting = false;
        resolve(false);
      }
    });
  }

  private async initialize(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await this.send("initialize", {});
    console.log("Napcat RPC initialized:", result);
  }

  private async watchSubscribe(): Promise<void> {
    const res = await this.send("watch.subscribe", {});
    if (res && res.subscription) {
      console.log(`Napcat RPC subscribed (subscription=${res.subscription})`);
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    try {
      const obj: RpcResponse = JSON.parse(line);
      if (obj.id !== undefined && this.pending.has(obj.id as any)) {
        const cb = this.pending.get(obj.id as any)!;
        this.pending.delete(obj.id as any);
        cb(obj);
        return;
      }
      if (obj.method === "message" && obj.params) {
        const payload = (obj.params as any).message ?? obj.params;
        this.listeners.forEach((l) => l(payload));
      }
    } catch (error) {
      console.error("Failed to parse RPC response:", error);
    }
  }

  async send(method: string, params?: any): Promise<any> {
    if (!this.proc || !this.proc.stdin?.writable) {
      throw new Error("Napcat RPC client not connected");
    }
    const id = this.nextId++;
    const payload: RpcRequest = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, (resp) => {
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      });
    });
  }

  subscribe(listener: (message: any) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  disconnect() {
    this.cleanup();
  }

  private cleanup() {
    this.rl?.close();
    this.rl = null;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.pending.clear();
    this.listeners = [];
    this.starting = false;
  }
}
