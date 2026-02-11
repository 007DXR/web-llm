"use strict";

/**
 * Popup - 用户界面层
 * 
 * 职责：
 * - 用户输入/输出
 * - 通过 Background 控制平面发送请求
 * - 接收 Streaming 响应并渲染
 */

// This code is partially adapted from the openai-chatgpt-chrome-extension repo:
// https://github.com/jessedi0n/openai-chatgpt-chrome-extension

import "./popup.css";
import { ProgressBar, Line } from "progressbar.js";

// ==================== 类型定义 ====================

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CachedSummaryData {
  url: string;
  title: string;
  summary: string;
  timestamp: number;
  contentLength: number;
}

interface TabContent {
  title: string;
  url: string;
  content: string;
  cachedSummary?: string;
  hasCachedSummary: boolean;
}

interface StreamChunk {
  requestId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
  usage?: any;
}

// ==================== 配置 ====================

const useContext = true;
console.log("[Popup] useContext:", useContext);

// ==================== UI 元素 ====================

const queryInput = document.getElementById("query-input")! as HTMLInputElement;
const submitButton = document.getElementById("submit-button")! as HTMLButtonElement;

submitButton.disabled = true;

const progressBar: ProgressBar = new Line("#loadingContainer", {
  strokeWidth: 4,
  easing: "easeInOut",
  duration: 1400,
  color: "#ffd166",
  trailColor: "#eee",
  trailWidth: 1,
  svgStyle: { width: "100%", height: "100%" },
});

// ==================== 状态管理 ====================

let isLoadingParams = true;
let allTabContents: TabContent[] = [];

// ==================== 引擎状态管理 ====================

async function checkEngineStatus(): Promise<{ ready: boolean; progress: number }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_ENGINE_STATUS" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[Popup] Error checking engine status:", chrome.runtime.lastError);
        resolve({ ready: false, progress: 0 });
      } else {
        resolve(response || { ready: false, progress: 0 });
      }
    });
  });
}

async function initializeEngine(): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "INIT_ENGINE_REQUEST" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[Popup] Error initializing engine:", chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

// 轮询检查引擎状态
async function waitForEngine(): Promise<void> {
  const checkInterval = 500;
  const maxWaitTime = 120000; // 2分钟超时
  const startTime = Date.now();

  // 先请求初始化
  await initializeEngine();

  return new Promise((resolve, reject) => {
    const check = async () => {
      const status = await checkEngineStatus();
      
      progressBar.animate(status.progress, { duration: 50 });
      
      if (status.ready) {
        enableInputs();
        resolve();
      } else if (Date.now() - startTime > maxWaitTime) {
        reject(new Error("Engine initialization timeout"));
      } else {
        setTimeout(check, checkInterval);
      }
    };
    
    check();
  });
}

function enableInputs() {
  if (isLoadingParams) {
    submitButton.disabled = false;
    const loadingBarContainer = document.getElementById("loadingContainer");
    if (loadingBarContainer) {
      loadingBarContainer.remove();
    }
    queryInput.focus();
    isLoadingParams = false;
  }
}

// ==================== Streaming Chat ====================

async function sendStreamingChat(messages: ChatMessage[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "chat_stream" });
    let fullMessage = "";

    port.onMessage.addListener((message) => {
      if (message.type === "chunk") {
        const chunk = message.data as StreamChunk;
        
        if (chunk.error) {
          reject(new Error(chunk.error));
          port.disconnect();
          return;
        }

        if (chunk.chunk) {
          fullMessage += chunk.chunk;
          updateAnswer(fullMessage);
        }

        if (chunk.done) {
          resolve(fullMessage);
          port.disconnect();
        }
      } else if (message.type === "status") {
        console.log("[Popup] Engine status:", message.status, message.progress);
      } else if (message.type === "error") {
        reject(new Error(message.error));
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      }
    });

    // 发送聊天请求
    port.postMessage({
      type: "CHAT_STREAM_START",
      messages: messages
    });
  });
}

// ==================== 事件监听器 ====================

queryInput.addEventListener("keyup", () => {
  submitButton.disabled = queryInput.value === "";
});

queryInput.addEventListener("keyup", (event) => {
  if (event.code === "Enter") {
    event.preventDefault();
    submitButton.click();
  }
});

submitButton.addEventListener("click", handleClick);

