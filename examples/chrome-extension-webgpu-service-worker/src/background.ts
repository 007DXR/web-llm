"use strict";

/**
 * Background Service Worker - 控制平面
 * 
 * 职责：
 * - 接收 popup / content 的请求
 * - 权限校验、路由、配额、任务队列
 * - 创建/唤醒 offscreen document
 * - 管理会话（session）、取消（abort）、超时、重试
 */

console.log("[Background] Service worker starting...");

// ==================== 类型定义 ====================

interface PendingPageData {
  url: string;
  title: string;
  content: string;
  timestamp: number;
}

interface SummaryData {
  url: string;
  title: string;
  summary: string;
  timestamp: number;
  contentLength: number;
}

interface StreamChunk {
  requestId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
  usage?: any;
}

// ==================== 常量配置 ====================

const SUMMARY_CACHE_PREFIX = "page_summary_";
const PENDING_CACHE_PREFIX = "pending_page_";
const MODEL_ID = "Llama-3.2-3B-Instruct-q4f32_1-MLC"//"Phi-3-mini-4k-instruct-q4f16_1-MLC";
console.log("[Background] MODEL_ID:", MODEL_ID);
// 配额和限制
const CONFIG = {
  maxConcurrentRequests: 1,
  requestTimeout: 120000, // 2分钟超时
  maxRetries: 3,
  maxContentLength: 8000,
  minContentLength: 100,
};

// ==================== 状态管理 ====================

let offscreenDocumentCreated = false;
let offscreenEngineReady = false;
let engineInitProgress = 0;

// 摘要队列
const summarizationQueue: string[] = [];
let isSummarizing = false;

// Streaming 端口管理
const streamPorts = new Map<string, chrome.runtime.Port>();

// ==================== Offscreen Document 管理 ====================

async function ensureOffscreenDocument(): Promise<boolean> {
  if (offscreenDocumentCreated) {
    return true;
  }

  try {
    // 检查是否已存在
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      console.log("[Background] Offscreen document already exists");
      return true;
    }

    // 创建新的 offscreen document
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run WebGPU ML engine for LLM inference"
    });

    offscreenDocumentCreated = true;
    console.log("[Background] Offscreen document created");
    return true;

  } catch (err) {
    console.error("[Background] Failed to create offscreen document:", err);
    return false;
  }
}

async function initializeEngine(): Promise<boolean> {
  if (offscreenEngineReady) {
    return true;
  }

  const created = await ensureOffscreenDocument();
  if (!created) {
    return false;
  }

  // 发送初始化请求到 offscreen
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "INIT_ENGINE",
      data: { modelId: MODEL_ID }
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[Background] Init engine error:", chrome.runtime.lastError);
        resolve(false);
      } else {
        resolve(response?.status === "initializing" || response?.status === "ready");
      }
    });
  });
}

// ==================== 摘要缓存管理 ====================

async function getCachedSummary(url: string): Promise<SummaryData | null> {
  const cacheKey = SUMMARY_CACHE_PREFIX + url;
  const cached = await chrome.storage.local.get(cacheKey);
  return (cached[cacheKey] as SummaryData) || null;
}

async function saveCachedSummary(data: SummaryData): Promise<void> {
  const cacheKey = SUMMARY_CACHE_PREFIX + data.url;
  await chrome.storage.local.set({ [cacheKey]: data });
}

async function getAllCachedSummaries(): Promise<{ [url: string]: SummaryData }> {
  const allData = await chrome.storage.local.get(null);
  const summaries: { [url: string]: SummaryData } = {};
  
  for (const key of Object.keys(allData)) {
    if (key.startsWith(SUMMARY_CACHE_PREFIX)) {
      const url = key.replace(SUMMARY_CACHE_PREFIX, "");
      summaries[url] = allData[key] as SummaryData;
    }
  }
  
  return summaries;
}

async function getPendingPage(url: string): Promise<PendingPageData | null> {
  const cacheKey = PENDING_CACHE_PREFIX + url;
  const cached = await chrome.storage.local.get(cacheKey);
  return (cached[cacheKey] as PendingPageData) || null;
}

async function savePendingPage(data: PendingPageData): Promise<void> {
  const cacheKey = PENDING_CACHE_PREFIX + data.url;
  await chrome.storage.local.set({ [cacheKey]: data });
}

async function removePendingPage(url: string): Promise<void> {
  const cacheKey = PENDING_CACHE_PREFIX + url;
  await chrome.storage.local.remove(cacheKey);
}

// ==================== 摘要队列处理 ====================

async function processSummarizationQueue() {
  if (isSummarizing || summarizationQueue.length === 0 || !offscreenEngineReady) {
    return;
  }

  isSummarizing = true;

  while (summarizationQueue.length > 0) {
    const url = summarizationQueue.shift()!;
    const pageData = await getPendingPage(url);

    if (!pageData) {
      continue;
    }

    // 检查是否已有摘要
    const existingSummary = await getCachedSummary(url);
    if (existingSummary) {
      await removePendingPage(url);
      continue;
    }

    console.log("[Background] Summarizing:", pageData.title);

    try {
      const response = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({
          type: "SUMMARIZE_PAGE",
          data: {
            url: pageData.url,
            title: pageData.title,
            content: pageData.content.substring(0, CONFIG.maxContentLength)
          }
        }, resolve);
      });

      if (response?.summary) {
        await saveCachedSummary({
          url: pageData.url,
          title: pageData.title,
          summary: response.summary,
          timestamp: Date.now(),
          contentLength: pageData.content.length
        });
        await removePendingPage(url);
        console.log("[Background] Summary saved:", pageData.title);
      }
    } catch (err) {
      console.error("[Background] Summarization failed:", err);
    }
  }

  isSummarizing = false;
}

