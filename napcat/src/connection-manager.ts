import { NapcatRpcClient } from './napcat-bridge.js';

class ConnectionManager {
  private static instance: ConnectionManager;
  private client: NapcatRpcClient | null = null;
  private isConnected: boolean = false;
  private messageHandlers: ((message: any) => void)[] = [];
  private connectPromise: Promise<boolean> | null = null;

  private constructor() {}

  public static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  async connect(): Promise<boolean> {
    if (this.isConnected || this.connectPromise) {
      return this.isConnected;
    }

    this.connectPromise = new Promise(async (resolve) => {
      try {
        this.client = new NapcatRpcClient();
        const connected = await this.client.connect();

        if (connected) {
          this.isConnected = true;

          if (this.client) {
            this.client.subscribe((message) => {
              for (const handler of this.messageHandlers) {
                try {
                  handler(message);
                } catch (error) {
                  console.error('Error in message handler:', error);
                }
              }
            });
          }

          console.log('Napcat persistent connection established');
          resolve(true);
        } else {
          console.error('Failed to establish napcat connection');
          resolve(false);
        }
      } catch (error) {
        console.error('Error establishing napcat connection:', error);
        resolve(false);
      } finally {
        this.connectPromise = null;
      }
    });

    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.isConnected = false;
    this.connectPromise = null;
  }

  getClient(): NapcatRpcClient | null {
    if (this.isConnected && this.client) {
      return this.client;
    }
    return null;
  }

  async ensureConnected(): Promise<boolean> {
    if (!this.isConnected) {
      return await this.connect();
    }
    return true;
  }

  subscribe(handler: (message: any) => void): () => void {
    this.messageHandlers.push(handler);

    // 返回取消订阅函数
    return () => {
      const index = this.messageHandlers.indexOf(handler);
      if (index !== -1) {
        this.messageHandlers.splice(index, 1);
      }
    };
  }

  async send(method: string, params?: any): Promise<any> {
    if (!await this.ensureConnected()) {
      throw new Error('Cannot send message: not connected to napcat');
    }

    const client = this.getClient();
    if (!client) {
      throw new Error('Client not available');
    }

    return await client.send(method, params);
  }
}

export const connectionManager = ConnectionManager.getInstance();
