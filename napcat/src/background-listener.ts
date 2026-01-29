import { spawn } from 'child_process';
import { NapcatRpcClient } from './napcat-bridge.js';

// 全局变量存储后台监听器
let backgroundListener: {
  client: NapcatRpcClient;
  unsubscribe: (() => void) | null;
} | null = null;

export async function startBackgroundListener(handleInboundMessage: (message: any) => void) {
  if (backgroundListener) {
    // 如果已经有一个监听器在运行，先停止它
    stopBackgroundListener();
  }
  
  const client = new NapcatRpcClient();
  const connected = await client.connect();
  
  if (!connected) {
    throw new Error('Failed to connect to nap-msg RPC for background listener');
  }
  
  // 订阅传入的消息
  const unsubscribe = client.subscribe((message) => {
    handleInboundMessage(message);
  });
  
  backgroundListener = { client, unsubscribe };
  
  console.log('Napcat background listener started');
  
  return () => {
    stopBackgroundListener();
  };
}

export function stopBackgroundListener() {
  if (backgroundListener) {
    if (backgroundListener.unsubscribe) {
      backgroundListener.unsubscribe();
    }
    backgroundListener.client.disconnect();
    backgroundListener = null;
    console.log('Napcat background listener stopped');
  }
}

export function getBackgroundListener() {
  return backgroundListener;
}