async function queuePageForSummarization(url: string, title: string, content: string) {
  // 检查是否已有摘要
  const existingSummary = await getCachedSummary(url);
  if (existingSummary) {
    console.log("[Background] Summary already exists:", url);
    return;
  }

  // 保存待处理页面
  await savePendingPage({
    url,
    title,
    content,
    timestamp: Date.now()
  });

  // 加入队列
  if (!summarizationQueue.includes(url)) {
    summarizationQueue.push(url);
  }

  // 确保 offscreen 已创建并开始处理
  await ensureOffscreenDocument();
  processSummarizationQueue();
}

// ==================== 消息监听器 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Received:", message.type);

  switch (message.type) {
    // ==================== Offscreen 引擎状态 ====================
    case "ENGINE_READY":
      offscreenEngineReady = true;
      engineInitProgress = 1;
      console.log("[Background] Engine ready!");
      processSummarizationQueue();
      sendResponse({ status: "acknowledged" });
      return true;

    case "ENGINE_INIT_PROGRESS":
      engineInitProgress = message.data.progress;
      console.log("[Background] Engine progress:", Math.round(engineInitProgress * 100) + "%");
      sendResponse({ status: "acknowledged" });
      return true;

    case "ENGINE_ERROR":
      console.error("[Background] Engine error:", message.data.error);
      sendResponse({ status: "acknowledged" });
      return true;

    // ==================== Streaming 响应（来自 offscreen）====================
    case "STREAM_CHUNK": {
      const chunk = message.data as StreamChunk;
      const port = streamPorts.get(chunk.requestId);
      if (port) {
        port.postMessage({ type: "chunk", data: chunk });
        if (chunk.done || chunk.error) {
          streamPorts.delete(chunk.requestId);
        }
      }
      sendResponse({ status: "acknowledged" });
      return true;
    }

    // ==================== Popup 请求 ====================
    case "GET_ENGINE_STATUS":
      sendResponse({
        ready: offscreenEngineReady,
        progress: engineInitProgress,
        modelId: MODEL_ID
      });
      return true;

    case "INIT_ENGINE_REQUEST":
      initializeEngine().then(() => {
        sendResponse({ status: offscreenEngineReady ? "ready" : "initializing" });
      });
      return true;

    // ==================== 页面内容处理 ====================
    case "PAGE_LOADED": {
      const { url, title, content } = message.data;
      console.log("[Background] PAGE_LOADED:", title, "length:", content?.length);
      
      if (content && content.length > CONFIG.minContentLength) {
        queuePageForSummarization(url, title, content).then(() => {
          sendResponse({ status: "queued" });
        });
      } else {
        sendResponse({ status: "skipped", reason: "content too short" });
      }
      return true;
    }

    // ==================== 缓存查询 ====================
    case "GET_CACHED_SUMMARY":
      getCachedSummary(message.data.url).then(summary => {
        sendResponse({ summary });
      });
      return true;

    case "GET_ALL_CACHED_SUMMARIES":
      getAllCachedSummaries().then(summaries => {
        sendResponse({ summaries });
      });
      return true;

    default:
      return false;
  }
});

// ==================== Port 连接（用于 Streaming Chat）====================

chrome.runtime.onConnect.addListener((port) => {
  console.log("[Background] Port connected:", port.name);

  if (port.name === "chat_stream") {
    // Streaming chat 连接
    port.onMessage.addListener(async (message) => {
      if (message.type === "CHAT_STREAM_START") {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // 确保引擎就绪
        if (!offscreenEngineReady) {
          port.postMessage({ type: "status", status: "initializing", progress: engineInitProgress });
          await initializeEngine();
        }

        if (!offscreenEngineReady) {
          port.postMessage({ type: "error", error: "Engine not ready" });
          return;
        }

        // 注册端口用于接收 streaming 响应
        streamPorts.set(requestId, port);

        // 发送请求到 offscreen
        chrome.runtime.sendMessage({
          type: "CHAT_COMPLETION_STREAM",
          data: {
            requestId,
            messages: message.messages
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            port.postMessage({ type: "error", error: chrome.runtime.lastError.message });
            streamPorts.delete(requestId);
          }
        });
      }
    });

    port.onDisconnect.addListener(() => {
      console.log("[Background] Stream port disconnected");
      // 清理该端口关联的所有请求
      for (const [requestId, p] of streamPorts.entries()) {
        if (p === port) {
          streamPorts.delete(requestId);
          // 可以发送取消请求到 offscreen
          chrome.runtime.sendMessage({
            type: "ABORT_REQUEST",
            data: { requestId }
          });
        }
      }
    });
  }
});

// ==================== 初始化 ====================

// 启动时创建 offscreen document
ensureOffscreenDocument().then(() => {
  console.log("[Background] Initialization complete");
});
