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
import { prebuiltAppConfig, ModelRecord } from "@mlc-ai/web-llm";

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

// ==================== Model Configuration ====================

// Get available models from web-llm config (filter for LLM models suitable for extension)
function getAvailableModels(): ModelRecord[] {
  return prebuiltAppConfig.model_list.filter(model => {
    // Filter for reasonable size models (under 8GB VRAM) for browser extension use
    const vram = model.vram_required_MB || 0;
    return vram > 0 && vram < 8000 && model.model_id;
  });
}

const AVAILABLE_MODELS = getAvailableModels();

// ==================== UI 元素 ====================

const queryInput = document.getElementById("query-input")! as HTMLInputElement;
const submitButton = document.getElementById("submit-button")! as HTMLButtonElement;

// Settings elements
const settingsButton = document.getElementById("settings-button")! as HTMLButtonElement;
const backButton = document.getElementById("back-button")! as HTMLButtonElement;
const chatPage = document.getElementById("chat-page")! as HTMLDivElement;
const settingsPage = document.getElementById("settings-page")! as HTMLDivElement;
const modelSelect = document.getElementById("model-select")! as HTMLSelectElement;
const modelInfo = document.getElementById("model-info")! as HTMLDivElement;
const saveSettingsButton = document.getElementById("save-settings")! as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status")! as HTMLDivElement;
const currentModelDisplay = document.getElementById("current-model-display")! as HTMLSpanElement;

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
let currentModelId = "";

// ==================== Settings Functions ====================

function populateModelSelect(selectedModelId?: string) {
  modelSelect.innerHTML = "";
  
  AVAILABLE_MODELS.forEach(model => {
    const option = document.createElement("option");
    option.value = model.model_id;
    option.textContent = model.model_id;
    if (model.model_id === selectedModelId) {
      option.selected = true;
    }
    modelSelect.appendChild(option);
  });
  
  updateModelInfo();
}

function updateModelInfo() {
  const selectedId = modelSelect.value;
  const model = AVAILABLE_MODELS.find(m => m.model_id === selectedId);
  
  if (model) {
    const vram = model.vram_required_MB?.toFixed(0) || "Unknown";
    const lowResource = model.low_resource_required ? "Yes" : "No";
    modelInfo.innerHTML = `
      <div><strong>VRAM Required:</strong> ${vram} MB</div>
      <div><strong>Low Resource:</strong> ${lowResource}</div>
    `;
  } else {
    modelInfo.innerHTML = "";
  }
}

function showSettingsPage() {
  chatPage.style.display = "none";
  settingsPage.style.display = "block";
  settingsStatus.textContent = "";
  
  // Get current model and populate select
  chrome.runtime.sendMessage({ type: "GET_SAVED_MODEL_ID" }, (response) => {
    const savedModelId = response?.modelId || AVAILABLE_MODELS[0]?.model_id;
    populateModelSelect(savedModelId);
  });
}

function showChatPage() {
  settingsPage.style.display = "none";
  chatPage.style.display = "block";
}

async function saveSettings() {
  const newModelId = modelSelect.value;
  
  if (!newModelId) {
    settingsStatus.textContent = "Please select a model.";
    return;
  }
  
  settingsStatus.textContent = "Saving...";
  saveSettingsButton.disabled = true;
  
  chrome.runtime.sendMessage({
    type: "CHANGE_MODEL",
    data: { modelId: newModelId }
  }, (response) => {
    if (chrome.runtime.lastError) {
      settingsStatus.textContent = "Error: " + chrome.runtime.lastError.message;
      saveSettingsButton.disabled = false;
      return;
    }
    
    if (response?.success) {
      if (response.status === "same_model") {
        settingsStatus.textContent = "Model unchanged.";
        saveSettingsButton.disabled = false;
      } else {
        currentModelId = newModelId;
        updateCurrentModelDisplay();
        settingsStatus.textContent = "Model changed! Reloading engine...";
        
        // Go back to chat page and show loading
        showChatPage();
        isLoadingParams = true;
        submitButton.disabled = true;
        
        // Recreate loading bar if needed
        let loadingContainer = document.getElementById("loadingContainer");
        if (!loadingContainer) {
          loadingContainer = document.createElement("div");
          loadingContainer.id = "loadingContainer";
          chatPage.insertBefore(loadingContainer, chatPage.firstChild);
        }
        
        // Wait for new engine
        waitForEngine().then(() => {
          console.log("[Popup] New model loaded successfully");
        }).catch(err => {
          console.error("[Popup] Failed to load new model:", err);
        });
      }
    } else {
      settingsStatus.textContent = "Error: " + (response?.error || "Unknown error");
      saveSettingsButton.disabled = false;
    }
  });
}

