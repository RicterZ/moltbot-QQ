import { spawn, ChildProcess } from 'child_process';

interface SendMessageParams {
  to: string;
  text: string;
  isGroup?: boolean;
  mediaUrl?: string;
}

export class NapcatRpcClient {
  private process: ChildProcess | null = null;
  private connected: boolean = false;
  private messageHandlers: ((message: any) => void)[] = [];

  constructor() {}

  async connect(): Promise<boolean> {
    // 启动nap-msg watch来监听消息
    try {
      this.process = spawn('nap-msg', ['watch']);
      
      this.process.stdout?.setEncoding('utf8');
      this.process.stdout?.on('data', (data) => {
        // 处理从nap-msg watch接收到的数据
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const messageObj = JSON.parse(line.trim());
              // 调用所有消息处理器
              for (const handler of this.messageHandlers) {
                handler(messageObj);
              }
            } catch (parseError) {
              // 忽略非JSON格式的日志行
              if (line.includes('Napcat process closed')) {
                console.log(line.trim());
              }
            }
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        console.error('Napcat stderr:', data.toString());
      });

      this.process.on('close', (code) => {
        console.log(`Napcat process closed with code ${code}`);
        this.connected = false;
      });

      // 等待一段时间让连接建立
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.connected = true;
      console.log('Napcat RPC connected');
      return true;
    } catch (error) {
      console.error('Failed to start nap-msg watch:', error);
      return false;
    }
  }

  async send(method: string, params?: any): Promise<any> {
    if (!this.connected) {
      throw new Error('Napcat RPC client not connected');
    }

    try {
      switch (method) {
        case 'message.send':
          return await this.sendMessage(params);
        default:
          throw new Error(`Unsupported method: ${method}`);
      }
    } catch (error) {
      console.error(`Error calling method ${method}:`, error);
      throw error;
    }
  }

  private async sendMessage(params: SendMessageParams): Promise<any> {
    const { execSync } = require('child_process');
    
    let cmd: string;
    if (params.isGroup) {
      // 发送到群组
      cmd = `nap-msg send-group ${params.to} --text "${params.text.replace(/"/g, '\\"')}"`;
    } else {
      // 发送私聊消息
      cmd = `nap-msg send ${params.to} --text "${params.text.replace(/"/g, '\\"')}"`;
    }

    if (params.mediaUrl) {
      // 如果有媒体文件，添加到命令中
      cmd += ` --media "${params.mediaUrl}"`;
    }

    try {
      const result = execSync(cmd, { encoding: 'utf8' });
      return { success: true, result };
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
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

  disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this.messageHandlers = [];
  }
}