// ==================== 处理用户提交 ====================

async function handleClick() {
  const message = queryInput.value;
  console.log("[Popup] User message:", message);

  // 重置 UI
  document.getElementById("answer")!.innerHTML = "";
  document.getElementById("answerWrapper")!.style.display = "none";
  document.getElementById("loading-indicator")!.style.display = "block";

  let finalMessages: ChatMessage[] = [];

  // 检查是否有多个标签页
  if (allTabContents.length > 1) {
    console.log(`[Popup] Processing ${allTabContents.length} tabs...`);

    // Phase 1: 对每个标签页，使用摘要或原始内容回答问题
    const compressedTabContents: { 
      title: string; 
      url: string; 
      compressed: string; 
      isRelevant: boolean 
    }[] = [];

    for (let i = 0; i < allTabContents.length; i++) {
      const tabInfo = allTabContents[i];
      console.log(`[Popup] Processing tab ${i + 1}/${allTabContents.length}: ${tabInfo.title}`);

      let compressedContent = "";
      let isRelevant = true;

      if (tabInfo.hasCachedSummary && tabInfo.cachedSummary) {
        // 使用缓存的摘要
        console.log(`[Popup] Using cached summary for: ${tabInfo.title}`);
        
        const summaryMessages: ChatMessage[] = [
          {
            role: "system",
            content: "Answer the question based on the summary. Output format:\nSUFFICIENT: yes/no\nANSWER: your answer here (or 'N/A' if not sufficient)\n\nBe concise."
          },
          {
            role: "user",
            content: `SUMMARY: ${tabInfo.cachedSummary}\n\nQUESTION: ${message}\n\nOutput:`
          }
        ];

        try {
          const summaryResponse = await sendStreamingChat(summaryMessages);
          const isSufficient = summaryResponse.toLowerCase().includes("sufficient: yes");
          
          if (isSufficient) {
            const answerMatch = summaryResponse.match(/ANSWER:\s*([\s\S]*)/i);
            compressedContent = answerMatch ? answerMatch[1].trim() : summaryResponse;
            isRelevant = !compressedContent.toLowerCase().includes("no relevant information") &&
                         compressedContent.toLowerCase() !== "n/a";
          } else {
            // 摘要不够，使用原始内容
            compressedContent = await answerFromContent(tabInfo.content, message);
            isRelevant = !compressedContent.toLowerCase().includes("no relevant information");
          }
        } catch (err) {
          console.error(`[Popup] Error processing tab ${tabInfo.title}:`, err);
          compressedContent = "Error processing this tab";
          isRelevant = false;
        }
      } else {
        // 无缓存摘要，直接使用原始内容
        console.log(`[Popup] No cached summary for: ${tabInfo.title}`);
        try {
          compressedContent = await answerFromContent(tabInfo.content, message);
          isRelevant = !compressedContent.toLowerCase().includes("no relevant information");
        } catch (err) {
          console.error(`[Popup] Error processing tab ${tabInfo.title}:`, err);
          compressedContent = "Error processing this tab";
          isRelevant = false;
        }
      }

      compressedTabContents.push({
        title: tabInfo.title,
        url: tabInfo.url,
        compressed: compressedContent,
        isRelevant: isRelevant
      });
    }

    // Phase 2: 过滤相关标签页并组合
    const relevantTabs = compressedTabContents.filter(tab => tab.isRelevant);
    console.log(`[Popup] Found ${relevantTabs.length} relevant tabs`);

    const combinedContext = relevantTabs
      .map((tabInfo, index) =>
        `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\nRelevant Information: ${tabInfo.compressed}\n`
      )
      .join("\n");

    finalMessages = [
      {
        role: "system",
        content: relevantTabs.length > 0
          ? `You are a helpful assistant. The user has ${allTabContents.length} browser tabs open. Below is the relevant information extracted from ${relevantTabs.length} relevant tabs:\n\n${combinedContext}\n\nPlease provide a comprehensive answer.`
          : `You are a helpful assistant. The user has ${allTabContents.length} browser tabs open, but none contain relevant information. Please let the user know.`
      },
      { role: "user", content: message }
    ];

  } else {
    // 单个标签页或无标签页
    console.log("[Popup] Single tab or no tabs, using original logic...");
    
    const pageContext = allTabContents
      .map((tabInfo, index) =>
        `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\n\n${tabInfo.content}\n\n`
      )
      .join("\n");

    finalMessages = [
      {
        role: "system",
        content: `You are a helpful assistant. Here is the content of the browser tab:\n\n${pageContext}\n\nPlease answer questions about this webpage.`
      },
      { role: "user", content: message }
    ];
  }

  console.log("[Popup] Sending final messages...");

  try {
    await sendStreamingChat(finalMessages);
  } catch (err) {
    console.error("[Popup] Chat error:", err);
    document.getElementById("answer")!.innerHTML = `Error: ${err}`;
  }
}