function updateCurrentModelDisplay() {
  if (currentModelId) {
    // Show shortened model name
    const shortName = currentModelId.replace("-MLC", "").substring(0, 25);
    currentModelDisplay.textContent = shortName + (currentModelId.length > 25 ? "..." : "");
    currentModelDisplay.title = currentModelId;
  } else {
    currentModelDisplay.textContent = "Loading...";
  }
}

// Settings event listeners
settingsButton.addEventListener("click", showSettingsPage);
backButton.addEventListener("click", showChatPage);
modelSelect.addEventListener("change", updateModelInfo);
saveSettingsButton.addEventListener("click", saveSettings);

// ==================== 引擎状态管理 ====================

async function checkEngineStatus(): Promise<{ ready: boolean; progress: number; modelId?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_ENGINE_STATUS" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[Popup] Error checking engine status:", chrome.runtime.lastError);
        resolve({ ready: false, progress: 0 });
      } else {
        // Update current model display
        if (response?.modelId) {
          currentModelId = response.modelId;
          updateCurrentModelDisplay();
        }
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

// updateUI: true 更新 UI（最终答案），false 静默模式（中间处理）
async function sendStreamingChat(messages: ChatMessage[], updateUI: boolean = true): Promise<string> {
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
          if (updateUI) {
            updateAnswer(fullMessage);
          }
        }

        if (chunk.done) {
          console.log("fullMessage:", fullMessage);
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
            content: "Answer the question based on the summary. You MUST use this EXACT format (no markdown, no asterisks):\nSUFFICIENT: yes\nANSWER: your answer\n\nOR if info not found:\nSUFFICIENT: no\nANSWER: N/A\n\nBe concise. No extra text."
          },
          {
            role: "user",
            content: `SUMMARY: ${tabInfo.cachedSummary}\n\nQUESTION: ${message}`
          }
        ];

        try {
          // 使用静默模式，不更新 UI
          const summaryResponse = await sendStreamingChat(summaryMessages, false);
          
          // 解析响应 - 更健壮的解析逻辑
          const parsedResult = parseSummaryResponse(summaryResponse);
          
          if (parsedResult.sufficient) {
            compressedContent = parsedResult.answer;
            isRelevant = !compressedContent.toLowerCase().includes("no relevant information") &&
                         compressedContent.toLowerCase() !== "n/a" &&
                         compressedContent.trim() !== "";
          } else {
            // 摘要不够，使用原始内容（静默模式）
            compressedContent = await answerFromContent(tabInfo.content, message);
            isRelevant = !compressedContent.toLowerCase().includes("no relevant information");
          }
        } catch (err) {
          console.error(`[Popup] Error processing tab ${tabInfo.title}:`, err);
          compressedContent = "Error processing this tab";
          isRelevant = false;
        }
      } else {
        // 无缓存摘要，直接使用原始内容（静默模式）
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

// 中间处理函数：使用静默模式，不更新 UI
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

  return sendStreamingChat(messages, false);
}

// 解析摘要响应 - 处理各种格式变体
function parseSummaryResponse(response: string): { sufficient: boolean; answer: string } {
  const normalized = response.toLowerCase();
  
  // 检查 SUFFICIENT - 支持多种格式：
  // "SUFFICIENT: yes", "**Sufficient:** yes", "sufficient:yes"
  const sufficientMatch = normalized.match(/\*{0,2}sufficient\*{0,2}:\s*(yes|no)/i);
  const hasSufficient = sufficientMatch !== null;
  const isSufficient = sufficientMatch ? sufficientMatch[1] === "yes" : false;
  
  // 提取 ANSWER - 支持多种格式：
  // "ANSWER: xxx", "**Answer:** xxx", "**ANSWER:** xxx"
  const answerMatch = response.match(/\*{0,2}answer\*{0,2}:\s*([\s\S]*)/i);
  let answer = "";
  
  if (answerMatch) {
    answer = answerMatch[1].trim();
    // 清理可能的 markdown 格式残留
    answer = answer.replace(/^\*+|\*+$/g, "").trim();
  } else if (!hasSufficient) {
    // 如果没有 SUFFICIENT 也没有 ANSWER 格式，整个响应可能就是答案
    // 这种情况假设模型直接给出了答案，视为 sufficient
    answer = response.trim();
    return { sufficient: true, answer };
  }
  
  return { sufficient: isSufficient, answer };
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

            console.log(`[Popup] Tab loaded: ${tab.title}, has cached summary: ${!!cachedSummary},cached summaries: ${cachedSummary?.summary}`);
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