async function answerFromContent(content: string, question: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "Answer the question based on the provided content. Format: Concise bullet points. If the content doesn't contain relevant information, say 'No relevant information'. No conversational filler."
    },
    {
      role: "user",
      content: `CONTENT: ${content.substring(0, 8000)}\nQUESTION: ${question}\nANSWER:`
    }
  ];

  return sendStreamingChat(messages);
}

// ==================== UI 更新 ====================

function updateAnswer(answer: string) {
  document.getElementById("answerWrapper")!.style.display = "block";
  const answerWithBreaks = answer.replace(/\n/g, "<br>");
  document.getElementById("answer")!.innerHTML = answerWithBreaks;

  // 复制按钮
  const copyButton = document.getElementById("copyAnswer");
  if (copyButton) {
    copyButton.onclick = () => {
      navigator.clipboard.writeText(answer)
        .then(() => console.log("[Popup] Answer copied"))
        .catch((err) => console.error("[Popup] Copy error:", err));
    };
  }

  // 时间戳
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  };
  const time = new Date().toLocaleString("en-US", options);
  document.getElementById("timestamp")!.innerText = time;

  // 隐藏加载指示器
  document.getElementById("loading-indicator")!.style.display = "none";
}

// ==================== 获取页面内容 ====================

async function getCachedSummary(url: string): Promise<CachedSummaryData | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_CACHED_SUMMARY", data: { url } },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Popup] Error getting cached summary:", chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(response?.summary || null);
        }
      }
    );
  });
}

async function getAllCachedSummaries(): Promise<{ [url: string]: CachedSummaryData }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_ALL_CACHED_SUMMARIES" },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Popup] Error getting cached summaries:", chrome.runtime.lastError);
          resolve({});
        } else {
          resolve(response?.summaries || {});
        }
      }
    );
  });
}

function fetchPageContents() {
  chrome.tabs.query({ currentWindow: true }, async (tabs) => {
    if (tabs.length === 0) {
      console.warn("[Popup] No tabs found");
      return;
    }

    // 获取所有缓存摘要
    const cachedSummaries = await getAllCachedSummaries();
    console.log(`[Popup] Found ${Object.keys(cachedSummaries).length} cached summaries`);

    tabs.forEach((tab) => {
      if (tab.id) {
        try {
          const port = chrome.tabs.connect(tab.id, { name: "channelName" });
          port.postMessage({});
          
          port.onMessage.addListener((msg) => {
            const tabUrl = tab.url || "Unknown URL";
            const cachedSummary = cachedSummaries[tabUrl];
            
            allTabContents.push({
              title: tab.title || "Untitled",
              url: tabUrl,
              content: msg.contents,
              cachedSummary: cachedSummary?.summary,
              hasCachedSummary: !!cachedSummary
            });

            console.log(`[Popup] Tab loaded: ${tab.title}, has cached summary: ${!!cachedSummary}`);
          });

          port.onDisconnect.addListener(() => {
            if (chrome.runtime.lastError) {
              console.warn(`[Popup] Could not connect to tab ${tab.id}: ${chrome.runtime.lastError.message}`);
            }
          });
        } catch (error) {
          console.warn(`[Popup] Failed to connect to tab ${tab.id}:`, error);
        }
      }
    });
  });
}

// ==================== 初始化 ====================

async function init() {
  console.log("[Popup] Initializing...");
  
  // 获取页面内容
  if (useContext) {
    fetchPageContents();
  }

  // 等待引擎就绪
  try {
    await waitForEngine();
    console.log("[Popup] Engine ready, UI enabled");
  } catch (err) {
    console.error("[Popup] Engine initialization failed:", err);
    document.getElementById("answer")!.innerHTML = "Engine initialization failed. Please reload the extension.";
  }
}

// 启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}